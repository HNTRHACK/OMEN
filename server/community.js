// The plaza's community layer: forum (threads, replies, reports), billboard ads (upload → review →
// optional rental → live → expiry) and mutes. Everything persists server-side; live updates go to
// every connected player. Moderators act with MODERATOR_KEY (moderate.html).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Collection } from "./db.js";
import { ApiError } from "./payments.js";
import { moderateText, safeUrl, rateLimiter, REPORT_HIDE } from "./moderation.js";
import { checkImage, storeImage } from "./images.js";
import { clean } from "./commerce.js";
import { BOARDS, boardById, SLOTS_PER_BOARD, AD_DAYS, AD_RENT_PAISE_PER_DAY } from "../shared/billboards.js";
import { directMerchantId } from "../shared/merchants.js";

export const CATS = { general: "General", market: "Marketplace", help: "Help & advice" };
const bad = (code, msg, status = 400) => new ApiError(status, code, msg);
const need = (id) => {
  if (!id) throw bad("no_identity", "Join the world first.", 401);
  return id;
};
const DAY = 86_400_000;
const VIEW_GAP = 5 * 60_000; // one impression per viewer per ad per 5 minutes
const CLICK_GAP = 30_000;
const MAX_TRACKED = 5000; // unique viewers/clickers remembered per ad

export function createCommunity({ dir = null, payments = null, notify = { all() {}, player() {} }, now = () => Date.now(), shopLookup = () => null, billboardPayout = process.env.BILLBOARD_PAYOUT || "" } = {}) {
  const threads = new Collection(dir, "threads");
  const posts = new Collection(dir, "posts");
  const ads = new Collection(dir, "ads");
  const mutes = new Collection(dir, "mutes");
  const uploads = dir ? join(dir, "uploads") : null;
  const threadRate = rateLimiter(3, 2); // per player per minute
  const postRate = rateLimiter(8, 4);
  const adRate = rateLimiter(2, 2);
  const reportRate = rateLimiter(20, 10);
  const seenRate = rateLimiter(90, 40);
  const seenAt = new Map(); // "adId:playerId:kind" -> last counted time (memory only; bounded)

  const muted = (id) => !!mutes.get(id);
  function speaker(id) {
    need(id);
    if (muted(id)) throw bad("muted", "A moderator has muted this courier.", 403);
    return id;
  }
  const text = (raw, opts) => {
    const r = moderateText(raw, opts);
    if (!r.ok) throw bad("rejected", r.reason);
    return r.text;
  };
  const visible = (x) => !x.hidden;
  const pubThread = (t) => ({ id: t.id, cat: t.cat, title: t.title, body: t.body, authorName: t.authorName, author: t.author, createdAt: t.createdAt, lastAt: t.lastAt, replies: t.replies });
  const pubPost = (p) => ({ id: p.id, threadId: p.threadId, parentId: p.parentId, body: p.body, authorName: p.authorName, author: p.author, createdAt: p.createdAt });

  // ---------------------------------------------------------------- forum
  function listThreads(cat) {
    return threads
      .where((t) => visible(t) && (!cat || t.cat === cat))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 60)
      .map(pubThread);
  }
  function getThread(id) {
    const t = threads.get(id);
    if (!t || !visible(t)) throw bad("not_found", "That thread is gone.", 404);
    return { thread: pubThread(t), posts: posts.where((p) => p.threadId === id && visible(p)).sort((a, b) => a.createdAt - b.createdAt).map(pubPost) };
  }
  function newThread(playerId, name, { cat, title, body }) {
    speaker(playerId);
    if (!CATS[cat]) throw bad("bad_cat", "Pick a category.");
    if (!threadRate(playerId, now())) throw bad("slow_down", "You're posting a lot. Give it a minute.", 429);
    const t = { id: randomUUID(), cat, title: text(title, { max: 80, min: 4 }), body: text(body, { max: 1500, min: 2, links: 2 }), author: playerId, authorName: clean(name, 16) || "Courier", createdAt: now(), lastAt: now(), replies: 0, reports: [], hidden: false };
    threads.put(t);
    notify.all("forum:thread", pubThread(t));
    return pubThread(t);
  }
  function reply(playerId, name, threadId, { body, parentId }) {
    speaker(playerId);
    const t = threads.get(threadId);
    if (!t || !visible(t)) throw bad("not_found", "That thread is gone.", 404);
    if (parentId) {
      const parent = posts.get(parentId);
      if (!parent || parent.threadId !== threadId) throw bad("bad_parent", "Reply to a post in this thread.");
      if (parent.parentId) parentId = parent.parentId; // keep replies one level deep
    }
    if (!postRate(playerId, now())) throw bad("slow_down", "Slow down a little.", 429);
    const p = { id: randomUUID(), threadId, parentId: parentId || null, body: text(body, { max: 1000, min: 1, links: 1 }), author: playerId, authorName: clean(name, 16) || "Courier", createdAt: now(), reports: [], hidden: false };
    posts.put(p);
    t.replies += 1;
    t.lastAt = now();
    threads.put(t);
    notify.all("forum:post", { ...pubPost(p), threadTitle: t.title });
    if (t.author !== playerId) notify.player(t.author, "forum:reply", { threadId, title: t.title, from: p.authorName });
    return pubPost(p);
  }

  // ---------------------------------------------------------------- reports
  function report(playerId, { kind, id }) {
    need(playerId);
    if (!reportRate(playerId, now())) throw bad("slow_down", "Too many reports at once.", 429);
    const col = { thread: threads, post: posts, ad: ads }[kind];
    const x = col?.get(id);
    if (!x) throw bad("not_found", "Nothing to report there.", 404);
    if (x.author === playerId) throw bad("own", "You can't report your own post.");
    x.reports ||= [];
    if (!x.reports.includes(playerId)) x.reports.push(playerId);
    if (x.reports.length >= REPORT_HIDE && !x.hidden) {
      x.hidden = true; // hidden until a moderator reviews it
      x.hiddenBy = "reports";
      if (kind === "ad") notify.all("ads:update", liveAds());
      else notify.all("forum:hidden", { kind, id });
    }
    col.put(x);
    return { ok: true, hidden: !!x.hidden };
  }

  // ---------------------------------------------------------------- billboard ads
  const pubAd = (a) => {
    const shop = a.shopId ? shopLookup(a.shopId) : null;
    return {
      id: a.id,
      boardId: a.boardId,
      brand: a.brand || a.authorName,
      title: a.title,
      text: a.text,
      link: a.link || null,
      shop: shop ? { id: shop.id, name: shop.name } : null,
      image: a.image ? `/uploads/${a.image}` : null,
      authorName: a.authorName,
      status: a.status,
      reason: a.reason || null,
      days: a.days,
      expiresAt: a.expiresAt || null,
      rented: !!a.rentPaymentId,
    };
  };
  /** What the advertiser (and moderators) see: the public card plus real, deduplicated counters. */
  const withStats = (a) => {
    const st = a.stats || { impressions: 0, clicks: 0, viewers: [], clickers: [] };
    return {
      ...pubAd(a),
      createdAt: a.createdAt,
      approvedAt: a.approvedAt || null,
      endedAt: a.endedAt || null,
      stats: { impressions: st.impressions, uniqueViewers: st.viewers.length, clicks: st.clicks, uniqueClickers: st.clickers.length, ctr: st.viewers.length ? Math.min(100, Math.round((st.clickers.length / st.viewers.length) * 1000) / 10) : 0 }, // % of unique viewers who clicked
    };
  };
  const isLive = (a) => a.status === "live" && !a.hidden && a.expiresAt > now();
  function liveAds() {
    return ads.where(isLive).sort((a, b) => b.approvedAt - a.approvedAt).map(pubAd);
  }
  const booked = (boardId) => ads.where((a) => a.boardId === boardId && ((a.status === "live" && a.expiresAt > now()) || a.status === "awaiting_rent")).length;
  /** Every hoarding with how many of its slots are taken, so players can claim a free one. */
  function boards() {
    return BOARDS.map((b) => {
      const holders = ads.where((a) => a.boardId === b.id && a.status === "live" && a.expiresAt > now());
      const taken = booked(b.id);
      return {
        id: b.id,
        label: b.label,
        slots: SLOTS_PER_BOARD,
        free: Math.max(0, SLOTS_PER_BOARD - taken),
        waiting: ads.where((a) => a.boardId === b.id && a.status === "pending").length,
        nextFreeAt: taken >= SLOTS_PER_BOARD && holders.length ? Math.min(...holders.map((a) => a.expiresAt)) : null,
      };
    });
  }
  function resolveDestination(playerId, b) {
    const hasLink = !!(b.link && String(b.link).trim());
    const hasShop = !!(b.shopId && String(b.shopId).trim());
    if (hasLink && hasShop) throw bad("one_destination", "Pick one destination: your stall or a link, not both.");
    if (hasShop) {
      const shop = /^[\w-]{1,40}$/.test(String(b.shopId)) ? shopLookup(String(b.shopId)) : null;
      if (!shop || shop.owner !== playerId) throw bad("bad_shop", "You can only point an ad at a stall you run.");
      return { shopId: shop.id, link: null };
    }
    if (hasLink) {
      const link = safeUrl(b.link);
      if (!link) throw bad("bad_link", "Links must be plain https:// addresses.");
      return { shopId: null, link };
    }
    return { shopId: null, link: null };
  }
  function submitAd(playerId, name, b) {
    speaker(playerId);
    const board = boardById(b.boardId);
    if (!board) throw bad("bad_board", "Pick a billboard.");
    const days = Number(b.days);
    if (!AD_DAYS.includes(days)) throw bad("bad_days", "Ads run for 1, 3 or 7 days.");
    const dest = resolveDestination(playerId, b);
    const brand = text(b.brand, { max: 30, min: 2 });
    const title = text(b.title, { max: 40, min: 2 });
    const body = text(b.text || "", { max: 160, min: 0 });
    const checked = b.image ? checkImage(b.image) : null; // validate everything before using any quota
    if (ads.where((a) => a.author === playerId && ["pending", "awaiting_rent"].includes(a.status)).length >= 2) throw bad("too_many", "You already have ads waiting for review.", 409);
    if (booked(board.id) >= SLOTS_PER_BOARD) {
      const free = boards().find((x) => x.id === board.id).nextFreeAt;
      throw bad("board_full", `The ${board.label} is fully booked${free ? ` until ${new Date(free).toUTCString()}` : ""}. Pick another hoarding.`, 409);
    }
    if (ads.where((a) => a.boardId === board.id && a.status === "pending").length >= 6) throw bad("queue_full", "That hoarding has a long review queue. Try another one.", 409);
    if (!adRate(playerId, now())) throw bad("slow_down", "One ad at a time, please.", 429);
    const img = checked ? storeImage(uploads, checked) : null;
    const a = {
      id: randomUUID(),
      boardId: board.id,
      brand,
      title,
      text: body,
      link: dest.link,
      shopId: dest.shopId,
      image: img?.file || null,
      author: playerId,
      authorName: clean(name, 16) || "Courier",
      days,
      status: "pending",
      reports: [],
      hidden: false,
      stats: { impressions: 0, clicks: 0, viewers: [], clickers: [] },
      createdAt: now(),
    };
    ads.put(a);
    notify.all("mod:queue", { pending: ads.where((x) => x.status === "pending").length });
    return pubAd(a);
  }
  const myAds = (playerId) => ads.where((a) => a.author === need(playerId)).sort((a, b) => b.createdAt - a.createdAt).map(withStats);

  function goLive(a) {
    a.status = "live";
    a.approvedAt = now();
    a.expiresAt = now() + a.days * DAY;
    ads.put(a);
    notify.all("ads:update", liveAds());
    notify.player(a.author, "ad:update", pubAd(a));
  }

  /** Rent a 3- or 7-day slot after approval: same checkout as everything else. */
  async function payRent(playerId, adId, { token }) {
    const a = ads.get(adId);
    if (!a || a.author !== need(playerId)) throw bad("not_found", "No such ad.", 404);
    if (a.status !== "awaiting_rent") throw bad("not_due", "This ad doesn't need rent right now.", 409);
    if (!payments) throw bad("off", "Payments are off.", 503);
    if (token === "USDT" && !billboardPayout) throw bad("no_payout", "Testnet USDT rental isn't configured (BILLBOARD_PAYOUT). Use DEMO credits.");
    const merchant = { id: "omen-billboards", name: "Blockhaven billboards", key: billboardPayout ? directMerchantId(billboardPayout) : null };
    let p = await payments.createDirect({ merchant, inrPaise: a.days * AD_RENT_PAISE_PER_DAY, note: `${a.days}-day billboard: ${a.title}`, token, market: { adId: a.id, kind: "ad" } });
    a.rentPaymentId = p.id;
    ads.put(a);
    p = await payments.risk(p.id);
    return { ad: pubAd(a), payment: p };
  }
  function onPayment(p) {
    const a = p.market?.adId && ads.get(p.market.adId);
    if (a && a.status === "awaiting_rent" && p.state === "COMPLETED" && a.rentPaymentId === p.id) goLive(a);
  }

  /** Expire old ads (the sweeper runs this). */
  function sweep() {
    let changed = false;
    for (const a of ads.where((x) => x.status === "live" && x.expiresAt <= now())) {
      a.status = "expired";
      a.endedAt = a.expiresAt;
      ads.put(a);
      changed = true;
    }
    // An approved ad whose rental is never confirmed must not hold a slot forever.
    for (const a of ads.where((x) => x.status === "awaiting_rent" && (x.decidedAt || x.createdAt) + 2 * DAY <= now())) {
      a.status = "expired";
      a.endedAt = now();
      a.reason = "The rental wasn't confirmed within 48 hours.";
      ads.put(a);
      notify.player(a.author, "ad:update", pubAd(a));
    }
    if (changed) notify.all("ads:update", liveAds());
  }

  // ---------------------------------------------------------------- real impressions and clicks
  // Counted only for LIVE ads, only for signed-in players, never for the advertiser's own views, at
  // most once per viewer per ad per 5 minutes (views) or 30 seconds (clicks). The browser reports a
  // view after the hoarding has been on screen, facing the player, for 1.5 s.
  function track(playerId, adId, kind) {
    need(playerId);
    if (!seenRate(playerId, now())) throw bad("slow_down", "Too many requests.", 429);
    const a = ads.get(adId);
    if (!a || !isLive(a)) return { counted: false, reason: "not_live" };
    if (a.author === playerId) return { counted: false, reason: "own_ad" };
    const key = `${adId}:${playerId}:${kind}`;
    const t = now();
    if (t - (seenAt.get(key) || 0) < (kind === "view" ? VIEW_GAP : CLICK_GAP)) return { counted: false, reason: "recent" };
    if (seenAt.size > 100_000) seenAt.clear(); // bounded memory
    seenAt.set(key, t);
    const st = (a.stats ||= { impressions: 0, clicks: 0, viewers: [], clickers: [] });
    const [counter, who] = kind === "view" ? ["impressions", "viewers"] : ["clicks", "clickers"];
    st[counter]++;
    if (!st[who].includes(playerId) && st[who].length < MAX_TRACKED) st[who].push(playerId);
    ads.save();
    return { counted: true };
  }
  const recordView = (playerId, adId) => track(playerId, adId, "view");
  const recordClick = (playerId, adId, kind = "details") => track(playerId, adId, `click-${["details", "shop", "link"].includes(kind) ? kind : "details"}`);

  // ---------------------------------------------------------------- moderation
  function modQueue() {
    return {
      pendingAds: ads.where((a) => a.status === "pending").map((a) => ({ ...pubAd(a), author: a.author, board: boards().find((x) => x.id === a.boardId) })),
      liveAds: ads.where((a) => a.status === "live" && a.expiresAt > now()).map((a) => ({ ...withStats(a), author: a.author })),
      decided: ads.where((a) => ["rejected", "expired", "removed"].includes(a.status)).sort((a, b) => (b.decidedAt || b.endedAt || b.createdAt) - (a.decidedAt || a.endedAt || a.createdAt)).slice(0, 15).map(withStats),
      reported: [
        ...threads.where((t) => t.reports?.length).map((t) => ({ kind: "thread", id: t.id, text: `${t.title}: ${t.body}`, authorName: t.authorName, author: t.author, reports: t.reports.length, hidden: t.hidden })),
        ...posts.where((p) => p.reports?.length).map((p) => ({ kind: "post", id: p.id, text: p.body, authorName: p.authorName, author: p.author, reports: p.reports.length, hidden: p.hidden })),
        ...ads.where((a) => a.reports?.length).map((a) => ({ kind: "ad", id: a.id, text: `${a.title}: ${a.text}`, authorName: a.authorName, author: a.author, reports: a.reports.length, hidden: a.hidden, image: a.image ? `/uploads/${a.image}` : null })),
      ],
      muted: mutes.all(),
    };
  }
  function moderate({ action, kind, id, playerId, reason }, { actor = null } = {}) {
    if (action === "approve" || action === "reject") {
      const a = ads.get(id);
      if (!a || a.status !== "pending") throw bad("not_pending", "That ad isn't waiting for review.", 409);
      // Moderators are a separate role (the moderator key); even one who also plays can't clear their own ad.
      if (actor && actor === a.author) throw bad("own_ad", "You can't moderate your own advertisement. Ask another moderator.", 403);
      if (action === "reject") {
        a.status = "rejected";
        a.decidedAt = now();
        a.reason = clean(reason, 120) || "Doesn't follow the billboard rules";
        ads.put(a);
        notify.player(a.author, "ad:update", pubAd(a));
        return pubAd(a);
      }
      if (booked(a.boardId) >= SLOTS_PER_BOARD) throw bad("board_full", "That hoarding's slots are full right now. Reject it, or approve it after another ad ends.", 409);
      a.decidedAt = now();
      if (a.days > 1) {
        a.status = "awaiting_rent"; // approved; goes live once the rental is paid
        ads.put(a);
        notify.player(a.author, "ad:update", pubAd(a));
        return pubAd(a);
      }
      goLive(a);
      return pubAd(a);
    }
    if (action === "hide" || action === "unhide" || action === "delete") {
      const col = { thread: threads, post: posts, ad: ads }[kind];
      const x = col?.get(id);
      if (!x) throw bad("not_found", "Not found.", 404);
      if (action === "delete") col.delete(id);
      else {
        x.hidden = action === "hide";
        if (action === "unhide") x.reports = [];
        col.put(x);
      }
      if (kind === "ad") notify.all("ads:update", liveAds());
      else notify.all("forum:hidden", { kind, id });
      return { ok: true };
    }
    if (action === "takedown") {
      const a = ads.get(id);
      if (!a || !["live", "awaiting_rent"].includes(a.status)) throw bad("not_live", "That ad isn't running.", 409);
      a.status = "removed";
      a.endedAt = now();
      a.decidedAt = now();
      a.reason = clean(reason, 120) || "Removed by a moderator";
      ads.put(a);
      notify.all("ads:update", liveAds());
      notify.player(a.author, "ad:update", pubAd(a));
      return pubAd(a);
    }
    if (action === "mute" || action === "unmute") {
      if (!/^[a-f0-9]{24}$/.test(String(playerId))) throw bad("bad_player", "Unknown courier.");
      if (action === "mute") mutes.put({ id: playerId, reason: clean(reason, 120), at: now() });
      else mutes.delete(playerId);
      return { ok: true };
    }
    throw bad("bad_action", "Unknown moderation action.");
  }

  return { listThreads, getThread, newThread, reply, report, submitAd, myAds, liveAds, boards, recordView, recordClick, payRent, onPayment, sweep, modQueue, moderate, muted, uploadsDir: uploads, _db: { threads, posts, ads, mutes } };
}
