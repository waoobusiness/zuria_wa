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
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// -------------------------
// CONFIG (vient de Render .env)
// -------------------------
const PORT = parseInt(process.env.PORT || '3001', 10)

const AUTH_DIR = process.env.AUTH_DIR || '/var/data/wa'
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(AUTH_DIR, 'media')

// ton domaine public pour les médias (doit finir SANS /)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://zuria-wa.onrender.com').replace(/\/$/, '')

// URL de l'Edge Function Supabase
// ex: https://xxxx.supabase.co/functions/v1/whatsapp-webhook-gateway
const SUPABASE_WEBHOOK_URL = (process.env.SUPABASE_WEBHOOK_URL || '').replace(/\/$/, '')

// secret global partagé Render <-> Supabase (== WA_WEBHOOK_SECRET côté Supabase)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// clé API pour ton endpoint POST /messages etc
const API_KEY = process.env.API_KEY || ''


// -------------------------
// TYPES & MÉMOIRE
// -------------------------

type ChatLite = {
  id: string
  name?: string | null
  subject?: string | null
  /** seconds since epoch (Baileys) */
  conversationTimestamp?: number | null
}

type SessionState = {
  id: string

  // QR pour UI
  qr?: string | null
  qr_text?: string | null

  // statut de connexion
  connected: boolean

  // socket baileys
  sock?: ReturnType<typeof makeWASocket>

  // persist creds baileys
  saveCreds?: () => Promise<void>

  // webhook de cette session (en général supabase + ?session_id=xxx)
  webhookUrl?: string

  // secret unique de cette session (stocké en DB Supabase dans whatsapp_sessions.webhook_secret)
  webhookSecret?: string

  // infos compte WA
  meId?: string | null
  meNumber?: string | null
  phoneNumber?: string | null

  // mini-stores mémoire pour sidebar/historique
  chats: Map<string, ChatLite>
  contacts: Map<string, { notify?: string; name?: string }>
}

// toutes les sessions en RAM
const sessions = new Map<string, SessionState>()


// -------------------------
// FASTIFY INSTANCE
// -------------------------
const app = Fastify({ logger: true })

// parser JSON permissif (body vide autorisé)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, {})
      return
    }
    const json = typeof body === 'string' ? JSON.parse(body) : body
    done(null, json)
  } catch (e) {
