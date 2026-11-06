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
import { createRelayer, relayerStatus } from "./relayer.js";
import { attachRealtime, merchantKeys, checkMerchantKey, merchantView } from "./realtime.js";
import { createWebhooks } from "./webhooks.js";
import { createMarket } from "./market.js";
import { MERCHANTS, merchantKey } from "../shared/merchants.js";
import { WHITECHAIN, USDT } from "../shared/chains.js";
import { FEE_BPS } from "../shared/money.js";

const CSV_COLS = ["createdAt", "id", "state", "mode", "inrPaise", "token", "amount", "payer", "txHash", "relayed", "inr"];
const csvCell = (v) => {
  let s = v == null ? "" : typeof v === "object" ? v.label : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // no formula injection when opened in a spreadsheet
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows) {
  return [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => csvCell(c === "createdAt" ? new Date(r.createdAt).toISOString() : r[c])).join(","))].join("\n") + "\n";
}

export function createApp({ service, publicConfig, store = null, merchantAccess = merchantKeys(), market = createMarket() }) {
  /** Merchant routes need that merchant's access key: Authorization: Bearer <key>. */
  const merchantOnly = (id, req) => {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
    if (!checkMerchantKey(merchantAccess, id, key)) throw new ApiError(401, "unauthorized", "This needs the merchant's access key.");
  };
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
    ["GET", /^\/api\/market\/([a-z]{2,5})$/, async ([sym]) => market.coin(sym)],
    ["POST", /^\/api\/payments$/, async (_, b) => service.create(b)],
    ["GET", /^\/api\/payments\/([\w-]{36})$/, async ([id]) => service.refresh(id)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/risk$/, async ([id]) => service.risk(id)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/authorize$/, async ([id], b) => service.authorize(id, b)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/submit$/, async ([id], b) => service.submit(id, b)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/relay$/, async ([id], b) => service.relay(id, b)],
    ["POST", /^\/api\/payments\/([\w-]{36})\/cancel$/, async ([id]) => service.cancel(id)],
    // Merchant: payment history (JSON) and accountant export (CSV)
    ["GET", /^\/api\/merchant\/([a-z-]{3,32})\/payments$/, async ([id], _, req, url) => {
      merchantOnly(id, req);
      const rows = (store?.byMerchant(id) || []).map(merchantView);
      return url.searchParams.get("format") === "csv" ? { __raw: { type: "text/csv; charset=utf-8", name: `omen-${id}-payments.csv`, body: toCsv(rows) } } : { payments: rows };
    }],
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
    if (limited(clientIp(req))) return send(429, { error: "rate_limited", message: "Too many requests. Slow down a little." });
    try {
      for (const [m, re, fn] of routes) {
        const match = re.exec(url.pathname);
        if (!match || m !== req.method) continue;
        let body = {};
        if (m === "POST") {
          if (!/^application\/json/.test(req.headers["content-type"] || "")) throw new ApiError(415, "json_only", "Send JSON.");
          body = await readJson(req);
        }
        const out = await fn(match.slice(1), body, req, url);
        if (out?.__raw) {
          res.writeHead(200, { "content-type": out.__raw.type, "content-disposition": `attachment; filename="${out.__raw.name}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(out.__raw.body);
        }
        return send(200, out);
      }
      send(404, { error: "not_found", message: "No such endpoint." });
    } catch (e) {
      if (e instanceof ApiError || e.status) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      send(500, { error: "internal", message: "Something went wrong on the server." });
    }
  };
}

/** The caller's IP for rate limiting; the left-most X-Forwarded-For hop only behind a trusted proxy. */
export function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "?";
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
export function createGateway({ onChange = () => {} } = {}) {
  const store = new Store(config.dataDir);
  const relayer = createRelayer();
  const service = createPaymentService({
    store,
    rates: () => usdtInr(),
    infer: (m) => infer(m),
    verify: (p, h) => verifyPayment(p, h),
    checkoutConfigured: () => !!config.checkoutAddress,
    checkoutAddress: () => config.checkoutAddress,
    relayer,
    onChange,
    quoteTtlMs: config.quoteTtlMs,
  });
  const publicConfig = () => ({
    whitechain: { ...WHITECHAIN, rpc: undefined },
    usdt: USDT,
    checkout: config.checkoutAddress,
    feeBps: FEE_BPS,
    zeroG: zgStatus(),
    // Public by design: anyone can see which address pays the gas. Its key never leaves the server.
    gasless: { enabled: relayerStatus().configured, relayer: relayer?.address || null },
    merchants: MERCHANTS.map((m) => ({ ...m, key: merchantKey(m.id) })),
    inrPayout: "simulated",
  });
  const app = createApp({ service, publicConfig, store });
  app.service = service;
  app.store = store;
  return app;
}

export function logStatus(where) {
  const z = zgStatus();
  console.log(`OMEN gateway ${where}`);
  console.log(`  Whitechain checkout: ${config.checkoutAddress || "not configured (DEMO credits only)"}`);
  console.log(`  0G inference:       ${z.configured ? z.mode : "off (rules-only risk checks)"}`);
  console.log(`  Gasless relayer:    ${relayerStatus().configured ? "on" : "off (set RELAYER_PRIVATE_KEY + CHECKOUT_ADDRESS)"}`);
}

/** Payment changes fan out to the merchant's live view and their signed webhook. */
export function createNotifier() {
  const webhooks = createWebhooks();
  let rt = null;
  return {
    webhooks,
    attach: (httpServer) => (rt = attachRealtime(httpServer)),
    onChange: (p) => {
      rt?.notifyPayment(p);
      webhooks.notify(p).catch(() => {});
    },
  };
}

export function start() {
  const notifier = createNotifier();
  const server = createServer(createGateway({ onChange: notifier.onChange }));
  notifier.attach(server);
  server.listen(config.port, () => {
    logStatus(`on http://localhost:${config.port}`);
  });
}
