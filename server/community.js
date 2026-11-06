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
import { boardById, AD_DAYS, AD_RENT_PAISE_PER_DAY } from "../shared/billboards.js";
import { directMerchantId } from "../shared/merchants.js";

export const CATS = { general: "General", market: "Marketplace", help: "Help & advice" };
const bad = (code, msg, status = 400) => new ApiError(status, code, msg);
const need = (id) => {
  if (!id) throw bad("no_identity", "Join the world first.", 401);
  return id;
};
const DAY = 86_400_000;

export function createCommunity({ dir = null, payments = null, notify = { all() {}, player() {} }, now = () => Date.now(), billboardPayout = process.env.BILLBOARD_PAYOUT || "" } = {}) {
  const threads = new Collection(dir, "threads");
  const posts = new Collection(dir, "posts");
  const ads = new Collection(dir, "ads");
  const mutes = new Collection(dir, "mutes");
  const uploads = dir ? join(dir, "uploads") : null;
  const threadRate = rateLimiter(3, 2); // per player per minute
  const postRate = rateLimiter(8, 4);
  const adRate = rateLimiter(2, 2);
  const reportRate = rateLimiter(20, 10);

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
  const pubAd = (a) => ({ id: a.id, boardId: a.boardId, title: a.title, text: a.text, link: a.link, image: a.image ? `/uploads/${a.image}` : null, authorName: a.authorName, status: a.status, days: a.days, expiresAt: a.expiresAt, rented: !!a.rentPaymentId });
  const isLive = (a) => a.status === "live" && !a.hidden && a.expiresAt > now();
  function liveAds() {
    return ads.where(isLive).sort((a, b) => b.approvedAt - a.approvedAt).map(pubAd);
  }
  function submitAd(playerId, name, b) {
    speaker(playerId);
    if (!boardById(b.boardId)) throw bad("bad_board", "Pick a billboard.");
    const days = Number(b.days);
    if (!AD_DAYS.includes(days)) throw bad("bad_days", "Ads run for 1, 3 or 7 days.");
    let link = null;
    if (b.link) {
      link = safeUrl(b.link);
      if (!link) throw bad("bad_link", "Links must be plain https:// addresses.");
    }
    const title = text(b.title, { max: 40, min: 2 });
    const body = text(b.text || "", { max: 90, min: 0 });
    const checked = b.image ? checkImage(b.image) : null; // validate everything before using any quota
    if (ads.where((a) => a.author === playerId && ["pending", "awaiting_rent"].includes(a.status)).length >= 2) throw bad("too_many", "You already have ads waiting for review.", 409);
    if (!adRate(playerId, now())) throw bad("slow_down", "One ad at a time, please.", 429);
    const img = checked ? storeImage(uploads, checked) : null;
    const a = {
      id: randomUUID(),
      boardId: b.boardId,
      title,
      text: body,
      link,
      image: img?.file || null,
      author: playerId,
      authorName: clean(name, 16) || "Courier",
      days,
      status: "pending",
      reports: [],
      hidden: false,
      createdAt: now(),
    };
    ads.put(a);
    notify.all("mod:queue", { pending: ads.where((x) => x.status === "pending").length });
    return pubAd(a);
  }
  const myAds = (playerId) => ads.where((a) => a.author === need(playerId)).sort((a, b) => b.createdAt - a.createdAt).map(pubAd);

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
      ads.put(a);
      changed = true;
    }
    if (changed) notify.all("ads:update", liveAds());
  }

  // ---------------------------------------------------------------- moderation
  function modQueue() {
    return {
      pendingAds: ads.where((a) => a.status === "pending").map((a) => ({ ...pubAd(a), author: a.author })),
      reported: [
        ...threads.where((t) => t.reports?.length).map((t) => ({ kind: "thread", id: t.id, text: `${t.title}: ${t.body}`, authorName: t.authorName, author: t.author, reports: t.reports.length, hidden: t.hidden })),
        ...posts.where((p) => p.reports?.length).map((p) => ({ kind: "post", id: p.id, text: p.body, authorName: p.authorName, author: p.author, reports: p.reports.length, hidden: p.hidden })),
        ...ads.where((a) => a.reports?.length).map((a) => ({ kind: "ad", id: a.id, text: `${a.title}: ${a.text}`, authorName: a.authorName, author: a.author, reports: a.reports.length, hidden: a.hidden, image: a.image ? `/uploads/${a.image}` : null })),
      ],
      muted: mutes.all(),
    };
  }
  function moderate({ action, kind, id, playerId, reason }) {
    if (action === "approve" || action === "reject") {
      const a = ads.get(id);
      if (!a || a.status !== "pending") throw bad("not_pending", "That ad isn't waiting for review.", 409);
      if (action === "reject") {
        a.status = "rejected";
        a.reason = clean(reason, 120);
        ads.put(a);
        notify.player(a.author, "ad:update", pubAd(a));
        return pubAd(a);
      }
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
    if (action === "mute" || action === "unmute") {
      if (!/^[a-f0-9]{24}$/.test(String(playerId))) throw bad("bad_player", "Unknown courier.");
      if (action === "mute") mutes.put({ id: playerId, reason: clean(reason, 120), at: now() });
      else mutes.delete(playerId);
      return { ok: true };
    }
    throw bad("bad_action", "Unknown moderation action.");
  }

  return { listThreads, getThread, newThread, reply, report, submitAd, myAds, liveAds, payRent, onPayment, sweep, modQueue, moderate, muted, uploadsDir: uploads, _db: { threads, posts, ads, mutes } };
}
