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

function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  // Exemple jid: "41766085008:29@s.whatsapp.net"
  const match = jid.match(/^(\d+)[@:]/)
  return match ? match[1] : null
}


// ---------- CONFIG ----------
const PORT = parseInt(process.env.PORT || '3001', 10)
// tu peux créer un disque Render plus tard (ex: /var/data/wa-auth)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Clé API pour sécuriser l'envoi de messages sortants
// (la même sera donnée à Lovable dans WA_API_KEY)
const API_KEY = process.env.API_KEY || ''

// Secret utilisé pour signer les webhooks sortants
// (le même sera donné à Lovable dans WA_GATEWAY_SECRET)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''


// ---------- TYPES ----------
type SessionState = {
  id: string
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // texte brut (fallback si pas d'image)
  connected: boolean
  phone?: string | null            // 👈 NOUVEAU : numéro WhatsApp lié
  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>

  // nouveau : webhook par session
  webhookUrl?: string | null
  webhookSecret?: string | null
}

const sessions = new Map<string, SessionState>()

// ---------- FASTIFY ----------
const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

// petite page debug pour créer une session manuellement
app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
    <h2>Zuria WhatsApp Gateway</h2>
    <button onclick="createSession()">Créer une session</button>
    <div id="out" style="margin-top:16px"></div>

    <h3 style="margin-top:32px">Console d'envoi</h3>
    <a href="/send" target="_blank">/send</a>

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

          if(s.connected){
            clearInterval(interval);
            img.remove();
            out.innerHTML += '<p>✅ Connecté</p>'
          }
        }, 1500)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})


// ---------- OUTBOUND WEBHOOK HELPER ----------
// Envoie un événement vers le webhook de la session (si défini)
async function pushWebhookEvent(s: SessionState, eventType: string, data: any) {
  if (!s.webhookUrl) {
    app.log.warn({ msg: 'no webhookUrl for session, skipping webhook push', sessionId: s.id })
    return
  }

  const payload = {
    sessionId: s.id,
    event: eventType, // ex: "message.in", "session.connected", "session.disconnected"
    data,
    ts: Date.now()
  }

  const headers: Record<string,string> = {
    'Content-Type': 'application/json'
  }

  // on signe la requête avec le secret de la session
  if (s.webhookSecret) {
    headers['x-wa-signature'] = s.webhookSecret
  } else if (WEBHOOK_SECRET) {
    // fallback global
    headers['x-wa-signature'] = WEBHOOK_SECRET
  }

  try {
    await fetch(s.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
    app.log.info({ msg: 'webhook pushed', sessionId: s.id, event: eventType })
  } catch (err) {
    app.log.error({ msg: 'webhook push failed', sessionId: s.id, error: String(err) })
  }
}


// ---------- CONNECTION HANDLER ----------
function isRestartRequired(err: any) {
  // Baileys signale "restart required" avec le code 515
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
  return code === 515 || code === DisconnectReason.restartRequired
}

async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({
    wa_update: {
      session: s.id,
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect,
    }
  })

  // Baileys nous donne un QR de pairing
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  // connecté = téléphone lié
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // prévenir Zuria via webhook
    await pushWebhookEvent(s, 'session.connected', {
      connected: true
    })

    return
  }

  // déconnecté
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // 515 => WhatsApp demande un redémarrage (recreate socket)
    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515) — restarting socket', id: s.id })

      s.connected = false

      // prévenir Zuria
      await pushWebhookEvent(s, 'session.disconnected', {
        reason: 'restart_required'
      })

      await restartSession(s.id)
      return
    }

    // "loggedOut" => l'appareil a été déliée côté WhatsApp
    const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
    if (code === DisconnectReason.loggedOut) {
      s.connected = false

      await pushWebhookEvent(s, 'session.disconnected', {
        reason: 'logged_out'
      })

      app.log.warn({ msg: 'logged out — rescan required', id: s.id })
      return
    }

    // Autres cas : en général Baileys retente tout seul
    s.connected = false

    await pushWebhookEvent(s, 'session.disconnected', {
      reason: 'closed'
    })
  }
}


// ---------- SESSION LIFECYCLE ----------
async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session (515)', id })

  // nettoyer l'ancien socket
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
    defaultQueryTimeoutMs: 60_000
  })
  s.sock = sock

  // listeners
  sock.ev.on('creds.update', saveCreds)

  // messages entrants
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0]
    if (!msg || !msg.key?.remoteJid) return

    const remoteJid = msg.key.remoteJid
    const text =
      msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || ''

    app.log.info({ inbound: { sessionId: s.id, from: remoteJid, text } })

    // push webhook "message.in"
    await pushWebhookEvent(s, 'message.in', {
      from: remoteJid,
      text
    })
  })

  // état connexion
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
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
    phone: null,          // 👈 nouveau
    saveCreds,
    webhookUrl: null,
    webhookSecret: null,
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

  // listeners
  sock.ev.on('creds.update', saveCreds)

    // 2. Messages entrants / sortants
  sock.ev.on('messages.upsert', async (m) => {
    // m.type === 'notify' => nouveaux messages (pas l'historique complet)
    if (m.type !== 'notify') return

    const msg = m.messages?.[0]
    if (!msg || !msg.key?.remoteJid) return

    // le chat (la conversation)
    const chatJid = msg.key.remoteJid            // ex: "41766085008@s.whatsapp.net"
    const chatNumber = extractPhoneFromJid(chatJid) // ex: "41766085008" (notre helper)

    // texte du message
    const text =
      msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || ''

    // est-ce que CE message a été envoyé par NOUS (depuis ce compte WhatsApp) ?
    const fromMe = msg.key.fromMe === true

    app.log.info({
      inbound: {
        sessionId: s.id,
        chatJid,
        chatNumber,
        text,
        fromMe
      }
    })

    // 🔥 on envoie maintenant chatNumber proprement
    await sendWebhookEvent(s, {
      sessionId: s.id,
      event: fromMe ? 'message.out' : 'message.in',
      data: {
        chatJid,      // ex: "41766085008@s.whatsapp.net"
        chatNumber,   // ex: "41766085008"  <-- à utiliser pour afficher dans l'UI
        text,
        fromMe        // true si envoyé par nous, false si reçu du client
      },
      ts: Date.now()
    })
  })


  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))

  return s
}

// ---------- Logout de la session ----------
async function destroySession(id: string) {
  const s = sessions.get(id)
  if (!s) {
    return
  }

  app.log.warn({ msg: 'destroying session (logout requested)', id })

  // 1. Déconnexion côté WhatsApp
  try {
    await s.sock?.logout()
  } catch (e) {
    app.log.error({ msg: 'logout error', id, err: String(e) })
  }

  // 2. On ferme proprement le socket
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}

  // 3. On supprime les creds sur le disque
  try {
    fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true })
  } catch (e) {
    app.log.error({ msg: 'failed to remove auth dir', id, err: String(e) })
  }

  // 4. On enlève la session de la mémoire
  sessions.delete(id)
}



// ---------- API ROUTES ----------

// 1. créer une session
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)

  // petite pause pour laisser Baileys démarrer et potentiellement générer le QR
  await new Promise(res => setTimeout(res, 500))

  reply.send({ session_id: s.id })
})


// 2. récupérer l'état d'une session (pour afficher le QR, etc.)
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }
  return reply.send({
    session_id: id,
    connected: s.connected,
    qr: s.qr || null,
    qr_text: s.qr_text || null
  })
})


// 3. déclarer le webhook d'une session
//    appelé par Zuria juste après la création de session
//    body attendu: { "url": "...", "secret": "..." }
app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id
  const body = (req.body as any) || {}
  const s = sessions.get(id)

  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }

  s.webhookUrl = body.url || null
  s.webhookSecret = body.secret || null

  app.log.info({
    msg: 'webhook registered for session',
    id,
    url: s.webhookUrl ? 'set' : 'none'
  })

  reply.send({ ok: true })
})


// 4. redémarrer une session à la main (debug bouton "Restart")
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  await restartSession(id)
  return reply.send({ ok: true })
})


// 5. envoyer un message sortant WhatsApp
//    body attendu: { sessionId, to, text }
//    header optionnel: x-api-key
app.post('/messages', async (req, reply) => {
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const { sessionId, to, text } = (req.body as any) || {}

  const s = sessions.get(sessionId)
  if (!s?.sock) {
    return reply.code(400).send({ error: 'session not ready' })
  }

  const jid = `${String(to).replace(/[^\d]/g,'')}@s.whatsapp.net`

  await s.sock.sendMessage(jid, { text })
  reply.send({ ok: true })
})


// 6. mini console web manuelle d'envoi (debug humain)
app.get('/send', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Envoyer un message</title></head>
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


// 7. healthcheck Render
app.get('/health', async (_req, reply) => reply.send({ ok: true }))

// Déconnecter / supprimer complètement une session WhatsApp
app.post('/sessions/:id/logout', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }

  await destroySession(id)

  return reply.send({ ok: true, message: 'session destroyed' })
})



// ---------- START SERVER ----------
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
