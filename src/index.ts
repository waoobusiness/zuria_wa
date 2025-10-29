// src/index.ts

// -------------------------
// IMPORTS
// -------------------------
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'
import crypto from 'crypto'
import pino from 'pino'
import NodeCache from 'node-cache'

import makeWASocket, {
  useMultiFileAuthState,              // ⚠️ MVP. Prévoir store DB/Redis en prod.
  DisconnectReason,
  downloadContentFromMessage,
  Browsers,
  proto,
  WAMessageKey
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'

// -------------------------
// CONFIG
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

const WEBHOOK_SECRET_FALLBACK = process.env.WEBHOOK_SECRET || ''
const SUPABASE_WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || ''   // Edge Function cible
const API_KEY = process.env.API_KEY || ''

const MARK_ONLINE = (process.env.WA_MARK_ONLINE || 'false').toLowerCase() === 'true'
const FULL_HISTORY = (process.env.WA_FULL_HISTORY || 'true').toLowerCase() !== 'false'

// Anti-ban pacing
const SEND_MIN_INTERVAL_MS = Math.max(0, parseInt(process.env.SEND_MIN_INTERVAL_MS || '1500', 10))
const SEND_MAX_PER_MINUTE = Math.max(1, parseInt(process.env.SEND_MAX_PER_MINUTE || '20', 10))
const SEND_JITTER_MS = Math.max(0, parseInt(process.env.SEND_JITTER_MS || '400', 10))

// -------------------------
// TYPES & MEMORY
// -------------------------
type ChatLite = {
  id: string
  name?: string | null
  subject?: string | null
  conversationTimestamp?: number | null // seconds since epoch (Baileys)
}

type SessionState = {
  id: string

  // QR for UI
  qr?: string | null
  qr_text?: string | null

  // connection
  connected: boolean

  // Baileys socket
  sock?: ReturnType<typeof makeWASocket>

  // creds persist
  saveCreds?: () => Promise<void>

  // per-session webhook (unique)
  webhookUrl?: string
  webhookSecret?: string

  // account info
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null

  // minimal in-memory stores
  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
  messageStore: Map<string, proto.IMessage | undefined>
  groupCache: NodeCache

  // pacing / queue
  queue: Array<() => Promise<void>>
  sending: boolean
  lastMinuteWindowStart: number
  sentInCurrentMinute: number
}

const sessions = new Map<string, SessionState>()

// -------------------------
// FASTIFY INSTANCE
// -------------------------
const app = Fastify({ logger: true })

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

app.addHook('onRequest', (req, _reply, done) => {
  if (req.url.startsWith('/api/')) {
    // @ts-ignore
    req.url = req.url.slice(4)
  }
  done()
})

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

  if (msg.message?.imageMessage) { mediaType = 'image'; mediaObj = msg.message.imageMessage }
  else if (msg.message?.videoMessage) { mediaType = 'video'; mediaObj = msg.message.videoMessage }
  else if (msg.message?.audioMessage) { mediaType = 'audio'; mediaObj = msg.message.audioMessage }
  else if (msg.message?.documentMessage) { mediaType = 'document'; mediaObj = msg.message.documentMessage }
  else if (msg.message?.stickerMessage) { mediaType = 'sticker'; mediaObj = msg.message.stickerMessage }

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

function mkMsgKey(key?: WAMessageKey): string | null {
  if (!key?.id || !key.remoteJid) return null
  return `${key.id}|${key.remoteJid}`
}

// HMAC SHA-256 (secret + body)
function hmacSha256Hex(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// sendWebhookEvent (PATCHÉ)
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  if (!s.webhookUrl) {
    app.log.warn({ msg: 'no webhookUrl for session, drop event', sessionId: s.id, event })
    return
  }

  // special case: le tout premier event "session.created"
  // On signe avec le secret global fallback (WEBHOOK_SECRET_FALLBACK),
  // et on envoie aussi le vrai secret de session dans le body pour que Supabase l'enregistre.
  const isBootstrap = event === 'session.created'

  const secretToUse = isBootstrap
    ? (WEBHOOK_SECRET_FALLBACK || s.webhookSecret || '')
    : (s.webhookSecret || WEBHOOK_SECRET_FALLBACK || '')

  const body = {
    sessionId: s.id,
    event,
    ...(isBootstrap ? { sessionSecret: s.webhookSecret } : {}),
    ...payload
  }

  const json = JSON.stringify(body)
  const sig = hmacSha256Hex(secretToUse, json)

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': sig,
        'x-wa-sig-version': isBootstrap ? 'bootstrap-v1' : 'session-v1'
      },
      body: json
    })
    app.log.info({ webhookPush: { sessionId: s.id, event, status: res.status } })
  } catch (e) {
    app.log.error({ msg: 'webhook push failed', sessionId: s.id, event, err: String(e) })
  }
}
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

async function enqueueSend(s: SessionState, task: () => Promise<void>) {
  s.queue.push(task)
  if (!s.sending) {
    s.sending = true
    while (s.queue.length) {
      // rate limit par minute
      const now = Date.now()
      if (now - s.lastMinuteWindowStart >= 60_000) {
        s.lastMinuteWindowStart = now
        s.sentInCurrentMinute = 0
      }
      if (s.sentInCurrentMinute >= SEND_MAX_PER_MINUTE) {
        await new Promise(r => setTimeout(r, 1000))
        continue
      }

      // délai mini + jitter
      const jitter = Math.floor(Math.random() * (SEND_JITTER_MS + 1))
      await new Promise(r => setTimeout(r, SEND_MIN_INTERVAL_MS + jitter))

      const fn = s.queue.shift()!
      try {
        await fn()
        s.sentInCurrentMinute++
      } catch (e) {
        app.log.error({ msg: 'send task failed', err: String(e) })
      }
    }
    s.sending = false
  }
}

// -------------------------
// BAILEYS HANDLERS
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
        conversationTimestamp: (typeof c.conversationTimestamp === 'number'
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

  ;(sock.ev as any).on('messaging-history.set', ({ chats, contacts, messages, syncType }: any) => {
    if (Array.isArray(chats)) setChats(chats)
    if (Array.isArray(contacts)) {
      for (const c of contacts) {
        const jid = c.id
        s.contacts.set(jid, { notify: c.notify, name: c.name })
      }
    }
    if (Array.isArray(messages)) {
      for (const m of messages) {
        const k = mkMsgKey(m.key)
        if (k) {
          s.messageStore.set(k, m.message)
        }
      }
    }
    app.log.info({
      msg: 'history.sync',
      id: s.id,
      syncType,
      chats: chats?.length,
      contacts: contacts?.length,
      messages: messages?.length
    })
  })
}

async function onMessagesUpsert(s: SessionState, up: any) {
  const type = up?.type
  const arr = Array.isArray(up?.messages) ? up.messages : []
  if (!arr.length) return

  for (const msg of arr) {
    const remoteJid = msg.key?.remoteJid || ''
    const fromMe = msg.key?.fromMe === true
    const chatNumber = extractPhoneFromJid(remoteJid)

    const storeKey = mkMsgKey(msg.key)
    if (storeKey) {
      s.messageStore.set(storeKey, msg.message)
    }

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      ''

    const mediaInfo = await saveIncomingMedia(msg).catch(() => null) // may be null

    // update chat timestamp
    const base = s.chats.get(remoteJid) ?? ensureChat(remoteJid)
    const tsSec = Number(msg.messageTimestamp || 0)
    s.chats.set(remoteJid, { ...base, conversationTimestamp: tsSec })

    const eventName = fromMe ? 'message.out' : 'message.in'
    await sendWebhookEvent(s, eventName, {
      data: {
        from: chatNumber || remoteJid,
        fromJid: remoteJid,
        fromMe,
        text,
        media: mediaInfo || null,
        timestampMs: tsSec * 1000,
        upsertType: type
      },
      ts: Date.now()
    })
  }
}

function attachSocketHandlers(s: SessionState, sock: ReturnType<typeof makeWASocket>) {
  if (s.saveCreds) sock.ev.on('creds.update', s.saveCreds)

  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
  sock.ev.on('messages.upsert', async (m) => onMessagesUpsert(s, m))
  sock.ev.on('messages.update', async (updates: any[]) =>
    sendWebhookEvent(s, 'messages.update', { data: updates, ts: Date.now() }))
  sock.ev.on('messages.delete', async (d) =>
    sendWebhookEvent(s, 'messages.delete', { data: d, ts: Date.now() }))
  sock.ev.on('messages.reaction', async (r) =>
    sendWebhookEvent(s, 'messages.reaction', { data: r, ts: Date.now() }))
  sock.ev.on('message-receipt.update', async (r) =>
    sendWebhookEvent(s, 'message-receipt.update', { data: r, ts: Date.now() }))

  sock.ev.on('chats.upsert', async (c) =>
    sendWebhookEvent(s, 'chats.upsert', { data: c, ts: Date.now() }))
  sock.ev.on('chats.update', async (c) =>
    sendWebhookEvent(s, 'chats.update', { data: c, ts: Date.now() }))
  sock.ev.on('chats.delete', async (c) =>
    sendWebhookEvent(s, 'chats.delete', { data: c, ts: Date.now() }))

  sock.ev.on('groups.upsert', async (g) =>
    sendWebhookEvent(s, 'groups.upsert', { data: g, ts: Date.now() }))
  sock.ev.on('groups.update', async (g) =>
    sendWebhookEvent(s, 'groups.update', { data: g, ts: Date.now() }))
  sock.ev.on('group-participants.update', async (g) =>
    sendWebhookEvent(s, 'group-participants.update', { data: g, ts: Date.now() }))

  sock.ev.on('contacts.update', async (c) =>
    sendWebhookEvent(s, 'contacts.update', { data: c, ts: Date.now() }))

  wireChatContactStores(s, sock)
}

async function pushInitialHistorySeed(s: SessionState) {
  // prendre les 10 chats les plus récents
  const chats = Array.from(s.chats.values())
    .sort((a, b) => (Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0)))
    .slice(0, 10)

  const items: any[] = []
  for (const c of chats) {
    let lastText: string | null = null
    let lastTsMs: number | null = null
    try {
      const msgs = await (s.sock as any).loadMessages(c.id, 1)
      const m = msgs?.[0]
      if (m) {
        lastText =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          m.message?.documentMessage?.caption ||
          null
        lastTsMs = Number(m.messageTimestamp || 0) * 1000
      }
    } catch {}
    items.push({
      chatJid: c.id,
      chatNumber: extractPhoneFromJid(c.id),
      chatName: c.name || c.subject || null,
      lastText,
      lastTsMs
    })
  }

  await sendWebhookEvent(s, 'bootstrap.history', {
    data: { items },
    ts: Date.now()
  })
}

async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({ wa_update: { conn: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })

  if (u.qr) {
    s.qr_text = u.qr
    try { s.qr = await QRCode.toDataURL(u.qr) } catch { s.qr = null }
    // informer le backend qu'une session est “created/pending”
    await sendWebhookEvent(s, 'session.created', {
      data: { sessionId: s.id, qr: s.qr || null, qr_text: s.qr_text || null },
      ts: Date.now()
    })
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

      // webhook URL unique par session + numéro (si dispo)
      if (SUPABASE_WEBHOOK_URL) {
        s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?sessionId=${encodeURIComponent(s.id)}&phone=${encodeURIComponent(s.phoneNumber || '')}`
      }
    }

    await sendWebhookEvent(s, 'session.connected', {
      data: { meId: s.meId || null, phoneNumber: s.meNumber || null },
      ts: Date.now()
    })

    // seed initial: 10 conversations (évite l'effet vide)
    setTimeout(() => {
      pushInitialHistorySeed(s).catch(() => {})
    }, 3000)
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
        ts: Date.now()
      })
      return
    }
    s.connected = false
  }
}

// -------------------------
// SESSION LIFECYCLE
// -------------------------
async function buildSocket(s: SessionState) {
  const waLogger = pino({ level: process.env.WA_LOG_LEVEL || 'info', name: `wa:${s.id}` })

  const sock = makeWASocket({
    auth: (s as any).authState || undefined,
    logger: waLogger,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: FULL_HISTORY,
    markOnlineOnConnect: MARK_ONLINE,
    printQRInTerminal: false,

    // requis par Baileys (resend, polls)
    getMessage: async (key: WAMessageKey) => {
      const k = mkMsgKey(key)
      return k ? s.messageStore.get(k) : undefined
    },

    // cache group metadata pour limiter les fetchs
    cachedGroupMetadata: async (jid: string) => {
      // Typescript: NodeCache.get() renvoie unknown → on cast en any
      let md: any = s.groupCache.get(jid) as any
      if (!md && s.sock) {
        try {
          md = await s.sock.groupMetadata(jid)
          if (md) s.groupCache.set(jid, md, 3600)
        } catch {}
      }
      return md as any
    },

    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })

  return sock
}

async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session', id })

  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  s.saveCreds = saveCreds
  ;(s as any).authState = state

  const sock = await buildSocket(s)
  s.sock = sock
  attachSocketHandlers(s, sock)
}

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))

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
    messageStore: new Map(),
    groupCache: new NodeCache({ stdTTL: 3600 }),
    queue: [],
    sending: false,
    lastMinuteWindowStart: Date.now(),
    sentInCurrentMinute: 0
  }
  ;(s as any).authState = state

  // secret par session (HMAC privé pour signer les futurs webhooks)
  s.webhookSecret = crypto.randomBytes(32).toString('hex')

  // URL webhook de base (sans numéro tant qu'on ne connaît pas encore le phone)
  if (SUPABASE_WEBHOOK_URL) {
    s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?sessionId=${encodeURIComponent(s.id)}`
  }

  const sock = await buildSocket(s)
  s.sock = sock

  sessions.set(id, s)
  attachSocketHandlers(s, sock)

  return s
}

// -------------------------
// ROUTES HTTP DU GATEWAY
// -------------------------

// mini-dashboard debug
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

// UI test d’envoi
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

// créer une session WhatsApp
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)

  // webhook dès la création
  if (SUPABASE_WEBHOOK_URL) {
    s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?sessionId=${encodeURIComponent(s.id)}`
  }

  // informer Supabase (session.created)
  await sendWebhookEvent(s, 'session.created', {
    data: { sessionId: s.id },
    ts: Date.now()
  })

  await new Promise(res => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})

// lire état d'une session
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

// relancer la session
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  await restartSession(id)
  return reply.send({ ok: true })
})

// configurer (ou reconfigurer) le webhook manuellement
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

// envoyer un message WhatsApp (passe par file d'attente anti-ban)
app.post('/messages', async (req, reply) => {
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) return reply.code(401).send({ error: 'unauthorized' })
  }

  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`

  await new Promise<void>((res, rej) => {
    enqueueSend(s, async () => {
      const resMsg = await s.sock!.sendMessage(jid, { text: String(text || '') })

      const k = mkMsgKey(resMsg?.key)
      if (k) {
        const safeMessage = (resMsg as any)?.message ?? undefined
        s.messageStore.set(k, safeMessage)
      }

      await sendWebhookEvent(s, 'message.out', {
        data: { to: jid, text: String(text || ''), key: resMsg?.key },
        ts: Date.now()
      })
    }).then(res).catch(rej)
  })

  return reply.send({ ok: true })
})

// lister les chats récents
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

// lister les messages d'un chat
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

    const k = mkMsgKey(m.key)
    if (k) {
      s.messageStore.set(k, m.message)
    }

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
  const nextCursor = last ? { beforeId: last.messageId, beforeFromMe: last.fromMe } : null

  return reply.send({ ok: true, messages, nextCursor })
})

// logout + purge
app.post('/sessions/:id/logout', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  try { if (s.sock) await s.sock.logout() } catch (e: any) {
    app.log.warn({ msg: 'logout() threw', id, err: String(e) })
  }

  await sendWebhookEvent(s, 'session.disconnected', {
    data: { reason: 'manual_logout' },
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

// health
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
