import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
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

/* -------- CONFIG -------- */

const PORT = parseInt(process.env.PORT || '3001', 10)

// Dossier d'authentification (identité WhatsApp, clés, etc.)
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Dossier où on sauve les médias reçus (images, vocaux, etc.)
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// URL publique de TON service Render
// (doit finir sans slash)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com'

// Secret partagé pour sécuriser les webhooks (même secret côté Lovable)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Clé API optionnelle pour l’envoi sortant (header x-api-key)
const API_KEY = process.env.API_KEY || ''


/* -------- TYPES -------- */

type SessionState = {
  id: string
  qr?: string | null          // data:image/png;base64,...
  qr_text?: string | null     // QR brut (fallback)
  connected: boolean
  sock?: ReturnType<typeof makeWASocket>
  saveCreds?: () => Promise<void>

  webhookUrl?: string         // où on envoie les events (Lovable)
  webhookSecret?: string      // override du WEBHOOK_SECRET global si fourni
  meId?: string | null        // genre "4176xxx:29@s.whatsapp.net"
  meNumber?: string | null    // ex "4176xxx"
}

const sessions = new Map<string, SessionState>()


/* -------- FASTIFY BOOT -------- */

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

// servir les médias statiquement à /media/<fichier>
fs.mkdirSync(MEDIA_DIR, { recursive: true })
await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
})

/* -------- PAGE DE DEBUG SIMPLE -------- */

app.get('/', async (_req, reply) => {
  const html = `
  <html><head><meta charset="utf-8"><title>Zuria WA</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
    <h2>Zuria WhatsApp Gateway</h2>

    <section style="padding:12px;border:1px solid #ccc;border-radius:8px;">
      <h3>1. Créer une session</h3>
      <button onclick="createSession()">Créer une session</button>
      <div id="sessionBlock" style="margin-top:16px;font-family:monospace;"></div>
    </section>

    <section style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:24px;">
      <h3>2. Vérifier / Redémarrer une session</h3>
      <label>Session ID<br/><input id="sid" style="width:100%"/></label>
      <div style="margin:8px 0;">
        <button onclick="checkStatus()">Vérifier statut</button>
        <button onclick="restart()">Relancer session</button>
      </div>
      <pre id="statusOut" style="background:#000;color:#0f0;padding:8px;min-height:80px;white-space:pre-wrap;"></pre>
    </section>

    <section style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-top:24px;">
      <h3>3. Envoyer un message</h3>
      <label>Numéro (ex: 41766085008)<br/>
        <input id="to" style="width:100%" placeholder="chiffres uniquement"/>
      </label>
      <br/><br/>
      <label>Message<br/>
        <textarea id="text" style="width:100%;height:100px">Hello depuis Zuria 🚀</textarea>
      </label>
      <br/><br/>
      <button onclick="sendMsg()">Envoyer</button>
      <pre id="sendOut" style="background:#000;color:#0f0;padding:8px;min-height:60px;white-space:pre-wrap;"></pre>
    </section>

    <script>
      async function createSession(){
        const r = await fetch('/sessions', {method:'POST'})
        const j = await r.json()
        const block = document.getElementById('sessionBlock')
        block.innerHTML = '<p><b>Session:</b> '+j.session_id+'</p><img id="qr" style="width:300px;border:1px solid #ccc;border-radius:4px;">'
        document.getElementById('sid').value = j.session_id
        const img = document.getElementById('qr')
        const interval = setInterval(async ()=>{
          const r2 = await fetch('/sessions/'+j.session_id)
          const s = await r2.json()
          if(s.qr){ img.src = s.qr }
          else if (s.qr_text && !s.connected) {
            // fallback QR côté client si pas d'image base64
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(s.qr_text)
          }
          if(s.connected){
            clearInterval(interval);
            img.remove();
            block.innerHTML += '<p>✅ Connecté comme '+(s.me_number||'?')+'</p>'
          }
        }, 1500)
      }

      async function checkStatus(){
        const sid = document.getElementById('sid').value.trim()
        const r = await fetch('/sessions/'+sid)
        const j = await r.json()
        document.getElementById('statusOut').textContent = JSON.stringify(j,null,2)
      }

      async function restart(){
        const sid = document.getElementById('sid').value.trim()
        const r = await fetch('/sessions/'+sid+'/restart', { method: 'POST' })
        const j = await r.json()
        document.getElementById('statusOut').textContent = JSON.stringify(j,null,2)
      }

      async function sendMsg(){
        const sid = document.getElementById('sid').value.trim()
        const to = document.getElementById('to').value.trim()
        const text = document.getElementById('text').value
        const r = await fetch('/messages', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ sessionId: sid, to, text })
        })
        const j = await r.json()
        document.getElementById('sendOut').textContent = JSON.stringify(j,null,2)
      }
    </script>
  </body></html>`
  reply.type('text/html').send(html)
})


/* -------- HELPERS -------- */

// pour donner une extension de fichier correcte
function guessExt(mime: string) {
  const map: Record<string,string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  }
  return map[mime] || 'bin'
}

// sauvegarder un Buffer (image, audio, etc.) dans MEDIA_DIR
async function saveMediaFile(buf: Buffer, mimeType: string) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true })

  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)

  fs.writeFileSync(absPath, buf)

  const publicUrl = `${PUBLIC_BASE_URL}/media/${filename}`

  return {
    filename,
    mimeType,
    url: publicUrl,
  }
}

// télécharger le média depuis Baileys (imageMessage, audioMessage, etc.)
async function fetchMediaBuffer(
  baileysMsgPart: any,
  mediaType: 'image' | 'video' | 'audio' | 'document'
) {
  const stream = await downloadContentFromMessage(baileysMsgPart, mediaType)
  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }
  return buffer
}

// Baileys dit "j'ai besoin d'un restart" => code 515 ou DisconnectReason.restartRequired
function isRestartRequired(err: any) {
  const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
  return code === 515 || code === DisconnectReason.restartRequired
}

// envoi d'un event webhook vers Zuria/Lovable
async function sendWebhookEvent(s: SessionState, payload: {
  event: string
  data: any
  ts: number
}) {
  if (!s.webhookUrl) {
    // pas de webhook configuré pour cette session => on log juste
    app.log.warn({ msg: 'no webhookUrl for session, drop event', sessionId: s.id })
    return
  }

  const signature = s.webhookSecret || WEBHOOK_SECRET || ''

  const body = {
    sessionId: s.id,
    ...payload
  }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': signature
      },
      body: JSON.stringify(body)
    })
    app.log.info({
      webhookPush: {
        sessionId: s.id,
        status: res.status
      }
    })
  } catch (e: any) {
    app.log.error({
      msg: 'webhook push failed',
      sessionId: s.id,
      err: String(e)
    })
  }
}

// handler commun pour les updates de connexion WhatsApp
async function onConnectionUpdate(s: SessionState, u: any) {
  app.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect,
    }
  })

  // si Baileys nous a donné un QR => on le stocke pour l'UI
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  // si on est connecté
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // récupérer le numéro du compte (quand dispo)
    if (u.me?.id) {
      s.meId = u.me.id
      // exemple "41766085008:29@s.whatsapp.net"
      // on garde juste le numéro avant le ":" et avant "@"
      const raw = String(u.me.id)
      const numPart = raw.split('@')[0].split(':')[0]
      s.meNumber = numPart || null
    }

    // webhook "session.connected"
    await sendWebhookEvent(s, {
      event: 'session.connected',
      data: {
        meId: s.meId || null,
        phoneNumber: s.meNumber || null,
      },
      ts: Date.now()
    })

    return
  }

  // si fermeture
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // 515 => restart complet (recréer un socket)
    if (isRestartRequired(err)) {
      app.log.warn({ msg: 'restart required (515) — restarting socket', id: s.id })
      await restartSession(s.id)
      return
    }

    // loggedOut => plus connecté du tout, QR devra être rescanné
    const code = Number(err?.output?.statusCode ?? err?.status ?? err?.code)
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app.log.warn({ msg: 'logged out — rescan required', id: s.id })

      await sendWebhookEvent(s, {
        event: 'session.disconnected',
        data: { reason: 'logged_out' },
        ts: Date.now()
      })
      return
    }

    // autres cas => Baileys va essayer de se reconnecter
    s.connected = false

    await sendWebhookEvent(s, {
      event: 'session.disconnected',
      data: { reason: 'closed' },
      ts: Date.now()
    })
  }
}

/* -------- LIFECYCLE SOCKET -------- */

// recréer un socket Baileys en gardant le même dossier d'auth
async function restartSession(id: string) {
  const s = sessions.get(id)
  if (!s) return

  app.log.warn({ msg: 'restart WA session (manual/515)', id })

  // on nettoie l'ancien socket
  try { (s.sock as any)?.ev?.removeAllListeners?.() } catch {}
  try { (s.sock as any)?.ws?.close?.() } catch {}
  s.sock = undefined
  s.connected = false
  s.qr = null
  s.qr_text = null

  // on recrée
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

  // listeners de base
  sock.ev.on('creds.update', saveCreds)

  // messages entrants
  sock.ev.on('messages.upsert', async (m) => {
    await handleIncomingMessages(s, m)
  })

  // connexion / déconnexion / QR
  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))
}

// créer une nouvelle session (nouveau dossier d'auth)
async function startSession(id: string) {
  fs.mkdirSync(path.join(AUTH_DIR, id), { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(path.join(AUTH_DIR, id))
  const { version } = await fetchLatestBaileysVersion()

  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
    saveCreds,
    meId: null,
    meNumber: null
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

  sock.ev.on('messages.upsert', async (m) => {
    await handleIncomingMessages(s, m)
  })

  sock.ev.on('connection.update', async (u) => onConnectionUpdate(s, u))

  return s
}

/* -------- TRAITEMENT DES MESSAGES ENTRANTS -------- */

async function handleIncomingMessages(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key?.remoteJid) return
  if (!msg.message) return // pas de contenu utile (accusés de réception etc.)
  if (msg.key.remoteJid === 'status@broadcast') return // on ignore le statut WhatsApp

  const fromJid = msg.key.remoteJid // "4176xxxx@s.whatsapp.net" ou un groupe "...@g.us"
  const fromMe = !!msg.key.fromMe
  const phoneNumberGuess = fromJid.split('@')[0] // juste la partie avant @
  const timestamp = Number(msg.messageTimestamp || Date.now())

  const mcontent = msg.message

  // payload de base qu'on va envoyer au webhook
  const payload: any = {
    from: phoneNumberGuess,
    fromJid,
    fromMe,
    type: 'text',
    text: ''
  }

  // 1. TEXTE pur / caption
  if (mcontent.conversation) {
    payload.type = 'text'
    payload.text = mcontent.conversation
  } else if (mcontent.extendedTextMessage?.text) {
    payload.type = 'text'
    payload.text = mcontent.extendedTextMessage.text
  }

  // 2. IMAGE
  if (mcontent.imageMessage) {
    const buf = await fetchMediaBuffer(mcontent.imageMessage, 'image')
    const mime = mcontent.imageMessage.mimetype || 'image/jpeg'
    const saved = await saveMediaFile(buf, mime)

    payload.type = 'image'
    payload.text = mcontent.imageMessage.caption || ''
    payload.mimeType = saved.mimeType
    payload.mediaUrl = saved.url
  }

  // 3. VIDEO (y compris GIF animé WhatsApp => gifPlayback === true)
  else if (mcontent.videoMessage) {
    const buf = await fetchMediaBuffer(mcontent.videoMessage, 'video')
    const mime = mcontent.videoMessage.mimetype || 'video/mp4'
    const saved = await saveMediaFile(buf, mime)

    payload.type = mcontent.videoMessage.gifPlayback ? 'gif' : 'video'
    payload.text = mcontent.videoMessage.caption || ''
    payload.mimeType = saved.mimeType
    payload.mediaUrl = saved.url
  }

  // 4. AUDIO / NOTE VOCALE
  else if (mcontent.audioMessage) {
    const buf = await fetchMediaBuffer(mcontent.audioMessage, 'audio')
    const mime = mcontent.audioMessage.mimetype || 'audio/ogg'
    const saved = await saveMediaFile(buf, mime)

    payload.type = mcontent.audioMessage.ptt ? 'voice' : 'audio'
    payload.mimeType = saved.mimeType
    payload.mediaUrl = saved.url
    payload.durationSeconds = mcontent.audioMessage.seconds
    payload.isVoiceNote = !!mcontent.audioMessage.ptt
  }

  // 5. DOCUMENT / PDF / etc
  else if (mcontent.documentMessage) {
    const buf = await fetchMediaBuffer(mcontent.documentMessage, 'document')
    const mime = mcontent.documentMessage.mimetype || 'application/octet-stream'
    const saved = await saveMediaFile(buf, mime)

    payload.type = 'document'
    payload.mimeType = saved.mimeType
    payload.mediaUrl = saved.url
    payload.fileName = mcontent.documentMessage.fileName || null
  }

  app.log.info({ inbound: payload })

  // push vers la plateforme via webhook
  await sendWebhookEvent(s, {
    event: 'message.in',
    data: payload,
    ts: timestamp
  })
}


/* -------- ROUTES API -------- */

// 1. Créer une session (et donc un QR à scanner)
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)

  // petite pause pour laisser Baileys démarrer et générer le QR
  await new Promise(res => setTimeout(res, 500))

  return reply.send({ session_id: s.id })
})

// 2. Lire l'état d'une session
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
    qr_text: s.qr_text || null,
    me_number: s.meNumber || null
  })
})

// 3. Enregistrer / mettre à jour l’URL webhook pour cette session
// body attendu: { "url": "...", "secret": "..." }
app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id
  const { url, secret } = (req.body as any) || {}
  const s = sessions.get(id)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }
  s.webhookUrl = url
  s.webhookSecret = secret || WEBHOOK_SECRET
  return reply.send({ ok: true })
})

// 4. Forcer un redémarrage manuel si besoin
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  const s = sessions.get(id)
  if (!s) return reply.code(404).send({ error: 'unknown session' })
  await restartSession(id)
  return reply.send({ ok: true })
})

// 5. Envoyer un message sortant
// body attendu: { sessionId, to, text }
// (tu peux étendre plus tard pour image/audio sortant)
app.post('/messages', async (req, reply) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' })
  }

  const { sessionId, to, text } = (req.body as any) || {}
  const s = sessions.get(sessionId)
  if (!s?.sock) return reply.code(400).send({ error: 'session not ready' })

  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`

  await s.sock.sendMessage(jid, { text })

  // IMPORTANT : notifier le webhook que c'est un message "sortant"
  await sendWebhookEvent(s, {
    event: 'message.in', // tu peux aussi décider 'message.out' côté Lovable
    data: {
      from: s.meNumber || null,
      fromJid: s.meId || null,
      fromMe: true,
      to: jid,
      type: 'text',
      text
    },
    ts: Date.now()
  })

  return reply.send({ ok: true })
})

// 6. Healthcheck pour Render
app.get('/health', async (_req, reply) => reply.send({ ok: true }))

/* -------- START HTTP SERVER -------- */

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
