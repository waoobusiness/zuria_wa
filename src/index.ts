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
import crypto from 'crypto'

// -------------------------
// CONFIG
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// utilisé pour exposer les médias téléchargés
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

// secret GLOBAL partagé Render ↔ Supabase pour signer le premier webhook session.created
const WEBHOOK_SECRET_GLOBAL = process.env.WEBHOOK_SECRET || ''

// URL de l’Edge Function Supabase (whatsapp-webhook-gateway)
const SUPABASE_WEBHOOK_URL =
  (process.env.SUPABASE_WEBHOOK_URL || '').replace(/\/$/, '')

// -------------------------
// TYPES & MEMORY
// -------------------------

type ChatLite = {
  id: string
  name?: string | null
  subject?: string | null
  /** seconds since epoch (Baileys) */
  conversationTimestamp?: number | null
}

type SessionState = {
  id: string

  // QR pour affichage dans / (tableau de bord debug)
  qr?: string | null
  qr_text?: string | null

  // état connexion
  connected: boolean

  // socket Baileys
  sock?: ReturnType<typeof makeWASocket>

  // sauvegarde creds baileys
  saveCreds?: () => Promise<void>

  // URL webhook pour cette session vers Supabase
  // ex: https://.../whatsapp-webhook-gateway?session_id=<sessionId>
  webhookUrl?: string

  // secret unique POUR CETTE SESSION
  // (on l'envoie à Supabase dans session.created;
  // ensuite tous les events hors session.created sont signés avec ça)
  sessionSecret?: string

  // infos compte whatsapp
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null

  // stores mémoire pour l'UI temps réel /chats et /messages
  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
}

// toutes les sessions actives en RAM
const sessions = new Map<string, SessionState>()

// -------------------------
// FASTIFY INSTANCE
// -------------------------
const app = Fastify({ logger: true })

// parse JSON permissif (corps vide => {})
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
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
})

// accepter /api/... en le réécrivant en /...
app.addHook('onRequest', (req, _reply, done) => {
  if (req.url.startsWith('/api/')) {
    // @ts-ignore override fastify readonly
    req.url = req.url.slice(4)
  }
  done()
})

// s'assurer que le dossier media existe
fs.mkdirSync(MEDIA_DIR, { recursive: true })

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

  if (!mediaType || !mediaObj) return null

  const stream = await downloadContentFromMessage(mediaObj, mediaType)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const buf = Buffer.concat(chunks)

  const mimeType = mediaObj.mimetype || 'application/octet-stream'
  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)
  fs.writeFileSync(absPath, buf)

  const url = `${PUBLIC_BASE_URL}/media/${filename}`
  return { filename, mimeType, url }
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

// ----- HMAC SIGNATURE (Render -> Supabase) -----
function hmacHex(secret: string, bodyObj: Record<string, any>): string {
  const body = JSON.stringify(bodyObj)
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Envoie un webhook vers Supabase.
 *
 * event = "session.created" | "session.connected" | "session.disconnected" | "message.in" | "message.out" | etc.
 *
 * Règle de signature:
 *  - "session.created"  -> signé avec le secret GLOBAL (WEBHOOK_SECRET_GLOBAL)
 *  - tout le reste      -> signé avec le secret DE LA SESSION (s.sessionSecret)
 */
async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  // Construire l'URL webhook une fois qu'on connaît la session
  // Format attendu par Supabase: .../whatsapp-webhook-gateway?session_id=<sessionId>
  const url = s.webhookUrl || (SUPABASE_WEBHOOK_URL
    ? `${SUPABASE_WEBHOOK_URL}?session_id=${s.id}`
    : '')

  if (!url) {
    app.log.warn({ msg: 'no webhook URL configured, drop event', sessionId: s.id, event })
    return
  }

  // Corps envoyé à Supabase.
  // IMPORTANT: structure adaptée à l’Edge Function actuelle.
  const body = {
    session_id: s.id,
    event,
    data: payload
  }

  // On choisit quel secret utiliser pour signer
  const secretToUse = event === 'session.created'
    ? WEBHOOK_SECRET_GLOBAL              // global pour le tout premier handshake
    : (s.sessionSecret || '')            // secret unique stocké en DB par Supabase après session.created

  if (!secretToUse) {
    app.log.warn({
      msg: 'no signing secret available for webhook',
      sessionId: s.id,
      event
    })
  }

  const signature = hmacHex(secretToUse, body)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': signature,
        'x-wa-sig-version': '1'
      },
      body: JSON.stringify(body)
    })

    app.log.info({
      class: 'WEBHOOK DEBUG SENT',
      sessionId: s.id,
      event,
      url,
      status: res.status
    })
  } catch (e) {
    app.log.error({
      msg: 'webhook push failed',
      sessionId: s.id,
      event,
      err: String(e)
    })
  }
}

// -------------------------
// BAILEYS EVENT WIRING
// -------------------------

function ensureChat(id: string): ChatLite {
  return { id, name: null, subject: null, conversationTimestamp: null }
}

function wireChatContactStores(s: SessionState, sock: ReturnType<typeof makeWASocket>) {
  const setChats = (arr: any[]) => {
    for (const c of arr || []) {
      const base: ChatLite = s.chats.get(c.id) ?? ensureChat(c.id)
      s.chats.set(c.id, {
        id: c.id,
        name: c.name ?? base.name ?? null,
        subject: c.subject ?? base.subject ?? null,
        conversationTimestamp:
          (typeof c.conversationTimestamp === 'number'
            ? c.conversationTimestamp
            : Number(c.conversationTimestamp || 0)) || base.conversationTimestamp || 0
      })
    }
  }

  ;(sock.ev as any).on('chats.set', (data: any) => setChats(data?.chats || []))
  ;(sock.ev as any).on('chats.upsert', (arr: any[]) => setChats(arr))
  ;(sock.ev as any).on('chats.update', (updates: any[]) => {
    for (const u of updates || []) {
      const base: ChatLite = s.chats.get(u.id) ?? ensureChat(u.id)
      s.chats.set(u.id, {
        ...base,
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.subject !== undefined ? { subject: u.subject } : {}),
        ...(u.conversationTimestamp !== undefined
          ? { conversationTimestamp: Number(u.conversationTimestamp || 0) }
          : {})
      })
    }
  })

  ;(sock.ev as any).on('contacts.upsert', (arr: any[]) => {
    for (const c of arr || []) {
      const jid = c.id
      s.contacts.set(jid, { notify: c.notify, name: c.name })
      const chat = s.chats.get(jid)
      if (chat && !chat.name && (c.notify || c.name)) {
        s.chats.set(jid, { ...chat, name: c.notify || c.name })
      }
    }
  })
}

async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({
    wa_update: {
      connection: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect
    }
  })

  // si on reçoit un QR -> garder pour l'UI
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch {
      s.qr = null
    }
  }

  // connecté
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // récupérer info du compte localement
    const me = (s.sock as any)?.user
    if (me?.id) {
      s.meId = me.id
      const num = extractPhoneFromJid(me.id)
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    // avertir Supabase (signé avec le secret session car ce n'est pas "session.created")
    await sendWebhookEvent(s, 'session.connected', {
      jid: s.meId || null,
      phone_number: s.meNumber || null,
      ts: Date.now()
    })
    return
  }

  // fermé
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // cas: restart nécessaire
    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515)', id: s.id })
      await restartSession(s.id)
      return
    }

    const code = Number(
      err?.output?.statusCode ??
        err?.status ??
        err?.code ??
        err?.statusCode ??
        0
    )

    // cas: logged out -> il faut rescanner
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app.log.warn({ msg: 'logged out — rescan required', id: s.id })

      await sendWebhookEvent(s, 'session.disconnected', {
        reason: 'loggedOut',
        ts: Date.now()
      })
      return
    }

    s.connected = false
  }
}

async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key) return

  const remoteJid = msg.key.remoteJid || ''
  const fromMe = msg.key.fromMe === true
  const chatNumber = extractPhoneFromJid(remoteJid)

  // texte ou caption
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    ''

  // récupérer media si présent, le sauver sur disque, générer l’URL publique
  const mediaInfo = await saveIncomingMedia(msg) // peut être null

  // mettre à jour l’horodatage de la conversation pour l’UI /chats
  const base = s.chats.get(remoteJid) ?? ensureChat(remoteJid)
  const tsSec = Number(msg.messageTimestamp || 0)
  s.chats.set(remoteJid, { ...base, conversationTimestamp: tsSec })

  const eventName = fromMe ? 'message.out' : 'message.in'

  // pousser dans Supabase
  await sendWebhookEvent(s, eventName, {
    from: chatNumber || remoteJid,
    fromJid: remoteJid,
    fromMe,
    text,
    media: mediaInfo || null,
    timestampMs: tsSec * 1000
  })
}

function attachSocketHandlers(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  if (s.saveCreds) sock.ev.on('creds.update', s.saveCreds)
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
  sock.ev.on('messages.upsert', async (m) => onMessagesUpsert(s, m))
  wireChatContactStores(s, sock)
}

// -------------------------
// SESSION LIFECYCLE
// -------------------------

async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session', id })

  // nettoyer anciens listeners/socket
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  // recharger l'état d'auth
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()
  s.saveCreds = saveCreds

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })
  s.sock = sock

  attachSocketHandlers(s, sock)
}

async function startSession(id: string) {
  // chaque session a son propre dossier d'auth
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  // générer un secret UNIQUE pour CETTE session
  const sessionSecret = crypto.randomBytes(32).toString('hex')

  // construire l'URL webhook pour Supabase pour cette session
  const fullWebhookUrl = SUPABASE_WEBHOOK_URL
    ? `${SUPABASE_WEBHOOK_URL}?session_id=${id}`
    : undefined

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
    contacts: new Map(),
    sessionSecret,
    webhookUrl: fullWebhookUrl
  }

  // ouvrir la connexion WhatsApp
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })
  s.sock = sock

  sessions.set(id, s)
  attachSocketHandlers(s, sock)

  // === ENVOI IMMÉDIAT DE session.created ===
  // signé avec le secret GLOBAL (WEBHOOK_SECRET_GLOBAL)
  // Supabase va:
  //  - vérifier la signature
  //  - faire un UPSERT dans whatsapp_sessions
  //  - stocker sessionSecret dans whatsapp_sessions.webhook_secret
  await sendWebhookEvent(s, 'session.created', {
    sessionSecret,
    phone: null
  })

  return s
}

// -------------------------
// ROUTES HTTP
// -------------------------

// Mini dashboard debug
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
          if(s.qr){ img.src = s.qr }
          else if (s.qr_text) {
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='
                      + encodeURIComponent(s.qr_text)
          }
          stat.textContent = s.connected
            ? '✅ Connecté ('+(s.phoneNumber||'???')+')'
            : '⏳ En attente...'
          if(s.connected){ clearInterval(interval); img.remove() }
        }, 1500)
      }
      </script>
    </body>
  </html>`
  reply.type('text/html').send(html)
})

// page debug pour envoyer un message manuellement
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
        <button id="seed">Forcer session.created</button>
      </div>
      <label>Numéro (ex: 41760000000)<br/><input id="to" style="width:100%" placeholder="chiffres uniquement"/></label>
      <br/><br/>
      <label>Message<br/><textarea id="text" style="width:100%; height:120px">Hello depuis Zuria 🚀</textarea></label>
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
        document.getElementById('seed').onclick = async () => {
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid + '/seed-created', { method: 'POST' })
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

// créer une nouvelle session WhatsApp (avec QR)
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)
  // petite pause pour laisser Baileys commencer et éventuellement générer un QR
  await new Promise(res => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})

// lire l'état d'une session
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

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

// relancer la socket Baileys pour une session donnée
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  await restartSession(id)
  return reply.send({ ok: true })
})

// forcer l'envoi du webhook "session.created" à Supabase
// utile pour les anciennes sessions créées AVANT ce code
app.post('/sessions/:id/seed-created', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  // si pas de secret de session encore présent, on en génère un
  if (!s.sessionSecret) {
    s.sessionSecret = crypto.randomBytes(32).toString('hex')
  }

  if (!s.webhookUrl && SUPABASE_WEBHOOK_URL) {
    s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?session_id=${id}`
  }

  await sendWebhookEvent(s, 'session.created', {
    sessionSecret: s.sessionSecret,
    phone: s.meNumber || null
  })

  return reply.send({ ok: true })
})

// envoyer un message WhatsApp sortant
app.post('/messages', async (req, reply) => {
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text: String(text || '') })

  // notifier Supabase pour logguer le message sortant
  await sendWebhookEvent(s, 'message.out', {
    to: jid,
    text: String(text || ''),
    ts: Date.now()
  })

  return reply.send({ ok: true })
})

// récupérer la liste triée des chats pour une session
app.get('/sessions/:id/chats', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)
  const beforeTs = Number(q.beforeTs || 0) // ms

  const raw = Array.from(s.chats.values())

  const sorted = raw.sort((a, b) => {
    const ta = Number(a.conversationTimestamp || 0)
    const tb = Number(b.conversationTimestamp || 0)
    return tb - ta
  })

  const filtered = beforeTs > 0
    ? sorted.filter(c => Number(c.conversationTimestamp || 0) * 1000 < beforeTs)
    : sorted

  const page = filtered.slice(0, limit)

  const chats = page.map(chat => ({
    chatJid: chat.id,
    chatNumber: extractPhoneFromJid(chat.id),
    chatName: chat.name || chat.subject || null,
    lastTsMs: Number(chat.conversationTimestamp || 0) * 1000
  }))

  const nextBeforeTs = page.length > 0
    ? Number(page[page.length - 1].conversationTimestamp || 0) * 1000
    : null

  return reply.send({ ok: true, chats, nextBeforeTs })
})

// récupérer les messages d'un chat précis dans une session
app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
  const { id, jid } = (req.params as any)
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)

  const beforeId = q.beforeId ? String(q.beforeId) : undefined
  let beforeFromMe: boolean | undefined = undefined
  if (q.beforeFromMe === 'true' || q.beforeFromMe === true) beforeFromMe = true
  else if (q.beforeFromMe === 'false' || q.beforeFromMe === false) beforeFromMe = false

  const cursor = (beforeId && typeof beforeFromMe === 'boolean')
    ? { id: beforeId, fromMe: beforeFromMe, remoteJid: jid }
    : undefined

  let rawMsgs: any[] = []
  try {
    rawMsgs = await (s.sock as any).loadMessages(jid, limit, cursor)
  } catch (e: any) {
    return reply.code(500).send({ error: 'loadMessages failed', detail: String(e) })
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
      mediaUrl: null,
      mediaMime: null,
      timestampMs: tsMs
    }
  })

  const last = messages[messages.length - 1]
  const nextCursor = last
    ? { beforeId: last.messageId, beforeFromMe: last.fromMe }
    : null

  return reply.send({ ok: true, messages, nextCursor })
})

// logout total d'une session + suppression des creds
app.post('/sessions/:id/logout', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  try {
    if (s.sock) await s.sock.logout()
  } catch (e: any) {
    app.log.warn({ msg: 'logout() threw', id, err: String(e) })
  }

  await sendWebhookEvent(s, 'session.disconnected', {
    reason: 'manual_logout',
    ts: Date.now()
  })

  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false

  try {
    const authPath = path.join(AUTH_DIR, id)
    fs.rmSync(authPath, { recursive: true, force: true })
    app.log.info({ msg: 'auth folder deleted', path: authPath })
  } catch (e: any) {
    app.log.warn({ msg: 'failed to delete auth folder', err: String(e) })
  }

  sessions.delete(id)
  return reply.send({ ok: true, loggedOut: true })
})

// healthcheck pour Render
app.get('/health', async (_req, reply) => reply.send({ ok: true }))

// -------------------------
// BOOTSTRAP
// -------------------------
async function bootstrap() {
  await app.register(cors, { origin: true })
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: '/media/' })

  app.listen({ port: PORT, host: '0.0.0.0' })
    .then(() => app.log.info(`HTTP server listening on ${PORT}`))
    .catch((err) => {
      app.log.error(err)
      process.exit(1)
    })
}
bootstrap()
