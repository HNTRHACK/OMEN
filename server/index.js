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
import { createCommerce } from "./commerce.js";
import { playerFromRequest } from "./identity.js";
import { createCommunity, CATS } from "./community.js";
import { serveUpload, normalizeImage } from "./images.js";
import { createDatabase } from './postgres.js';
import { createAuth } from './auth.js';
import { createWorldIdentity } from './world-identity.js';
import { createBtcInr } from './btcinr.js';
import { createAlfred } from "./alfred.js";
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

export function createApp({ service, publicConfig, store = null, merchantAccess = merchantKeys(), market = createMarket(), commerce = null, community = null, alfred = null, database = null, auth = null, worldIdentity = null, btcinr = null }) {
  const name = (b) => String(b?.name || "").slice(0, 16);
  /** The caller's player id if they sent a valid guest token, else null (moderator-only pages send none). */
  const optionalPlayer = (req) => {
    try {
      return playerFromRequest(req) || null;
    } catch {
      return null;
    }
  };
  const modOnly = async (req, permission = 'review') => {
    if (!auth) throw new ApiError(401, 'unauthorized', 'Sign in with a moderator account.');
    return auth.account(req, permission);
  };
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
    ...(btcinr ? [
      ['GET', /^\/api\/btcinr\/rate$/, async () => btcinr.rate(), { external: true }],
      ['GET', /^\/api\/btcinr\/customer$/, async (_, b, req) => btcinr.getCustomer(req), { external: true }],
      ['POST', /^\/api\/btcinr\/customer$/, async (_, b, req) => btcinr.registerCustomer(req, b), { external: true }],
      ['POST', /^\/api\/btcinr\/merchants$/, async (_, b, req) => btcinr.registerMerchant(req, b), { external: true }],
      ['POST', /^\/api\/btcinr\/merchant\/session$/, async (_, b, req) => btcinr.loginMerchant(req, b), { external: true }],
      ['DELETE', /^\/api\/btcinr\/merchant\/session$/, async (_, b, req) => btcinr.logoutMerchant(req), { external: true }],
      ['POST', /^\/api\/btcinr\/merchant\/recover$/, async (_, b, req) => btcinr.recoverMerchant(req), { external: true }],
      ['GET', /^\/api\/btcinr\/merchant$/, async (_, b, req) => btcinr.getMerchant(req), { external: true }],
      ['POST', /^\/api\/btcinr\/merchant\/requests$/, async (_, b, req) => btcinr.createRequest(req, b), { external: true }],
      ['GET', /^\/api\/btcinr\/requests\/([A-Za-z0-9_-]{6,64})$/, async ([code], b, req) => btcinr.getRequest(req, code), { external: true }],
      ['POST', /^\/api\/btcinr\/quotes$/, async (_, b, req) => btcinr.createQuote(req, b), { external: true }],
      ['POST', /^\/api\/btcinr\/payments$/, async (_, b, req) => btcinr.pay(req, b), { external: true }],
      ['GET', /^\/api\/btcinr\/payments$/, async (_, b, req, url) => btcinr.history(req, url.searchParams), { external: true }],
      ['GET', /^\/api\/btcinr\/payments\/(pay_[a-f0-9]{32})$/, async ([id], b, req) => btcinr.getPayment(req, id), { external: true }],
    ] : []),
    ...(worldIdentity ? [
      ['GET', /^\/api\/auth\/world\/status$/, async () => worldIdentity.status(), { external: true }],
      ['POST', /^\/api\/auth\/world\/start$/, async (_, b, req) => worldIdentity.start(req, b), { external: true }],
      ['GET', /^\/api\/auth\/world\/callback$/, async (_, b, req, url) => worldIdentity.callback(req, url.searchParams), { external: true }],
      ['GET', /^\/api\/auth\/me$/, async (_, b, req) => worldIdentity.me(req)],
      ['POST', /^\/api\/auth\/logout$/, async (_, b, req) => worldIdentity.logout(req, b), { external: true }],
      ['GET', /^\/api\/avatar$/, async (_, b, req) => worldIdentity.ownAvatar(req)],
      ['POST', /^\/api\/avatar$/, async (_, b, req) => worldIdentity.updateAvatar(req, b)],
    ] : []),
    ...(auth ? [
      ['POST', /^\/api\/mod\/login$/, async (_, b, req) => auth.login(req, b)],
      ['POST', /^\/api\/mod\/logout$/, async (_, b, req) => auth.logout(req)],
      ['GET', /^\/api\/mod\/me$/, async (_, b, req) => ({ account: await modOnly(req) })],
    ] : []),
    ["GET", /^\/api\/health$/, async () => {
      try { if (database) await database.pool.query({ text: 'SELECT 1', query_timeout: 2000 }); }
      catch { throw new ApiError(503, 'unavailable', 'Database health check failed.'); }
      return { ok: true };
    }, { external: true }],
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
    // Marketplace: shops (B2C), orders, invoices (B2B). Identity from the x-omen-token header.
    ...(commerce
      ? [
          ["GET", /^\/api\/shops$/, async () => commerce.list()],
          ["GET", /^\/api\/shops\/mine$/, async (_, b, req) => ({ shop: commerce.myShop(playerFromRequest(req)) })],
          ["POST", /^\/api\/shops\/(plot-[a-z]{2,20})\/claim$/, async ([id], b, req) => commerce.claim(playerFromRequest(req), id, b, b.ownerName)],
          ["POST", /^\/api\/shops\/(plot-[a-z]{2,20})$/, async ([id], b, req) => commerce.update(playerFromRequest(req), id, b)],
          ["POST", /^\/api\/shops\/(plot-[a-z]{2,20})\/release$/, async ([id], b, req) => commerce.release(playerFromRequest(req), id)],
          ["POST", /^\/api\/shops\/(plot-[a-z]{2,20})\/products$/, async ([id], b, req) => commerce.upsertProduct(playerFromRequest(req), id, b)],
          ["GET", /^\/api\/shops\/(plot-[a-z]{2,20})\/orders$/, async ([id], b, req) => ({ orders: commerce.shopOrders(playerFromRequest(req), id) })],
          ["POST", /^\/api\/orders$/, async (_, b, req) => commerce.order(playerFromRequest(req), b.buyerName, b)],
          ["GET", /^\/api\/orders\/mine$/, async (_, b, req) => ({ orders: commerce.myOrders(playerFromRequest(req)) })],
          ["POST", /^\/api\/orders\/([\w-]{36})\/fulfil$/, async ([id], b, req) => commerce.fulfil(playerFromRequest(req), id)],
          ["POST", /^\/api\/invoices$/, async (_, b, req) => commerce.invoice(playerFromRequest(req), b)],
          ["GET", /^\/api\/invoices\/mine$/, async (_, b, req) => commerce.myInvoices(playerFromRequest(req))],
          ["POST", /^\/api\/invoices\/([\w-]{36})\/pay$/, async ([id], b, req) => commerce.payInvoice(playerFromRequest(req), id, b)],
          ["POST", /^\/api\/invoices\/([\w-]{36})\/cancel$/, async ([id], b, req) => commerce.cancelInvoice(playerFromRequest(req), id)],
        ]
      : []),
    // Community: forum, reports, billboard ads, moderation
    ...(community
      ? [
          ["GET", /^\/api\/forum$/, async (_, b, req, url) => ({ cats: CATS, threads: community.listThreads(url.searchParams.get("cat") || null) })],
          ["GET", /^\/api\/forum\/([\w-]{36})$/, async ([id]) => community.getThread(id)],
          ["POST", /^\/api\/forum$/, async (_, b, req) => community.newThread(playerFromRequest(req), name(b), b)],
          ["POST", /^\/api\/forum\/([\w-]{36})\/reply$/, async ([id], b, req) => community.reply(playerFromRequest(req), name(b), id, b)],
          ["POST", /^\/api\/report$/, async (_, b, req) => community.report(playerFromRequest(req), b)],
          ["GET", /^\/api\/ads$/, async () => ({ ads: community.liveAds() })],
          ["GET", /^\/api\/ads\/boards$/, async () => ({ boards: community.boards() })],
          ["POST", /^\/api\/ads\/([\w-]{36})\/seen$/, async ([id], b, req) => community.recordView(playerFromRequest(req), id)],
          ["POST", /^\/api\/ads\/([\w-]{36})\/click$/, async ([id], b, req) => community.recordClick(playerFromRequest(req), id, b.kind)],
          ["GET", /^\/api\/ads\/mine$/, async (_, b, req) => ({ ads: community.myAds(playerFromRequest(req)) })],
          ["POST", /^\/api\/ads$/, async (_, b, req) => community.submitAd(playerFromRequest(req), name(b), b), { maxBody: 1_048_576 }],
          ["POST", /^\/api\/ads\/([\w-]{36})\/rent$/, async ([id], b, req) => community.payRent(playerFromRequest(req), id, b)],
          ["GET", /^\/api\/mod\/queue$/, async (_, b, req) => { await modOnly(req); return community.modQueue(); }],
          ["POST", /^\/api\/mod$/, async (_, b, req) => {
            const account = await modOnly(req, b.action === 'delete' || ['mute', 'unmute'].includes(b.action) ? 'admin' : 'moderate');
            // Ownership is bound to the account by an operator; the caller cannot omit or forge it.
            const target = community._db.ads.get(b.id);
            if (target && (target.author === account.playerId || target.author === optionalPlayer(req))) throw new ApiError(403, 'own_ad', 'Ask another moderator to review your advertisement.');
            const result = community.moderate(b, { actor: account.playerId });
            await auth.audit(account, b);
            return result;
          }],
        ]
      : []),
    // Alfred, the advisor NPC
    ...(alfred
      ? [
          ["GET", /^\/api\/alfred$/, async () => alfred.status()],
          ["POST", /^\/api\/alfred$/, async (_, b, req) => alfred.ask(playerFromRequest(req), b.name, b.text, b.context || {})],
        ]
      : []),
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
      const cookie = body?.__cookie;
      if (cookie) { body = { ...body }; delete body.__cookie; }
      const playerToken = String(req.headers['x-omen-token'] || '');
      // Browser <img> requests cannot attach x-omen-token. Set a narrowly scoped media cookie
      // after an authenticated advertiser request, without changing the frontend API.
      const mediaCookie = /^[a-f0-9]{64}$/.test(playerToken) && url.pathname.startsWith('/api/ads')
        ? `omen_media=${playerToken}; Path=/uploads/; HttpOnly; SameSite=Strict; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` : null;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        'referrer-policy': 'no-referrer',
        ...(cookie || mediaCookie ? { 'set-cookie': [cookie, mediaCookie].flat().filter(Boolean) } : {}),
        ...(config.allowedOrigin ? { "access-control-allow-origin": config.allowedOrigin, vary: "origin" } : {}),
      });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/uploads/') && database) {
      try {
        const name = url.pathname.slice(9);
        const upload = await database.transaction(async () => {
          if (!/^[a-f0-9]{32}\.(png|jpg)$/.test(name) || !['GET', 'HEAD'].includes(req.method)) return null;
          if (worldIdentity) req.omenPlayer = await worldIdentity.resolveRequest(req);
          let moderator = false;
          try { moderator = !!(await modOnly(req)); } catch (e) { if (![401, 403].includes(e.status)) throw e; }
          const mediaToken = /(?:^|;\s*)omen_media=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
          const owner = optionalPlayer(req) || (mediaToken ? playerFromRequest({ headers: { 'x-omen-token': mediaToken } }) : null);
          const allowed = community._db.ads.where((a) => a.image === name && (moderator || a.author === owner || (a.status === 'live' && !a.hidden && a.expiresAt > Date.now()))).length;
          if (!allowed) return null;
          return (await database.state().client.query('SELECT content_type,bytes FROM uploads WHERE name=$1', [name])).rows[0];
        });
        if (!upload) return send(404, { error: 'not_found', message: 'Image not found.' });
        res.writeHead(200, { 'content-type': upload.content_type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
        return res.end(req.method === 'HEAD' ? undefined : upload.bytes);
      } catch (e) {
        if (e.status === 401) return send(401, { error: e.code, message: e.message });
        console.error('Image lookup failed:', e.code); return send(503, { error: 'unavailable', message: 'Image storage unavailable.' });
      }
    }
    if (url.pathname.startsWith("/uploads/")) return serveUpload(community?.uploadsDir, url.pathname.slice(9), res);
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);
    if (req.method === "OPTIONS" && config.allowedOrigin) {
      res.writeHead(204, { "access-control-allow-origin": config.allowedOrigin, "access-control-allow-methods": "GET,POST,DELETE", "access-control-allow-headers": "content-type,authorization,x-omen-token,x-omen-session,x-mod-key,idempotency-key", vary: 'origin' });
      return res.end();
    }
    if (limited(clientIp(req))) return send(429, { error: "rate_limited", message: "Too many requests. Slow down a little." });
    try {
      req.omenClientIp = clientIp(req);
      if (['POST', 'DELETE'].includes(req.method) && req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new ApiError(403, 'bad_origin', 'This origin is not allowed.'); }
        if (!['http:', 'https:'].includes(origin.protocol) || (origin.host !== req.headers.host && origin.origin !== config.allowedOrigin)) throw new ApiError(403, 'bad_origin', 'This origin is not allowed.');
      }
      for (const [m, re, fn, opts] of routes) {
        const match = re.exec(url.pathname);
        if (!match || m !== req.method) continue;
        let body = {};
        if (m === "POST") {
          if (!/^application\/json/.test(req.headers["content-type"] || "")) throw new ApiError(415, "json_only", "Send JSON.");
          body = await readJson(req, opts?.maxBody);
        }
        if (database && req.method === 'POST' && url.pathname === '/api/ads' && body.image) {
          if (worldIdentity) req.omenPlayer = await worldIdentity.resolveRequest(req);
          if (!playerFromRequest(req)) throw new ApiError(401, 'no_identity', 'Join the world first.');
          body.image = await normalizeImage(body.image);
        }
        const invoke = async () => {
          if (worldIdentity && !opts?.external) req.omenPlayer = await worldIdentity.resolveRequest(req);
          // Ad rental payment records are private even through the generic checkout endpoints.
          if (database && url.pathname.startsWith('/api/payments/')) {
            const p = store?.get(match[1]);
            if (p?.market?.adId) {
              const ad = community._db.ads.get(p.market.adId);
              if (!ad || ad.author !== playerFromRequest(req)) throw new ApiError(404, 'not_found', 'No such payment.');
            }
          }
          return fn(match.slice(1), body, req, url);
        };
        const out = database && !opts?.external ? await database.transaction(invoke) : await invoke();
        if (out?.__error) return send(out.__error.status, { error: out.__error.error, message: out.__error.message });
        if (out?.__redirect) {
          res.writeHead(303, { location: out.__redirect, 'set-cookie': out.__cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
          return res.end();
        }
        if (out?.__raw) {
          res.writeHead(200, { "content-type": out.__raw.type, "content-disposition": `attachment; filename="${out.__raw.name}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(out.__raw.body);
        }
        const status = out?.__status || 200;
        if (out && Object.hasOwn(out, '__status')) delete out.__status;
        return send(status, out);
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

function readJson(req, max = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
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
  let rel;
  try {
    rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("Malformed path.");
    return;
  }
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
export function createGateway({ onChange = () => {}, notify = { player() {}, all() {} }, database = createDatabase(config.databaseUrl), legacyDir = config.dataDir, worldIdentity = createWorldIdentity(database, config.worldId), btcinr = createBtcInr(database, { worldIdentity }) } = {}) {
  const store = new Store(null, { database });
  const liveNotify = notify;
  notify = Object.fromEntries(['player', 'all'].map((method) => [method, (...args) => {
    const snapshot = structuredClone(args);
    database.defer(() => liveNotify[method](...snapshot));
  }]));
  const relayer = createRelayer();
  let commerce = null; // set below; payment changes also settle marketplace orders
  let community = null; // and billboard rentals
  const service = createPaymentService({
    store,
    rates: () => usdtInr(),
    infer: (m) => infer(m),
    verify: (p, h) => verifyPayment(p, h),
    checkoutConfigured: () => !!config.checkoutAddress,
    checkoutAddress: () => config.checkoutAddress,
    relayer,
    onChange: (p) => {
      commerce?.onPayment(p);
      community?.onPayment(p);
      const snapshot = structuredClone(p);
      database.defer(() => onChange(snapshot));
    },
    quoteTtlMs: config.quoteTtlMs,
  });
  commerce = createCommerce({ database, payments: service, notify });
  community = createCommunity({
    dir: config.dataDir,
    database,
    payments: service,
    notify,
    // Ads may point at a stall: look it up live, so a closed stall stops being linked.
    shopLookup: (id) => {
      const l = commerce.list();
      const s = l.plots.find((p) => p.shop?.id === id)?.shop || l.npc.find((n) => n.id === id);
      return s ? { id: s.id, name: s.name, owner: s.owner || null } : null;
    },
  });
  const sweeper = setInterval(() => database.transaction(() => { commerce.sweep(); community.sweep(); }).catch((e) => console.error('Economy sweep failed:', e.code)), 30_000);
  sweeper.unref();
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
  const alfred = createAlfred({ zgInfer: zgStatus().configured ? (m) => infer(m) : null });
  const handle = createApp({ service, publicConfig, store, commerce, community, alfred, database, auth: createAuth(database), worldIdentity, btcinr });
  const ready = database.verifyReady(legacyDir);
  ready.catch(() => {}); // start() or the request handler reports startup failures
  const app = async (req, res) => {
    try { await ready; }
    catch { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: 'backend_not_ready', message: 'Database migrations and legacy import must complete before serving.' })); }
    return handle(req, res);
  };
  app.ready = ready;
  app.commerce = commerce;
  const muted = community.muted;
  community.muted = (id) => database.transaction(() => muted(id));
  app.community = community;
  community.worldIdentity = worldIdentity; // Vite's existing notifier call can discover the backend identity service
  community.btcinr = btcinr;
  app.service = service;
  app.store = store;
  app.database = database;
  app.worldIdentity = worldIdentity;
  app.btcinr = btcinr;
  app.close = async () => { clearInterval(sweeper); await database.close(); };
  return app;
}

export function logStatus(where) {
  const z = zgStatus();
  console.log(`OMEN gateway ${where}`);
  console.log(`  Whitechain checkout: ${config.checkoutAddress || "not configured (DEMO credits only)"}`);
  console.log(`  0G inference:       ${z.configured ? z.mode : "off (rules-only risk checks)"}`);
  console.log(`  Gasless relayer:    ${relayerStatus().configured ? "on" : "off (set RELAYER_PRIVATE_KEY + CHECKOUT_ADDRESS)"}`);
  console.log(`  Alfred (AI NPC):    ${process.env.ANTHROPIC_API_KEY ? "Claude" : zgStatus().configured ? "0G" : "offline mode (set ANTHROPIC_API_KEY)"}`);
}

/** Payment changes fan out to the merchant's live view and their signed webhook. */
export function createNotifier() {
  const webhooks = createWebhooks();
  let rt = null;
  return {
    webhooks,
    attach: (httpServer, community, database, worldIdentity = community?.worldIdentity) => (rt = attachRealtime(httpServer, { worldIdentity, btcinr: community?.btcinr, isMuted: (id) => database ? database.transaction(() => community?.muted(id)) : community?.muted(id) })),
    notify: { player: (id, ev, d) => rt?.toPlayer(id, ev, d), all: (ev, d) => rt?.toAll(ev, d) },
    onChange: (p) => {
      rt?.notifyPayment(p);
      webhooks.notify(p).catch(() => {});
    },
  };
}

export async function start() {
  const notifier = createNotifier();
  const app = createGateway({ onChange: notifier.onChange, notify: notifier.notify });
  try {
    await app.ready;
  } catch (e) { await app.close(); throw e; }
  const server = createServer(app);
  notifier.attach(server, app.community, app.database, app.worldIdentity);
  server.listen(config.port, '0.0.0.0', () => {
    logStatus(`on http://localhost:${config.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(async () => { await app.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
  return { server, app };
}
