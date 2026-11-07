// TEST HARNESS ONLY (never used by the product): the real gateway, multiplayer, Bounty Royale and
// the built game (dist/) against a throwaway database, with ONE stub — World's verify API answers
// "success" — so browser tests can create verified sessions without a phone. Staging environment,
// so nothing here can ever display a production VERIFIED HUMAN badge.
//   ROYALE_TEST_DATABASE_URL=postgres://…/omen_royale_e2e PORT=5195 node e2e/royale-harness.mjs
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, normalize, extname, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = process.env.ROYALE_TEST_DATABASE_URL;
if (!URL_ || !/_e2e$|_test$/.test(URL_)) throw new Error("ROYALE_TEST_DATABASE_URL must name a throwaway *_e2e or *_test database.");
const PORT = Number(process.env.PORT || 5195);
const WORK = process.env.WORK || join(ROOT, "server", "data", "e2e");
await mkdir(join(WORK, "legacy"), { recursive: true });

// fresh database every run
const pg = (await import("../server/node_modules/pg/lib/index.js")).default;
const admin = new pg.Client({ connectionString: URL_.replace(/\/[^/]+$/, "/postgres") });
await admin.connect();
const dbName = URL_.split("/").pop();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
execFileSync(process.execPath, ["server/manage.js", "migrate"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: URL_ }, stdio: "pipe" });

Object.assign(process.env, { DATABASE_URL: URL_, DATA_DIR: join(WORK, "legacy"), PORT: String(PORT) });
const { createGateway, createNotifier } = await import("../server/index.js");
const { createFinalBlock, finalConfig, fileStore } = await import("../server/final-block.js");
const { mountFinalRoutes } = await import("../server/final-routes.js");
const { createAuth } = await import("../server/auth.js");

const notifier = createNotifier();
const app = createGateway({ onChange: notifier.onChange, notify: notifier.notify });
await app.ready;
const config = { ...finalConfig(), appId: "app_staging_harness", rpId: "rp_harness", signingKey: "11".repeat(32), environment: "staging", issues: [], allowGuest: false, dataFile: join(WORK, `humans-${Date.now()}.json`) };
const worldStub = async (url) => (url.startsWith("https://developer.world.org/") ? { ok: true, json: async () => ({ success: true }) } : fetch(url));
const final = createFinalBlock({ config, store: fileStore(config.dataFile), fetchImpl: worldStub, signRequestImpl: () => ({ sig: "0x", nonce: "0x", createdAt: 0, expiresAt: 0 }) });
mountFinalRoutes(final, { database: app.database, fetchImpl: worldStub });
await final.royale.ready;
const auth = createAuth(app.database);
await app.database.transaction(() => auth.provision({ username: "royale-mod", password: "harness-moderator-pass" }));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };
async function serveStatic(pathname, res) {
  const dist = join(ROOT, "dist");
  const file = normalize(join(dist, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
  if (!file.startsWith(dist + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}
// load-test metrics (harness only): event-loop delay, CPU, memory and the world tick's counters
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let cpu0 = process.cpuUsage();
let t0 = performance.now();
let rt = null;
function metrics() {
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - t0;
  const out = {
    cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10,
    loopMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    world: rt?.worldStats?.(),
    royaleSockets: final.royale.io?.of("/royale").sockets.size,
  };
  cpu0 = process.cpuUsage();
  t0 = performance.now();
  loop.reset();
  return out;
}
const server = createServer(async (req, res) => {
  if (req.url === "/__metrics") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(metrics()));
  if (await final(req, res)) return;
  if (req.url.startsWith("/api/") || req.url.startsWith("/uploads/")) return app(req, res);
  serveStatic(new URL(req.url, "http://x").pathname, res);
});
rt = notifier.attach(server, app.community, app.database, app.worldIdentity);
final.royale.attach(server);
server.listen(PORT, () => console.log(`HARNESS READY http://localhost:${PORT}`));
