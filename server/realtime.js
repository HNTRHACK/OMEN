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

export const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
export const OUTFITS = 6;
const RECONNECT_GRACE_MS = 10_000;
const MAX_PER_ROOM = 16;
const ACTS = {
  talk: new Set(["maya", "orin", "echo", "relay", "board"]),
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
    relayed: !!p.relayed,
    inr: p.payout ? { real: !!p.payout.real, label: p.payout.label } : null,
    note: p.upi?.note || "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function attachRealtime(httpServer, { merchantAccess = merchantKeys() } = {}) {
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
      // Reconnect: the same browser tab gets its old player back instead of a duplicate.
      const resume = typeof msg?.resume === "string" && /^[a-f0-9]{24}$/.test(msg.resume) ? msg.resume : null;
      const ghost = resume && ghosts.get(resume);
      if (ghost && ghost.room === room) {
        clearTimeout(ghost.timer);
        ghosts.delete(resume);
        me = players.get(resume);
      }
      if (!me) {
        if (players.size >= MAX_PER_ROOM) return ack({ error: "This room is full." });
        me = { id: randomBytes(12).toString("hex"), name: cleanName(msg?.name), outfit: Math.abs(Math.trunc(Number(msg?.outfit) || 0)) % OUTFITS, s: null, room };
        players.set(me.id, me);
        sock.to(room).emit("joined", pub(me));
      }
      me.sock = sock.id;
      sock.join(room);
      ack({ id: me.id, room, players: [...players.values()].filter((p) => p.id !== me.id).map(pub) });
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
  const pub = (p) => ({ id: p.id, name: p.name, outfit: p.outfit, s: p.s });

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
  };
}
