// src/index.ts
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

const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

const WEBHOOK_SECRET_GLOBAL = process.env.WEBHOOK_SECRET || ''
const SUPABASE_WEBHOOK_URL = (process.env.SUPABASE_WEBHOOK_URL || '').replace(/\/$/, '')

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
  sessionSecret?: string
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null
  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
}

const sessions = new Map<string, SessionState>()
const app = Fastify({ logger: true })

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    if (!body || (typeof body === 'string' && body.trim() === '')) return done(null, {})
    done(null, typeof body === 'string' ? JSON.parse(body) : body)
  } catch (e) { done(e as any, undefined) }
})
app.addHook('onRequest', (req, _reply, done) => {
  if ((req.url as string).startsWith('/api/')) { // support /api/*
    // @ts-ignore
    req.url = req.url.slice(4)
  }
  done()
})
fs.mkdirSync(MEDIA_DIR, { recursive: true })

function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  const m = jid.match(/^(\d{5,20})/)
  return m ? m[1] : null
}
function guessExt(mime?: string) {
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
async function saveIncomingMedia(msg: any) {
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
  for await (const c of stream) chunks.push(c as Buffer)
  const buf = Buffer.concat(chunks)

  const mime = mediaObj.mimetype || 'application/octet-stream'
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${guessExt(mime)}`
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buf)
  return { filename, mimeType: mime, url: `${PUBLIC_BASE_URL}/media/${filename}` }
}
function isRestartRequired(err: any) {
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0)
  return code === 515 || code === DisconnectReason.restartRequired
}
function hmacHex(secret: string, bodyObj: Record<string, any>) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(bodyObj)).digest('hex')
}
async function sendWebhookEvent(s: SessionState, event: string, payload: Record<string, any>) {
  const url = s.webhookUrl || (SUPABASE_WEBHOOK_URL ? `${SUPABASE_WEBHOOK_URL}?session_id=${s.id}` : '')
  if (!url) { app.log.warn({ msg: 'no webhook url', sessionId: s.id, event }); return }
  const body = { session_id: s.id, event, data: payload }
  const secret = event === 'session.created' ? WEBHOOK_SECRET_GLOBAL : (s.sessionSecret || '')
  const signature = secret ? hmacHex(secret, body) : ''
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wa-signature': signature, 'x-wa-sig-version': '1' },
    body: JSON.stringify(body)
  }).catch((e) => { app.log.error({ msg: 'webhook push failed', e: String(e), event, url }); return null })
  app.log.info({ class: 'webhookPush', sessionId: s.id, event, status: res?.status ?? 'no-resp' })
}

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
          ? c.conversationTimestamp : Number(c.conversationTimestamp || 0)) || base.conversationTimestamp || 0
      })
    }
  }
  ;(sock.ev as any).on('chats.set', (d: any) => setChats(d?.chats || []))
  ;(sock.ev as any).on('chats.upsert', (a: any[]) => setChats(a))
  ;(sock.ev as any).on('chats.update', (ups: any[]) => {
    for (const u of ups || []) {
      const base = s.chats.get(u.id) ?? ensureChat(u.id)
      s.chats.set(u.id, {
        ...base,
        ...(u.name !== undefined ? { name: u.name } : {}),
        ...(u.subject !== undefined ? { subject: u.subject } : {}),
        ...(u.conversationTimestamp !== undefined
          ? { conversationTimestamp: Number(u.conversationTimestamp || 0) } : {})
      })
    }
  })
  ;(sock.ev as any).on('contacts.upsert', (arr: any[]) => {
    for (const c of arr || []) {
      s.contacts.set(c.id, { notify: c.notify, name: c.name })
      const chat = s.chats.get(c.id)
      if (chat && !chat.name && (c.notify || c.name)) s.chats.set(c.id, { ...chat, name: c.notify || c.name })
    }
  })
}

async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({ wa_update: { connection: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })
  if (u.qr) { s.qr_text = u.qr; try { s.qr = await QRCode.toDataURL(u.qr) } catch { s.qr = null } }
  if (u.connection === 'open') {
    s.connected = true; s.qr = null; s.qr_text = null
    const me = (s.sock as any)?.user || u.me // plusieurs sources possibles
    if (me?.id) {
      s.meId = me.id
      s.meNumber = extractPhoneFromJid(me.id)
      s.phoneNumber = s.meNumber || null
    }
    await sendWebhookEvent(s, 'session.connected', { jid: s.meId || null, phone_number: s.meNumber || null, ts: Date.now() })
    return
  }
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error
    if (isRestartRequired(err)) { app.log.warn({ msg: 'restart required (515)', id: s.id }); await restartSession(s.id); return }
    const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code ?? err?.statusCode ?? 0)
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      await sendWebhookEvent(s, 'session.disconnected', { reason: 'loggedOut', ts: Date.now() })
      return
    }
    s.connected = false
  }
}

async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]; if (!msg || !msg.key) return
  const remoteJid = msg.key.remoteJid || ''; const fromMe = msg.key.fromMe === true
  const chatNumber = extractPhoneFromJid(remoteJid)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption || ''
  const mediaInfo = await saveIncomingMedia(msg)
  const base = s.chats.get(remoteJid) ?? ensureChat(remoteJid)
  const tsSec = Number(msg.messageTimestamp || 0)
  s.chats.set(remoteJid, { ...base, conversationTimestamp: tsSec })

  const event = fromMe ? 'message.out' : 'message.in'
  await sendWebhookEvent(s, event, {
    from: chatNumber || remoteJid,
    fromJid: remoteJid,
    fromMe,
    text,
    media: mediaInfo || null,
    timestampMs: tsSec * 1000
  })
}

function attachSocketHandlers(s: SessionState, sock: ReturnType<typeof makeWASocket>) {
  if (s.saveCreds) sock.ev.on('creds.update', s.saveCreds)
  sock.ev.on('connection.update', (u) => onConnectionUpdate(s, u))
  sock.ev.on('messages.upsert', (m) => onMessagesUpsert(s, m))
  wireChatContactStores(s, sock)
}

async function restartSession(id: string) {
  const s = sessions.get(id); if (!s) return
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined; s.connected = false; s.qr = null; s.qr_text = null
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()
  s.saveCreds = saveCreds
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ['Zuria','Chrome','120.0.0.0'], connectTimeoutMs: 60_000, defaultQueryTimeoutMs: 60_000 })
  s.sock = sock
  attachSocketHandlers(s, sock)
}

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()
  const sessionSecret = crypto.randomBytes(32).toString('hex')
  const s: SessionState = {
    id, qr: null, qr_text: null, connected: false,
    saveCreds, phoneNumber: null, meId: null, meNumber: null,
    chats: new Map(), contacts: new Map(),
    sessionSecret,
    webhookUrl: SUPABASE_WEBHOOK_URL ? `${SUPABASE_WEBHOOK_URL}?session_id=${id}` : undefined
  }
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ['Zuria','Chrome','120.0.0.0'], connectTimeoutMs: 60_000, defaultQueryTimeoutMs: 60_000 })
  s.sock = sock
  sessions.set(id, s)
  attachSocketHandlers(s, sock)
  await sendWebhookEvent(s, 'session.created', { sessionSecret, phone: null })
  return s
}

// -------- HTTP ROUTES (debug/ops) --------
app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width:720px; margin:40px auto;">
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
        stat.textContent = s.connected ? ('✅ Connecté ('+(s.phoneNumber||'???')+')') : '⏳ En attente...'
        if(s.connected){ clearInterval(interval); img.remove() }
      }, 1500)
    }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})
app.get('/send', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Envoyer</title></head>
  <body style="font-family: system-ui; max-width:700px; margin:40px auto;">
    <h2>Envoyer un message WhatsApp</h2>
    <label>ID session<br/><input id="sid" style="width:100%"/></label>
    <div style="margin:8px 0">
      <button id="check">Vérifier statut</button>
      <button id="restart">Relancer</button>
      <button id="logout">Logout</button>
      <button id="seed">Forcer session.created</button>
    </div>
    <label>Numéro<br/><input id="to" style="width:100%" placeholder="41760000000"/></label>
    <label>Message<br/><textarea id="text" style="width:100%; height:120px">Hello depuis Zuria 🚀</textarea></label>
    <button id="btn">Envoyer</button>
    <pre id="out" style="background:#111;color:#0f0;padding:12px;margin-top:16px;white-space:pre-wrap;"></pre>
    <script>
      const out = document.getElementById('out')
      document.getElementById('check').onclick = async () => {
        const sid = (document.getElementById('sid').value || '').trim()
        const r = await fetch('/sessions/' + sid); out.textContent = JSON.stringify(await r.json(), null, 2)
      }
      document.getElementById('restart').onclick = async () => {
        const sid = (document.getElementById('sid').value || '').trim()
        const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' }); out.textContent = JSON.stringify(await r.json(), null, 2)
      }
      document.getElementById('logout').onclick = async () => {
        const sid = (document.getElementById('sid').value || '').trim()
        const r = await fetch('/sessions/' + sid + '/logout', { method: 'POST' }); out.textContent = JSON.stringify(await r.json(), null, 2)
      }
      document.getElementById('seed').onclick = async () => {
        const sid = (document.getElementById('sid').value || '').trim()
        const r = await fetch('/sessions/' + sid + '/seed-created', { method: 'POST' }); out.textContent = JSON.stringify(await r.json(), null, 2)
      }
      document.getElementById('btn').onclick = async () => {
        const sessionId = (document.getElementById('sid').value || '').trim()
        const to = (document.getElementById('to').value || '').trim()
        const text = document.getElementById('text').value
        out.textContent = 'Envoi en cours...'
        try {
          const r = await fetch('/messages', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sessionId, to, text }) })
          out.textContent = JSON.stringify(await r.json(), null, 2)
        } catch (e) { out.textContent = 'Erreur: ' + e }
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  const s = await startSession(id)
  await new Promise(res => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id; const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  return reply.send({
    session_id: id, connected: s.connected, qr: s.qr || null, qr_text: s.qr_text || null,
    phoneNumber: s.phoneNumber || null, meNumber: s.meNumber || null, meId: s.meId || null, hasSock: !!s.sock
  })
})
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id; const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  await restartSession(id); return reply.send({ ok: true })
})
app.post('/sessions/:id/seed-created', async (req, reply) => {
  const id = (req.params as any).id; const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  if (!s.sessionSecret) s.sessionSecret = crypto.randomBytes(32).toString('hex')
  if (!s.webhookUrl && SUPABASE_WEBHOOK_URL) s.webhookUrl = `${SUPABASE_WEBHOOK_URL}?session_id=${id}`
  await sendWebhookEvent(s, 'session.created', { sessionSecret: s.sessionSecret, phone: s.meNumber || null })
  return reply.send({ ok: true })
})
app.post('/messages', async (req, reply) => {
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId); if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text: String(text || '') })
  await sendWebhookEvent(s, 'message.out', { to: jid, text: String(text || ''), ts: Date.now() })
  return reply.send({ ok: true })
})
app.get('/sessions/:id/chats', async (req, reply) => {
  const id = (req.params as any).id; const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const q = (req.query as any) || {}; const limit = Math.min(Number(q.limit || 20), 50); const beforeTs = Number(q.beforeTs || 0)
  const raw = Array.from(s.chats.values())
  const sorted = raw.sort((a,b)=>Number(b.conversationTimestamp||0)-Number(a.conversationTimestamp||0))
  const filtered = beforeTs>0 ? sorted.filter(c => Number(c.conversationTimestamp||0)*1000 < beforeTs) : sorted
  const page = filtered.slice(0, limit)
  const chats = page.map(c => ({ chatJid: c.id, chatNumber: extractPhoneFromJid(c.id), chatName: c.name || c.subject || null, lastTsMs: Number(c.conversationTimestamp||0)*1000 }))
  const nextBeforeTs = page.length>0 ? Number(page[page.length-1].conversationTimestamp||0)*1000 : null
  return reply.send({ ok:true, chats, nextBeforeTs })
})
app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
  const { id, jid } = (req.params as any); const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const q = (req.query as any) || {}; const limit = Math.min(Number(q.limit || 20), 50)
  const beforeId = q.beforeId ? String(q.beforeId) : undefined
  let beforeFromMe: boolean | undefined = undefined
  if (q.beforeFromMe === 'true' || q.beforeFromMe === true) beforeFromMe = true
  else if (q.beforeFromMe === 'false' || q.beforeFromMe === false) beforeFromMe = false
  const cursor = (beforeId && typeof beforeFromMe === 'boolean') ? { id: beforeId, fromMe: beforeFromMe, remoteJid: jid } : undefined
  let raw: any[] = []
  try { raw = await (s.sock as any).loadMessages(jid, limit, cursor) } catch (e:any) {
    return reply.code(500).send({ error: 'loadMessages failed', detail: String(e) })
  }
  const messages = raw.map(m => {
    const fromMe = m.key?.fromMe === true
    const text =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      m.message?.videoMessage?.caption ||
      m.message?.documentMessage?.caption || ''
    const messageId = m.key?.id || ''
    const tsMs = Number(m.messageTimestamp || 0) * 1000
    return { messageId, fromMe, text, mediaUrl: null, mediaMime: null, timestampMs: tsMs }
  })
  const last = messages[messages.length-1]; const nextCursor = last ? { beforeId: last.messageId, beforeFromMe: last.fromMe } : null
  return reply.send({ ok:true, messages, nextCursor })
})
app.post('/sessions/:id/logout', async (req, reply) => {
  const id = (req.params as any).id; const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  try { if (s.sock) await s.sock.logout() } catch (e:any) { app.log.warn({ msg: 'logout() threw', id, err: String(e) }) }
  await sendWebhookEvent(s, 'session.disconnected', { reason: 'manual_logout', ts: Date.now() })
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined; s.connected = false
  try { fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true }) } catch {}
  sessions.delete(id); return reply.send({ ok:true, loggedOut:true })
})
app.get('/health', async (_req, reply) => reply.send({ ok: true }))

async function bootstrap() {
  await app.register(cors, { origin: true })
  await app.register(fastifyStatic, { root: MEDIA_DIR, prefix: '/media/' })
  app.listen({ port: PORT, host: '0.0.0.0' })
    .then(() => app.log.info(`HTTP server listening on ${PORT}`))
    .catch((err) => { app.log.error(err); process.exit(1) })
}
bootstrap()
