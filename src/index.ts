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
  // Messages entrants
sock.ev.on('messages.upsert', async (m) => {
  const msg = m.messages?.[0]
  if (!msg || !msg.key?.remoteJid) return

  // Texte du message (simples cas)
  const text =
      msg.message?.conversation
   || msg.message?.extendedTextMessage?.text
   || msg.message?.imageMessage?.caption
   || ''

  app.log.info({ inbound: { from: msg.key.remoteJid, text } })

  // (optionnel) auto-réponse de test
  // await sock.sendMessage(msg.key.remoteJid, { text: '✅ Reçu !' })
})

  const API_KEY = process.env.API_KEY || ''

app.post('/messages', async (req, reply) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })
  const jid = `${String(to).replace(/[^\d]/g,'')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text })
  reply.send({ ok: true })
})

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

app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  reply.send({ session_id: id, connected: s.connected, hasSock: !!s.sock })
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

// --- Mini console d’envoi de message ---
app.get('/send', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Envoyer un message</title></head>
  <body style="font-family: system-ui; max-width: 700px; margin: 40px auto;">
    <h2>Envoyer un message WhatsApp</h2>

    <label>ID de session<br/>
      <input id="sid" style="width:100%" value="9b115dd2-28e1-49d5-ba30-5176a9ea5408"/>
    </label>
    <div style="margin:8px 0">
      <button id="check">Vérifier statut</button>
      <button id="restart">Relancer</button>
    </div>

    <label>Numéro (ex: 41766085008)<br/>
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
        const sid = document.getElementById('sid').value.trim()
        const r = await fetch('/sessions/' + sid)
        const j = await r.json()
        out.textContent = JSON.stringify(j, null, 2)
      }

      document.getElementById('restart').onclick = async () => {
        const sid = document.getElementById('sid').value.trim()
        const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' })
        const j = await r.json()
        out.textContent = JSON.stringify(j, null, 2)
      }

      document.getElementById('btn').onclick = async () => {
        const sessionId = document.getElementById('sid').value.trim()
        const to = document.getElementById('to').value.trim()
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
  </body></html>`
  reply.type('text/html').send(html)
})

// --- fin mini console ---


app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
