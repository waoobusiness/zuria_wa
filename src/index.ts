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
// Chemin où sont stockées les cred Baileys (monte un Disk Render ici)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

type SessionState = {
  id: string
  status: 'connecting' | 'open' | 'close' | 'unknown'
  connected: boolean
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // QR brut si besoin
  pairingCode?: string | null // dernier code de jumelage généré
  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>
}

const sessions = new Map<string, SessionState>()

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 32px auto;">
    <h2>Zuria WhatsApp Gateway</h2>
    <button onclick="createSession()">Créer une session</button>
    <div id="out" style="margin-top:16px"></div>
    <script>
      async function createSession(){
        const r = await fetch('/sessions', {method:'POST'})
        const j = await r.json()
        const out = document.getElementById('out')
        out.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p><img id="qr" style="width:300px;display:block;margin:12px 0"><div id="pc"></div><small id="st"></small>'
        const img = document.getElementById('qr')
        const pc = document.getElementById('pc')
        const st = document.getElementById('st')

        // Exemple: demander un pairing code (remplace le numéro)
        // fetch('/sessions/'+j.session_id+'/pairing-code?phone=41766085008')

        const interval = setInterval(async ()=>{
          const r2 = await fetch('/sessions/'+j.session_id)
          const s = await r2.json()
          st.textContent = 'status=' + s.status + ', connected=' + s.connected

          if(s.qr){ img.src = s.qr; img.style.display='block' }
          else if (s.qr_text) {
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(s.qr_text)
            img.style.display='block'
          } else {
            img.style.display='none'
          }

          if (s.pairingCode) {
            pc.innerHTML = '<p style="font-size:18px">Code de jumelage : <b>'+s.pairingCode+'</b></p>'
          }

          if(s.connected){ clearInterval(interval); pc.innerHTML += '<p>✅ Connecté</p>' }
        }, 1500)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  const s: SessionState = {
    id,
    status: 'connecting',
    connected: false,
    qr: null,
    qr_text: null,
    pairingCode: null,
    saveCreds
  }

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

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
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
    if (u.connection) {
      s.status = u.connection as SessionState['status']
    }
    if (u.connection === 'open') {
      s.connected = true
      s.qr = null
      s.qr_text = null
      s.pairingCode = null
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      s.connected = false
      s.qr = null
      s.qr_text = null
      if (shouldReconnect) {
        // Reconnexion auto gérée par Baileys
      } else {
        // déconnecté définitivement (logout)
      }
    }
  })

  return s
}

/** Crée une nouvelle session */
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)
  // Laisse à Baileys le temps d’émettre le 1er "connection.update"
  await new Promise(res => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})

/** Infos de session (QR/pairing/status) */
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  return reply.send({
    session_id: id,
    status: s.status,
    connected: s.connected,
    qr: s.qr || null,
    qr_text: s.qr_text || null,
    pairingCode: s.pairingCode || null
  })
})

/** Génère un code de jumelage (pairing code) */
app.post('/sessions/:id/pairing-code', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(404).send({ error: 'unknown session' })
  const body = (req.body as any) || {}
  const phone = String(body.phone || '').replace(/[^\d]/g, '')
  if (!phone) return reply.code(400).send({ error: 'missing phone' })
  const code = await s.sock.requestPairingCode(phone) // v7 API
  s.pairingCode = code
  return reply.send({ session_id: id, code })
})

/** Variante GET pratique: /sessions/:id/pairing-code?phone=41766085008 */
app.get('/sessions/:id/pairing-code', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s?.sock) return reply.code(404).send({ error: 'unknown session' })
  const phone = String((req.query as any).phone || '').replace(/[^\d]/g, '')
  if (!phone) return reply.code(400).send({ error: 'missing phone' })
  const code = await s.sock.requestPairingCode(phone) // v7 API
  s.pairingCode = code
  return reply.send({ session_id: id, code })
})

/** Envoi d’un message texte */
app.post('/messages', async (req, reply) => {
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const digits = String(to || '').replace(/[^\d]/g, '')
  if (!digits) return reply.code(400).send({ error: 'invalid "to"' })

  // v7 : on essaie de résoudre un JID valide (LID si dispo), sinon fallback user JID
  let jid = `${digits}@s.whatsapp.net`
  try {
    // onWhatsApp retourne le JID correct (souvent LID) si le numéro existe
    const res = await s.sock.onWhatsApp(digits)
    if (Array.isArray(res) && res[0]?.jid) jid = res[0].jid
  } catch {}

  await s.sock.sendMessage(jid, { text: String(text || '') })
  return reply.send({ ok: true })
})

/** Healthcheck */
app.get('/health', async (_req, reply) => reply.send({ ok: true }))

await app.listen({ port: PORT, host: '0.0.0.0' })
