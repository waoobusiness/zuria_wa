import Fastify from 'fastify'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'

const PORT = parseInt(process.env.PORT || '3001', 10)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

type SessionState = {
  id: string
  qr?: string | null
  connected: boolean
  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>
}

const sessions = new Map<string, SessionState>()

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width: 700px; margin: 40px auto;">
    <h2>Zuria WhatsApp Gateway</h2>
    <button onclick="createSession()">Créer une session</button>
    <div id="out"></div>
    <script>
      async function createSession(){
        const r = await fetch('/sessions', {method:'POST'})
        const j = await r.json()
        const out = document.getElementById('out')
        out.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p><img id="qr" style="width:300px">'
        const img = document.getElementById('qr')
        const interval = setInterval(async ()=>{
          const r2 = await fetch('/sessions/'+j.session_id)
          const s = await r2.json()
          if(s.qr) img.src = s.qr
          if(s.connected){ clearInterval(interval); img.remove(); out.innerHTML += '<p>✅ Connecté</p>' }
        }, 1500)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const s: SessionState = { id, qr: null, connected: false, saveCreds }
  const sock = makeWASocket({ auth: state, printQRInTerminal: false })
  s.sock = sock
  sessions.set(id, s)

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) s.qr = await QRCode.toDataURL(u.qr)
    if (u.connection === 'open') { s.connected = true; s.qr = null }
    if (u.connection === 'close') {
      const reason = (u.lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      s.connected = false
      if (shouldReconnect) { /* auto-reconnect géré par Baileys */ }
    }
  })
  return s
}

app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  const s = await startSession(id)
  await new Promise(res => setTimeout(res, 1000))
  return reply.send({ session_id: s.id })
})

app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  return reply.send({ session_id: id, connected: s.connected, qr: s.qr || null })
})

app.post('/messages', async (req, reply) => {
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const jid = `${String(to).replace(/[^\d]/g,'')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text })
  return reply.send({ ok: true })
})

app.get('/health', async (_req, reply) => reply.send({ ok: true }))
app.listen({ port: PORT, host: '0.0.0.0' })
