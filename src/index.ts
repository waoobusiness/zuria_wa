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

// 👇 IMPORTANT : hack compatible Render / TypeScript
// Certaines versions de Baileys ne ré-exportent pas correctement makeInMemoryStore
// et tsc plante si on essaie d'importer depuis "baileys/lib/Store".
// On fait donc un require() dynamique qui échappe au check TS.
const baileysAny: any = require('@whiskeysockets/baileys')
const makeInMemoryStore = baileysAny.makeInMemoryStore as (
  opts?: any
) => any

import fs from 'fs'
import path from 'path'


// -------------------------
// CONFIG (variables d'environnement Render)
// -------------------------

// Port HTTP du serveur Fastify
const PORT = parseInt(process.env.PORT || '3001', 10)

// Dossier persistant monté sur Render (disque). Exemple: /var/data/wa
// Chaque session a son propre sous-dossier: /var/data/wa/<sessionId>/*
const AUTH_DIR = process.env.AUTH_DIR || './.wa'

// Dossier où on sauvegarde les médias reçus (images, audio, etc.)
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// URL publique de ton service Baileys (celle de Render)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com'

// Secret global utilisé pour signer les webhooks sortants
// (header x-wa-signature)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Clé d'API optionnelle pour protéger certains endpoints (messages, chats...)
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES & MÉMOIRE
// -------------------------

type SessionState = {
  id: string

  // QR code pour affichage dans l'UI :
  // - qr : data:image/png;base64,...
  // - qr_text : texte brut du QR (fallback)
  qr?: string | null
  qr_text?: string | null

  // état de connexion
  connected: boolean

  // socket Baileys
  sock?: ReturnType<typeof makeWASocket>

  // store mémoire Baileys (chats, etc.)
  store?: ReturnType<typeof makeInMemoryStore>

  // pour sauvegarder les credentials
  saveCreds?: () => Promise<void>

  // webhook configuré par Zuria/Lovable pour CETTE session
  webhookUrl?: string
  webhookSecret?: string // override possible

  // infos du compte WhatsApp connecté
  meId?: string | null        // ex "4176xxxxxx:29@s.whatsapp.net"
  meNumber?: string | null    // juste les chiffres "4176xxxxxx"
  phoneNumber?: string | null // alias pratique
}

// Map en RAM de toutes les sessions
const sessions = new Map<string, SessionState>()


// -------------------------
// FASTIFY BOOT
// -------------------------

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

// s'assure que le dossier média existe
fs.mkdirSync(MEDIA_DIR, { recursive: true })

// servir les médias statiquement à /media/<fichier>
await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
})


// -------------------------
// HELPERS
// -------------------------

// "41766085008@s.whatsapp.net"  -> "41766085008"
// "41766085008:29@s.whatsapp.net" -> "41766085008"
function extractPhoneFromJid(jid?: string | null): string | null {
  if (!jid) return null
  const m = jid.match(/^(\d{5,20})/)
  return m ? m[1] : null
}

// MimeType -> extension simple
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
  // détecter le type de média
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

  // pas de média
  if (!mediaType || !mediaObj) {
    return null
  }

  // Télécharger le flux binaire
  const stream = await downloadContentFromMessage(mediaObj, mediaType)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)

  // Nom de fichier unique
  const mimeType = mediaObj.mimetype || 'application/octet-stream'
  const ext = guessExt(mimeType)
  const filename = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`
  const absPath = path.join(MEDIA_DIR, filename)

  fs.writeFileSync(absPath, buf)

  // URL publique servie par /media
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

// Transforme un message Baileys brut en format simple pour le front (historique)
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
    mediaUrl: null, // pagination historique : pas de re-téléchargement du binaire
    mediaMime: null,
    timestampMs: tsMs,
  }
}

// Envoie un event webhook vers Zuria / Lovable
// - s : la session
// - event : "message.in", "message.out", "session.connected", ...
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

  const signature = s.webhookSecret || WEBHOOK_SECRET || ''

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
  return code === 515 || code === DisconnectReason.restartRequired
}


// -------------------------
// HANDLERS BAILEYS
// -------------------------

// Gestion des updates de connexion (QR, connecté/déconnecté, etc.)
async function onConnectionUpdate(s: SessionState, u: any) {
  // log Render
  app.log.info({
    wa_update: {
      conn: u.connection,
      hasQR: !!u.qr,
      disc: !!u.lastDisconnect,
    },
  })

  // nouveau QR reçu -> stock pour UI
  if (u.qr) {
    s.qr_text = u.qr
    try {
      s.qr = await QRCode.toDataURL(u.qr)
    } catch (e) {
      s.qr = null
      app.log.warn({ msg: 'qr toDataURL failed', err: String(e) })
    }
  }

  // connexion ouverte
  if (u.connection === 'open') {
    s.connected = true
    s.qr = null
    s.qr_text = null

    // extraire notre numéro WhatsApp
    if (u.me?.id) {
      s.meId = u.me.id || null
      const num = extractPhoneFromJid(s.meId || '')
      s.meNumber = num || null
      s.phoneNumber = s.meNumber || null
    }

    // prévenir la plateforme
    await sendWebhookEvent(s, 'session.connected', {
      data: {
        meId: s.meId || null,
        phoneNumber: s.meNumber || null,
      },
      ts: Date.now(),
    })

    return
  }

  // fermeture / déconnexion
  if (u.connection === 'close') {
    const err = (u.lastDisconnect as any)?.error

    // Cas A : Baileys dit "restart required" (code 515)
    if (isRestartRequired(err)) {
      app.log.warn({
        msg: 'restart required (515) — restarting socket',
        id: s.id,
      })
      await restartSession(s.id)
      return
    }

    // Cas B : logged out complet
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

    // Autres cas : tentative d'auto-reconnect Baileys
    s.connected = false
  }
}

// Gestion des messages entrants
async function onMessagesUpsert(s: SessionState, m: any) {
  const msg = m.messages?.[0]
  if (!msg || !msg.key) return

  const remoteJid = msg.key.remoteJid || '' // "4176xxxxxx@s.whatsapp.net"
  const fromMe = msg.key.fromMe === true    // true = c'est nous (le business)
  const chatNumber = extractPhoneFromJid(remoteJid)

  // texte principal
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '' // ex: si c'est juste un audio sans caption

  // média si présent
  const mediaInfo = await saveIncomingMedia(msg) // peut être null

  // push webhook "message.in"
  // (le front utilisera fromMe pour bulle gauche/droite)
  await sendWebhookEvent(s, 'message.in', {
    data: {
      from: chatNumber || remoteJid,
      fromJid: remoteJid,
      fromMe,            // super important pour l'UI
      text,
      media: mediaInfo,  // { url, mimeType, filename } | null
    },
    ts: Date.now(),
  })
}

// Attache tous les listeners nécessaires à un socket Baileys
function attachSocketHandlers(
  s: SessionState,
  sock: ReturnType<typeof makeWASocket>
) {
  // sauver les creds quand ils changent
  if (s.saveCreds) {
    sock.ev.on('creds.update', s.saveCreds)
  }

  // updates de connexion (QR, open, close...)
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

// (ré)initialise le socket pour une session existante
async function restartSession(id: string
