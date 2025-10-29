// src/index.ts
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'
import crypto from 'crypto'
import pino from 'pino'
import NodeCache from 'node-cache'

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  Browsers,
  proto,
  WAMessageKey,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'

// -------------------------
// CONFIG (Render env vars)
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

const WEBHOOK_SECRET_FALLBACK = process.env.WEBHOOK_SECRET || '' // secret global partagé avec Supabase (pour session.created)
const SUPABASE_WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || ''
const API_KEY = process.env.API_KEY || ''

const MARK_ONLINE = (process.env.WA_MARK_ONLINE || 'false').toLowerCase() === 'true'
const FULL_HISTORY = (process.env.WA_FULL_HISTORY || 'true').toLowerCase() !== 'false'

const SEND_MIN_INTERVAL_MS = Math.max(0, parseInt(process.env.SEND_MIN_INTERVAL_MS || '1500', 10))
const SEND_MAX_PER_MINUTE = Math.max(1, parseInt(process.env.SEND_MAX_PER_MINUTE || '20', 10))
const SEND_JITTER_MS = Math.max(0, parseInt(process.env.SEND_JITTER_MS || '400', 10))

// -------------------------
// TYPES & STATE
// -------------------------
type ChatLite = {
  id: string
  name?: string | null
  subject?: string | null
  conversationTimestamp?: number | null
}

type SessionState = {
  id: string
  qr?: string | null
  qr_text?: string | null
  connected: boolean

  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>

  webhookUrl?: string
  webhookSecret?: string

  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null

  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
  messageStore: Map<string, proto.IMessage | undefined>
  groupCache: NodeCache

  queue: Array<() => Promise<void>>
  sending: boolean
  lastMinuteWindowStart: number
  sentInCurrentMinute: number
}

const sessions = new Map<string, SessionState>()

// -------------------------
// FASTIFY
// -------------------------
const app = Fastify({ logger: true })

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    if (!body || (typeof body === 'string' && body.trim() === '')) { done(null, {}); return }
    const json = typeof body === 'string' ? JSON.parse(body) : body
    done(null, json)
  } catch (e) { done(e as any, undefined) }
})

app.addHook('onRequest', (req, _reply, done) => {
  if (req.url.startsWith('/api/')) { // support /api/*
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
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg'
  if (mime.includes('pdf')) return 'pdf'
  return 'bin'
}

async function saveIncomingMedia(msg: any): Promise<null | { filename: string; mimeType: string; url: string }> {
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
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buf)
  const url = `${PUBLIC_BASE_URL}/media/${filename}`
  return { filename, mimeType, url }
}

function isRestartRequired(err: any) {
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0)
  return code === 515 || code === DisconnectReason.restartRequired
}

function mkMsgKey(key?: WAMessageKey): string | null {
  if (!key?.id || !key.remoteJid) return null
  return `${key.id}|${key.remoteJid}`
}

function hmacSha256Hex(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// -------------------------
// WEBHOOK (compat snake + camel)
// -------------------------
async function sendWebhookEvent(s: SessionState, event: string, payload: Record<string, any>) {
  if (!s.webhookUrl) {
    app.log.warn({ msg: 'no webhookUrl for session, drop event', sessionId: s.id, event })
    return
  }

  const isBootstrap = event === 'session.created'
  const secretToUse = isBootstrap
    ? (WEBHOOK_SECRET_FALLBACK || s.webhookSecret || '')
    : (s.webhookSecret || WEBHOOK_SECRET_FALLBACK || '')

  // compat : on envoie les 2 formes (snake/camel) + on “aplanit” certains champs utiles
  const baseBody = {
    // identifiants de session
    sessionId: s.id,
    session_id: s.id,

    // type d'event
    event,
    event_type: event,

    // secret de session envoyé UNIQUEMENT au bootstrap (les handlers côté Supabase stockent ceci)
    ...(isBootstrap ? { sessionSecret: s.webhookSecret, session_secret: s.webhookSecret } : {}),

    // miroir camel + snake pour champs standards que l’Edge Function pourrait attendre
    // (payload.data peut déjà contenir des clés — on laisse telle quelle)
    ...payload
  }

  // petit sucre: si on nous a donné un phoneNumber/jid dans payload.data, on le reflète aussi au top-level en snake_case
  const data = (payload as any)?.data || {}
  if (data) {
    if (data.phoneNumber && !('phone_number' in baseBody)) (baseBody as any).phone_number = data.phoneNumber
    if (data.meId && !('me_id' in baseBody)) (baseBody as any).me_id = data.meId
    if (data.jid && !('jid' in baseBody)) (baseBody as any).jid = data.jid
    if (data.qr && !('qr_code' in baseBody)) (baseBody as any).qr_code = data.qr
  }

  const json = JSON.stringify(baseBody)
  const sig = hmacSha256Hex(secretToUse, json)

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': sig,
        'x-wa-sig-version': isBootstrap ? 'bootstrap-v1' : 'session-v1',
        'x-wa-session': s.id
      },
      body: json
    })
    app.log.info({ webhookPush: { url: s.webhookUrl, sessionId: s.id, event, status: res.status } })
  } catch (e) {
    app.log.error({ msg: 'webhook push failed', sessionId: s.id, event, err: String(e) })
  }
}

// -------------------------
// ENVOI (anti-ban)
// -------------------------
async function enqueueSend(s: SessionState, task: () => Promise<void>) {
  s.queue.push(task)
  if (!s.sending) {
    s.sending = true
    while (s.queue.length) {
      const now = Date.now()
      if (now - s.lastMinuteWindowStart >= 60_000) {
        s.lastMinuteWindowStart = now
        s.sentInCurrentMinute = 0
      }
      if (s.sentInCurrentMinute >= SEND_MAX_PER_MINUTE) {
        await new Promise(r => setTimeout(r, 1000))
        continue
      }
      const jitter = Math.floor(Math.random() * (SEND_JITTER_MS + 1))
      await new Promise(r => setTimeout(r, SEND_MIN_INTERVAL_MS + jitter))
      const fn = s.queue.shift()!
      try { await fn(); s.sentInCurrentMinute++ } catch (e) {
        app.log.error({ msg: 'send task failed', err: String(e) })
      }
    }
    s.sending = false
  }
}

// -------------------------
// HANDLERS BAILEYS
// -------------------------
function ensureChat(id: string): ChatLite { return { id, name: null, subject: null, conversationTimestamp: null } }

function wireChatContactStores(s: SessionState, sock: ReturnType<typeof makeWASocket>) {
  const setChats = (arr: any[]) => {
    for (const c of arr || []) {
      const base = s.chats.get(c.id) ?? ensureChat(c.id)
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
  ;(sock.ev as any).on('chats.set', (d: any) => setChats(d?.chats || []))
  ;(sock.ev as any).on('chats.upsert', (arr: any[]) => setChats(arr))
  ;(sock.ev as any).on('chats.update', (updates: any[]) => {
    for (const u of updates || []) {
      const base = s.chats.get(u.id) ?? ensureChat(u.id)
      s.chats.set(u.id, {
        ...base,
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.subject !== undefined ? { subject: u.subject } : {}),
        ...(u.conversationTimestamp !== undefined ? { conversationTimestamp: Number(u.conversationTimestamp || 0) } : {})
      })
    }
  })
  ;(sock.ev as any).on('contacts.upsert', (arr: any[]) => {
    for (const c of arr || []) {
      const jid = c.id
      s.contacts.set(jid, { notify: c.notify, name: c.name })
      const chat = s.chats.get(jid)
      if (chat && !chat.name && (c.notify || c.name)) s.chats.set(jid, { ...chat, name: c.notify || c.name })
    }
  })
  ;(sock.ev as any).on('messaging-history.set', ({ chats, contacts, messages, syncType }: any) => {
    if (Array.isArray(chats)) setChats(chats)
    if (Array.isArray(contacts)) for (const c of contacts) s.contacts.set(c.id, { notify: c.notify, name: c.name })
    if (Array.isArray(messages)) for (const m of messages) { const k = mkMsgKey(m.key); if (k) s.messageStore.set(k, m.message) }
    app.log.info({ msg: 'history.sync', id: s.id, syncType, chats: chats?.length, contacts: contacts?.length, messages: messages?.length })
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
    const storeKey = mkMsgKey(msg.key); if (storeKey) s.messageStore.set(storeKey, msg.message)

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption || ''

    const mediaInfo = await saveIncomingMedia(msg).catch(() => null)

    const base = s.chats.get(remoteJid) ?? ensureChat(remoteJid)
    const tsSec = Number(msg.messageTimestamp || 0)
    s.chats.set(remoteJid, { ...base, conversationTimestamp: tsSec })

    await sendWebhookEvent(s, fromMe ? 'message.out' : 'message.in', {
      data: {
        from: chatNumber || remoteJid,
        fromJid: remoteJid,
        jid: remoteJid,
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
  wireChatContactStores(s, sock)
}

// -------------------------
// HISTORY SEED (10 convos)
// -------------------------
async function pushInitialHistorySeed(s: SessionState) {
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
          m.message?.documentMessage?.caption || null
        lastTsMs = Number(m.messageTimestamp || 0) * 1000
      }
    } catch {}
    items.push({
      chatJid: c.id,
      jid: c.id,
      chatNumber: extractPhoneFromJid(c.id),
      chatName: c.name || c.subject || null,
      lastText,
      lastTsMs
    })
  }

  await sendWebhookEvent(s, 'bootstrap.history', { data: { items }, ts: Date.now() })
}

// -------------------------
// CONNECTION UPDATE
// -------------------------
async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({ wa_update: { conn: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })

  if (u.qr) {
    s.qr_text = u.qr
    try { s.qr = await QRCode.toDataURL(u.qr) } catch { s.qr = null }

    await sendWebhookEvent(s, 'session.created', {
      data: { sessionId: s.id, qr: s.qr || null, qr_code: s.qr || null, qr_text: s.qr_text || null },
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

      // enrichit l’URL webhook avec le numéro (snake_case dans query)
      if (SUPABASE_WEBHOOK_URL) {
        s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?session_id=${encodeURIComponent(s.id)}&phone=${encodeURIComponent(s.phoneNumber || '')}`
      }
    }

    // on envoie camel + snake au top-level dans data
    await sendWebhookEvent(s, 'session.connected', {
      data: {
        meId: s.meId || null,
        me_id: s.meId || null,
        jid: s.meId || null,
        phoneNumber: s.meNumber || null,
        phone_number: s.meNumber || null,
        device_name: 'Zuria/Render'
      },
      ts: Date.now()
    })

    setTimeout(() => { pushInitialHistorySeed(s).catch(() => {}) }, 3000)
    return
  }

  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error
    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515) — restarting socket', id: s.id })
      await restartSession(s.id)
      return
    }
    const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0)
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      await sendWebhookEvent(s, 'session.disconnected', { data: { reason: 'loggedOut' }, ts: Date.now() })
      return
    }
    s.connected = false
  }
}

// -------------------------
// SOCKET LIFECYCLE
// -------------------------
async function buildSocket(s: SessionState) {
  const waLogger = pino({ level: process.env.WA_LOG_LEVEL || 'info', name: `wa:${s.id}` })
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: (s as any).authState || undefined,
    logger: waLogger,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: FULL_HISTORY,
    markOnlineOnConnect: MARK_ONLINE,
    printQRInTerminal: false,
    getMessage: async (key: WAMessageKey) => {
      const k = mkMsgKey(key); return k ? s.messageStore.get(k) : undefined
    },
    cachedGroupMetadata: async (jid: string) => {
      let md: any = s.groupCache.get(jid) as any
      if (!md && s.sock) { try { md = await s.sock.groupMetadata(jid); if (md) s.groupCache.set(jid, md, 3600) } catch {} }
      return md as any
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })
  return sock
}

async function restartSession(id: string) {
  const s = sessions.get(id); if (!s) return
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined; s.connected = false; s.qr = null; s.qr_text = null
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  s.saveCreds = saveCreds; (s as any).authState = state
  const sock = await buildSocket(s); s.sock = sock; attachSocketHandlers(s, sock)
}

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const s: SessionState = {
    id, qr: null, qr_text: null, connected: false, saveCreds,
    phoneNumber: null, meId: null, meNumber: null,
    chats: new Map(), contacts: new Map(), messageStore: new Map(),
    groupCache: new NodeCache({ stdTTL: 3600 }),
    queue: [], sending: false, lastMinuteWindowStart: Date.now(), sentInCurrentMinute: 0
  }
  ;(s as any).authState = state
  s.webhookSecret = crypto.randomBytes(32).toString('hex') // secret par session
  if (SUPABASE_WEBHOOK_URL) s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?session_id=${encodeURIComponent(s.id)}`
  const sock = await buildSocket(s); s.sock = sock
  sessions.set(id, s); attachSocketHandlers(s, sock)
  return s
}

// -------------------------
// ROUTES HTTP (UI debug)
// -------------------------
app.get('/', async (_req, reply) => {
  const html = `
  <html>
    <head><meta charset="utf-8"><title>Zuria WhatsApp Gateway</title></head>
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
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='+encodeURIComponent(s.qr_text)
          }
          stat.textContent = s.connected ? '✅ Connecté ('+(s.phoneNumber||'???')+')' : '⏳ En attente...'
          if(s.connected){ clearInterval(interval); img.remove() }
        }, 1500)
      }
      </script>
    </body>
  </html>`
  reply.type('text/html').send(html)
})

// create session
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  const s = await startSession(id)
  if (SUPABASE_WEBHOOK_URL) s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?session_id=${encodeURIComponent(s.id)}`
  await sendWebhookEvent(s, 'session.created', { data: { sessionId: s.id }, ts: Date.now() })
  await new Promise(res => setTimeout(res, 300))
  return reply.send({ session_id: s.id })
})

// session status
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

// send message
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
      const k = mkMsgKey(resMsg?.key); if (k) s.messageStore.set(k, (resMsg as any)?.message ?? undefined)
      await sendWebhookEvent(s, 'message.out', { data: { to: jid, text: String(text || ''), key: resMsg?.key }, ts: Date.now() })
    }).then(res).catch(rej)
  })
  return reply.send({ ok: true })
})

app.get('/health', async (_req, reply) => reply.send({ ok: true }))

// -------------------------
// BOOTSTRAP
// -------------------------
async function bootstrap() {
  await app.register(cors, { origin: true })
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: '/media/' })
  app.listen({ port: PORT, host: '0.0.0.0' })
    .then(() => app.log.info(`HTTP server listening on ${PORT}`))
    .catch((err) => { app.log.error(err); process.exit(1) })
}
bootstrap()
