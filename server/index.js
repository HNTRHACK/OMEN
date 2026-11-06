// OMEN payment gateway API (plain node:http, no framework). Also serves the built game from dist/.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { config, ROOT } from "./config.js";
import { Store } from "./store.js";
import { createPaymentService, ApiError } from "./payments.js";
import { usdtInr } from "./rates.js";
import { infer, zgStatus } from "./zerog.js";
import { verifyPayment } from "./chain.js";
import { MERCHANTS, merchantKey } from "../shared/merchants.js";
import { WHITECHAIN, USDT } from "../shared/chains.js";
import { FEE_BPS } from "../shared/money.js";

export function createApp({ service, publicConfig }) {
  const hits = new Map(); // ip → [windowStart, count]
  const limited = (ip) => {
    const t = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v[0] > 60_000) hits.delete(k); // bound memory
    const h = hits.get(ip);
    if (!h || t - h[0] > 60_000) return hits.set(ip, [t, 1]) && false;
    return ++h[1] > 120;
  };

  const routes = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true })],
    ["GET", /^\/api\/config$/, async () => publicConfig()],
    ["GET", /^\/api\/rates$/, async () => usdtInr()],
    ["POST", /^\/api\/payments$/, async (_, b) => service.create(b)],
    ["GET", /^\/api\/payments\/([\w-]{36})$/, async ([id]) => service.refresh(id)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/risk$/, async ([id]) => service.risk(id)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/authorize$/, async ([id], b) => service.authorize(id, b)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/submit$/, async ([id], b) => service.submit(id, b)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/cancel$/, async ([id]) => service.cancel(id)],
  ];

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(config.allowedOrigin ? { "access-control-allow-origin": config.allowedOrigin, vary: "origin" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
    if (req.method === "OPTIONS" && config.allowedOrigin) {
      res.writeHead(204, { "access-control-allow-origin": config.allowedOrigin, "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    if (limited(req.socket.remoteAddress || "?")) return send(429, { error: "rate_limited", message: "Too many requests. Slow down a little." });
    try {
      for (const [m, re, fn] of routes) {
        const match = re.exec(url.pathname);
        if (!match || m !== req.method) continue;
        let body = {};
        if (m === "POST") {
          if (!/^application\/json/.test(req.headers["content-type"] || "")) throw new ApiError(415, "json_only", "Send JSON.");
          body = await readJson(req);
        }
        return send(200, await fn(match.slice(1), body));
      }
      send(404, { error: "not_found", message: "No such endpoint." });
    } catch (e) {
      if (e instanceof ApiError || e.status) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      send(500, { error: "internal", message: "Something went wrong on the server." });
    }
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 16_384) {
        reject(new ApiError(413, "too_large", "Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw 0;
        resolve(v);
      } catch {
        reject(new ApiError(400, "bad_json", "Malformed JSON."));
      }
    });
    req.on("error", reject);
  });
}

const DIST = join(ROOT, "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
async function serveStatic(path, res) {
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  let file = join(DIST, rel || "index.html");
  if (!file.startsWith(DIST + sep) && file !== DIST) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "x-content-type-options": "nosniff" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Run `npm run build` to serve the game from this server, or use `npm run dev`.");
  }
}

// ------------------------------------------------------------------ start

/** The real gateway (store, live rates, 0G, Whitechain verification) as a request handler. */
export function createGateway() {
  const store = new Store(config.dataDir);
  const service = createPaymentService({
    store,
    rates: () => usdtInr(),
    infer: (m) => infer(m),
    verify: (p, h) => verifyPayment(p, h),
    checkoutConfigured: () => !!config.checkoutAddress,
    quoteTtlMs: config.quoteTtlMs,
  });
  const publicConfig = () => ({
    whitechain: { ...WHITECHAIN, rpc: undefined },
    usdt: USDT,
    checkout: config.checkoutAddress,
    feeBps: FEE_BPS,
    zeroG: zgStatus(),
    merchants: MERCHANTS.map((m) => ({ ...m, key: merchantKey(m.id) })),
    inrPayout: "simulated",
  });
  return createApp({ service, publicConfig });
}

export function logStatus(where) {
  const z = zgStatus();
  console.log(`OMEN gateway ${where}`);
  console.log(`  Whitechain checkout: ${config.checkoutAddress || "not configured (DEMO credits only)"}`);
  console.log(`  0G inference:       ${z.configured ? z.mode : "off (rules-only risk checks)"}`);
}

export function start() {
  createServer(createGateway()).listen(config.port, () => {
    logStatus(`on http://localhost:${config.port}`);
  });
}
