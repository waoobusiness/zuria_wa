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

// NOTE: sur certaines versions, les typings n’exposent pas makeInMemoryStore en named export.
// On passe par un import namespace pour l’attraper de façon sûre.
import * as Baileys from '@whiskeysockets/baileys'
const makeInMemoryStore: any = (Baileys as any).makeInMemoryStore

import fs from 'fs'
import path from 'path'


// -------------------------
// CONFIG (variables d'environnement Render)
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES & MÉMOIRE
// -------------------------
type SessionState = {
  id: string
  qr?: string | null
  qr_text?: string | null
  connected: boolean
  sock?: ReturnType<typeof makeWASocket>
  store?: any                 // <= pour éviter un blocage TS avec les typings Baileys
  saveCreds?: () => Promise<void>
  webhookUrl?: string
  webhookSecret?: string
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null
}

const sessions = new Map<string, SessionState>()


// -------------------------
// FASTIFY BOOT
// -------------------------
const app = Fastify({ logger: true })
await app.register(cors, { origin: true })
fs.mkdirSync(MEDIA_DIR, { recursive: true })

await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
})


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

  const publicUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${filename}`
  return { filename, mimeType, url: publicUrl }
}

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
    mediaUrl: null,
    mediaMime: null,
    timestampMs: tsMs,
  }
}

async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  if (!s.webhookUrl) {
    app.log.warn({ msg: 'no webhookUrl for session, drop event', sessionId: s.id, event })
    return
  }

  const signature = s.webhookSecret || WEBHOOK_SECRET || ''
  const body = { sessionId: s.id, event, ...payload }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wa-signature': signature },
      body: JSON.stringify(body),
    })
    app.log.info({ webhookPush: { sessionId: s.id, event, status: res.status } })
  } catch (e: any) {
    app.log.error({ msg: 'webhook push failed', sessionId: s.id, event, err: String(e) })
  }
}

function isRestartRequired(err: any) {
  const code = Number(
    err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0
  )
  return code === 515 || code === DisconnectReason.restartRequired
}


// -------------------------
// HANDLERS BAILEYS
// -------------------------
async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({ wa_update: { conn: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })

  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    if (u.me?.id) {
      s.meId = u.me.id || null
      const num = extractPhoneFromJid(s.meId || '')
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    await sendWebhookEvent(s, 'session.connected', {
      data: { meId: s.meId || null, phoneNumber: s.meNumber || null },
      ts: Date.now(),
    })
    return
  }

  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515) — restarting socket', id: s.id })
      await restartSession(s.id)
      return
    }

    const code = Number(
      err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0
    )
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app.log.warn({ msg: 'logged out — rescan required', id: s.id })

      await sendWebhookEvent(s, 'session.disconnected', {
        data: { reason: 'loggedOut' },
        ts: Date.now(),
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

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    ''

  const mediaInfo = await saveIncomingMedia(msg)

  await sendWebhookEvent(s, 'message.in', {
    data: { from: chatNumber || remoteJid, fromJid: remoteJid, fromMe, text, media: mediaInfo },
    ts: Date.now(),
  })
}

function attachSocketHandlers(s: SessionState, sock: ReturnType<typeof makeWASocket>) {
  if (s.saveCreds) sock.ev.on('creds.update', s.saveCreds)
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
  sock.ev.on('messages.upsert', async (m) => onMessagesUpsert(s, m))
}


// -------------------------
// CYCLE DE VIE D'UNE SESSION
// -------------------------
async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session (515)', id })

  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()
  s.saveCreds = saveCreds

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  })
  s.sock = sock

  const store = makeInMemoryStore({})
  store.bind(sock.ev)
  s.store = store

  attachSocketHandlers(s, sock)
}

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
    saveCreds,
    phoneNumber: null,
    meId: null,
    meNumber: null,
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  })
  s.sock = sock

  const store = makeInMemoryStore({})
  store.bind(sock.ev)
  s.store = store

  sessions.set(id, s)
  attachSocketHandlers(s, sock)
  return s
}


// -------------------------
// ROUTES HTTP
// -------------------------
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
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(s.qr_text)
          }

          stat.textContent = s.connected ? '✅ Connecté ('+(s.phoneNumber||'???')+')' : '⏳ En attente...'

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
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
        }

        document.getElementById('restart').onclick = async () => {
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' })
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
        }

        document.getElementById('logout').onclick = async () => {
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid + '/logout', { method: 'POST' })
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

app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  await startSession(id)
  await new Promise((res) => setTimeout(res, 500))
  return reply.send({ session_id: id })
})

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
    hasSock: !!s.sock,
  })
})

app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  await restartSession(id)
  return reply.send({ ok: true })
})

app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  const { url, secret } = (req.body as any) || {}
  if (!url) return reply.code(400).send({ error: 'missing url' })

  s.webhookUrl = String(url)
  if (secret) s.webhookSecret = String(secret)

  return reply.send({ ok: true, session_id: id, webhookUrl: s.webhookUrl })
})

app.post('/messages', async (req, reply) => {
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) return reply.code(401).send({ error: 'unauthorized' })
  }

  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text: String(text || '') })

  await sendWebhookEvent(s, 'message.out', {
    data: { to: jid, text: String(text || '') },
    ts: Date.now(),
  })

  return reply.send({ ok: true })
})

app.get('/sessions/:id/chats', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) return reply.code(401).send({ error: 'unauthorized' })
  }

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)
  const beforeTs = Number(q.beforeTs || 0)

  let rawChats: any[] = []
  if (s.store && (s.store as any).chats) {
    const ch: any = (s.store as any).chats
    if (typeof ch.values === 'function') rawChats = Array.from(ch.values())
    else if (ch instanceof Map) rawChats = Array.from(ch.values())
    else if (Array.isArray(ch)) rawChats = ch
  }

  const sorted = rawChats.sort((a: any, b: any) => {
    const ta = Number(a.conversationTimestamp || 0)
    const tb = Number(b.conversationTimestamp || 0)
    return tb - ta
  })

  const filtered =
    beforeTs > 0
      ? sorted.filter((c: any) => Number(c.conversationTimestamp || 0) * 1000 < beforeTs)
      : sorted

  const page = filtered.slice(0, limit)

  const chats = page.map((chat: any) => ({
    chatJid: chat.id,
    chatNumber: extractPhoneFromJid(chat.id),
    chatName: chat.name || chat.subject || null,
    lastTsMs: Number(chat.conversationTimestamp || 0) * 1000,
  }))

  const nextBeforeTs =
    page.length > 0
      ? Number(page[page.length - 1].conversationTimestamp || 0) * 1000
      : null

  return reply.send({ ok: true, chats, nextBeforeTs })
})

app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
  const { id, jid } = (req.params as any)
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) return reply.code(401).send({ error: 'unauthorized' })
  }

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)

  const beforeId = q.beforeId ? String(q.beforeId) : undefined
  let beforeFromMe: boolean | undefined = undefined
  if (q.beforeFromMe === 'true' || q.beforeFromMe === true) beforeFromMe = true
  else if (q.beforeFromMe === 'false' || q.beforeFromMe === false) beforeFromMe = false

  const cursor =
    beforeId && typeof beforeFromMe === 'boolean'
      ? { id: beforeId, fromMe: beforeFromMe, remoteJid: jid }
      : undefined

  let rawMsgs: any[] = []
  try {
    rawMsgs = await (s.sock as any).loadMessages(jid, limit, cursor)
  } catch (e: any) {
    return reply.code(500).send({ error: 'loadMessages failed', detail: String(e) })
  }

  const messages = rawMsgs.map(simplifyBaileysMessage)
  const last = messages[messages.length - 1]
  const nextCursor = last ? { beforeId: last.messageId, beforeFromMe: last.fromMe } : null

  return reply.send({ ok: true, messages, nextCursor })
})

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
    data: { reason: 'manual_logout' },
    ts: Date.now(),
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

app.get('/health', async (_req, reply) => {
  reply.send({ ok: true })
})

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
