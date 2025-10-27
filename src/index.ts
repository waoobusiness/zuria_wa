// src/index.ts

// -------------------------
// IMPORTS
// -------------------------
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import cors from '@fastify/cors'
import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'


// -------------------------
// CONFIG (variables d'environnement Render)
// -------------------------

// Port HTTP du serveur Fastify
const PORT = parseInt(process.env.PORT || '3001', 10)

// Dossier persistant monté sur Render (disque).
// Là-dedans on met la sous-dossier de chaque session: /var/data/wa/<sessionId>/*
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Dossier où on sauvegarde les médias reçus (images, audio, etc.)
// Par défaut on fait "<AUTH_DIR>/media"
const MEDIA_DIR =
  process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// URL publique de ton service Baileys (celle de Render)
// Sert à générer des liens publics vers les médias
// ex: https://zuria-wa.onrender.com
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com'

// Secret global utilisé pour signer les webhooks sortants
// (header x-wa-signature)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Clé d'API optionnelle pour protéger les endpoints sensibles (/messages, etc.)
// => le front devra envoyer le header:  x-api-key: <API_KEY>
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES & MÉMOIRE
// -------------------------

type SessionState = {
  id: string

  // QR code pour affichage dans l'UI :
  // - qr : data:image/png;base64,...
  // - qr_text : texte brut du QR (fallback texte du QR)
  qr?: string | null
  qr_text?: string | null

  // état connexion WA
  connected: boolean

  // socket Baileys courant
  sock?: ReturnType<typeof makeWASocket>

  // fonction fournie par Baileys pour persister les credentials multi-fichiers
  saveCreds?: () => Promise<void>

  // webhook enregistré par Zuria/Lovable pour CETTE session
  webhookUrl?: string
  webhookSecret?: string // peut overrider WEBHOOK_SECRET global

  // infos sur le compte WhatsApp connecté
  meId?: string | null        // ex "4176xxxxxx:29@s.whatsapp.net"
  meNumber?: string | null    // juste les chiffres
  phoneNumber?: string | null // alias pratique (= meNumber)
}

// toutes les sessions vivantes (en RAM côté serveur)
const sessions = new Map<string, SessionState>()


// -------------------------
// FASTIFY BOOT
// -------------------------

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

// s'assurer que le dossier média existe
fs.mkdirSync(MEDIA_DIR, { recursive: true })

// servir les médias statiquement à /media/<fichier>
await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
})


// -------------------------
// HELPERS
// -------------------------

// chemin du dossier d'auth d'une session
function getSessionAuthDir(id: string) {
  return path.join(AUTH_DIR, id)
}

// Ex: "41766085008@s.whatsapp.net"          -> "41766085008"
//     "41766085008:29@s.whatsapp.net"       -> "41766085008"
function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  // on prend uniquement les premiers chiffres avant ":" ou "@"
  const m = jid.match(/^(\d{5,20})/)
  return m ? m[1] : null
}

// MimeType -> extension de fichier simple
function guessExt(mime: string | undefined): string {
  if (!mime) return 'bin'
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('jpg')) return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('opus')) return 'ogg'
  if (mime.includes('pdf')) return 'pdf'
  return 'bin'
}

// Télécharge un média (image, audio, etc.) depuis un message Baileys,
// le stocke dans MEDIA_DIR, puis renvoie { filename, mimeType, url }
async function saveIncomingMedia(
  msg: any
): Promise<null | { filename: string; mimeType: string; url: string }> {
  // On cherche si ce message contient un média supporté
  // On traite en priorité image/video/audio/document/sticker
  let mediaType:
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | null = null
  let mediaObj: any = null

  if (msg.message?.imageMessage) {
    mediaType = 'image'
    mediaObj = msg.message.imageMessage
  } else if (msg.message?.videoMessage) {
    mediaType = 'video'
    mediaObj = msg.message.videoMessage
  } else if (msg.message?.audioMessage) {
    mediaType = 'audio'
    mediaObj = msg.message.audioMessage
  } else if (msg.message?.documentMessage) {
    mediaType = 'document'
    mediaObj = msg.message.documentMessage
  } else if (msg.message?.stickerMessage) {
    mediaType = 'sticker'
    mediaObj = msg.message.stickerMessage
  }

  if (!mediaType || !mediaObj) {
    return null // pas de média
  }

  // Récupérer le flux binaire via Baileys
  const stream = await downloadContentFromMessage(mediaObj, mediaType)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)

  // Construire un nom de fichier unique
  const mimeType =
    mediaObj.mimetype ||
    mediaObj.mimetype ||
    'application/octet-stream'

  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)

  fs.writeFileSync(absPath, buf)

  // URL publique pour que la plateforme puisse télécharger/afficher
  // exemple: https://zuria-wa.onrender.com/media/abc123.jpg
  const publicUrl = `${PUBLIC_BASE_URL.replace(
    /\/$/,
    ''
  )}/media/${filename}`

  return {
    filename,
    mimeType,
    url: publicUrl,
  }
}

// Transforme un message Baileys brut en format simple pour le front
function simplifyBaileysMessage(m: any) {
  const fromMe = m.key?.fromMe === true

  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.documentMessage?.caption ||
    ''

  const messageId = m.key?.id || ''
  const tsMs = Number(m.messageTimestamp || 0) * 1000

  return {
    messageId,
    fromMe,
    text,
    mediaUrl: null, // pour l'historique: pas de re-download du binaire
    mediaMime: null,
    timestampMs: tsMs,
  }
}

// Envoi d'un event webhook vers Zuria / Lovable
// - s : la session
// - event : ex "message.in", "session.connected"
// - payload : { data: {...}, ts: Date.now(), ... }
async function sendWebhookEvent(
  s: SessionState,
  event: string,
  payload: Record<string, any>
) {
  if (!s.webhookUrl) {
    // pas de webhook configuré => on log seulement
    app.log.warn({
      msg: 'no webhookUrl for session, drop event',
      sessionId: s.id,
      event,
    })
    return
  }

  // on signe le webhook
  const signature = s.webhookSecret || WEBHOOK_SECRET || ''

  // body envoyé au webhook
  const body = {
    sessionId: s.id,
    event,
    ...payload,
  }

  try {
    const res = await fetch(s.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-signature': signature,
      },
      body: JSON.stringify(body),
    })

    app.log.info({
      webhookPush: {
        sessionId: s.id,
        event,
        status: res.status,
      },
    })
  } catch (e: any) {
    app.log.error({
      msg: 'webhook push failed',
      sessionId: s.id,
      event,
      err: String(e),
    })
  }
}

// Baileys dit "restart required" avec le code 515
function isRestartRequired(err: any) {
  const code = Number(
    err?.output?.statusCode ??
      err?.status ??
      err?.code ??
      err?.statusCode ??
      0
  )
  return (
    code === 515 || code === DisconnectReason.restartRequired
  )
}


// -------------------------
// HANDLERS BAILEYS
// -------------------------

// Gestion des updates de connexion (QR, connecté/déconnecté, etc.)
async function onConnectionUpdate(s: SessionState, u: any) {
  // log utile côté Render
  app.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect,
    },
  })

  // Si Baileys nous donne un nouveau QR => on le stocke pour l'UI
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({
        msg: 'qr toDataURL failed',
        err: String(e),
      })
    }
  }

  // Si on est connecté
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // on essaie d'extraire le numéro du compte WhatsApp lié
    // Baileys renvoie souvent "me" ou "user" dans l'update
    // ex u.me.id = "4176XXXXXX:29@s.whatsapp.net"
    if (u.me?.id) {
      s.meId = u.me.id || null
      // on garde juste les chiffres avant ":" ou "@"
      const num = extractPhoneFromJid(s.meId || '')
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    // prévenir la plateforme (Zuria)
    await sendWebhookEvent(s, 'session.connected', {
      data: {
        meId: s.meId || null,
        phoneNumber: s.meNumber || null,
      },
      ts: Date.now(),
    })

    return
  }

  // Si fermeture
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // Cas A : Baileys dit "restart required" (code 515)
    if (isRestartRequired(err)) {
      app.log.warn({
        msg: 'restart required (515) — restarting socket',
        id: s.id,
      })
      await restartSession(s.id, { resetAuth: false })
      return
    }

    // Cas B : vraiment déconnecté / logged out => il faudra rescanner
    const code = Number(
      err?.output?.statusCode ??
        err?.status ??
        err?.code ??
        err?.statusCode ??
        0
    )
    if (code === DisconnectReason.loggedOut) {
      s.connected = false
      app.log.warn({
        msg: 'logged out — rescan required',
        id: s.id,
      })

      await sendWebhookEvent(s, 'session.disconnected', {
        data: {
          reason: 'loggedOut',
        },
        ts: Date.now(),
      })

      return
    }

    // Autres cas : Baileys va réessayer de se reconnecter
    s.connected = false
  }
}

// Gestion des messages entrants
async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key) return

  const remoteJid = msg.key.remoteJid || '' // ex "4176xxxxxx@s.whatsapp.net"
  const fromMe = msg.key.fromMe === true // true si c'est NOUS qui parlons
  const chatNumber = extractPhoneFromJid(remoteJid)

  // Texte du message (le cas le plus fréquent)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '' // si juste un vocal, etc.

  // Si c'est un message média -> on sauvegarde le fichier
  const mediaInfo = await saveIncomingMedia(msg) // peut être null

  // On envoie l'event "message.in" au webhook
  await sendWebhookEvent(s, 'message.in', {
    data: {
      from: chatNumber || remoteJid,
      fromJid: remoteJid,
      fromMe, // super important pour savoir si c'est agent ou client
      text,
      media: mediaInfo, // { url, mimeType, filename } | null
    },
    ts: Date.now(),
  })
}

// relier les listeners Baileys à notre session
function attachSocketHandlers(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  // sauve les crédos quand ils changent
  if (s.saveCreds) {
    sock.ev.on('creds.update', s.saveCreds)
  }

  // updates de connexion (QR, ouvert, fermé, etc.)
  sock.ev.on('connection.update', async (u) =>
    onConnectionUpdate(s, u)
  )

  // messages entrants
  sock.ev.on('messages.upsert', async (m) =>
    onMessagesUpsert(s, m)
  )
}


// -------------------------
// CYCLE DE VIE D'UNE SESSION
// -------------------------

// crée / recrée vraiment le socket pour une session donnée
async function buildSessionSocket(id: string): Promise<SessionState> {
  // s'assure que le dossier d'auth existe
  fs.mkdirSync(getSessionAuthDir(id), { recursive: true })

  // récupère l'état multi-fichiers (tokens WhatsApp) depuis le disque
  const { state, saveCreds } = await useMultiFileAuthState(
    getSessionAuthDir(id)
  )
  const { version } = await fetchLatestBaileysVersion()

  // objet session en RAM
  const s: SessionState = {
    id,
    qr: null,
    qr_text: null,
    connected: false,
    saveCreds,
    phoneNumber: null,
    meId: null,
    meNumber: null,
  }

  // créer le socket
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Zuria', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
  })

  s.sock = sock

  // brancher les listeners sur ce socket
  attachSocketHandlers(s, sock)

  // stocker/mettre à jour dans la map globale
  sessions.set(id, s)

  return s
}

// assure qu'une session est en mémoire & a un socket vivant
async function ensureSessionLoaded(id: string): Promise<SessionState> {
  const existing = sessions.get(id)
  if (existing?.sock) {
    return existing
  }
  // pas en RAM -> on recrée depuis le disque (sans effacer les creds)
  const s = await buildSessionSocket(id)
  return s
}

// redémarrer une session
// resetAuth=true => on efface les anciens credentials sur disque,
//                   donc on force une NOUVELLE connexion avec QR.
async function restartSession(
  id: string,
  opts: { resetAuth: boolean }
): Promise<SessionState> {
  const old = sessions.get(id)

  // nettoyer l'ancien socket si présent
  if (old?.sock) {
    try {
      ;(old.sock as any)?.ev?.removeAllListeners?.()
    } catch {}
    try {
      ;(old.sock as any)?.ws?.close?.()
    } catch {}
  }

  // si on veut forcer une reconnexion propre (nouveau scan)
  if (opts.resetAuth) {
    try {
      fs.rmSync(getSessionAuthDir(id), {
        recursive: true,
        force: true,
      })
    } catch {}
  }

  // recréer proprement à partir du disque (éventuellement vide -> QR)
  const fresh = await buildSessionSocket(id)
  return fresh
}

// crée une NOUVELLE session (nouvel ID)
// => utilisé quand tu cliques "Créer une session" sur /
async function startSession(newId: string) {
  const s = await buildSessionSocket(newId)
  return s
}


// -------------------------
// ROUTES HTTP
// -------------------------

// Petite UI manuelle pour créer une session et voir le QR
app.get('/', async (_req, reply) => {
  const html = `
  <html>
    <head><meta charset="utf-8"><title>Zuria WA</title></head>
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

          if(s.qr){
            img.src = s.qr
          } else if (s.qr_text) {
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data='
                      + encodeURIComponent(s.qr_text)
          }

          stat.textContent = s.connected
            ? '✅ Connecté ('+(s.phoneNumber||'???')+')'
            : '⏳ En attente...'

          if(s.connected){
            clearInterval(interval)
            img.remove()
          }
        }, 1500)
      }
      </script>
    </body>
  </html>`
  reply.type('text/html').send(html)
})

// Mini console d’envoi de message pour test humain
app.get('/send', async (_req, reply) => {
  const html = `
  <html>
    <head><meta charset="utf-8"><title>Envoyer un message</title></head>
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
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid)
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
        }

        document.getElementById('restart').onclick = async () => {
          const sid = (document.getElementById('sid').value || '').trim()
          const r = await fetch('/sessions/' + sid + '/restart', { method: 'POST' })
          const j = await r.json()
          out.textContent = JSON.stringify(j, null, 2)
        }

        document.getElementById('btn').onclick = async () => {
          const sessionId = (document.getElementById('sid').value || '').trim()
          const to = (document.getElementById('to').value || '').trim()
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
    </body>
  </html>`
  reply.type('text/html').send(html)
})

// Créer une session (=> retourne l'ID)
// -> on génère un nouvel UUID et on démarre un socket pour cette session
app.post('/sessions', async (_req, reply) => {
  const id = uuid()
  app.log.info({ msg: 'create session', id })
  const s = await startSession(id)
  // on laisse ~500ms à Baileys pour éventuellement déjà générer un QR
  await new Promise((res) => setTimeout(res, 500))
  return reply.send({ session_id: s.id })
})

// Récupérer l'état d'une session
app.get('/sessions/:id', async (req, reply) => {
  const id = (req.params as any).id

  // assure qu'elle est (re)chargée en mémoire si besoin
  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s) {
    return reply.code(404).send({ error: 'unknown session' })
  }

  return reply.send({
    session_id: id,
    connected: s.connected,
    qr: s.qr || null,
    qr_text: s.qr_text || null,
    phoneNumber: s.phoneNumber || null,
    meNumber: s.meNumber || null,
    meId: s.meId || null,
    hasSock: !!s.sock,
  })
})

// Redémarrer / reconnecter une session (bouton "Reconnecter")
// IMPORTANT: ici on FORCE resetAuth: true
// -> on supprime les anciens credentials => Baileys va demander un NOUVEAU QR
app.post('/sessions/:id/restart', async (req, reply) => {
  const id = (req.params as any).id
  try {
    const s = await restartSession(id, { resetAuth: true })
    return reply.send({
      ok: true,
      session_id: s.id,
      connected: s.connected,
      // on peut indiquer au front qu'il doit afficher le modal QR:
      needScan: true,
    })
  } catch (e: any) {
    app.log.error({
      msg: 'restartSession failed',
      id,
      err: String(e),
    })
    return reply
      .code(500)
      .send({ error: 'restart failed', detail: String(e) })
  }
})

// Enregistrer / mettre à jour le webhook pour une session
// Body attendu:
// { "url": "https://.../whatsapp-webhook-gateway?session_id=xxx",
//   "secret": "xxxxx-optional" }
app.post('/sessions/:id/webhook', async (req, reply) => {
  const id = (req.params as any).id

  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s) return reply.code(404).send({ error: 'unknown session' })

  const { url, secret } = (req.body as any) || {}
  if (!url) {
    return reply.code(400).send({ error: 'missing url' })
  }

  s.webhookUrl = String(url)
  if (secret) {
    s.webhookSecret = String(secret)
  }

  return reply.send({
    ok: true,
    session_id: id,
    webhookUrl: s.webhookUrl,
  })
})

// Envoyer un message sortant
// Body attendu:
// { "sessionId": "...", "to": "4176xxxxxxx", "text": "hello" }
app.post('/messages', async (req, reply) => {
  // auth API_KEY si défini
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const { sessionId, to, text } = (req.body as any) || {}

  // s'assurer que la session est chargée
  const s = await ensureSessionLoaded(sessionId).catch(() => null)
  if (!s?.sock) {
    return reply
      .code(400)
      .send({ error: 'session not ready' })
  }

  const jid = `${String(to).replace(/[^\d]/g, '')}@s.whatsapp.net`
  await s.sock.sendMessage(jid, { text: String(text || '') })

  // envoyer aussi un webhook "message.out"
  await sendWebhookEvent(s, 'message.out', {
    data: {
      to: jid,
      text: String(text || ''),
    },
    ts: Date.now(),
  })

  return reply.send({ ok: true })
})

// Messages paginés d'une conversation
// GET /sessions/:id/chats/:jid/messages?limit=20&beforeId=...&beforeFromMe=true|false
app.get('/sessions/:id/chats/:jid/messages', async (req, reply) => {
  const { id, jid } = (req.params as any)

  // auth API_KEY si défini
  if (API_KEY) {
    const hdr = req.headers['x-api-key']
    if (!hdr || hdr !== API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }

  const q = (req.query as any) || {}
  const limit = Math.min(Number(q.limit || 20), 50)

  // curseur de pagination
  const beforeId = q.beforeId ? String(q.beforeId) : undefined
  let beforeFromMe: boolean | undefined = undefined
  if (
    q.beforeFromMe === 'true' ||
    q.beforeFromMe === true
  ) {
    beforeFromMe = true
  } else if (
    q.beforeFromMe === 'false' ||
    q.beforeFromMe === false
  ) {
    beforeFromMe = false
  }

  // charger / créer la session en mémoire
  const s = await ensureSessionLoaded(id).catch(() => null)
  if (!s?.sock) {
    return reply
      .code(400)
      .send({ error: 'session not ready' })
  }

  // Baileys attend un "cursor" facultatif { id, fromMe, remoteJid }
  const cursor =
    beforeId && typeof beforeFromMe === 'boolean'
      ? {
          id: beforeId,
          fromMe: beforeFromMe,
          remoteJid: jid,
        }
      : undefined

  let rawMsgs: any[] = []
  try {
    // charge les messages du plus récent vers le plus ancien
    rawMsgs = await (s.sock as any).loadMessages(
      jid,
      limit,
      cursor
    )
  } catch (e: any) {
    return reply
      .code(500)
      .send({
        error: 'loadMessages failed',
        detail: String(e),
      })
  }

  const messages = rawMsgs.map(simplifyBaileysMessage)

  // prépare le curseur pour "page suivante" = le dernier (donc le plus ancien) de cette page
  const last = messages[messages.length - 1]
  const nextCursor = last
    ? {
        beforeId: last.messageId,
        beforeFromMe: last.fromMe,
      }
    : null

  return reply.send({
    ok: true,
    messages,
    nextCursor, // le front renverra ça pour charger encore plus vieux
  })
})

// Healthcheck basique
app.get('/health', async (_req, reply) => {
  reply.send({ ok: true })
})

// -------------------------
// START HTTP SERVER
// -------------------------
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`HTTP server listening on ${PORT}`)
})
