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
// Sur Render, pointe vers le disque monté (ex: /var/data/wa-auth)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

type SessionState = {
  id: string
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // QR brut (fallback)
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
      async function createSession(){
        const r = await fetch('/sessions', {method:'POST'})
        const j = await r.json()
        const out = document.getElementById('out')
        out.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p><img id="qr" style="width:300px">'
        const img = document.getElementById('qr')
        const interval = setInterval(async ()=>{
          const r2 = await fetch('/sessions/'+j.session_id)
          const s = await r2.json()
          if(s.qr){ img.src = s.qr }
          else if (s.qr_text) {
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(s.qr_text)
          }
          if(s.connected){ clearInterval(interval); img.remove(); out.innerHTML += '<p>✅ Connecté</p>' }
        }, 1500)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})

/** ------------- helpers ------------- */

function isRestartRequired(err: any) {
  // Baileys signale "restart required" avec le code 515
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
  return code === 515 || code === DisconnectReason.restartRequired
}

async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({ wa_update: { conn: u.connection, hasQR: !!u.qr, disc: !!u.lastDisconnect } })

  if (u.qr) {
    s.qr_text = u.qr
    try { s.qr = await QRCode.toDataURL(u.qr) }
    catch (e) { s.qr = null; app.log.warn({ msg: 'qr toDataURL failed', err: String(e) }) }
  }

  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null
    return
  }

  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // (A) 515 => redémarrage complet de la session (recréation du socket)
    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515) — restarting socket', id: s.id })
      await restartSession(s.id)
      return
    }

    // (B) Déconnexion définitive (logged out) => il faudra rescanner
    const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app.log.warn({ msg: 'logged out — rescan required', id: s.id })
      return
    }

    // (C) Autres cas : Baileys tentera de se reconnecter tout seul
    s.connected = false
  }
}

/** ------------- lifecycle ------------- */

async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session (515)', id })

  // Nettoyage "soft" de l'ancien socket
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  // Recréer le socket sur le même répertoire d’auth
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

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
}

async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  const s: SessionState = { id, qr: null, qr_text: null, connected: false, saveCreds }
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
  // 🔧 NOUVEAU: un seul handler centralisé
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))

  return s
}

/** ------------- API ------------- */

app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)
  await new Promise(res => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})

app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  return reply.send({ session_id: id, connected: s.connected, qr: s.qr || null, qr_text: s.qr_text || null })
})

// Optionnel: forcer un redémarrage manuel si besoin
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  await restartSession(id)
  return reply.send({ ok: true })
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

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
