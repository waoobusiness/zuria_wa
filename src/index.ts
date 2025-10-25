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

// --------------------
// CONFIG (env Render)
// --------------------

const PORT = parseInt(process.env.PORT || '3001', 10)

// IMPORTANT : sur Render tu as AUTH_DIR=/var/data/wa
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Shared secret envoyé aux webhooks (header x-wa-signature)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Pour protéger l'endpoint /messages (appel direct depuis Zuria par ex)
const API_KEY = process.env.API_KEY || ''


// --------------------
// TYPES ET MEMOIRE
// --------------------

type SessionState = {
  id: string

  // QR code affiché côté / (page HTML) :
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // texte brut du QR
  connected: boolean

  // socket Baileys courant
  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>

  // webhook cible (URL envoyée par Zuria / Lovable)
  webhookUrl?: string

  // numéro WhatsApp lié à CETTE session (l'agent)
  phoneNumber?: string
}

// toutes les sessions vivantes en RAM
const sessions = new Map<string, SessionState>()


// --------------------
// FASTIFY SERVER
// --------------------

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })


// ---------------------------------------------------
// HELPERS
// ---------------------------------------------------

// On transforme "41766085008@s.whatsapp.net" -> "41766085008"
function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  const match = jid.match(/^(\d+)[@:]/)
  return match ? match[1] : null
}

// Envoi d'un event vers la plateforme (Zuria / Supabase / Lovable)
async function pushWebhookEvent(
  s: SessionState,
  event: string,
  data: any
) {
  if (!s.webhookUrl) {
    // pas de webhook enregistré => rien à envoyer
    return
  }

  const payload = {
    sessionId: s.id,
    event, // "message.in", "message.out", "session.connected", ...
    data,
    ts: Date.now(),
    sessionPhone: s.phoneNumber || null
  }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': WEBHOOK_SECRET || ''
      },
      body: JSON.stringify(payload)
    })

    app.log.info({
      webhook_push: {
        session: s.id,
        event,
        status: res.status
      }
    })
  } catch (err: any) {
    app.log.error({
      msg: 'webhook push failed',
      session: s.id,
      event,
      err: String(err)
    })
  }
}

// Baileys nous dit "restart required" avec le code 515
function isRestartRequired(err: any) {
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
  return code === 515 || code === DisconnectReason.restartRequired
}


// ---------------------------------------------------
// GESTION DES MISES À JOUR DE CONNEXION
// ---------------------------------------------------

async function onConnectionUpdate(s: SessionState, u: any) {
  // petit log pour Render
  app.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect
    }
  })

  // nouveau QR reçu -> on le stocke
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  // connexion OK
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // essaie de récupérer le numéro du compte WhatsApp lié
    // ex dans les logs Render on voit "me":{"id":"41766085008:29@s.whatsapp.net",...}
    const selfJid =
      (s.sock as any)?.user?.id ||
      (s.sock as any)?.user ||
      ''

    const phone = extractPhoneFromJid(
      typeof selfJid === 'string'
        ? selfJid
        : (selfJid?.toString?.() || '')
    )
    if (phone) {
      s.phoneNumber = phone
    }

    // prévenir Zuria
    await pushWebhookEvent(s, 'session.connected', {
      phoneNumber: s.phoneNumber || null,
    })

    return
  }

  // déconnexion
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // Cas A : 515 => il faut juste recréer le socket
    if (isRestartRequired(err)) {
      app.log.warn({
        msg: 'restart required (515) — restarting socket',
        id: s.id
      })
      await restartSession(s.id)
      return
    }

    // Cas B : vraiment déloggué
    const code = Number(
      err?.output?.statusCode ?? err?.status ?? err?.code
    )
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      await pushWebhookEvent(s, 'session.disconnected', {
        reason: 'logged_out'
      })
      app.log.warn({
        msg: 'logged out — rescan required',
        id: s.id
      })
      return
    }

    // Cas C : autre
    s.connected = false
    await pushWebhookEvent(s, 'session.disconnected', {
      reason: 'connection_closed',
      code
    })
  }
}


// ---------------------------------------------------
// GESTION DES MESSAGES (ENTRANTS / SORTANTS)
// ---------------------------------------------------

// Cette fonction va être branchée sur sock.ev.on('messages.upsert')
function attachMessagesHandler(s: SessionState, sock: any) {
  sock.ev.on('messages.upsert', async (m: any) => {
    // On ne gère que les nouveaux messages (notify), pas l'historique
    if (m.type !== 'notify') return

    const msg = m.messages?.[0]
    if (!msg || !msg.key?.remoteJid) return

    // --- infos conversation ---
    const chatJid = msg.key.remoteJid                       // "4176xxxxxxx@s.whatsapp.net"
    const chatNumber = extractPhoneFromJid(chatJid) || ''   // "4176xxxxxxx"

    // --- contenu du message ---
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      ''

    // --- est-ce un message envoyé PAR NOUS (depuis ce compte WhatsApp) ? ---
    const fromMe = msg.key.fromMe === true

    // log debug dans Render
    app.log.info({
      inbound: {
        sessionId: s.id,
        chatJid,
        chatNumber,
        text,
        fromMe
      }
    })

    // webhook vers Zuria / Lovable
    await pushWebhookEvent(
      s,
      fromMe ? 'message.out' : 'message.in',
      {
        chatJid,      // "4176...@s.whatsapp.net"
        chatNumber,   // "4176..."
        text,         // contenu
        fromMe        // true si c'est nous; false si c'est le client
      }
    )
  })
}


// ---------------------------------------------------
// (RE)CRÉATION D'UNE SESSION
// ---------------------------------------------------

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

  // recharge l'état d'auth depuis le disque
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(AUTH_DIR, id)
  )
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

  // brancher les listeners
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u: any) =>
    onConnectionUpdate(s, u)
  )
  attachMessagesHandler(s, sock)
}

async function startSession(id: string) {
  // s'assurer que le dossier d'auth existe
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(AUTH_DIR, id)
  )
  const { version } = await fetchLatestBaileysVersion()

  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
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

  // brancher les listeners
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u: any) =>
    onConnectionUpdate(s, u)
  )
  attachMessagesHandler(s, sock)

  return s
}


// ---------------------------------------------------
// ROUTES HTTP
// ---------------------------------------------------

// Petit dashboard minimal (scan QR etc.)
app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
    <h2>Zuria WhatsApp Gateway</h2>
    <button onclick="createSession()">Créer une session</button>
    <div style="margin-top:16px" id="out"></div>

    <script>
      async function createSession(){
        const r = await fetch('/sessions', {method:'POST'})
        const j = await r.json()
        const out = document.getElementById('out')
        out.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p><img id="qr" style="width:300px">'

        const img = document.getElementById('qr')

        // on poll l'état de la session toutes les 1.5s
        const interval = setInterval(async ()=>{
          const r2 = await fetch('/sessions/'+j.session_id)
          const s = await r2.json()

          if(s.qr){ img.src = s.qr }
          else if (s.qr_text) {
            // fallback si pas de dataURL dispo
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='
                      + encodeURIComponent(s.qr_text)
          }

          if(s.connected){
            clearInterval(interval)
            img.remove()
            out.innerHTML += '<p>✅ Connecté</p>'
            if (s.phoneNumber){
              out.innerHTML += '<p><b>Numéro WhatsApp lié :</b> '+s.phoneNumber+'</p>'
            }
            out.innerHTML += '<p>Tu peux maintenant aller sur /send pour tester l\\'envoi de message.</p>'
          }
        }, 1500)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})

// Mini console manuelle pour tester envoi de messages
app.get('/send', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Envoyer un message</title></head>
  <body style="font-family: system-ui; max-width: 700px; margin: 40px auto;">
    <h2>Envoyer un message WhatsApp</h2>

    <label>ID de session<br/>
      <input id="sid" style="width:100%"/>
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


// Crée une nouvelle session WhatsApp
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)

  // petite pause pour laisser Baileys initialiser
  await new Promise(res => setTimeout(res, 500))

  reply.send({ session_id: s?.id })
})


// Récupère l'état actuel d'une session
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }

  reply.send({
    session_id: id,
    connected: s.connected,
    qr: s.qr || null,
    qr_text: s.qr_text || null,
    hasSock: !!s.sock,
    phoneNumber: s.phoneNumber || null,
    webhookUrl: s.webhookUrl || null
  })
})


// Forcer un redémarrage manuel de la session (utilise restartSession)
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  await restartSession(id)
  reply.send({ ok: true })
})


// Enregistrer le webhook URL pour une session
// (c'est ce que la plateforme Zuria/Lovable va appeler après avoir créé la session)
app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id
  const body = (req.body as any) || {}
  const { url } = body

  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  if (!url) return reply.code(400).send({ error: 'missing url' })

  s.webhookUrl = url

  reply.send({ ok: true })
})


// Envoyer un message sortant
// Body attendu:
// {
//   "sessionId": "...",
//   "to": "4176xxxxxxx",
//   "text": "Hello depuis Zuria 👋"
// }
app.post('/messages', async (req, reply) => {
  // sécurité basique par clé
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' })
  }

  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)

  if (!s?.sock) {
    return reply.code(400).send({ error: 'session not ready' })
  }

  const cleanNumber = String(to).replace(/[^\d]/g, '')
  const jid = `${cleanNumber}@s.whatsapp.net`

  await s.sock.sendMessage(jid, { text })

  // on push aussi un event "message.out" pour cohérence UI (bulle envoyée)
  await pushWebhookEvent(s, 'message.out', {
    chatJid: jid,
    chatNumber: cleanNumber,
    text,
    fromMe: true
  })

  reply.send({ ok: true })
})


// Healthcheck Render
app.get('/health', async (_req, reply) => reply.send({ ok: true }))


// Lancer le serveur HTTP
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
