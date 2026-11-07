// OMEN Final Block API: the human gate (World ID via IDKit, verified server-side), wallet binding,
// the ChaiPay tutorial payment proxy and the testnet prediction booths' server half.
// Self-contained: plain node:http handler, file-backed store, no database. Mounted before the
// main gateway (vite.config.js in dev, server/final-main.js in production).
//
// Nothing here trusts the browser: a session is only created after World's verify API says the
// proof is valid, and one World ID nullifier (per action) is exactly one OMEN player.
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { verifyMessage, getAddress, isAddress } from "viem";
import { randomLook, cleanLook } from "../shared/look.js";
import { ROOT } from './env.js';

const env = process.env;

export const ACTION = "play-omen";
const VERIFY_URL = (rpId) => `https://developer.world.org/api/v4/verify/${rpId}`;
const SESSION_DAYS = 7;

export function finalConfig(e = env) {
  const value = (key) => (e[key] || '').trim();
  const environment = value('WORLD_ENVIRONMENT') || 'production';
  const appId = value('VITE_WORLD_APP_ID') || value('WORLD_APP_ID');
  const rpId = value('WORLD_RP_ID');
  const signingKey = value('WORLD_RP_SIGNING_KEY');
  const issues = [];
  const check = (name, input, valid, message) => {
    if (!input) issues.push({ variable: name, reason: 'missing', message: `${name} is missing.` });
    else if (!valid) issues.push({ variable: name, reason: 'invalid', message });
  };
  check('VITE_WORLD_APP_ID', appId, /^app_[A-Za-z0-9_]+$/.test(appId), 'World app ID must start with app_.');
  check('WORLD_RP_ID', rpId, /^rp_[A-Za-z0-9_]+$/.test(rpId), 'World RP ID must start with rp_.');
  const hex = signingKey.replace(/^0x/, '');
  const validKey = /^[0-9a-fA-F]{64}$/.test(hex) && BigInt(`0x${hex}`) > 0n &&
    BigInt(`0x${hex}`) < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  check('WORLD_RP_SIGNING_KEY', signingKey, validKey, 'WORLD_RP_SIGNING_KEY must be a 32-byte private signing key (64 hex characters, optionally prefixed with 0x), not a public address.');
  if (!['staging', 'production'].includes(environment)) issues.push({ variable: 'WORLD_ENVIRONMENT', reason: 'invalid', message: 'WORLD_ENVIRONMENT must be staging or production.' });
  return {
    appId: /^app_[A-Za-z0-9_]+$/.test(appId) ? appId : '',
    rpId: /^rp_[A-Za-z0-9_]+$/.test(rpId) ? rpId : '',
    signingKey: validKey ? signingKey : '',
    issues,
    environment,
    allowGuest: e.OMEN_ALLOW_UNVERIFIED_GUEST === "1",
    chaipayUrl: (e.CHAIPAY_RELAYER_URL || "http://localhost:3001").replace(/\/$/, ""),
    dataFile: join(e.FINAL_DATA_DIR || join(ROOT, "server", "data"), "final-block.json"),
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Tiny JSON-file store with atomic writes. Shapes: humans{nullifier→human}, sessions{hash→…}. */
export function fileStore(file) {
  let db = { humans: {}, sessions: {}, wallets: {} };
  try {
    if (existsSync(file)) db = { ...db, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    /* start empty on a corrupt file rather than crash the demo */
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify(db, null, 1));
    renameSync(file + ".tmp", file);
  };
  return { db, save };
}

/** Crypto-random [0,1) for avatar picks, so crowds don't repeat Math.random's sequence across restarts. */
const lookRand = () => () => randomBytes(4).readUInt32BE() / 2 ** 32;
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function createFinalBlock({ config = finalConfig(), store = fileStore(config.dataFile), fetchImpl = fetch, signRequestImpl = null, now = Date.now } = {}) {
  const { db, save } = store;

  const configured = () => !!(config.appId && config.rpId && config.signingKey && !config.issues?.length);
  const cookieOf = (req) => /(?:^|;\s*)omen_human=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1] || null;
  const sessionOf = (req) => {
    const t = cookieOf(req);
    const s = t && db.sessions?.[sha(t)];
    if (!s || s.expiresAt < now()) return null;
    const human = db.humans[s.nullifier];
    return human ? { token: t, human } : null;
  };
  const publicHuman = (h) =>
    h && {
      playerId: h.playerId,
      verified: true,
      environment: h.environment,
      level: h.level,
      wallet: h.wallet || null,
      look: cleanLook(h.look || {}),
      verifiedAt: h.verifiedAt,
      // The VERIFIED HUMAN badge is only for a production proof World confirmed. Staging = simulator.
      badge: h.environment === "production" ? "VERIFIED HUMAN" : "STAGING SIMULATOR (not a real World ID)",
    };

  async function rpContext() {
    if (!configured()) throw new HttpError(503, "world_not_configured", "World ID isn't configured on this server (VITE_WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY).");
    const sign = signRequestImpl || (await import("@worldcoin/idkit-core/signing")).signRequest;
    const sig = sign({ signingKeyHex: config.signingKey.replace(/^0x/, ""), action: ACTION, ttl: 300 });
    return {
      app_id: config.appId,
      action: ACTION,
      environment: config.environment,
      rp_context: { rp_id: config.rpId, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
    };
  }

  async function verify(body, req) {
    if (!configured()) throw new HttpError(503, "world_not_configured", "World ID isn't configured on this server.");
    const proof = body?.result;
    if (!proof || typeof proof !== "object" || !Array.isArray(proof.responses) || !proof.responses.length) throw new HttpError(400, "bad_proof", "Send the IDKit result as {result}.");
    if (proof.action !== undefined && proof.action !== ACTION) throw new HttpError(400, "wrong_action", "That proof is for another action.");
    if (proof.environment && proof.environment !== config.environment) throw new HttpError(400, "wrong_environment", `This server accepts ${config.environment} proofs only.`);

    let r, j;
    try {
      r = await fetchImpl(VERIFY_URL(config.rpId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof), signal: AbortSignal.timeout(15000) });
      j = await r.json().catch(() => null);
    } catch {
      throw new HttpError(502, "world_unreachable", "Couldn't reach World's verify API. Try again.");
    }
    if (!r.ok || j?.success !== true) throw new HttpError(400, j?.code || "verification_failed", j?.detail || j?.message || "World didn't accept this proof.");

    // The nullifier World just vouched for: the first (and for our presets, only) response.
    const resp = proof.responses[0];
    const nullifier = String(resp.nullifier ?? resp.nullifier_hash ?? "");
    if (!/^(0x[0-9a-fA-F]{1,64}|\d{1,80})$/.test(nullifier)) throw new HttpError(400, "bad_proof", "The proof has no nullifier.");
    const key = `${ACTION}:${BigInt(nullifier).toString()}`; // canonical: decimal, so hex and decimal can't double-register
    const level = String(resp.identifier || resp.credential_type || resp.verification_level || "orb").replace(/^.*?(orb|device|document|face|selfie).*$/i, "$1").toLowerCase();

    let human = db.humans[key];
    const returning = !!human;
    // A randomized avatar, chosen once when this identity is first created (never from World ID data).
    if (!human) human = db.humans[key] = { playerId: "h_" + sha(key).slice(0, 20), environment: config.environment, level, verifiedAt: now(), wallet: null, look: randomLook(lookRand()) };
    if (!human.look) human.look = randomLook(lookRand());
    const token = randomBytes(32).toString("hex");
    db.sessions[sha(token)] = { nullifier: key, createdAt: now(), expiresAt: now() + SESSION_DAYS * 864e5 };
    for (const [h, s] of Object.entries(db.sessions)) if (s.expiresAt < now()) delete db.sessions[h];
    save();
    const secure = req.headers["x-forwarded-proto"] === "https" || env.NODE_ENV === "production" ? "; Secure" : "";
    return { __cookie: `omen_human=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`, human: publicHuman(human), returning };
  }

  /** Bind one wallet to one human, proven by a personal_sign over a server-shaped message. */
  async function bindWallet(body, req) {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "not_verified", "Verify with World ID first.");
    if (!isAddress(body?.address || "")) throw new HttpError(400, "bad_address", "Send a wallet address.");
    const address = getAddress(body.address);
    const message = walletMessage(s.human.playerId, address);
    if (body.message !== message) throw new HttpError(400, "bad_message", "Sign the exact message the server expects.");
    let ok = false;
    try {
      ok = await verifyMessage({ address, message, signature: body.signature });
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(400, "bad_signature", "That signature isn't from this wallet.");
    const owner = db.wallets[address];
    if (owner && owner !== s.human.playerId) throw new HttpError(409, "wallet_taken", "This wallet already belongs to another verified player.");
    if (s.human.wallet && s.human.wallet !== address) delete db.wallets[s.human.wallet];
    s.human.wallet = address;
    db.wallets[address] = s.human.playerId;
    save();
    return { human: publicHuman(s.human) };
  }

  const routes = {
    "GET /api/world/config": async () => ({ configured: configured(), appId: config.appId || null, action: ACTION, environment: config.environment, allowGuest: config.allowGuest, issues: config.issues || [] }),
    "POST /api/world/rp-context": rpContext,
    "POST /api/verify": verify,
    "GET /api/human": async (_, req) => ({ human: publicHuman(sessionOf(req)?.human) || null }),
    "GET /api/human/wallet-message": async (_, req, url) => {
      const s = sessionOf(req);
      if (!s) throw new HttpError(401, "not_verified", "Verify with World ID first.");
      const a = url.searchParams.get("address") || "";
      if (!isAddress(a)) throw new HttpError(400, "bad_address", "Send a wallet address.");
      return { message: walletMessage(s.human.playerId, getAddress(a)) };
    },
    "POST /api/human/wallet": bindWallet,
    "POST /api/human/logout": async (_, req) => {
      const t = cookieOf(req);
      if (t) delete db.sessions[sha(t)];
      save();
      return { __cookie: "omen_human=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", ok: true };
    },
  };

  const extra = [];
  const handle = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const key = `${req.method} ${url.pathname}`;
    const fn = routes[key] || extra.find((x) => x.match(req.method, url.pathname))?.fn;
    if (!fn) return false;
    const send = (status, body) => {
      const cookie = body?.__cookie;
      if (cookie) delete body.__cookie;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(cookie ? { "set-cookie": cookie } : {}) });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "POST" && req.headers.origin) {
        const o = new URL(req.headers.origin);
        if (o.host !== req.headers.host) throw new HttpError(403, "bad_origin", "This origin is not allowed.");
      }
      const body = req.method === "POST" ? await readJson(req) : null;
      const execute = () => fn(body, req, url);
      send(200, await (store.run ? store.run(execute) : execute()));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error("[final-block]", e);
      send(e.status || 500, { error: e.code || "internal", message: e instanceof HttpError ? e.message : "Something went wrong." });
    }
    return true;
  };
  handle.sessionOf = sessionOf;
  handle.resolveSession = (req) => store.run ? store.run(() => sessionOf(req)) : Promise.resolve(sessionOf(req));
  handle.publicHuman = publicHuman;
  handle.db = db;
  handle.save = save;
  handle.config = config;
  /** Later steps add routes: use(method, pathRegex, fn(body, req, url, match)). */
  handle.use = (method, re, fn) => extra.push({ match: (m, p) => m === method && re.test(p), fn: (b, req, url) => fn(b, req, url, re.exec(url.pathname)) });
  handle.HttpError = HttpError;
  return handle;
}

export const walletMessage = (playerId, address) => `OMEN: link this wallet to my verified player.\nPlayer: ${playerId}\nWallet: ${address}\nTestnet only. This signature costs nothing and moves no funds.`;

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers["content-type"] || "")) return reject(new HttpError(415, "json_only", "Send JSON."));
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > max) {
        reject(new HttpError(413, "too_large", "Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new HttpError(400, "bad_json", "Malformed JSON."));
      }
    });
    req.on("error", reject);
  });
}
