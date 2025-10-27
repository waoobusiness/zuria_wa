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
  downloadContentFromMessage,
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'


// -------------------------
// CONFIG
// -------------------------

// Port HTTP du serveur Fastify
const PORT = parseInt(process.env.PORT || '3001', 10)

// Dossier persistant monté sur Render (ex /var/data/wa/<sessionId>/*)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Dossier pour stocker les médias
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// URL publique de ce service (Render). Sert à générer les URLs des médias
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com'

// Secret global pour signer les webhooks sortants
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// API key optionnelle pour protéger les endpoints sensibles
// (le front doit envoyer header x-api-key: <API_KEY>)
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES / MÉMOIRE
// -------------------------

// conversation récente en RAM (sert à /chats pour la sidebar)
type RecentChat = {
  jid: string
  lastTsMs: number
  name: string | null
}

type SessionState = {
  id: string

  // QR pour affichage (UI)
  qr?: string | null
  qr_text?: string | null

  // statut WA
  connected: boolean

  // socket Baileys
  sock?: ReturnType<typeof makeWASocket>

  // fonction Baileys pour persister les credentials multi-fichiers
  saveCreds?: () => Promise<void>

  // webhook (Lovable/Zuria)
  webhookUrl?: string
  webhookSecret?: string

  // infos du compte WhatsApp connecté
  meId?: string | null         // ex "4176xxxxxx:29@s.whatsapp.net"
  meNumber?: string | null     // juste les chiffres
  phoneNumber?: string | null  // alias pratique (= meNumber)

  // mémoire locale des chats récents
  recentChats: Map<string, RecentChat>
}

// sessions en RAM
const sessions = new Map<string, SessionState>()


// -------------------------
// FASTIFY BOOT
// -------------------------

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

// créer le dossier média si besoin
fs.mkdirSync(MEDIA_DIR, { recursive: true })

// servir les médias en statique
await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
})


// -------------------------
// HELPERS
// -------------------------

function getSessionAuthDir(id: string) {
  return path.join(AUTH_DIR, id)
}

// "41760000000:29@s.whatsapp.net" -> "41760000000"
function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  const m = jid.match(/^(\d{5,20})/)
  return m ? m[1] : null
}

// MimeType -> extension fichier
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

// Télécharge un média reçu via Baileys, le stocke en local et renvoie l'URL publique
async function saveIncomingMedia(
  msg: any
): Promise<null | { filename: string; mimeType: string; url: string }> {
  let mediaType:
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | null = null
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

  // Téléchargement du flux binaire
  const stream = await downloadContentFromMessage(mediaObj, mediaType)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)

  // Nom de fichier unique
  const mimeType =
    mediaObj.mimetype || mediaObj.mimetype || 'application/octet-stream'
  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)

  fs.writeFileSync(absPath, buf)

  // URL publique de ce média
  const publicUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${filename}`

  return {
    filename,
    mimeType,
    url: publicUrl,
  }
}

// simplifier un message Baileys pour renvoi au front (historique)
function simplifyBaileysMessage(m: any) {
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
    mediaUrl: null, // pas de re-download du binaire en pagination
    mediaMime: null,
    timestampMs: tsMs,
  }
}

// On garde une petite liste des chats récents pour la sidebar "Live WhatsApp"
function touchRecentChat(
  s: SessionState,
  jid: string,
  tsMs: number,
  nameGuess: string | null
) {
  const prev = s.recentChats.get(jid)
  if (!prev) {
    s.recentChats.set(jid, {
      jid,
      lastTsMs: tsMs,
      name: nameGuess || null,
    })
  } else {
    if (tsMs > prev.lastTsMs) {
      prev.lastTsMs = tsMs
    }
    if (!prev.name && nameGuess) {
      prev.name = nameGuess
    }
    s.recentChats.set(jid, prev)
  }
}

// ENVOI D'UN WEBHOOK vers Supabase/Lovable
async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  if (!s.webhookUrl) {
    app.log.warn({
      msg: 'no webhookUrl for session, drop event',
      sessionId: s.id,
      event,
    })
    return
  }

  const signature = s.webhookSecret || WEBHOOK_SECRET || ''

  const body = {
    sessionId: s.id,
    event,
    ...payload,
  }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': signature,
      },
      body: JSON.stringify(body),
    })

    app.log.info({
      webhookPush: {
        sessionId: s.id,
        event,
        status: res.status,
      },
    })
  } catch (e: any) {
    app.log.error({
      msg: 'webhook push failed',
      sessionId: s.id,
      event,
      err: String(e),
    })
  }
}

// Baileys code 515 => restartRequired
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


// -------------------------
// HANDLERS BAILEYS
// -------------------------

// Connexion / QR / déconnexion
async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect,
    },
  })

  // Nouveau QR à afficher
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  // Connecté
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // Récupérer l'ID et le numéro lié
    if (u.me?.id) {
      s.meId = u.me.id || null
      const num = extractPhoneFromJid(s.meId || '')
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    // webhook "session.connected"
    await sendWebhookEvent(s, 'session.connected', {
      data: {
        meId: s.meId || null,
        jid: s.meId || null,
        phone_number: s.phoneNumber || null,
      },
      ts: Date.now(),
    })

    return
  }

  // Fermeture / déconnexion
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // Cas 515 => restart automatique
    if (isRestartRequired(err)) {
      app.log.warn({
        msg: 'restart required (515) — restarting socket',
        id: s.id,
      })
      await restartSession(s.id, { resetAuth: false })
      return
    }

    // Cas loggedOut => il faudra rescanner
    const code = Number(
      err?.output?.statusCode ??
        err?.status ??
        err?.code ??
        err?.statusCode ??
        0
    )
    if (code === DisconnectReason.loggedOut) {
      s.connected = false

      await sendWebhookEvent(s, 'session.disconnected', {
        data: {
          reason: 'loggedOut',
          phone_number: s.phoneNumber || null,
        },
        ts: Date.now(),
      })

      return
    }

    // Sinon : juste déconnecté, Baileys va retenter
    s.connected = false
  }
}

// Messages entrants/sortants temps réel
async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key) return

  const remoteJid = msg.key.remoteJid || '' // "4176xxxxxx@s.whatsapp.net"
  const fromMe = msg.key.fromMe === true
  const chatNumber = extractPhoneFromJid(remoteJid)

  // timestamp du message
  const tsMs = Number(msg.messageTimestamp || Date.now()) * 1000

  // mettre à jour la liste des conversations récentes
  const possibleName: string | null =
    (msg.pushName && String(msg.pushName)) || null
  touchRecentChat(s, remoteJid, tsMs, possibleName)

  // texte du message
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    ''

  // media éventuel
  const mediaInfo = await saveIncomingMedia(msg) // peut être null

  // IMPORTANT :
  // - Si fromMe === false => message du CLIENT -> "message.in"
  // - Si fromMe === true  => message envoyé PAR NOUS (téléphone business OU bot) -> "message.out"
  const eventName = fromMe ? 'message.out' : 'message.in'

  await sendWebhookEvent(s, eventName, {
    data: {
      from: chatNumber || remoteJid,         // numéro du client OU nous selon le sens
      fromJid: remoteJid,
      fromMe,
      text,
      media: mediaInfo,                      // { url, mimeType, filename } | null
      sessionPhone: s.phoneNumber || null,   // numéro de la session WA
      timestampMs: tsMs,
    },
    ts: Date.now(),
  })
}

// brancher les listeners Baileys
function attachSocketHandlers(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  if (s.saveCreds) {
    sock.ev.on('creds.update', s.saveCreds)
  }
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
  sock.ev.on('messages.upsert', async (m) => onMessagesUpsert(s, m))
}


// -------------------------
// CYCLE DE VIE DES SESSIONS
// -------------------------

// Crée un socket Baileys pour une session donnée
async function buildSessionSocket(id: string): Promise<SessionState> {
  // s'assure que le dossier d'auth existe
  fs.mkdirSync(getSessionAuthDir(id), { recursive: true })

  // charge l'état multi-fichiers
  const { state, saveCreds } = await useMultiFileAuthState(
    getSessionAuthDir(id)
  )
  const { version } = await fetchLatestBaileysVersion()

  // prépare notre session en RAM
  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
    saveCreds,
    phoneNumber: null,
    meId: null,
    meNumber: null,
    recentChats: new Map<string, RecentChat>(),
  }

  // crée le socket
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  })
  s.sock = sock

  // branche les handlers
  attachSocketHandlers(s, sock)

  // stocke en RAM
  sessions.set(id, s)

  return s
}

// Charge la session en RAM ou la reconstruit depuis disque
async function ensureSessionLoaded(id: string): Promise<SessionState> {
  const existing = sessions.get(id)
  if (existing?.sock) {
    return existing
  }
  // pas en RAM -> reconstruire
  const s = await buildSessionSocket(id)
  return s
}

// Redémarrer une session. resetAuth=true => on supprime ses creds,
// donc l'utilisateur devra rescanner un QR.
async function restartSession(
  id: string,
  opts: { resetAuth: boolean }
): Promise<SessionState> {
  const old = sessions.get(id)

  // couper l'ancien socket
  if (old?.sock) {
    try {
      ;(old.sock as any)?.ev?.removeAllListeners?.()
    } catch {}
    try {
      ;(old.sock as any)?.ws?.close?.()
    } catch {}
  }

  // si on veut un tout nouveau login => effacer les creds
  if (opts.resetAuth) {
    try {
      fs.rmSync(getSessionAuthDir(id), {
        recursive: true,
        force: true,
      })
    } catch {}
  }

  // reconstruire
  const fresh = await buildSessionSocket(id)
  return fresh
}

// Crée une toute nouvelle session (nouvel ID)
async function startSession(newId: string) {
  const s = await buildSessionSocket(newId)
  return s
}


// -------------------------
// ROUTES HTTP
// -------------------------

// Page de test pour créer une session à la main et voir le QR
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

// Mini console d'envoi manuel
app.get('/send', async (_req, reply) => {
  const html = `
  <html>
    <head><meta charset="utf-8"><title>Envoyer un message</title></head>
    <body style="font-family: system-ui; max-width: 700px; margin: 40px auto;">
      <h2>Envoyer un message WhatsApp</h2>

      <label>ID de session<br/>
        <input id="sid" style="width:100%" />
      </label>
      <div style="margin:8px 0">
        <button id="check">Vérifier statut</button>
        <button id="restart">Relancer</button>
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
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
        }

        document.getElementById('restart').onclick = async () => {
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' })
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
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
            const j = await r.json()
            out.textContent = JSON.stringify(j, null, 2)
          } catch (e) {
            out.textContent = 'Erreur: ' + e
          }
        }
      </script>
    </body>
  </html>`
  reply.type('text/html').send(html)
})

// Créer une nouvelle session => renvoie son ID
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)

  // petite pause pour que Baileys ait le temps de générer un QR
  await new Promise((res) => setTimeout(res, 500))

  return reply.send({ session_id: s.id })
})

// Récupérer l'état d'une session
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = await ensureSessionLoaded(id).catch(() => null)
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
    hasSock: !!s.sock,
  })
})

// Redémarrer / Reconnecter : on efface les creds pour FORCER un nouveau QR
// (c'est ce que ton bouton "Reconnecter" doit faire)
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  try {
    const s = await restartSession(id, { resetAuth: true })
    return reply.send({
      ok: true,
      session_id: s.id,
      connected: s.connected,
      needScan: true,
    })
  } catch (e: any) {
    app.log.error({
      msg: 'restartSession failed',
      id,
      err: String(e),
    })
    return reply
      .code(500)
      .send({ error: 'restart failed', detail: String(e) })
  }
})

// Enregistrer / Mettre à jour le webhook pour une session
// Body attendu: { "url": "...", "secret": "..." (optionnel) }
app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id
  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

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
    webhookUrl: s.webhookUrl,
  })
})

// Liste paginée des conversations récentes (sidebar Live WhatsApp)
// GET /sessions/:id/chats?limit=20&beforeTs=...
app.get('/sessions/:id/chats', async (req, reply) => {
  const id = (req.params as any).id

  // protéger avec API_KEY si fourni
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)
  const beforeTs = Number(q.beforeTs || 0)

  // on lit notre Map locale
  const rawChats: RecentChat[] = Array.from(s.recentChats.values())

  // tri du plus récent au plus ancien
  const sorted = rawChats.sort((a, b) => b.lastTsMs - a.lastTsMs)

  // pagination "avant telle date"
  const filtered =
    beforeTs > 0
      ? sorted.filter((c) => c.lastTsMs < beforeTs)
      : sorted

  const page = filtered.slice(0, limit)

  const chats = page.map((chat) => ({
    chatJid: chat.jid,
    chatNumber: extractPhoneFromJid(chat.jid),
    chatName: chat.name || null,
    lastTsMs: chat.lastTsMs,
  }))

  const nextBeforeTs =
    page.length > 0 ? page[page.length - 1].lastTsMs : null

  return reply.send({
    ok: true,
    chats,
    nextBeforeTs,
  })
})

// Historique paginé des messages d'une conversation
// GET /sessions/:id/chats/:jid/messages?limit=20&beforeId=...&beforeFromMe=...
app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
  const { id, jid } = (req.params as any)

  // protéger avec API_KEY si fourni
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)

  // curseur pagination
  const beforeId = q.beforeId ? String(q.beforeId) : undefined
  let beforeFromMe: boolean | undefined = undefined
  if (q.beforeFromMe === 'true' || q.beforeFromMe === true) {
    beforeFromMe = true
  } else if (q.beforeFromMe === 'false' || q.beforeFromMe === false) {
    beforeFromMe = false
  }

  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s?.sock) {
    return reply.code(400).send({ error: 'session not ready' })
  }

  // Baileys attend un cursor éventuel { id, fromMe, remoteJid }
  const cursor =
    beforeId && typeof beforeFromMe === 'boolean'
      ? { id: beforeId, fromMe: beforeFromMe, remoteJid: jid }
      : undefined

  let rawMsgs: any[] = []
  try {
    rawMsgs = await (s.sock as any).loadMessages(jid, limit, cursor)
  } catch (e: any) {
    return reply.code(500).send({
      error: 'loadMessages failed',
      detail: String(e),
    })
  }

  const messages = rawMsgs.map(simplifyBaileysMessage)

  const last = messages[messages.length - 1]
  const nextCursor = last
    ? { beforeId: last.messageId, beforeFromMe: last.fromMe }
    : null

  return reply.send({
    ok: true,
    messages,
    nextCursor,
  })
})

// ENVOI d'un message "classique" (notre ancienne route interne)
// Body: { sessionId, to (numero sans @), text }
app.post('/messages', async (req, reply) => {
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const { sessionId, to, text } = (req.body as any) || {}
  const s = await ensureSessionLoaded(sessionId).catch(() => null)
  if (!s?.sock) {
    return reply.code(400).send({ error: 'session not ready' })
  }

  const cleanTo = String(to || '').replace(/[^\d]/g, '')
  const jid = `${cleanTo}@s.whatsapp.net`
  const messageText = String(text || '')

  await s.sock.sendMessage(jid, { text: messageText })

  // recentChats bump
  const nowMs = Date.now()
  touchRecentChat(s, jid, nowMs, null)

  // webhook "message.out"
  await sendWebhookEvent(s, 'message.out', {
    data: {
      from: jid,
      fromJid: jid,
      fromMe: true,
      text: messageText,
      media: null,
      sessionPhone: s.phoneNumber || null,
      timestampMs: nowMs,
    },
    ts: nowMs,
  })

  return reply.send({ ok: true })
})

// ENVOI d'un message façon Lovable (`wa-send-message`)
// POST /sessions/:id/send
// Body attendu: { jid: "4176...@s.whatsapp.net", message: "Hello" }
app.post('/sessions/:id/send', async (req, reply) => {
  const id = (req.params as any).id

  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const { jid, message } = (req.body as any) || {}
  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s?.sock) {
    return reply.code(400).send({ error: 'session not ready' })
  }

  const finalJid = String(jid || '')
  const finalText = String(message || '')

  await s.sock.sendMessage(finalJid, { text: finalText })

  // mettre à jour recentChats
  const nowMs = Date.now()
  touchRecentChat(s, finalJid, nowMs, null)

  // webhook "message.out"
  await sendWebhookEvent(s, 'message.out', {
    data: {
      from: finalJid,
      fromJid: finalJid,
      fromMe: true,
      text: finalText,
      media: null,
      sessionPhone: s.phoneNumber || null,
      timestampMs: nowMs,
    },
    ts: nowMs,
  })

  return reply.send({ ok: true })
})

// healthcheck
app.get('/health', async (_req, reply) => {
  reply.send({ ok: true })
})

// Lancer HTTP
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
