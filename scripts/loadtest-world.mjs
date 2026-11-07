// Multiplayer load test: N bot couriers in the public world, all moving (worst case: nobody idle),
// plus every bot watching the shared Bounty Royale arena while verified bots place picks.
// Run against e2e/royale-harness.mjs (it exposes /__metrics: event-loop delay, CPU, memory).
//   node scripts/loadtest-world.mjs http://localhost:5195 200 30
// Reports: join latency, movement delivery latency (sender → server tick → receiver, one machine
// so one clock), Royale broadcast latency, server event-loop lag / CPU / memory, disconnects,
// received bandwidth per client. Exit code 1 if any pass criterion fails.
import { io } from "socket.io-client";
import { randomBytes } from "node:crypto";

const BASE = (process.argv[2] || "http://localhost:5195").replace(/\/$/, "");
const N = Number(process.argv[3] || 50);
const SECONDS = Number(process.argv[4] || 30);
const SEND_HZ = 12; // the real client's rate
const STAKERS = Math.min(10, N);

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
const key = (d) => d.map((x) => Math.round(x * 1e4)).join(",");

const sent = new Map(); // botId → Map(dKey → sentAt)
const moveLat = [];
const joinLat = [];
const royaleLat = [];
let bytes = 0;
let statesMsgs = 0;
let entries = 0;
let disconnects = 0;
let joinErrors = [];
const bots = [];

function unit(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

async function bot(i) {
  const token = randomBytes(32).toString("hex");
  const s = io(`${BASE}/world`, { transports: ["websocket"], forceNew: true, reconnection: true });
  const b = { i, s, id: null, d: unit([Math.random() - 0.5, 0.6 + Math.random(), Math.random() - 0.5]), heading: Math.random() * 6.28, timer: 0 };
  s.io.engine?.on?.("packet", () => {});
  s.on("connect", () => s.io.engine.on("data", (d) => (bytes += typeof d === "string" ? d.length : d.byteLength || 0)));
  s.on("disconnect", (r) => r !== "io client disconnect" && disconnects++);
  s.on("states", (list) => {
    statesMsgs++;
    entries += list.length;
    const now = performance.now();
    for (const st of list) {
      const at = sent.get(st[0])?.get(key([st[1], st[2], st[3]]));
      if (at) moveLat.push(now - at);
    }
  });
  await new Promise((resolve) => s.once("connect", resolve));
  const t0 = performance.now();
  const ack = await new Promise((r) => s.emit("join", { room: "blockhaven", name: `bot${i}`, token, look: { jacket: i % 6, skin: i % 5, hair: i % 6 } }, r));
  if (ack?.error) {
    joinErrors.push(ack.error);
    return b;
  }
  joinLat.push(performance.now() - t0);
  b.id = ack.id;
  b.room = ack.room;
  sent.set(b.id, new Map());
  // walk: small steps around the planet's north side so neighbourhoods mix
  b.timer = setInterval(() => {
    b.heading += (Math.random() - 0.5) * 0.4;
    const step = 0.004;
    const [x, y, z] = b.d;
    b.d = unit([x + Math.cos(b.heading) * step, y, z + Math.sin(b.heading) * step]);
    if (b.d[1] < 0.2) b.d = unit([b.d[0] * 0.5, 1, b.d[2] * 0.5]);
    const m = sent.get(b.id);
    m.set(key(b.d), performance.now());
    if (m.size > 40) m.delete(m.keys().next().value);
    s.volatile.emit("state", { d: b.d, f: unit([Math.cos(b.heading), 0, Math.sin(b.heading)]), h: 0, sp: 3 });
  }, 1000 / SEND_HZ);
  // the shared arena: every bot watches it
  b.r = io(`${BASE}/royale`, { path: "/royale-io/", transports: ["websocket"], forceNew: true, extraHeaders: b.cookie ? { cookie: b.cookie } : {} });
  b.r.on("royale:activity", (a) => a?.sentAt && royaleLat.push(Date.now() - a.sentAt));
  b.r.on("royale:changed", (c) => c?.at && royaleLat.push(Date.now() - c.at));
  b.r.on("disconnect", (r) => r !== "io client disconnect" && disconnects++);
  return b;
}

async function metrics() {
  return fetch(`${BASE}/__metrics`).then((r) => r.json());
}

// verified stakers (the harness stubs only World's verify API)
async function staker(i) {
  const v = await fetch(`${BASE}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result: { action: "play-omen", environment: "staging", responses: [{ nullifier: BigInt("0x" + randomBytes(16).toString("hex")).toString() }] } }) });
  const cookie = v.headers.get("set-cookie").split(";")[0];
  const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }).then((r) => r.json());
  await post("/api/royale/join", { name: `staker${i}` });
  return { post };
}

console.log(`load test: ${N} clients, ${SECONDS}s, ${SEND_HZ} Hz movement each`);
await metrics(); // reset counters
for (let i = 0; i < N; i++) {
  bots.push(bot(i));
  if (i % 20 === 19) await new Promise((r) => setTimeout(r, 250)); // a crowd arriving, not one instant
}
await Promise.all(bots);
const live = (await Promise.all(bots)).filter((b) => b.id);
console.log(`joined ${live.length}/${N} (errors: ${joinErrors.length ? [...new Set(joinErrors)].join("; ") : "none"}), rooms: ${[...new Set(live.map((b) => b.room))].join(", ")}`);

// projects for stakers to pick (moderator-only route → use the harness moderator)
const login = await fetch(`${BASE}/api/mod/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ username: "royale-mod", password: "harness-moderator-pass" }) });
const mcookie = login.headers.get("set-cookie")?.split(";")[0];
await fetch(`${BASE}/api/royale/mod/projects`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: mcookie }, body: JSON.stringify({ projects: Array.from({ length: 30 }, (_, i) => ({ name: `Load Team ${i}` })) }) });
const stakers = await Promise.all(Array.from({ length: STAKERS }, (_, i) => staker(i)));

// warm-up, then measure
await new Promise((r) => setTimeout(r, 3000));
moveLat.length = royaleLat.length = 0;
bytes = statesMsgs = entries = 0;
const disc0 = disconnects;
await metrics();
const samples = [];
const stakeLat = [];
const started = performance.now();
const stakeTimer = setInterval(async () => {
  const s = stakers[Math.floor(Math.random() * stakers.length)];
  const t = performance.now();
  await s.post("/api/royale/predictions", { marketId: "top3", selection: `load-team-${Math.floor(Math.random() * 30)}`, amount: 1, idempotencyKey: randomBytes(12).toString("hex") }).catch(() => {});
  stakeLat.push(performance.now() - t);
}, 500);
for (let s = 0; s < SECONDS; s++) {
  await new Promise((r) => setTimeout(r, 1000));
  samples.push(await metrics());
}
clearInterval(stakeTimer);
const elapsed = (performance.now() - started) / 1000;

const loopP99 = Math.max(...samples.map((m) => m.loopMs.p99));
const loopMax = Math.max(...samples.map((m) => m.loopMs.max));
const cpu = samples.map((m) => m.cpuPct);
const report = {
  clients: N,
  joined: live.length,
  rooms: samples.at(-1).world?.rooms,
  joinMs: { p50: round(pct(joinLat, 50)), p95: round(pct(joinLat, 95)) },
  movementDeliveryMs: { p50: round(pct(moveLat, 50)), p95: round(pct(moveLat, 95)), p99: round(pct(moveLat, 99)), samples: moveLat.length },
  royaleBroadcastMs: { p50: round(pct(royaleLat, 50)), p95: round(pct(royaleLat, 95)), samples: royaleLat.length },
  stakeHttpMs: { p50: round(pct(stakeLat, 50)), p95: round(pct(stakeLat, 95)), n: stakeLat.length },
  serverEventLoopMs: { p99Worst: round(loopP99), maxWorst: round(loopMax) },
  serverCpuPct: { avg: round(cpu.reduce((a, b) => a + b, 0) / cpu.length), max: round(Math.max(...cpu)) },
  serverMemMb: { rss: samples.at(-1).rssMb, heap: samples.at(-1).heapMb },
  worldTick: { lastTickMs: round(samples.at(-1).world?.lastTickMs) },
  disconnects: disconnects - disc0,
  receivedPerClient: { kbps: round((bytes * 8) / 1000 / elapsed / Math.max(1, live.length)), statesMsgsPerSec: round(statesMsgs / elapsed / Math.max(1, live.length)), avgEntriesPerMsg: round(entries / Math.max(1, statesMsgs)) },
};
const criteria = {
  "all clients joined": live.length === N,
  "no disconnects": report.disconnects === 0,
  "movement p95 < 250 ms": report.movementDeliveryMs.p95 !== null && report.movementDeliveryMs.p95 < 250,
  "event-loop p99 < 50 ms": loopP99 < 50,
  "royale broadcast p95 < 1000 ms": report.royaleBroadcastMs.p95 !== null && report.royaleBroadcastMs.p95 < 1000,
  "per-client download < 400 kbps": report.receivedPerClient.kbps < 400,
};
console.log(JSON.stringify(report, null, 2));
for (const [k, v] of Object.entries(criteria)) console.log(v ? "PASS" : "FAIL", k);
for (const b of live) {
  clearInterval(b.timer);
  b.s.close();
  b.r?.close();
}
process.exit(Object.values(criteria).every(Boolean) ? 0 : 1);
