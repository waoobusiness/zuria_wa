// app/src/server.ts

import express, { Request, Response } from "express";
import cors from "cors";
import pino from "pino";
import fs from "fs-extra";
import path from "path";
import { LRUCache } from "lru-cache";
import { lookup as mimeLookup } from "mime-types";
import EventEmitter from "eventemitter3";
import QRCode from "qrcode";

// Baileys
import makeWASocket, {
  WASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  WAMessage,
  AnyMessageContent,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ----------- Config

const PORT = Number(process.env.PORT || 3000);

// ✅ On prend d’abord SESSIONS_DIR, sinon DATA_DIR, sinon ./sessions
const SESSIONS_DIR =
  process.env.SESSIONS_DIR ||
  process.env.DATA_DIR ||
  path.join(process.cwd(), "sessions");

// 🔄 Webhook (Make / Supabase / autre)
const WEBHOOK_URL =
  process.env.WA_WEBHOOK_URL || process.env.WEBHOOK_URL || "";

// 🌍 URL publique de la gateway (pour mediaUrl)
const PUBLIC_URL =
  process.env.WA_PUBLIC_URL || process.env.PUBLIC_URL || "";

// ----------- App

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// ----------- Types & Stores

type SessionStatus = "starting" | "qr" | "connecting" | "connected" | "closed";

type ChatSummary = {
  id: string;
  name?: string;
  unreadCount?: number;
  lastMessageTimestamp?: number;
  lastMessagePreview?: string;
  isGroup?: boolean;
};

type ContactSummary = {
  id: string;
  name?: string;
  notify?: string;
  shortName?: string;
};

type Session = {
  orgId: string;
  sock?: WASocket;
  saveCreds?: () => Promise<void>;
  bus: EventEmitter;
  qr?: string | null;
  status: SessionStatus;
  msgCache: LRUCache<string, WAMessage>;
  chats: Map<string, ChatSummary>;
  contacts: Map<string, ContactSummary>;

  // ✅ caches PN <-> LID (résout ton problème de double conversations)
  lidByPn: LRUCache<string, string>; // key: 4179..@s.whatsapp.net -> value: xxx@lid
  pnByLid: LRUCache<string, string>; // key: xxx@lid -> value: 4179..@s.whatsapp.net
};

const sessions = new Map<string, Session>();

function createEmptySession(orgId: string): Session {
  return {
    orgId,
    bus: new EventEmitter(),
    status: "closed",
    qr: null,
    msgCache: new LRUCache({ max: 1000 }),
    chats: new Map(),
    contacts: new Map(),

    lidByPn: new LRUCache({ max: 5000 }),
    pnByLid: new LRUCache({ max: 5000 }),
  };
}

function getBus(orgId: string): EventEmitter {
  let s = sessions.get(orgId);
  if (!s) {
    s = createEmptySession(orgId);
    sessions.set(orgId, s);
  }
  return s.bus;
}

function phoneToJid(to: string): string {
  const digits = to.replace(/[^\d]/g, "").replace(/^00/, "");
  return `${digits}@s.whatsapp.net`;
}

function isLidJid(jid?: string | null): boolean {
  return !!jid && jid.endsWith("@lid");
}

function isPnJid(jid?: string | null): boolean {
  return !!jid && jid.endsWith("@s.whatsapp.net");
}

function computeCanonicalChatId(
  remoteJid?: string | null,
  remoteJidAlt?: string | null
): string | null {
  // ✅ Canonical = LID si on l'a, sinon PN
  if (remoteJid && isLidJid(remoteJid)) return remoteJid;
  if (remoteJidAlt && isLidJid(remoteJidAlt)) return remoteJidAlt;
  return remoteJid || remoteJidAlt || null;
}

function getRemoteJidAlt(msg: WAMessage): string | null {
  // Baileys v7 fournit remoteJidAlt sur msg.key (si dispo)
  return (((msg.key as any)?.remoteJidAlt as string) || null) ?? null;
}

function rememberLidMapping(sess: Session, pnJid: string, lidJid: string) {
  if (!pnJid || !lidJid) return;
  if (!isPnJid(pnJid) || !isLidJid(lidJid)) return;

  sess.lidByPn.set(pnJid, lidJid);
  sess.pnByLid.set(lidJid, pnJid);
}

function rememberFromKey(sess: Session, remoteJid?: string | null, remoteJidAlt?: string | null) {
  if (!remoteJid || !remoteJidAlt) return;

  if (isLidJid(remoteJid) && isPnJid(remoteJidAlt)) {
    rememberLidMapping(sess, remoteJidAlt, remoteJid);
  } else if (isPnJid(remoteJid) && isLidJid(remoteJidAlt)) {
    rememberLidMapping(sess, remoteJid, remoteJidAlt);
  }
}

async function resolveSendJid(
  sess: Session,
  toPhone: string
): Promise<{ pn: string; lid: string | null; sendTo: string }> {
  const pn = phoneToJid(toPhone);

  // 1) cache d'abord
  const cached = sess.lidByPn.get(pn);
  if (cached) return { pn, lid: cached, sendTo: cached };

  // 2) essayer lidMapping du signalRepository (Baileys v7)
  let lid: string | null = null;
  try {
    const sockAny: any = sess.sock as any;
    const lm = sockAny?.signalRepository?.lidMapping;

    // différentes implémentations selon builds
    if (lm?.getLIDForPN) {
      lid = await lm.getLIDForPN(pn);
    } else if (typeof lm?.get === "function") {
      // certaines versions exposent .get(pn)
      lid = await lm.get(pn);
    }
  } catch (err) {
    logger.warn({ err, pn }, "resolveSendJid: lid lookup failed");
  }

  if (lid && isLidJid(lid)) {
    rememberLidMapping(sess, pn, lid);
    return { pn, lid, sendTo: lid };
  }

  return { pn, lid: null, sendTo: pn };
}

async function bufferFromInput(input?: { url?: string; base64?: string }) {
  if (!input) return undefined;

  if (input.base64) {
    const comma = input.base64.indexOf(",");
    const b64 = comma >= 0 ? input.base64.slice(comma + 1) : input.base64;
    return Buffer.from(b64, "base64");
  }

  if (input.url) {
    const r = await fetch(input.url);
    if (!r.ok) throw new Error(`fetch failed ${r.status}`);
    const arr = await r.arrayBuffer();
    return Buffer.from(arr);
  }

  return undefined;
}

function getSessionOr404(orgId: string, res: Response): Session | null {
  const s = sessions.get(orgId);
  if (!s || !s.sock?.user) {
    res.status(400).json({ ok: false, error: "Session not connected" });
    return null;
  }
  return s;
}

// ----------- Helper pour effacer complètement l’auth disque

async function clearSessionAuth(orgId: string) {
  const authDir = path.join(SESSIONS_DIR, orgId);
  try {
    await fs.remove(authDir);
    logger.info({ orgId, authDir }, "cleared auth directory");
  } catch (err) {
    logger.error({ err, orgId, authDir }, "failed clearing auth directory");
  }
}

// ----------- Helpers divers

// ✅ On NE considère pas @lid, @g.us, status, etc. comme des numéros de téléphone
function jidToPhone(jid?: string | null): string | null {
  if (!jid) return null;

  const [local, domain] = jid.split("@");
  if (!local) return null;

  if (
    domain === "lid" ||
    domain === "g.us" ||
    domain === "newsletter" ||
    local === "status" ||
    local.includes("-")
  ) {
    return null;
  }

  const digits = local.replace(/[^\d]/g, "");
  return digits || null;
}

function getConnectedPhone(sess: Session): string | null {
  const jid = sess.sock?.user?.id; // ex: "41782640976:52@s.whatsapp.net"
  if (!jid) return null;
  const main = jid.split(":")[0];
  const digits = main.replace(/[^\d]/g, "");
  return digits || null;
}

function buildMediaUrl(orgId: string, msgId: string): string | null {
  if (!PUBLIC_URL) return null;
  const base = PUBLIC_URL.replace(/\/+$/, "");
  return `${base}/wa/media/${encodeURIComponent(orgId)}/${encodeURIComponent(
    msgId
  )}`;
}

// ----------- Helper: extraire le texte d’un message

function extractMessageBody(msg: WAMessage): string | undefined {
  const m: any = msg.message;
  if (!m) return undefined;

  if (m.conversation) return m.conversation as string;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text as string;
  if (m.imageMessage?.caption) return m.imageMessage.caption as string;
  if (m.videoMessage?.caption) return m.videoMessage.caption as string;
  if (m.buttonsMessage?.contentText)
    return m.buttonsMessage.contentText as string;
  if (m.listMessage?.description) return m.listMessage.description as string;

  return undefined;
}

// ----------- Helper: envoyer vers le webhook externe

async function postWebhook(
  event: string,
  orgId: string,
  payload: any
): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        orgId,
        ts: Date.now(),
        payload,
      }),
    });
  } catch (err) {
    logger.error({ err, orgId, event }, "webhook error");
  }
}

// ----------- Helper: payload style Z-API pour un message

function buildZapiLikeMessage(msg: WAMessage, sess: Session, orgId: string): any {
  const m: any = msg.message || {};
  const connectedPhone = getConnectedPhone(sess);

  const remoteJid = (msg.key.remoteJid as string | undefined) || null;
  const remoteJidAlt = getRemoteJidAlt(msg);

  // ✅ si remoteJid = @lid, on essaie d'extraire le phone depuis remoteJidAlt
  const phone =
    jidToPhone(remoteJid || "") ||
    jidToPhone(remoteJidAlt || "");

  const isGroup = (remoteJid || "").endsWith("@g.us");
  const fromMe = !!msg.key.fromMe;
  const tsSec = Number(msg.messageTimestamp || 0) || 0;
  const tsMs = tsSec * 1000;

  const contact =
    (remoteJid && sess.contacts.get(remoteJid)) ||
    (remoteJidAlt && sess.contacts.get(remoteJidAlt)) ||
    (phone ? sess.contacts.get(`${phone}@s.whatsapp.net`) : undefined);

  const displayName =
    contact?.name ||
    contact?.shortName ||
    (msg as any).pushName ||
    phone ||
    remoteJidAlt ||
    remoteJid;

  const chatIdCanonical = computeCanonicalChatId(remoteJid, remoteJidAlt);

  const base: any = {
    isStatusReply: false,
    chatLid: null,
    connectedPhone,
    waitingMessage: false,
    isEdit: false,
    isGroup,
    isNewsletter: false,
    instanceId: orgId,
    messageId: msg.key.id,

    // ✅ identifiants
    remoteJid: remoteJid || null,
    remoteJidAlt: remoteJidAlt || null,

    // compat: ancien champ
    chatId: remoteJid || null,

    // ✅ nouveaux champs pour merger côté Supabase
    chatIdAlt: remoteJidAlt || null,
    chatIdCanonical,

    phone, // peut être null
    fromMe,
    momment: tsMs,
    status: fromMe ? "SENT" : "RECEIVED",
    chatName: displayName,
    senderPhoto: null,
    senderName: displayName,
    photo: null,
    broadcast: false,
    participantLid: null,
    forwarded: !!m.contextInfo?.isForwarded,
    type: "ReceivedCallback",
    fromApi: false,
  };

  // Texte
  const body = extractMessageBody(msg);
  if (body) {
    base.text = { message: body };
  }

  // Audio
  if (m.audioMessage) {
    base.audio = {
      ptt: !!m.audioMessage.ptt,
      seconds: m.audioMessage.seconds || 0,
      audioUrl:
        msg.key.id && PUBLIC_URL ? buildMediaUrl(orgId, msg.key.id) : null,
      mimeType: m.audioMessage.mimetype || "audio/ogg; codecs=opus",
      viewOnce: false,
    };
  }

  // Image
  if (m.imageMessage) {
    base.image = {
      imageUrl:
        msg.key.id && PUBLIC_URL ? buildMediaUrl(orgId, msg.key.id) : null,
      thumbnailUrl:
        msg.key.id && PUBLIC_URL ? buildMediaUrl(orgId, msg.key.id) : null,
      caption: m.imageMessage.caption || "",
      mimeType: m.imageMessage.mimetype || "image/jpeg",
      viewOnce: !!m.imageMessage.viewOnce,
      width: m.imageMessage.width || 0,
      height: m.imageMessage.height || 0,
    };
  }

  // Video
  if (m.videoMessage) {
    base.video = {
      videoUrl:
        msg.key.id && PUBLIC_URL ? buildMediaUrl(orgId, msg.key.id) : null,
      caption: m.videoMessage.caption || "",
      mimeType: m.videoMessage.mimetype || "video/mp4",
      viewOnce: !!m.videoMessage.viewOnce,
      seconds: m.videoMessage.seconds || 0,
    };
  }

  // Document
  if (m.documentMessage) {
    base.document = {
      documentUrl:
        msg.key.id && PUBLIC_URL ? buildMediaUrl(orgId, msg.key.id) : null,
      fileName: m.documentMessage.fileName,
      mimeType: m.documentMessage.mimetype,
      fileSize: m.documentMessage.fileLength,
    };
  }

  // Réaction
  if (m.reactionMessage) {
    base.reaction = {
      value:
        m.reactionMessage.text ||
        m.reactionMessage.emoji ||
        m.reactionMessage.reaction ||
        "",
      time: tsMs,
      reactionBy: phone,
      referencedMessage: {
        messageId: m.reactionMessage.key?.id,
        fromMe: m.reactionMessage.key?.fromMe,
        phone: jidToPhone(m.reactionMessage.key?.remoteJid) || null,
        participant: m.reactionMessage.key?.participant || null,
      },
    };
  }

  return base;
}

// Helpers pour normaliser ce qu’on garde en mémoire
function normalizeChat(raw: any): ChatSummary | null {
  if (!raw || !raw.id) return null;
  const id = raw.id as string;
  const isGroup = id.endsWith("@g.us");
  const name =
    raw.name || raw.subject || raw.pushName || raw.formattedName || id;
  const lastMessageTimestamp = Number(
    raw.conversationTimestamp ||
      raw.lastMessageRecv?.messageTimestamp ||
      raw.t ||
      0
  );
  const lastMessagePreview =
    raw.lastMessage?.conversation ||
    raw.lastMessage?.message?.conversation ||
    raw.lastMessage?.msg ||
    undefined;
  const unreadCount = raw.unreadCount;

  return {
    id,
    name,
    unreadCount,
    lastMessageTimestamp,
    lastMessagePreview,
    isGroup,
  };
}

function normalizeContact(raw: any): ContactSummary | null {
  if (!raw || !raw.id) return null;
  const id = raw.id as string;
  const name = raw.name || raw.notify || raw.pushName || id;
  const notify = raw.notify;
  const shortName = raw.shortName || raw.name || raw.pushName || name;
  return { id, name, notify, shortName };
}

// ----------- Session bootstrap

async function startSession(orgId: string): Promise<Session> {
  let sess = sessions.get(orgId);

  // Si déjà connecté, on renvoie
  if (sess?.sock && sess.status === "connected") {
    return sess;
  }

  const authDir = path.join(SESSIONS_DIR, orgId);
  await fs.ensureDir(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  if (!sess) {
    sess = createEmptySession(orgId);
  }

  sessions.set(orgId, sess);

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["Zuria", "Chrome", "1.0.0"],
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sess.sock = sock;
  sess.saveCreds = saveCreds;
  sess.status = "connecting";
  sess.qr = null;

  // Sauvegarde des creds
  sock.ev.on("creds.update", saveCreds);

  // Événements de connexion
  sock.ev.on("connection.update", (u: any) => {
    const { connection, lastDisconnect, qr } = u;

    // QR reçu
    if (qr) {
      sess!.qr = qr;
      sess!.status = "qr";
      getBus(orgId).emit("status", { type: "qr", qr });
    }

    // Ouvert
    if (connection === "open") {
      sess!.status = "connected";
      sess!.qr = null;
      getBus(orgId).emit("status", { type: "connected", user: sock.user });
      logger.info({ orgId }, "WA connected");

      void postWebhook("connection.open", orgId, { user: sock.user });
      return;
    }

    // Fermé
    if (connection === "close") {
      const code: number =
        (lastDisconnect as any)?.error?.output?.statusCode ?? 0;

      const fatalCodes: number[] = [
        DisconnectReason.loggedOut,
        DisconnectReason.forbidden,
        DisconnectReason.badSession,
        DisconnectReason.connectionReplaced,
      ];

      const willReconnect = !fatalCodes.includes(code);

      sess!.status = "closed";
      getBus(orgId).emit("status", { type: "closed", code, willReconnect });

      logger.warn({ orgId, code, willReconnect }, "WA closed");

      void postWebhook("connection.close", orgId, { code, willReconnect });

      if (!willReconnect) {
        sessions.delete(orgId);
        clearSessionAuth(orgId).catch(() => {});
      } else {
        setTimeout(() => {
          logger.info({ orgId, code }, "auto-restart WA session");
          startSession(orgId).catch((err) =>
            logger.error({ err, orgId }, "failed to restart session")
          );
        }, 1000);
      }
    }
  });

  // Historique initial (chats, contacts, messages)
  sock.ev.on("messaging-history.set", (payload: any) => {
    const { chats, contacts, messages, syncType } = payload || {};

    if (Array.isArray(chats)) {
      for (const c of chats) {
        const summary = normalizeChat(c);
        if (summary) sess!.chats.set(summary.id, summary);
      }
    }

    if (Array.isArray(contacts)) {
      for (const c of contacts) {
        const summary = normalizeContact(c);
        if (summary) sess!.contacts.set(summary.id, summary);
      }
    }

    if (Array.isArray(messages)) {
      for (const msg of messages as WAMessage[]) {
        if (msg.key && msg.key.id) sess!.msgCache.set(msg.key.id, msg);

        // ✅ on profite de l'historique si remoteJidAlt est présent pour enrichir le mapping
        const rj = (msg.key.remoteJid as string | undefined) || null;
        const rja = getRemoteJidAlt(msg);
        rememberFromKey(sess!, rj, rja);
      }
    }

    getBus(orgId).emit("history", {
      type: "set",
      syncType,
      chats: Array.from(sess!.chats.values()),
      contacts: Array.from(sess!.contacts.values()),
    });
  });

  // Chats & contacts live updates
  sock.ev.on("chats.upsert", (up: any) => {
    const arr = Array.isArray(up) ? up : up?.chats || [];
    const updated: ChatSummary[] = [];

    for (const c of arr) {
      const summary = normalizeChat(c);
      if (summary) {
        sess!.chats.set(summary.id, summary);
        updated.push(summary);
      }
    }

    if (updated.length) {
      getBus(orgId).emit("chats", { type: "upsert", chats: updated });
    }
  });

  sock.ev.on("chats.update", (updates: any) => {
    const updated: ChatSummary[] = [];

    for (const u of updates || []) {
      const id = u.id as string;
      const existing = sess!.chats.get(id) || ({ id } as ChatSummary);

      const merged: ChatSummary = {
        ...existing,
        unreadCount:
          u.unreadCount !== undefined ? u.unreadCount : existing.unreadCount,
        lastMessageTimestamp:
          u.conversationTimestamp !== undefined
            ? Number(u.conversationTimestamp)
            : existing.lastMessageTimestamp,
      };

      if (u.name || u.subject) merged.name = u.name || u.subject;

      sess!.chats.set(id, merged);
      updated.push(merged);
    }

    if (updated.length) {
      getBus(orgId).emit("chats", { type: "update", chats: updated });
    }
  });

  sock.ev.on("contacts.upsert", (up: any) => {
    const arr = Array.isArray(up) ? up : up?.contacts || [];
    const updated: ContactSummary[] = [];

    for (const c of arr) {
      const summary = normalizeContact(c);
      if (summary) {
        sess!.contacts.set(summary.id, summary);
        updated.push(summary);
      }
    }

    if (updated.length) {
      getBus(orgId).emit("contacts", { type: "upsert", contacts: updated });
    }
  });

  sock.ev.on("contacts.update", (updates: any) => {
    const updated: ContactSummary[] = [];

    for (const u of updates || []) {
      const id = u.id as string;
      const existing = sess!.contacts.get(id) || ({ id } as ContactSummary);

      const merged: ContactSummary = {
        ...existing,
        name: u.name || u.notify || existing.name,
        notify: u.notify ?? existing.notify,
        shortName: u.shortName ?? existing.shortName,
      };

      sess!.contacts.set(id, merged);
      updated.push(merged);
    }

    if (updated.length) {
      getBus(orgId).emit("contacts", { type: "update", contacts: updated });
    }
  });

  // Messages entrants => cache + bus + webhook (INBOUND uniquement)
  sock.ev.on("messages.upsert", (m: any) => {
    const up = m.messages || [];
    for (const msg of up as WAMessage[]) {
      if (msg.key && msg.key.id) sess!.msgCache.set(msg.key.id, msg);

      const messageType = msg.message ? Object.keys(msg.message)[0] : undefined;
      const body = extractMessageBody(msg);

      // 🧪 LOG SPÉCIAL : messages sortants contenant "zuria.ai/tradein"
      if (msg.key.fromMe && body?.includes("zuria.ai/tradein")) {
        logger.info(
          {
            orgId,
            key: msg.key,
            messageType,
            body,
            rawMessage: msg.message,
          },
          "GW OUTGOING TRADEIN MESSAGE"
        );
      }

      const remoteJid = (msg.key.remoteJid as string | undefined) || null;
      const remoteJidAlt = getRemoteJidAlt(msg);

      // ✅ enrichit mapping PN<->LID dès qu'on le voit
      rememberFromKey(sess!, remoteJid, remoteJidAlt);

      const chatIdCanonical = computeCanonicalChatId(remoteJid, remoteJidAlt);

      const simplified = {
        id: msg.key.id,
        from: remoteJid,
        fromAlt: remoteJidAlt,
        chatIdCanonical,
        fromMe: msg.key.fromMe,
        pushName: (msg as any).pushName,
        timestamp: (msg.messageTimestamp || 0).toString(),
        messageType,
        body,
      };

      // 🔴 SSE pour Lovable (UI)
      getBus(orgId).emit("message", {
        type: "message",
        message: simplified,
      });

      // 🔔 Webhook Supabase (INBOUND) :
      if (!msg.key.fromMe) {
        const zmsg = buildZapiLikeMessage(msg, sess!, orgId);

        const webhookPayload = {
          ...simplified,
          zapi: zmsg,
        };

        void postWebhook("message.incoming", orgId, webhookPayload);
      }
    }
  });

  sock.ev.on("messages.update", (updates: any) => {
    getBus(orgId).emit("messages.update", updates);
    void postWebhook("messages.update", orgId, updates);
  });

  sock.ev.on("message-receipt.update", (r: any) => {
    getBus(orgId).emit("receipt", r);
    void postWebhook("message-receipt.update", orgId, r);
  });

  return sess;
}

// ----------- SSE (événements temps réel)

app.get("/wa/sse", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  if (!orgId) return res.status(400).end("orgId required");

  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const bus = getBus(orgId);

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const s = sessions.get(orgId);
  send("hello", {
    orgId,
    status: s?.status || "closed",
    hasQR: Boolean(s?.qr),
    connected: Boolean(s?.sock?.user),
    user: s?.sock?.user || null,
  });

  if (s?.qr) {
    const qrSvg = await QRCode.toString(s.qr, { type: "svg" });
    send("qr", { qr: s.qr, svg: qrSvg });
  }

  if (s && (s.chats.size || s.contacts.size)) {
    send("history", {
      type: "set",
      syncType: "initial",
      chats: Array.from(s.chats.values()),
      contacts: Array.from(s.contacts.values()),
    });
  }

  const onStatus = (data: any) => send("status", data);
  const onMessage = (data: any) => send("message", data);
  const onUpdate = (data: any) => send("messages.update", data);
  const onReceipt = (data: any) => send("receipt", data);
  const onHistory = (data: any) => send("history", data);
  const onChats = (data: any) => send("chats", data);
  const onContacts = (data: any) => send("contacts", data);

  bus.on("status", onStatus);
  bus.on("message", onMessage);
  bus.on("messages.update", onUpdate);
  bus.on("receipt", onReceipt);
  bus.on("history", onHistory);
  bus.on("chats", onChats);
  bus.on("contacts", onContacts);

  const interval = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(interval);
    bus.off("status", onStatus);
    bus.off("message", onMessage);
    bus.off("messages.update", onUpdate);
    bus.off("receipt", onReceipt);
    bus.off("history", onHistory);
    bus.off("chats", onChats);
    bus.off("contacts", onContacts);
  });
});

// ----------- Auth / Status

app.post("/wa/login", async (req: Request, res: Response) => {
  const { orgId } = req.body || {};
  if (!orgId) {
    return res.status(400).json({ ok: false, error: "orgId required" });
  }

  try {
    const s = await startSession(String(orgId));
    res.json({
      ok: true,
      status: s.status,
      hasQR: Boolean(s.qr),
      user: s.sock?.user || null,
    });
  } catch (err) {
    logger.error({ err, orgId }, "login error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/wa/status", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  if (!orgId) {
    return res.status(400).json({ ok: false, error: "orgId required" });
  }

  const s = sessions.get(orgId);
  res.json({
    ok: true,
    status: s?.status || "closed",
    hasQR: Boolean(s?.qr),
    user: s?.sock?.user || null,
    connected: Boolean(s?.sock?.user),
  });
});

app.get("/wa/qr", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  if (!orgId) {
    return res.status(400).json({ ok: false, error: "orgId required" });
  }

  const s = sessions.get(orgId);
  if (!s?.qr) {
    return res.status(404).json({ ok: false, error: "No pending QR" });
  }

  const svg = await QRCode.toString(s.qr, { type: "svg" });
  res.json({ ok: true, qr: s.qr, svg });
});

// ➕ Bootstrap : renvoyer les dernières conversations + contacts
app.get("/wa/bootstrap", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  const limit = Number(req.query.limit || 20);

  if (!orgId) {
    return res.status(400).json({ ok: false, error: "orgId required" });
  }

  const s = sessions.get(orgId);
  if (!s) {
    return res.status(404).json({ ok: false, error: "No session" });
  }

  const chats = Array.from(s.chats.values()).sort(
    (a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0)
  );

  const contacts = Array.from(s.contacts.values());

  res.json({
    ok: true,
    chats: chats.slice(0, limit),
    contacts,
  });
});

// ➕ Avatar à la demande
app.get("/wa/profile-picture", async (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  const jid = String(req.query.jid || "");
  if (!orgId || !jid) {
    return res.status(400).json({ ok: false, error: "orgId,jid required" });
  }

  const s = getSessionOr404(orgId, res);
  if (!s) return;

  try {
    const url = await s.sock!.profilePictureUrl(jid, "image");
    res.json({ ok: true, url: url || null });
  } catch (err) {
    logger.warn({ err, orgId, jid }, "profile picture error");
    res.json({ ok: true, url: null });
  }
});

app.post("/wa/logout", async (req: Request, res: Response) => {
  const { orgId } = req.body || {};
  if (!orgId) {
    return res.status(400).json({ ok: false, error: "orgId required" });
  }

  const id = String(orgId);
  const s = sessions.get(id);

  try {
    await s?.sock?.logout();
  } catch (e) {
    logger.warn({ e, orgId: id }, "logout error (ignored)");
  }

  sessions.delete(id);

  await clearSessionAuth(id);

  res.json({ ok: true });
});

// ----------- LID Resolver (PN -> LID)

// Auth optionnelle: si WA_API_KEY (ou GATEWAY_API_KEY / WA_GATEWAY_API_KEY) est défini
// et AUTH_DISABLED n'est pas activé, alors on exige une clé.
const AUTH_DISABLED =
  String(process.env.AUTH_DISABLED || "").toLowerCase() === "1" ||
  String(process.env.AUTH_DISABLED || "").toLowerCase() === "true";

const WA_API_KEY =
  process.env.WA_API_KEY ||
  process.env.GATEWAY_API_KEY ||
  process.env.WA_GATEWAY_API_KEY ||
  "";

function checkAuth(req: Request, res: Response): boolean {
  if (AUTH_DISABLED) return true;
  if (!WA_API_KEY) return true;

  const headerKey =
    (req.headers["x-api-key"] as string) ||
    (req.headers["x-gateway-key"] as string) ||
    "";

  const auth = (req.headers["authorization"] as string) || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  const provided = headerKey || bearer;

  if (!provided || provided !== WA_API_KEY) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }

  return true;
}

app.post("/wa/resolve", async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;

  const { orgId, to, sendTest, testText } = req.body || {};

  if (!orgId || !to) {
    return res
      .status(400)
      .json({ ok: false, error: "orgId,to required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    // 1) resolve via cache / lidMapping
    const before = await resolveSendJid(s, String(to));

    let sentKey: any = null;
    let after = before;

    // 2) option: envoyer un ping réel (utile si mapping pas encore "chaud")
    if (Boolean(sendTest)) {
      const text = String(testText || "ping");

      logger.info(
        { orgId, to, before, text },
        "GW /wa/resolve sendTest: sending ping"
      );

      const sent = await s.sock!.sendMessage(before.sendTo, { text });
      sentKey = sent?.key || null;

      // petite pause pour laisser Baileys enrichir lidMapping si ça arrive
      await new Promise((r) => setTimeout(r, 700));

      after = await resolveSendJid(s, String(to));
    }

    return res.json({
      ok: true,
      orgId: String(orgId),
      input: String(to),
      before, // { pn, lid, sendTo }
      after,  // { pn, lid, sendTo }
      sentKey,
    });
  } catch (err) {
    logger.error({ err, orgId, to }, "GW /wa/resolve error");
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ----------- ENVOI DE MESSAGES (OUTBOUND) + webhook

app.post("/wa/send/text", async (req: Request, res: Response) => {
  const {
    orgId,
    to,
    text,
    quotedMsgId,
    mentions,
    link_preview,
    linkPreview,
  } = req.body || {};

  if (!orgId || !to || !text) {
    return res.status(400).json({ ok: false, error: "orgId,to,text required" });
  }

  logger.info({ body: req.body }, "GW /wa/send/text incoming payload");

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    // ✅ PN -> LID si dispo
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));

    const options: any = {};

    if (quotedMsgId) {
      options.quoted = {
        key: { id: quotedMsgId, fromMe: false, remoteJid: sendTo },
      };
    }

    const enablePreview = link_preview ?? linkPreview;
    if (enablePreview) options.linkPreview = true;

    const content: AnyMessageContent = { text: String(text) };
    if (Array.isArray(mentions) && mentions.length) {
      (content as any).mentions = mentions.map((p: string) => phoneToJid(p));
    }

    logger.info({ pn, lid, sendTo, content, options }, "GW /wa/send/text before sendMessage");

    const sent = await s.sock!.sendMessage(sendTo, content, options);

    logger.info({ key: sent?.key }, "GW /wa/send/text sent");

    void postWebhook("message.outgoing", String(orgId), {
      kind: "text",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      body: String(text),
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    logger.error({ err: String(err), orgId, to, text }, "GW /wa/send/text error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/wa/send/image", async (req: Request, res: Response) => {
  const { orgId, to, caption, image } = req.body || {};
  if (!orgId || !to || !image) {
    return res.status(400).json({ ok: false, error: "orgId,to,image required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));
    const buf = await bufferFromInput(image);

    const msg: AnyMessageContent = buf
      ? { image: buf, caption }
      : { image: { url: image.url }, caption };

    const sent = await s.sock!.sendMessage(sendTo, msg);

    void postWebhook("message.outgoing", String(orgId), {
      kind: "image",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      caption: caption || null,
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/wa/send/document", async (req: Request, res: Response) => {
  const { orgId, to, fileName, mimetype, document } = req.body || {};
  if (!orgId || !to || !document) {
    return res.status(400).json({ ok: false, error: "orgId,to,document required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));
    const buf = await bufferFromInput(document);

    const msg: AnyMessageContent = buf
      ? { document: buf, fileName: fileName || "file", mimetype }
      : { document: { url: document.url }, fileName: fileName || "file", mimetype };

    const sent = await s.sock!.sendMessage(sendTo, msg);

    void postWebhook("message.outgoing", String(orgId), {
      kind: "document",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      fileName: fileName || "file",
      mimetype: mimetype || null,
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/wa/send/audio", async (req: Request, res: Response) => {
  const { orgId, to, ptt, audio } = req.body || {};
  if (!orgId || !to || !audio) {
    return res.status(400).json({ ok: false, error: "orgId,to,audio required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));
    const buf = await bufferFromInput(audio);

    const msg: AnyMessageContent = buf
      ? { audio: buf, ptt: Boolean(ptt) }
      : { audio: { url: audio.url }, ptt: Boolean(ptt) };

    const sent = await s.sock!.sendMessage(sendTo, msg);

    void postWebhook("message.outgoing", String(orgId), {
      kind: "audio",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      ptt: Boolean(ptt),
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/wa/send/buttons", async (req: Request, res: Response) => {
  const { orgId, to, text, footer, buttons } = req.body || {};
  if (!orgId || !to || !text || !Array.isArray(buttons)) {
    return res.status(400).json({ ok: false, error: "orgId,to,text,buttons required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));

    const msg: AnyMessageContent = {
      text,
      footer,
      buttons: buttons.map((b: any, i: number) => ({
        buttonId: String(b.id ?? `btn_${i + 1}`),
        buttonText: { displayText: String(b.label ?? b.text ?? `Option ${i + 1}`) },
        type: 1,
      })),
      headerType: 1,
    } as any;

    const sent = await s.sock!.sendMessage(sendTo, msg);

    void postWebhook("message.outgoing", String(orgId), {
      kind: "buttons",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      text,
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/wa/send/list", async (req: Request, res: Response) => {
  const { orgId, to, title, text, footer, buttonText, sections } = req.body || {};
  if (!orgId || !to || !text || !Array.isArray(sections)) {
    return res.status(400).json({ ok: false, error: "orgId,to,text,sections required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  try {
    const { pn, lid, sendTo } = await resolveSendJid(s, String(to));

    const msg: AnyMessageContent = {
      text,
      footer,
      title,
      buttonText: buttonText || "Choisir",
      sections: sections.map((sec: any) => ({
        title: String(sec.title || ""),
        rows: (sec.rows || []).map((r: any, i: number) => ({
          rowId: String(r.id ?? `row_${i + 1}`),
          title: String(r.title ?? `Option ${i + 1}`),
          description: r.description ? String(r.description) : undefined,
        })),
      })),
    } as any;

    const sent = await s.sock!.sendMessage(sendTo, msg);

    void postWebhook("message.outgoing", String(orgId), {
      kind: "list",
      to: sendTo,
      toPn: pn,
      toLid: lid,
      key: sent.key,
      title,
      text,
    });

    res.json({ ok: true, key: sent.key, to: sendTo, toPn: pn, toLid: lid });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ----------- Lecture messages récents (et médias)

app.get("/wa/messages/recent", (req: Request, res: Response) => {
  const orgId = String(req.query.orgId || "");
  const limit = Number(req.query.limit || 50);

  const s = sessions.get(orgId);
  if (!s) {
    return res.status(404).json({ ok: false, error: "No session" });
  }

  const out: any[] = [];

  s.msgCache.forEach((msg, id) => {
    const body = extractMessageBody(msg);
    const remoteJid = (msg.key.remoteJid as string | undefined) || null;
    const remoteJidAlt = getRemoteJidAlt(msg);

    out.push({
      id,
      from: remoteJid,
      fromAlt: remoteJidAlt,
      chatIdCanonical: computeCanonicalChatId(remoteJid, remoteJidAlt),
      fromMe: msg.key.fromMe,
      timestamp: (msg.messageTimestamp || 0).toString(),
      type: msg.message ? Object.keys(msg.message)[0] : undefined,
      body,
    });
  });

  out.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

  res.json({ ok: true, messages: out.slice(0, limit) });
});

app.post("/wa/media/download", async (req: Request, res: Response) => {
  const { orgId, msgId } = req.body || {};
  if (!orgId || !msgId) {
    return res.status(400).json({ ok: false, error: "orgId,msgId required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  const msg = s.msgCache.get(String(msgId));
  if (!msg) {
    return res.status(404).json({ ok: false, error: "Message not in cache" });
  }

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: s.sock!.updateMediaMessage }
    );

    const m =
      (msg.message as any)?.imageMessage?.mimetype ||
      (msg.message as any)?.videoMessage?.mimetype ||
      (msg.message as any)?.documentMessage?.mimetype ||
      (msg.message as any)?.audioMessage?.mimetype ||
      mimeLookup("bin") ||
      "application/octet-stream";

    const base64 = buffer.toString("base64");

    res.json({
      ok: true,
      mimetype: m,
      base64: `data:${m};base64,${base64}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ➕ GET direct pour media (pour audioUrl / imageUrl style Z-API)
app.get("/wa/media/:orgId/:msgId", async (req: Request, res: Response) => {
  const { orgId, msgId } = req.params;
  if (!orgId || !msgId) {
    return res.status(400).json({ ok: false, error: "orgId,msgId required" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  const msg = s.msgCache.get(String(msgId));
  if (!msg) {
    return res.status(404).json({ ok: false, error: "Message not in cache" });
  }

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: s.sock!.updateMediaMessage }
    );

    const m =
      (msg.message as any)?.imageMessage?.mimetype ||
      (msg.message as any)?.videoMessage?.mimetype ||
      (msg.message as any)?.documentMessage?.mimetype ||
      (msg.message as any)?.audioMessage?.mimetype ||
      mimeLookup("bin") ||
      "application/octet-stream";

    res.setHeader("Content-Type", m as string);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ----------- Vérification de numéros WhatsApp — VERSION CORRIGÉE (v2)
// Remplace ENTIÈREMENT le bloc /wa/check-numbers précédent dans src/server.ts de zuria_wa.
//
// Corrections v2 :
//  - onWhatsApp() reçoit des numéros BRUTS (digits), pas des JID — c'était la cause
//    des "Pas sur WhatsApp" systématiques.
//  - Mapping des résultats par digits (gère les retours jid PN ou LID de Baileys v7).
//  - Réponse: { ok, results: [{ number, input, exists, jid }] }
//
// POST /wa/check-numbers   Body: { orgId: string, numbers: string[] }  (max 50)

app.post("/wa/check-numbers", async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;

  const { orgId, numbers } = req.body || {};

  if (!orgId || !Array.isArray(numbers) || numbers.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "orgId, numbers[] required" });
  }

  if (numbers.length > 50) {
    return res
      .status(400)
      .json({ ok: false, error: "max 50 numbers per call" });
  }

  const s = getSessionOr404(String(orgId), res);
  if (!s) return;

  const toDigits = (n: string) =>
    String(n).replace(/[^\d]/g, "").replace(/^00/, "");

  try {
    const results: {
      number: string;
      input: string;
      exists: boolean;
      jid: string | null;
    }[] = [];

    const CHUNK = 10;
    for (let i = 0; i < numbers.length; i += CHUNK) {
      const chunk = numbers.slice(i, i + CHUNK).map(String);
      // ✅ Baileys onWhatsApp attend des numéros bruts, PAS des JID
      const digits = chunk.map(toDigits);

      const found = await s.sock!.onWhatsApp(...digits);

      // Map par digits — le jid retourné peut être PN (417...@s.whatsapp.net)
      // ou, selon les builds v7, un LID ; on extrait les digits du jid PN
      // et on garde aussi l'ordre de la requête comme filet.
      const existsByDigits = new Map<string, { exists: boolean; jid: string | null }>();
      for (const f of (found || []) as any[]) {
        const jid: string = String(f.jid || "");
        const d = toDigits(jid.split("@")[0].split(":")[0]);
        if (d) existsByDigits.set(d, { exists: Boolean(f.exists), jid });
      }

      for (let j = 0; j < chunk.length; j++) {
        const d = digits[j];
        const hit = existsByDigits.get(d);
        results.push({
          number: chunk[j],
          input: chunk[j],
          exists: hit ? hit.exists : false,
          jid: hit?.exists ? hit.jid : null,
        });
      }

      if (i + CHUNK < numbers.length) {
        await new Promise((r) =>
          setTimeout(r, 1500 + Math.floor(Math.random() * 1500))
        );
      }
    }

    logger.info(
      {
        orgId,
        total: numbers.length,
        found: results.filter((r) => r.exists).length,
      },
      "GW /wa/check-numbers done"
    );

    return res.json({ ok: true, results });
  } catch (err) {
    logger.error({ err, orgId }, "GW /wa/check-numbers error");
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ----------- Health

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "zuria-baileys", ts: Date.now() })
);

// ----------- Boot

async function main() {
  await fs.ensureDir(SESSIONS_DIR);
  app.listen(PORT, () => {
    logger.info(`HTTP listening on :${PORT}`);
  });
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
