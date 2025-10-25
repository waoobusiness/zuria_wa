import Fastify from 'fastify'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'

const PORT = parseInt(process.env.PORT || '3001', 10)
// IMPORTANT en prod: pointer vers un dossier PERSISTANT (voir étape Render plus bas)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

type SessionState = {
  id: string
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // texte QR brut (fallback)
  pairing_code?: string | null
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
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
    <h2>Zuria WhatsApp Gateway</h2>
    <button onclick="createSession()">Créer une session</button>
    <div id="out" style="margin-top:16px"></div>

    <script>
      let cur = null

      async function createSession(){
        const r = await fetch('/sessions', { method:'POST' })
        const j = await r.json()
        cur = j.session_id

        const out = document.getElementById('out')
        out.innerHTML = \`
          <p><b>Session:</b> \${cur}</p>
          <div style="display:flex; gap:24px; align-items:flex-start;">
            <div>
              <img id="qr" style="width:300px; border:1px solid #ddd; border-radius:8px" />
              <div id="qrNote" style="color:#555; font-size:13px">Scanne le QR dans WhatsApp &gt; Appareils connectés.</div>
            </div>
            <div style="flex:1">
              <h4>Ou appairage par code</h4>
              <input id="phone" placeholder="Ex: 41760000000" style="padding:8px; width:240px">
              <button onclick="getPairing()">Obtenir le code</button>
              <div id="pair" style="font-size:32px; margin-top:12px; letter-spacing:3px"></div>
              <div style="color:#555; font-size:13px">Dans WhatsApp: Appareils connectés &gt; Connecter un appareil &gt; 'Lier avec un numéro de téléphone' puis entre le code.</div>
            </div>
          </div>
          <div id="status" style="margin-top:16px"></div>
        \`

        const img = document.getElementById('qr')
        const status = document.getElementById('status')
        const pair = document.getElementById('pair')

        const t = setInterval(async ()=>{
          const s = await (await fetch('/sessions/'+cur)).json()
          if (s.qr) img.src = s.qr
          else if (s.qr_text) {
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='+encodeURIComponent(s.qr_text)
          }
          if (s.pairing_code) pair.textContent = s.pairing_code
          if (s.connected) {
            clearInterval(t)
            img.remove()
            document.getElementById('qrNote')?.remove()
            status.innerHTML = '<p style="color:green">✅ Connecté</p>'
          }
        }, 1500)
      }

      async function getPairing(){
        if(!cur) return alert('Crée la session d\'abord')
        const phone = document.getElementById('phone').value.trim()
        if(!phone) return alert('Numéro requis (format international, sans +)')
        const r = await fetch('/sessions/'+cur+'/pairing-code?phone='+encodeURIComponent(phone))
        const j = await r.json()
        if(j.error){ alert(j.error); return }
        // le polling affichera 'pairing_code' dès qu'il est généré
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  const session: SessionState = {
    id, qr: null, qr_text: null, pairing_code: null, connected: false, saveCreds
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  })

  session.sock = sock
  sessions.set(id, session)

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u) => {
    app.log.info({ wa_update: { conn: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })

    if (u.qr) {
      session.pairing_code = null
      session.qr_text = u.qr
      try {
        session.qr = await QRCode.toDataURL(u.qr)
      } catch (e) {
        session.qr = null
        app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
      }
    }

    if (u.connection === 'open') {
      session.connected = true
      session.qr = null
      session.qr_text = null
      session.pairing_code = null
    }

    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      session.connected = false
      if (shouldReconnect) {
        // Reconnexion auto gérée par Baileys
      }
    }
  })

  return session
}

app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)
  await new Promise((res) => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
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
    pairing_code: s.pairing_code || null
  })
})

app.get('/sessions/:id/pairing-code', async (req, reply) => {
  const { id } = (req.params as any)
  const phoneRaw = String((req.query as any)?.phone || '').trim()
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  if (!phoneRaw) return reply.code(400).send({ error: 'phone is required' })

  // format attendu: numéro complet en international SANS '+'
  const phone = phoneRaw.replace(/[^\d]/g, '')
  try {
    const code = await s.sock.requestPairingCode(phone)
    s.pairing_code = code
    s.qr = null
    s.qr_text = null
    return reply.send({ session_id: id, code })
  } catch (e: any) {
    app.log.error({ msg: 'pairing failed', err: String(e) })
    return reply.code(500).send({ error: 'pairing failed' })
  }
})

app.post('/messages', async (req, reply) => {
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text })
  return reply.send({ ok: true })
})

app.get('/health', async (_req, reply) => reply.send({ ok: true }))

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP listening on :${PORT}`)
})
