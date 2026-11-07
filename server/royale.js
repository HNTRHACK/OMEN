// Bounty Royale: the multiplayer ETHGlobal Mumbai prediction arena.
// FREE, NON-TRANSFERABLE, NON-REDEEMABLE OMEN points only. No deposits, withdrawals, crypto
// wagering, cash payouts or prizes. The server decides balances, deadlines, locks, scores and
// settlements; the browser only asks.
//
// Identity: the World ID human from the gate (server/final-block.js): one nullifier → one player →
// one 1,000-point grant. Moderators: the existing moderator accounts (server/auth.js).
import { randomBytes } from "node:crypto";
import { Server } from "socket.io";
import { createAuth } from "./auth.js";

export const GRANT = 1000;
export const MAX_STAKE = 1000;
export const SPONSORS = ["Whitechain", "Chainlink", "World", "ENS", "Arc", "Hedera", "0G", "1inch", "Uniswap", "Arkiv", "Ethereum Foundation", "Definitive"];
export const DEFAULT_LOCK = process.env.ROYALE_LOCK_AT || "2026-11-08T12:00:00+05:30";

/** Fixed, published rules. Shown in the arena before anyone stakes. */
export const RULES = {
  points: `Every World ID-verified human gets ${GRANT} free OMEN points, once. Points are free, non-transferable and non-redeemable: no deposits, withdrawals, cash, crypto or prizes.`,
  staking: `Commit 1–${MAX_STAKE} points per pick. Points leave your balance the moment you confirm; a pick can't be edited or withdrawn. One stake per team per market.`,
  lock: "Every market locks at its deadline (server time). Moderators may close a market earlier.",
  scoring: "Each market is a shared pool. When official results are announced, the whole pool is split between the points staked on winning picks, in proportion to each winning stake (rounded down). Losing picks score 0.",
  refunds: "If a market is voided, or nobody picked a winner, every stake in it is refunded in full.",
  results: "Moderators enter only official ETHGlobal results, with the source. Results appear for everyone at the same moment.",
  modes: {
    top3: "TOP THREE — pick up to 3 teams you think finish in the top three. If ETHGlobal announces unranked finalists instead, picks score against the official finalist list.",
    bounty: "SPONSOR BOUNTIES — one market per official sponsor track. Pick up to 3 teams per track; tracks with several prizes have several winners.",
    double: "DOUBLE CROWN — pick up to 3 teams that win a sponsor bounty AND a finalist spot.",
    wildcard: "GAME DEV WILDCARD — will a qualifying game project reach the finalists? A project qualifies if it is registered here as a game: its core is an interactive game (players make choices toward goals inside a game loop), playable at judging. Decided by moderators from the project's own submission before predictions open.",
  },
};

const MODES = ["top3", "bounty", "double", "wildcard"];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);

/** Markets every arena starts with (moderators can add, re-time or void). */
export function defaultMarkets(lockAt = DEFAULT_LOCK) {
  return [
    { id: "top3", mode: "top3", title: "Top three of ETHGlobal Mumbai", maxPicks: 3, kind: "projects", sort: 0 },
    ...SPONSORS.map((s, i) => ({ id: `bounty-${slug(s)}`, mode: "bounty", title: `${s} bounty winners`, sponsor: s, maxPicks: 3, kind: "projects", sort: 10 + i })),
    { id: "double-crown", mode: "double", title: "Double Crown: sponsor bounty + finalist", maxPicks: 3, kind: "projects", sort: 40 },
    { id: "game-wildcard", mode: "wildcard", title: "Does a game project reach the finalists?", maxPicks: 1, kind: "yesno", sort: 50 },
  ].map((m) => ({ ...m, lockAt }));
}

const DEMO_TEAMS = [
  { id: "demo-team-a", name: "DEMO Team A", team: "Sample team · not an ETHGlobal entrant" },
  { id: "demo-team-b", name: "DEMO Team B", team: "Sample team · not an ETHGlobal entrant" },
  { id: "demo-team-c", name: "DEMO Team C", team: "Sample team · not an ETHGlobal entrant", isGame: true },
];

class RoyaleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createRoyale({ pool, database = null, auth = database ? createAuth(database) : null, sessionOf, now = () => new Date() }) {
  let io = null;
  const tx = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") throw new RoyaleError(409, "duplicate", "You already have that pick.");
      if (e.code === "23514") throw new RoyaleError(409, "insufficient_points", "Not enough points.");
      throw e;
    } finally {
      c.release();
    }
  };

  async function seed() {
    await tx(async (c) => {
      // Operator switch for testing before the official list exists: the same clearly labelled DEMO teams.
      if (process.env.ROYALE_DEMO_TEAMS === "1")
        for (const t of DEMO_TEAMS) await c.query("INSERT INTO royale_projects(id,name,team,is_game,is_demo) VALUES($1,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING", [t.id, t.name, t.team, !!t.isGame]);
      for (const m of defaultMarkets())
        await c.query("INSERT INTO royale_markets(id,mode,title,sponsor,max_picks,kind,lock_at,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING", [m.id, m.mode, m.title, m.sponsor || null, m.maxPicks, m.kind, m.lockAt, m.sort]);
    });
  }

  const human = (req) => {
    const s = sessionOf(req);
    if (!s) throw new RoyaleError(401, "not_verified", "Verify with World ID to play Bounty Royale.");
    return s.human;
  };
  const moderator = async (req) => {
    if (!auth || !database) throw new RoyaleError(503, "no_moderation", "Moderation needs the full backend.");
    try {
      return await database.transaction(() => auth.account(req, "moderate"));
    } catch (e) {
      throw new RoyaleError(e.status || 401, e.code || "unauthorized", e.message);
    }
  };

  // ------------------------------------------------------------------ reads
  async function snapshot(playerId = null) {
    const q = (s, p) => pool.query(s, p).then((r) => r.rows);
    const [markets, projects, pools, board, recent, clock] = await Promise.all([
      q("SELECT * FROM royale_markets ORDER BY sort, id"),
      q("SELECT id,name,team,url,is_game,is_demo FROM royale_projects ORDER BY is_demo, name"),
      q("SELECT market_id, selection, sum(amount)::bigint AS points, count(*)::int AS picks, count(DISTINCT player_id)::int AS players FROM royale_predictions GROUP BY market_id, selection"),
      q(`SELECT p.player_id, p.display_name, p.balance + coalesce(sum(r.amount) FILTER (WHERE r.outcome IS NULL), 0) AS score,
           coalesce(sum(r.payout) FILTER (WHERE r.outcome = 'won'), 0) AS won
         FROM royale_players p LEFT JOIN royale_predictions r ON r.player_id = p.player_id
         GROUP BY p.player_id ORDER BY score DESC, p.granted_at ASC LIMIT 20`),
      q(`SELECT r.market_id, r.selection, r.amount, r.created_at, p.display_name FROM royale_predictions r JOIN royale_players p USING (player_id) ORDER BY r.created_at DESC LIMIT 15`),
      q("SELECT now() AS now"),
    ]);
    const t = clock[0].now;
    const byMarket = new Map();
    for (const p of pools) {
      if (!byMarket.has(p.market_id)) byMarket.set(p.market_id, []);
      byMarket.get(p.market_id).push({ selection: p.selection, points: Number(p.points), picks: p.picks, players: p.players });
    }
    let me = null;
    if (playerId) {
      const [pl] = await q("SELECT player_id, display_name, balance, granted_at FROM royale_players WHERE player_id=$1", [playerId]);
      if (pl) {
        const picks = await q("SELECT id, market_id, selection, amount, created_at, outcome, payout FROM royale_predictions WHERE player_id=$1 ORDER BY created_at DESC", [playerId]);
        const committed = picks.filter((p) => !p.outcome).reduce((a, p) => a + Number(p.amount), 0);
        me = { playerId, name: pl.display_name, balance: Number(pl.balance), committed, predictions: picks.map((p) => ({ ...p, amount: Number(p.amount), payout: p.payout === null ? null : Number(p.payout) })) };
      }
    }
    return {
      serverTime: t,
      rules: RULES,
      label: "Free OMEN points only. Non-transferable, non-redeemable. No real money.",
      projects: projects.map((p) => ({ id: p.id, name: p.name, team: p.team, url: p.url, isGame: p.is_game, demo: p.is_demo })),
      demoMode: projects.some((p) => p.is_demo),
      markets: markets.map((m) => {
        const sel = byMarket.get(m.id) || [];
        const total = sel.reduce((a, s) => a + s.points, 0);
        const status = m.status === "open" && new Date(m.lock_at) <= t ? "locked" : m.status;
        return {
          id: m.id, mode: m.mode, title: m.title, sponsor: m.sponsor, maxPicks: m.max_picks, kind: m.kind, status, lockAt: m.lock_at,
          winners: ["settled", "void"].includes(m.status) ? m.winners || [] : null, resultSource: m.result_source, settledAt: m.settled_at,
          pool: total, players: new Set(sel.flatMap((s) => s.players)).size,
          selections: sel.map((s) => ({ ...s, share: total ? s.points / total : 0 })).sort((a, b) => b.points - a.points),
        };
      }),
      leaderboard: board.map((b, i) => ({ rank: i + 1, name: b.display_name || "Courier", score: Number(b.score), won: Number(b.won), me: b.player_id === playerId })),
      activity: recent.map((r) => ({ name: r.display_name || "Courier", marketId: r.market_id, selection: r.selection, amount: Number(r.amount), at: r.created_at })),
      me,
    };
  }

  // ------------------------------------------------------------------ player writes
  async function join(req, body) {
    const h = human(req);
    const name = clean(body?.name, 16) || "Courier";
    const granted = await tx(async (c) => {
      const ins = await c.query("INSERT INTO royale_players(player_id, display_name, balance) VALUES($1,$2,$3) ON CONFLICT (player_id) DO NOTHING RETURNING player_id", [h.playerId, name, GRANT]);
      if (ins.rowCount) await c.query("INSERT INTO royale_ledger(player_id, delta, balance_after, kind, ref) VALUES($1,$2,$2,'grant','initial')", [h.playerId, GRANT]);
      else await c.query("UPDATE royale_players SET display_name=$2 WHERE player_id=$1", [h.playerId, name]);
      return ins.rowCount === 1;
    });
    if (granted) changed({ type: "joined", name });
    return { granted, ...(await snapshot(h.playerId)) };
  }

  const recentStakes = new Map(); // playerId → timestamps (rate limit: 20 picks / minute)
  async function predict(req, body) {
    const h = human(req);
    const t = Date.now();
    const list = (recentStakes.get(h.playerId) || []).filter((x) => t - x < 60_000);
    if (list.length >= 20) throw new RoyaleError(429, "rate_limited", "Slow down a little.");
    recentStakes.set(h.playerId, [...list, t]);

    const marketId = clean(body?.marketId, 64);
    const selection = clean(body?.selection, 64);
    const amount = Number(body?.amount);
    const idem = clean(body?.idempotencyKey, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(idem)) throw new RoyaleError(400, "bad_request", "Missing idempotency key.");
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_STAKE) throw new RoyaleError(400, "bad_amount", `Stake a whole number of points, 1–${MAX_STAKE}.`);

    const out = await tx(async (c) => {
      // Serialise this player's writes; replays of the same request return the same prediction.
      const [pl] = (await c.query("SELECT balance FROM royale_players WHERE player_id=$1 FOR UPDATE", [h.playerId])).rows;
      if (!pl) throw new RoyaleError(409, "not_joined", "Enter Bounty Royale first.");
      const [prev] = (await c.query("SELECT * FROM royale_predictions WHERE player_id=$1 AND idem_key=$2", [h.playerId, idem])).rows;
      if (prev) {
        if (prev.market_id !== marketId || prev.selection !== selection || Number(prev.amount) !== amount) throw new RoyaleError(409, "idempotency_mismatch", "That key was used for a different pick.");
        return { prediction: prev, replay: true };
      }
      const [m] = (await c.query("SELECT *, now() AS server_now FROM royale_markets WHERE id=$1 FOR SHARE", [marketId])).rows;
      if (!m) throw new RoyaleError(404, "no_market", "No such market.");
      if (m.status !== "open" || new Date(m.lock_at) <= m.server_now) throw new RoyaleError(409, "market_locked", "This market is locked.");
      if (m.kind === "yesno") {
        if (!["yes", "no"].includes(selection)) throw new RoyaleError(400, "bad_selection", "Pick yes or no.");
      } else if (!(await c.query("SELECT 1 FROM royale_projects WHERE id=$1", [selection])).rowCount) throw new RoyaleError(400, "bad_selection", "Pick a registered team.");
      const picks = (await c.query("SELECT count(*)::int AS n FROM royale_predictions WHERE player_id=$1 AND market_id=$2", [h.playerId, marketId])).rows[0].n;
      if (picks >= m.max_picks) throw new RoyaleError(409, "max_picks", `You can make ${m.max_picks} pick${m.max_picks > 1 ? "s" : ""} in this market.`);
      if (m.kind === "yesno" && picks) throw new RoyaleError(409, "max_picks", "You already picked a side.");
      if (Number(pl.balance) < amount) throw new RoyaleError(409, "insufficient_points", "Not enough points.");
      const id = "pr_" + randomBytes(10).toString("hex");
      const bal = (await c.query("UPDATE royale_players SET balance = balance - $2 WHERE player_id=$1 AND balance >= $2 RETURNING balance", [h.playerId, amount])).rows[0];
      if (!bal) throw new RoyaleError(409, "insufficient_points", "Not enough points.");
      const [p] = (await c.query("INSERT INTO royale_predictions(id, player_id, market_id, selection, amount, idem_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [id, h.playerId, marketId, selection, amount, idem])).rows;
      await c.query("INSERT INTO royale_ledger(player_id, delta, balance_after, kind, ref) VALUES($1,$2,$3,'stake',$4)", [h.playerId, -amount, bal.balance, id]);
      return { prediction: p, replay: false };
    });
    if (!out.replay) changed({ type: "stake", marketId, selection, amount });
    return { prediction: { ...out.prediction, amount: Number(out.prediction.amount) }, replay: out.replay, ...(await snapshot(h.playerId)) };
  }

  async function ledger(req) {
    const h = human(req);
    const rows = (await pool.query("SELECT delta, balance_after, kind, ref, created_at FROM royale_ledger WHERE player_id=$1 ORDER BY id DESC LIMIT 200", [h.playerId])).rows;
    return { ledger: rows.map((r) => ({ ...r, delta: Number(r.delta), balance_after: Number(r.balance_after) })) };
  }

  // ------------------------------------------------------------------ moderator writes
  const audit = (c, who, action, detail) => c.query("INSERT INTO royale_audit(actor, action, detail) VALUES($1,$2,$3)", [who.username || who.id || "moderator", action, JSON.stringify(detail)]);

  async function importProjects(req, body) {
    const who = await moderator(req);
    const list = Array.isArray(body?.projects) ? body.projects.slice(0, 1000) : [];
    if (!list.length) throw new RoyaleError(400, "bad_request", "Send {projects:[{name, team?, url?, isGame?}]}.");
    const n = await tx(async (c) => {
      let n = 0;
      for (const p of list) {
        const name = clean(p?.name, 80);
        if (!name) continue;
        const id = slug(p.id || name);
        await c.query("INSERT INTO royale_projects(id,name,team,url,is_game) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=excluded.name, team=excluded.team, url=excluded.url, is_game=excluded.is_game", [id, name, clean(p.team, 80), /^https?:\/\//.test(p.url || "") ? clean(p.url, 200) : "", !!p.isGame]);
        n++;
      }
      await audit(c, who, "import_projects", { count: n });
      return n;
    });
    changed({ type: "projects" });
    return { imported: n };
  }

  /** DEMO mode: three sample teams so the game can be played before the official list exists. */

  async function demoTeams(req, body) {
    const who = await moderator(req);
    const on = body?.enabled !== false;
    await tx(async (c) => {
      if (on) for (const t of DEMO_TEAMS) await c.query("INSERT INTO royale_projects(id,name,team,is_game,is_demo) VALUES($1,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING", [t.id, t.name, t.team, !!t.isGame]);
      else {
        const used = (await c.query("SELECT 1 FROM royale_predictions WHERE selection LIKE 'demo-team-%' LIMIT 1")).rowCount;
        if (used) throw new RoyaleError(409, "demo_in_use", "DEMO teams have predictions; void those markets first.");
        await c.query("DELETE FROM royale_projects WHERE is_demo");
      }
      await audit(c, who, on ? "demo_on" : "demo_off", {});
    });
    changed({ type: "projects" });
    return { demo: on };
  }
  async function auditLog(req) {
    await moderator(req);
    return { audit: (await pool.query("SELECT actor, action, detail, created_at FROM royale_audit ORDER BY id DESC LIMIT 50")).rows };
  }

  async function upsertMarket(req, body) {
    const who = await moderator(req);
    const id = slug(body?.id || body?.title);
    if (!id || !MODES.includes(body?.mode)) throw new RoyaleError(400, "bad_request", "Send {id?, mode, title, sponsor?, maxPicks?, lockAt}.");
    const lockAt = new Date(body.lockAt || DEFAULT_LOCK);
    if (isNaN(lockAt)) throw new RoyaleError(400, "bad_request", "Bad lockAt.");
    await tx(async (c) => {
      const [m] = (await c.query("SELECT status FROM royale_markets WHERE id=$1 FOR UPDATE", [id])).rows;
      if (m && ["settled", "void"].includes(m.status)) throw new RoyaleError(409, "settled", "That market is already settled.");
      await c.query(
        `INSERT INTO royale_markets(id,mode,title,sponsor,max_picks,kind,lock_at,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET title=excluded.title, sponsor=excluded.sponsor, max_picks=excluded.max_picks, lock_at=excluded.lock_at`,
        [id, body.mode, clean(body.title, 120) || id, clean(body.sponsor, 60) || null, Math.min(10, Math.max(1, Number(body.maxPicks) || 1)), body.mode === "wildcard" ? "yesno" : "projects", lockAt, Number(body.sort) || 100],
      );
      await audit(c, who, "upsert_market", { id, lockAt });
    });
    changed({ type: "market", marketId: id });
    return { ok: true, id };
  }

  async function closeMarket(req, id) {
    const who = await moderator(req);
    await tx(async (c) => {
      const r = await c.query("UPDATE royale_markets SET status='locked', lock_at=least(lock_at, now()) WHERE id=$1 AND status='open' RETURNING id", [id]);
      if (!r.rowCount) throw new RoyaleError(409, "not_open", "Market isn't open.");
      await audit(c, who, "close", { id });
    });
    changed({ type: "locked", marketId: id });
    return { ok: true };
  }

  /** Settle with official winners, or void (winners = null). Idempotent: a settled market stays settled. */
  async function settle(req, id, body, { voided = false } = {}) {
    const who = await moderator(req);
    const source = clean(body?.source, 300);
    if (!voided && !source) throw new RoyaleError(400, "bad_request", "Give the official source (announcement URL or note).");
    const result = await tx(async (c) => {
      const [m] = (await c.query("SELECT * FROM royale_markets WHERE id=$1 FOR UPDATE", [id])).rows;
      if (!m) throw new RoyaleError(404, "no_market", "No such market.");
      if (["settled", "void"].includes(m.status)) return { already: true, status: m.status };
      let winners = [];
      if (!voided) {
        winners = [...new Set((Array.isArray(body?.winners) ? body.winners : []).map((w) => clean(w, 64)))];
        if (!winners.length) throw new RoyaleError(400, "bad_request", "Enter the official winners.");
        if (m.kind === "yesno" && (winners.length !== 1 || !["yes", "no"].includes(winners[0]))) throw new RoyaleError(400, "bad_request", "Winner is yes or no.");
        if (m.kind === "projects") {
          const known = (await c.query("SELECT id FROM royale_projects WHERE id = ANY($1)", [winners])).rows.length;
          if (known !== winners.length) throw new RoyaleError(400, "bad_request", "Winners must be registered teams.");
        }
      }
      const preds = (await c.query("SELECT * FROM royale_predictions WHERE market_id=$1 AND outcome IS NULL ORDER BY created_at FOR UPDATE", [id])).rows;
      const pool = preds.reduce((a, p) => a + BigInt(p.amount), 0n);
      const winPool = preds.filter((p) => winners.includes(p.selection)).reduce((a, p) => a + BigInt(p.amount), 0n);
      const refund = voided || winPool === 0n;
      // lock every affected player row in a fixed order to avoid deadlocks
      const players = [...new Set(preds.map((p) => p.player_id))].sort();
      for (const pid of players) await c.query("SELECT 1 FROM royale_players WHERE player_id=$1 FOR UPDATE", [pid]);
      for (const p of preds) {
        const win = !refund && winners.includes(p.selection);
        const credit = refund ? BigInt(p.amount) : win ? (BigInt(p.amount) * pool) / winPool : 0n;
        await c.query("UPDATE royale_predictions SET outcome=$2, payout=$3 WHERE id=$1", [p.id, refund ? "refunded" : win ? "won" : "lost", credit.toString()]);
        if (credit > 0n) {
          const [b] = (await c.query("UPDATE royale_players SET balance = balance + $2 WHERE player_id=$1 RETURNING balance", [p.player_id, credit.toString()])).rows;
          await c.query("INSERT INTO royale_ledger(player_id, delta, balance_after, kind, ref) VALUES($1,$2,$3,$4,$5)", [p.player_id, credit.toString(), b.balance, refund ? "refund" : "payout", p.id]);
        }
      }
      await c.query("UPDATE royale_markets SET status=$2, winners=$3, result_source=$4, settled_at=now() WHERE id=$1", [id, refund && voided ? "void" : "settled", JSON.stringify(winners), source || (voided ? "voided by moderator" : null)]);
      await audit(c, who, voided ? "void" : "settle", { id, winners, source, pool: pool.toString(), winPool: winPool.toString(), refunded: refund });
      return { status: voided ? "void" : "settled", winners, pool: Number(pool), refunded: refund };
    });
    if (!result.already) {
      changed({ type: "reveal", marketId: id });
      io?.of("/royale").emit("royale:reveal", { marketId: id, ...result });
    }
    return result;
  }

  // ------------------------------------------------------------------ realtime
  let pending = null;
  function changed(event) {
    io?.of("/royale").emit("royale:activity", event);
    if (pending) return; // coalesce bursts: one "refresh" per 300 ms
    pending = setTimeout(() => {
      pending = null;
      io?.of("/royale").emit("royale:changed", { at: Date.now() });
    }, 300);
  }

  function attach(httpServer) {
    io = new Server(httpServer, { path: "/royale-io/", serveClient: false, maxHttpBufferSize: 2048 });
    io.of("/royale").use((sock, next) => {
      const s = sessionOf({ headers: sock.handshake.headers });
      sock.data.playerId = s?.human.playerId || null; // spectators may watch; only humans stake (over HTTP)
      next();
    });
    io.of("/royale").on("connection", (sock) => {
      sock.emit("royale:hello", { verified: !!sock.data.playerId });
      const count = () => io.of("/royale").emit("royale:presence", { online: io.of("/royale").sockets.size });
      count();
      sock.on("disconnect", count);
    });
    return io;
  }

  // ------------------------------------------------------------------ routes
  function mount(final) {
    const wrap = (fn) => async (body, req, url, match) => {
      try {
        return await fn(body, req, url, match);
      } catch (e) {
        if (e instanceof RoyaleError) throw new final.HttpError(e.status, e.code, e.message);
        throw e;
      }
    };
    final.use("GET", /^\/api\/royale\/state$/, wrap(async (_, req) => snapshot(sessionOf(req)?.human.playerId || null)));
    final.use("GET", /^\/api\/royale\/rules$/, wrap(async () => ({ rules: RULES })));
    final.use("POST", /^\/api\/royale\/join$/, wrap(async (b, req) => join(req, b)));
    final.use("POST", /^\/api\/royale\/predictions$/, wrap(async (b, req) => predict(req, b)));
    final.use("GET", /^\/api\/royale\/ledger$/, wrap(async (_, req) => ledger(req)));
    final.use("POST", /^\/api\/royale\/mod\/projects$/, wrap(async (b, req) => importProjects(req, b)));
    final.use("POST", /^\/api\/royale\/mod\/markets$/, wrap(async (b, req) => upsertMarket(req, b)));
    final.use("POST", /^\/api\/royale\/mod\/markets\/([a-z0-9-]{1,64})\/close$/, wrap(async (b, req, url, m) => closeMarket(req, m[1])));
    final.use("POST", /^\/api\/royale\/mod\/markets\/([a-z0-9-]{1,64})\/settle$/, wrap(async (b, req, url, m) => settle(req, m[1], b)));
    final.use("POST", /^\/api\/royale\/mod\/markets\/([a-z0-9-]{1,64})\/void$/, wrap(async (b, req, url, m) => settle(req, m[1], b, { voided: true })));
    final.use("POST", /^\/api\/royale\/mod\/demo$/, wrap(async (b, req) => demoTeams(req, b)));
    final.use("GET", /^\/api\/royale\/mod\/audit$/, wrap(async (_, req) => auditLog(req)));
    final.use("GET", /^\/api\/royale\/mod\/me$/, wrap(async (_, req) => ({ moderator: await moderator(req) })));
  }

  return { seed, snapshot, join, predict, ledger, importProjects, upsertMarket, closeMarket, settle, attach, mount, get io() { return io; } };
}
