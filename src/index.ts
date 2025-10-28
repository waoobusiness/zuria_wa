// src/index.ts

// -------------------------
// IMPORTS
// -------------------------
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'

// -------------------------
// CONFIG
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)

// Dossier où Baileys stocke l'auth multi-fichiers pour CHAQUE session
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Dossier où on stocke toutes les pièces jointes reçues
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// URL publique de ce service (pour générer les liens media)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

// Secret global qu’on envoie dans le header x-wa-signature aux webhooks
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Clé API optionnelle pour protéger les routes REST que Lovable appelle
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES & MÉMOIRE
// -------------------------

// Mini copie d'info de chat qu'on maintient nous-mêmes (plus de makeInMemoryStore)
type ChatLite = {
  id: string
  name?: string | null
  subject?: string | null
  conversationTimestamp?: number | string | null // en secondes (format Baileys)
}

type SessionState = {
  id: string

  // QR code (image base64) et texte brut du QR
  qr?: string | null
  qr_text?: string | null

  // connecté ou pas
  connected: boolean

  // socket Baileys actif
  sock?: ReturnType<typeof makeWASocket>

  // callback Baileys pour persister l'auth multi-fichiers
  saveCreds?: () => Promise<void>

  // webhook spécifique à CETTE session
  webhookUrl?: string
  webhookSecret?: string

  // infos du compte WhatsApp
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null // alias pratique

  // notre "store" mémoire
  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
}

// Toutes les sessions vivantes en RAM
const sessions = new Map<string, SessionState>()

// Fastify instance sera initialisée dans bootstrap()
let app: ReturnType<typeof Fastify> | null = null


// -------------------------
// HELPERS
// -------------------------

function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  const m = jid.match(/^(\d{5,20})/)
  return m ? m[1] : null
}

function guessExt(mime: string | undefined): string {
  if (!mime) return 'bin'
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('jpg')) return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('opus')) return 'ogg'
  if (mime.includes('pdf')) return 'pdf'
  return 'bin'
}

// Télécharge l'image / audio / vidéo / doc du message (si présent)
// -> enregistre le fichier dans MEDIA_DIR
// -> renvoie { filename, mimeType, url publique }
async function saveIncomingMedia(
  msg: any
): Promise<null | { filename: string; mimeType: string; url: string }> {
  let mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' | null = null
  let mediaObj: any = null

  if (msg.message?.imageMessage) {
    mediaType = 'image'
    mediaObj = msg.message.imageMessage
  } else if (msg.message?.videoMessage) {
    mediaType = 'video'
    mediaObj = msg.message.videoMessage
  } else if (msg.message?.audioMessage) {
    mediaType = 'audio'
    mediaObj = msg.message.audioMessage
  } else if (msg.message?.documentMessage) {
    mediaType = 'document'
    mediaObj = msg.message.documentMessage
  } else if (msg.message?.stickerMessage) {
    mediaType = 'sticker'
    mediaObj = msg.message.stickerMessage
  }

  if (!mediaType || !mediaObj) {
    return null
  }

  const stream = await downloadContentFromMessage(mediaObj, mediaType)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)

  const mimeType = mediaObj.mimetype || 'application/octet-stream'
  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)
  fs.writeFileSync(absPath, buf)

  const url = `${PUBLIC_BASE_URL}/media/${filename}`

  return {
    filename,
    mimeType,
    url
  }
}

function isRestartRequired(err: any) {
  const code = Number(
    err?.output?.statusCode ??
      err?.status ??
      err?.code ??
      err?.statusCode ??
      0
  )
  return code === 515 || code === DisconnectReason.restartRequired
}

// push un event webhook vers Lovable
async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  if (!s.webhookUrl) {
    app?.log.warn({
      msg: 'no webhookUrl for session, drop event',
      sessionId: s.id,
      event
    })
    return
  }

  const signature = s.webhookSecret || WEBHOOK_SECRET || ''
  const body = {
    sessionId: s.id,
    event,
    ...payload
  }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': signature
      },
      body: JSON.stringify(body)
    })

    app?.log.info({
      webhookPush: {
        sessionId: s.id,
        event,
        status: res.status
      }
    })
  } catch (e: any) {
    app?.log.error({
      msg: 'webhook push failed',
      sessionId: s.id,
      event,
      err: String(e)
    })
  }
}


// -------------------------
// BAILEYS HANDLERS
// -------------------------

// On garde à jour une liste minimale des chats dans s.chats
function wireChatContactStores(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  // internal helper pour fusionner les infos chats
  const setChats = (arr: any[]) => {
    for (const c of arr || []) {
      const existing: ChatLite =
        s.chats.get(c.id) || ({ id: c.id } as ChatLite)

      s.chats.set(c.id, {
        ...existing,
        id: c.id,
        name: c.name ?? existing.name ?? null,
        subject: c.subject ?? existing.subject ?? null,
        conversationTimestamp:
          c.conversationTimestamp ??
          existing.conversationTimestamp ??
          null
      })
    }
  }

  // Baileys émet des events type 'chats.set', 'chats.upsert', etc.
  // Les types officiels sont stricts → on cast en any pour éviter les erreurs TS.
  ;(sock.ev as any).on('chats.set', (data: any) => {
    setChats(data?.chats || [])
  })

  ;(sock.ev as any).on('chats.upsert', (arr: any[]) => {
    setChats(arr)
  })

  ;(sock.ev as any).on('chats.update', (updates: any[]) => {
    for (const u of updates || []) {
      const existing: ChatLite =
        s.chats.get(u.id) || ({ id: u.id } as ChatLite)

      s.chats.set(u.id, {
        ...existing,
        ...u
      })
    }
  })

  ;(sock.ev as any).on('contacts.upsert', (arr: any[]) => {
    for (const c of arr || []) {
      const jid = c.id
      s.contacts.set(jid, { notify: c.notify, name: c.name })

      // si on a un chat avec ce jid, on peut lui donner un nom humain
      const chat = s.chats.get(jid)
      if (chat && !chat.name && (c.notify || c.name)) {
        chat.name = c.notify || c.name
        s.chats.set(jid, chat)
      }
    }
  })
}

// connection.update : QR, connecté, déconnecté...
async function onConnectionUpdate(s: SessionState, u: any) {
  app?.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect
    }
  })

  // nouveau QR code dispo
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch {
      s.qr = null
    }
  }

  // session ouverte
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // extraire le numéro
    if (u.me?.id) {
      s.meId = u.me.id || null
      const num = extractPhoneFromJid(s.meId || '')
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    await sendWebhookEvent(s, 'session.connected', {
      data: {
        meId: s.meId || null,
        phoneNumber: s.meNumber || null
      },
      ts: Date.now()
    })

    return
  }

  // session fermée
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // cas "il faut juste redémarrer"
    if (isRestartRequired(err)) {
      app?.log.warn({
        msg: 'restart required (515) — restarting socket',
        id: s.id
      })
      await restartSession(s.id)
      return
    }

    // cas "vraiment déconnecté côté WhatsApp"
    const code = Number(
      err?.output?.statusCode ??
        err?.status ??
        err?.code ??
        err?.statusCode ??
        0
    )
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app?.log.warn({
        msg: 'logged out — rescan required',
        id: s.id
      })

      await sendWebhookEvent(s, 'session.disconnected', {
        data: { reason: 'loggedOut' },
        ts: Date.now()
      })

      return
    }

    // sinon juste "pas connecté"
    s.connected = false
  }
}

// messages.upsert : message entrant ou sortant
async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key) return

  const remoteJid = msg.key.remoteJid || ''
  const fromMe = msg.key.fromMe === true
  const chatNumber = extractPhoneFromJid(remoteJid)

  // texte du message
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '' // si c'est juste un vocal / sticker sans caption, text sera ''

  // média reçu ?
  const mediaInfo = await saveIncomingMedia(msg) // peut être null

  // met à jour le timestamp du chat pour le tri dans /chats
  const tsSec = Number(msg.messageTimestamp || 0) // en secondes
  const existingChat: ChatLite =
    s.chats.get(remoteJid) ||
    ({ id: remoteJid } as ChatLite)

  existingChat.conversationTimestamp = tsSec
  s.chats.set(remoteJid, existingChat)

  // on choisit l'event en fonction de fromMe
  const eventName = fromMe ? 'message.out' : 'message.in'

  await sendWebhookEvent(s, eventName, {
    data: {
      from: chatNumber || remoteJid,
      fromJid: remoteJid,
      fromMe,
      text,
      media: mediaInfo || null,
      timestampMs: tsSec * 1000
    },
    ts: Date.now()
  })
}

// attache tous les listeners Baileys à une session
function attachSocketHandlers(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  if (s.saveCreds) {
    ;(sock.ev as any).on('creds.update', s.saveCreds)
  }

  ;(sock.ev as any).on('connection.update', async (u: any) => {
    await onConnectionUpdate(s, u)
  })

  ;(sock.ev as any).on('messages.upsert', async (m: any) => {
    await onMessagesUpsert(s, m)
  })

  wireChatContactStores(s, sock)
}


// -------------------------
// CYCLE DE VIE D'UNE SESSION
// -------------------------

async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app?.log.warn({ msg: 'restart WA session', id })

  // nettoyer l'ancien socket
  try {
    ;(s.sock as any)?.ev?.removeAllListeners?.()
  } catch {}
  try {
    ;(s.sock as any)?.ws?.close?.()
  } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  // recharger l'état d'auth
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(AUTH_DIR, id)
  )
  const { version } = await fetchLatestBaileysVersion()

  s.saveCreds = saveCreds

  // recréer le socket
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })
  s.sock = sock

  // rebrancher les handlers
  attachSocketHandlers(s, sock)
}

// crée une nouvelle session (nouveau QR)
async function startSession(id: string) {
  // 1. créer le dossier d'auth sur disque
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  // 2. préparer l'état multi-fichiers Baileys
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(AUTH_DIR, id)
  )
  const { version } = await fetchLatestBaileysVersion()

  // 3. initialiser l'objet session en RAM
  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
    saveCreds,
    phoneNumber: null,
    meId: null,
    meNumber: null,
    chats: new Map(),
    contacts: new Map()
  }

  // 4. créer le socket Baileys
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })
  s.sock = sock

  // 5. stocker la session
  sessions.set(id, s)

  // 6. brancher les listeners
  attachSocketHandlers(s, sock)

  return s
}


// -------------------------
// BOOTSTRAP HTTP + ROUTES
// -------------------------

async function bootstrap() {
  // créer l'instance Fastify
  app = Fastify({ logger: true })

  // CORS ouvert pour Lovable
  await app.register(cors, { origin: true })

  // Parser JSON permissif :
  // si l'appelant dit "Content-Type: application/json" mais envoie pas de body,
  // on renvoie {} au lieu d'exploser -> ça corrige l'erreur 400 "Body cannot be empty"
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        if (!body || (typeof body === 'string' && body.trim() === '')) {
          done(null, {})
          return
        }
        const json = typeof body === 'string' ? JSON.parse(body) : body
        done(null, json)
      } catch (e) {
        done(e as any, undefined)
      }
    }
  )

  // Support du prefixe /api/* (les edge functions de Supabase appellent parfois /api/…)
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.url.startsWith('/api/')) {
      req.url = req.url.slice(4) // enlève "/api"
    }
    done()
  })

  // s'assure que le dossier média existe
  fs.mkdirSync(MEDIA_DIR, { recursive: true })

  // servir les médias statiquement sous /media/*
  await app.register(fastifyStatic, {
    root: MEDIA_DIR,
    prefix: '/media/'
  })

  //
  // ROUTES
  //

  // petit dashboard debug
  app.get('/', async (_req, reply) => {
    const html = `
    <html>
      <head><meta charset="utf-8"><title>Zuria WA</title></head>
      <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
        <h2>Zuria WhatsApp Gateway</h2>
        <button onclick="createSession()">Créer une session</button>
        <div id="out" style="margin-top:16px"></div>
        <script>
        async function createSession(){
          const r = await fetch('/sessions', {method:'POST'})
          const j = await r.json()
          const out = document.getElementById('out')
          out.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p>'
                         + '<img id="qr" style="width:300px;border:1px solid #ccc"/>'
                         + '<div id="stat"></div>'
          const img = document.getElementById('qr')
          const stat = document.getElementById('stat')
          const interval = setInterval(async ()=>{
            const r2 = await fetch('/sessions/'+j.session_id)
            const s = await r2.json()
            if(s.qr){
              img.src = s.qr
            } else if (s.qr_text) {
              img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='
                        + encodeURIComponent(s.qr_text)
            }
            stat.textContent = s.connected
              ? '✅ Connecté ('+(s.phoneNumber||'???')+')'
              : '⏳ En attente...'
            if(s.connected){
              clearInterval(interval)
              img.remove()
            }
          }, 1500)
        }
        </script>
      </body>
    </html>`
    reply.type('text/html').send(html)
  })

  // mini console pour test d'envoi
  app.get('/send', async (_req, reply) => {
    const html = `
    <html>
      <head><meta charset="utf-8"><title>Envoyer un message</title></head>
      <body style="font-family: system-ui; max-width: 700px; margin: 40px auto;">
        <h2>Envoyer un message WhatsApp</h2>
        <label>ID de session<br/><input id="sid" style="width:100%"/></label>
        <div style="margin:8px 0">
          <button id="check">Vérifier statut</button>
          <button id="restart">Relancer</button>
          <button id="logout">Logout complet</button>
        </div>

        <label>Numéro (ex: 41760000000)<br/>
          <input id="to" style="width:100%" placeholder="chiffres uniquement"/>
        </label>
        <br/><br/>

        <label>Message<br/>
          <textarea id="text" style="width:100%; height:120px">Hello depuis Zuria 🚀</textarea>
        </label>
        <br/><br/>

        <button id="btn">Envoyer</button>

        <pre id="out" style="background:#111;color:#0f0;padding:12px;margin-top:16px;white-space:pre-wrap;"></pre>

        <script>
          const out = document.getElementById('out')

          document.getElementById('check').onclick = async () => {
            const sid = (document.getElementById('sid').value || '').trim()
            const r = await fetch('/sessions/' + sid)
            out.textContent = JSON.stringify(await r.json(), null, 2)
          }

          document.getElementById('restart').onclick = async () => {
            const sid = (document.getElementById('sid').value || '').trim()
            const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' })
            out.textContent = JSON.stringify(await r.json(), null, 2)
          }

          document.getElementById('logout').onclick = async () => {
            const sid = (document.getElementById('sid').value || '').trim()
            const r = await fetch('/sessions/' + sid + '/logout', { method: 'POST' })
            out.textContent = JSON.stringify(await r.json(), null, 2)
          }

          document.getElementById('btn').onclick = async () => {
            const sessionId = (document.getElementById('sid').value || '').trim()
            const to = (document.getElementById('to').value || '').trim()
            const text = document.getElementById('text').value
            out.textContent = 'Envoi en cours...'
            try {
              const r = await fetch('/messages', {
                method:'POST',
                headers:{ 'Content-Type':'application/json' },
                body: JSON.stringify({ sessionId, to, text })
              })
              out.textContent = JSON.stringify(await r.json(), null, 2)
            } catch (e) {
              out.textContent = 'Erreur: ' + e
            }
          }
        </script>
      </body>
    </html>`
    reply.type('text/html').send(html)
  })

  // Créer une nouvelle session (génère un QR)
  app.post('/sessions', async (_req, reply) => {
    const id = uuid()
    app?.log.info({ msg: 'create session', id })
    const s = await startSession(id)

    // petite pause pour laisser Baileys nous donner un premier QR
    await new Promise((res) => setTimeout(res, 500))

    return reply.send({ session_id: s.id })
  })

  // Récupérer l'état d'une session
  app.get('/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id
    const s = sessions.get(id)
    if (!s) {
      return reply.code(404).send({ error: 'unknown session' })
    }

    return reply.send({
      session_id: id,
      connected: s.connected,
      qr: s.qr || null,
      qr_text: s.qr_text || null,
      phoneNumber: s.phoneNumber || null,
      meNumber: s.meNumber || null,
      meId: s.meId || null,
      hasSock: !!s.sock
    })
  })

  // Redémarrer la session Baileys (cas "restart required")
  app.post('/sessions/:id/restart', async (req, reply) => {
    const id = (req.params as any).id
    const s = sessions.get(id)
    if (!s) {
      return reply.code(404).send({ error: 'unknown session' })
    }

    await restartSession(id)
    return reply.send({ ok: true })
  })

  // Enregistrer / mettre à jour le webhook pour CETTE session
  // Body attendu:
  // { "url": "https://.../whatsapp-webhook-gateway?session=<sessionId>", "secret": "xxxxx-optional" }
  app.post('/sessions/:id/webhook', async (req, reply) => {
    const id = (req.params as any).id
    const s = sessions.get(id)
    if (!s) {
      return reply.code(404).send({ error: 'unknown session' })
    }

    const { url, secret } = (req.body as any) || {}
    if (!url) {
      return reply.code(400).send({ error: 'missing url' })
    }

    s.webhookUrl = String(url)
    if (secret) {
      s.webhookSecret = String(secret)
    }

    return reply.send({
      ok: true,
      session_id: id,
      webhookUrl: s.webhookUrl
    })
  })

  // Envoyer un message sortant
  // Body:
  // { "sessionId": "...", "to": "4176xxxxxxx", "text": "hello" }
  app.post('/messages', async (req, reply) => {
    if (API_KEY) {
      const hdr = req.headers['x-api-key']
      if (!hdr || hdr !== API_KEY) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }

    const { sessionId, to, text } = (req.body as any) || {}
    const s = sessions.get(sessionId)
    if (!s?.sock) {
      return reply.code(400).send({ error: 'session not ready' })
    }

    const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
    await s.sock.sendMessage(jid, { text: String(text || '') })

    // push webhook "message.out" pour Lovable
    await sendWebhookEvent(s, 'message.out', {
      data: {
        to: jid,
        text: String(text || '')
      },
      ts: Date.now()
    })

    return reply.send({ ok: true })
  })

  // Liste paginée des conversations (sidebar "Live WhatsApp")
  // GET /sessions/:id/chats?limit=20&beforeTs=...
  app.get('/sessions/:id/chats', async (req, reply) => {
    const id = (req.params as any).id
    const s = sessions.get(id)
    if (!s?.sock) {
      return reply.code(400).send({ error: 'session not ready' })
    }

    if (API_KEY) {
      const hdr = req.headers['x-api-key']
      if (!hdr || hdr !== API_KEY) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }

    const q = (req.query as any) || {}
    const limit = Math.min(Number(q.limit || 20), 50)
    const beforeTs = Number(q.beforeTs || 0) // ms

    const rawChats = Array.from(s.chats.values())

    // trier du plus récent au plus ancien
    const sorted = rawChats.sort((a, b) => {
      const ta = Number(a.conversationTimestamp || 0)
      const tb = Number(b.conversationTimestamp || 0)
      return tb - ta
    })

    // pagination par curseur de timestamp
    const filtered =
      beforeTs > 0
        ? sorted.filter(
            (c) =>
              Number(c.conversationTimestamp || 0) * 1000 <
              beforeTs
          )
        : sorted

    const page = filtered.slice(0, limit)

    const chats = page.map((chat) => ({
      chatJid: chat.id,
      chatNumber: extractPhoneFromJid(chat.id),
      chatName: chat.name || chat.subject || null,
      lastTsMs:
        Number(chat.conversationTimestamp || 0) * 1000
    }))

    const nextBeforeTs =
      page.length > 0
        ? Number(
            page[page.length - 1].conversationTimestamp || 0
          ) * 1000
        : null

    return reply.send({
      ok: true,
      chats,
      nextBeforeTs // le front renverra ça en ?beforeTs=... pour charger plus
    })
  })

  // Messages paginés d'une conversation
  // GET /sessions/:id/chats/:jid/messages?limit=20&beforeId=...&beforeFromMe=...
  app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
    const { id, jid } = (req.params as any)
    const s = sessions.get(id)
    if (!s?.sock) {
      return reply.code(400).send({ error: 'session not ready' })
    }

    if (API_KEY) {
      const hdr = req.headers['x-api-key']
      if (!hdr || hdr !== API_KEY) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }

    const q = (req.query as any) || {}
    const limit = Math.min(Number(q.limit || 20), 50)

    // curseur de pagination
    const beforeId = q.beforeId ? String(q.beforeId) : undefined

    let beforeFromMe: boolean | undefined = undefined
    if (q.beforeFromMe === 'true' || q.beforeFromMe === true) {
      beforeFromMe = true
    } else if (
      q.beforeFromMe === 'false' ||
      q.beforeFromMe === false
    ) {
      beforeFromMe = false
    }

    // Baileys attend un cursor { id, fromMe, remoteJid }
    const cursor =
      beforeId && typeof beforeFromMe === 'boolean'
        ? {
            id: beforeId,
            fromMe: beforeFromMe,
            remoteJid: jid
          }
        : undefined

    let rawMsgs: any[] = []
    try {
      // charge du plus récent vers le plus ancien
      rawMsgs = await (s.sock as any).loadMessages(
        jid,
        limit,
        cursor
      )
    } catch (e: any) {
      return reply.code(500).send({
        error: 'loadMessages failed',
        detail: String(e)
      })
    }

    const messages = rawMsgs.map((m: any) => {
      const fromMe = m.key?.fromMe === true
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        m.message?.documentMessage?.caption ||
        ''
      const messageId = m.key?.id || ''
      const tsMs = Number(m.messageTimestamp || 0) * 1000

      return {
        messageId,
        fromMe,
        text,
        mediaUrl: null,   // on ne redécharge pas le binaire dans la pagination historique
        mediaMime: null,
        timestampMs: tsMs
      }
    })

    // curseur pour "charger plus"
    const last = messages[messages.length - 1]
    const nextCursor = last
      ? {
          beforeId: last.messageId,
          beforeFromMe: last.fromMe
        }
      : null

    return reply.send({
      ok: true,
      messages,
      nextCursor
    })
  })

  // Déconnexion COMPLÈTE d'une session WhatsApp
  // -> logout WhatsApp (supprime l'appareil côté téléphone)
  // -> envoie "session.disconnected" au webhook
  // -> supprime les creds du disque
  // -> enlève la session de la RAM
  app.post('/sessions/:id
