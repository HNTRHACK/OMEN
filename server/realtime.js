// Real-time layer (Socket.IO), on the same HTTP server as the game and the API.
//
//   /world     multiplayer: rooms, player state, interaction feed
//   /merchant  a merchant's live payment notifications (needs that merchant's access key)
//
// The server relays but never trusts: every message is validated, rate-limited and stripped to
// what other players are allowed to see. Wallet balances, addresses and payment amounts are never
// broadcast to the world.
import { Server } from "socket.io";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { merchantById } from "../shared/merchants.js";
import { cleanLook, lookFromOutfit } from "../shared/look.js";
import { playerIdOf, TOKEN_RE, ID_RE } from "./identity.js";
import { moderateText } from "./moderation.js";

export const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
export const OUTFITS = 6;
const RECONNECT_GRACE_MS = 10_000;
const MAX_PER_ROOM = 16;
const ACTS = {
  talk: new Set(["maya", "orin", "echo", "relay", "board", "alfred"]),
  scan: new Set(["maya-chai", "orin-relay"]),
  paid: new Set(["maya-chai", "orin-relay"]), // no amount, no address: just "X paid Maya"
  coin: new Set(["btc", "eth", "sol", "usdt", "usdc", "wbt"]),
  wave: new Set([""]),
  cheer: new Set([""]),
};

export function cleanName(s) {
  const n = String(s ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g, "")
    .trim()
    .slice(0, 16);
  return n || "Courier";
}

const finite = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Number.isFinite(x));
/** Validate + normalise one movement snapshot; null if it's junk. */
export function cleanState(s) {
  if (!s || !finite(s.d, 3) || !finite(s.f, 3)) return null;
  const len = Math.hypot(...s.d);
  const flen = Math.hypot(...s.f);
  if (len < 0.5 || len > 1.5 || flen < 0.1) return null;
  const r = (x) => Math.round(x * 1e5) / 1e5;
  return {
    d: s.d.map((x) => r(x / len)),
    f: s.f.map((x) => r(x / flen)),
    h: Math.max(0, Math.min(3, Number(s.h) || 0)),
    sp: Math.max(0, Math.min(8, Number(s.sp) || 0)),
    air: !!s.air,
    talk: !!s.talk,
    hold: !!s.hold,
    t: Date.now(),
  };
}

/** Per-socket token bucket. */
function limiter(perSec, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const t = Date.now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Merchant access keys from MERCHANT_KEYS="maya-chai:secret,orin-relay:secret2". */
export function merchantKeys(env = process.env.MERCHANT_KEYS || "") {
  const m = new Map();
  for (const pair of env.split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return m;
}
const hash = (s) => createHash("sha256").update(String(s)).digest();
export function checkMerchantKey(keys, merchantId, key) {
  const want = keys.get(merchantId);
  return !!want && timingSafeEqual(hash(want), hash(key)); // constant-time, length-independent
}

/** What a merchant's live view may show about a payment (no UPI IDs, no risk internals). */
export function merchantView(p) {
  return {
    id: p.id,
    merchant: p.merchant?.id,
    state: p.state,
    mode: p.mode,
    inrPaise: p.quote.inrPaise,
    token: p.quote.token,
    amount: p.quote.tokenAmount,
    payer: p.payer || null,
    txHash: p.txHash || null,
    orderId: p.chain?.orderId || null, // on-chain order id, needed for refunds
    amountUnits: p.quote.tokenUnits,
    relayed: !!p.relayed,
    inr: p.payout ? { real: !!p.payout.real, label: p.payout.label } : null,
    note: p.upi?.note || "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function attachRealtime(httpServer, { merchantAccess = merchantKeys(), isMuted = () => false } = {}) {
  const chatLog = new Map(); // room → last messages, for players who arrive mid-conversation
  const io = new Server(httpServer, { serveClient: false, maxHttpBufferSize: 4096, pingInterval: 10_000, pingTimeout: 8_000 });
  const rooms = new Map(); // room → Map(playerId → player)
  const ghosts = new Map(); // playerId → { room, timer } (disconnected, may come back)

  // ---------------------------------------------------------------- world
  const world = io.of("/world");
  world.on("connection", (sock) => {
    const allow = limiter(25, 40);
    let me = null;

    sock.on("join", (msg, ack) => {
      if (typeof ack !== "function" || me) return;
      const room = String(msg?.room || "").toLowerCase();
      if (!ROOM_RE.test(room)) return ack({ error: "Room codes are 3–24 letters, digits or dashes." });
      if (!rooms.has(room)) rooms.set(room, new Map());
      const players = rooms.get(room);
      const look = msg?.look ? cleanLook(msg.look) : lookFromOutfit(Math.abs(Math.trunc(Number(msg?.outfit) || 0)) % OUTFITS);
      const name = cleanName(msg?.name);
      // Identity: a guest token gives a stable id across refreshes and reconnects. (Old clients
      // without one get a per-tab id they can resume with.)
      const token = typeof msg?.token === "string" && TOKEN_RE.test(msg.token) ? msg.token : null;
      const resume = !token && typeof msg?.resume === "string" && ID_RE.test(msg.resume) ? msg.resume : null;
      const id = token ? playerIdOf(token) : resume;
      const existing = id ? players.get(id) : null;
      if (existing) {
        const ghost = ghosts.get(id);
        if (ghost) {
          clearTimeout(ghost.timer);
          ghosts.delete(id);
        }
        if (existing.sock && existing.sock !== sock.id) world.sockets.get(existing.sock)?.emit("replaced"); // same courier opened elsewhere
        me = existing;
        const changed = me.name !== name || JSON.stringify(me.look) !== JSON.stringify(look);
        if (token) Object.assign(me, { name, look });
        if (changed && token) sock.to(room).emit("look", { id: me.id, name: me.name, look: me.look });
      } else {
        if (players.size >= MAX_PER_ROOM) return ack({ error: "This room is full." });
        me = { id: id || randomBytes(12).toString("hex"), name, look, s: null, room };
        players.set(me.id, me);
        sock.to(room).emit("joined", pub(me));
      }
      me.sock = sock.id;
      sock.data.playerId = me.id; // for per-player notifications (orders, invoices)
      sock.join(room);
      ack({ id: me.id, room, players: [...players.values()].filter((p) => p.id !== me.id).map(pub), chat: chatLog.get(room) || [] });
    });

    const chatAllow = limiter(0.8, 4); // ~1 message a second, short bursts
    sock.on("chat", (msg, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!me) return reply({ error: "Join the world first." });
      if (isMuted(me.id)) return reply({ error: "A moderator has muted this courier." });
      if (!chatAllow()) return reply({ error: "Slow down a little." });
      const r = moderateText(msg?.text, { max: 160, min: 1, links: 0 });
      if (!r.ok) return reply({ error: r.reason });
      const line = { id: me.id, name: me.name, text: r.text, t: Date.now() };
      const log = chatLog.get(me.room) || [];
      log.push(line);
      chatLog.set(me.room, log.slice(-30));
      world.to(me.room).emit("chat", line);
      reply({ ok: true });
    });

    sock.on("look", (l) => {
      if (!me || !allow()) return;
      me.look = cleanLook(l);
      sock.to(me.room).emit("look", { id: me.id, name: me.name, look: me.look });
    });

    sock.on("state", (s) => {
      if (!me || !allow()) return;
      const c = cleanState(s);
      if (!c) return;
      me.s = c;
      sock.to(me.room).volatile.emit("state", { id: me.id, ...c });
    });

    sock.on("act", (a) => {
      if (!me || !allow()) return;
      const kind = String(a?.kind || "");
      const target = String(a?.target ?? "");
      if (!ACTS[kind]?.has(target)) return;
      sock.to(me.room).emit("act", { id: me.id, kind, target });
    });

    sock.on("disconnect", () => {
      if (!me) return;
      const p = me;
      if (p.sock !== sock.id) return; // replaced by a newer connection of the same courier
      // Keep the player briefly so a flaky connection resumes instead of leaving and rejoining.
      ghosts.set(p.id, {
        room: p.room,
        timer: setTimeout(() => {
          ghosts.delete(p.id);
          rooms.get(p.room)?.delete(p.id);
          if (!rooms.get(p.room)?.size) rooms.delete(p.room);
          world.to(p.room).emit("left", { id: p.id, name: p.name });
        }, RECONNECT_GRACE_MS),
      });
    });
  });
  const pub = (p) => ({ id: p.id, name: p.name, look: p.look, outfit: p.look.jacket, s: p.s });

  // ---------------------------------------------------------------- merchant notifications
  const merchant = io.of("/merchant");
  merchant.use((sock, next) => {
    const { merchantId, key } = sock.handshake.auth || {};
    if (!merchantById(merchantId) || !checkMerchantKey(merchantAccess, merchantId, key)) return next(new Error("unauthorized"));
    sock.data.merchantId = merchantId;
    next();
  });
  merchant.on("connection", (sock) => sock.join(`m:${sock.data.merchantId}`));

  return {
    io,
    /** Call on every payment change; merchants hear about their own testnet/demo payments. */
    notifyPayment(p) {
      if (!p.merchant?.id) return;
      if (!["SUBMITTED", "COMPLETED", "FAILED", "CONFIRMED"].includes(p.state)) return;
      merchant.to(`m:${p.merchant.id}`).emit("payment", merchantView(p));
    },
    stats: () => ({ rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.size, 0) }),
    /** Send to every connected socket of one player (any room). */
    toPlayer(id, ev, data) {
      if (!id) return;
      for (const s of world.sockets.values()) if (s.data.playerId === id) s.emit(ev, data);
    },
    /** Send to every connected player (shop, billboard and forum updates are world-wide). */
    toAll(ev, data) {
      world.emit(ev, data);
    },
  };
}
