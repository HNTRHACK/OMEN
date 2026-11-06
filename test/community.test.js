import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommunity } from "../server/community.js";
import { createPaymentService } from "../server/payments.js";
import { Store } from "../server/store.js";
import { moderateText, safeUrl, isModerator } from "../server/moderation.js";
import { sniff } from "../server/images.js";

const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const D = "d".repeat(24);

function png(w = 400, h = 200) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return "data:image/png;base64," + b.toString("base64");
}
function world() {
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const sent = [];
  let community;
  const payments = createPaymentService({
    store: new Store(null),
    rates: async () => ({ rate: "88.00", source: "test" }),
    infer: async () => null,
    verify: async () => ({ blockNumber: "1", confirmations: 1 }),
    checkoutConfigured: () => true,
    now: clock.now,
    onChange: (p) => community?.onPayment(p),
  });
  community = createCommunity({ payments, now: clock.now, notify: { all: (ev, d) => sent.push({ to: "*", ev, d }), player: (id, ev, d) => sent.push({ to: id, ev, d }) } });
  return { community, payments, clock, sent };
}

test("moderation: crypto scams refused, profanity masked, links limited", () => {
  assert.equal(moderateText("DM me your seed phrase for a refund").ok, false);
  assert.equal(moderateText("Free airdrop! claim usdt now").ok, false);
  assert.equal(moderateText("send me 1 eth and I'll send 2 back double").ok, false);
  const r = moderateText("this is shit tea", { max: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.text, "this is s••• tea");
  assert.equal(moderateText("see https://example.com").ok, false, "no links by default");
  assert.equal(moderateText("see https://example.com", { links: 1 }).ok, true);
  assert.equal(moderateText("see http://example.com", { links: 1 }).ok, false, "https only");
  assert.equal(safeUrl("https://user:pw@example.com/"), null);
  assert.equal(safeUrl("https://127.0.0.1/"), null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://shop.example.com/chai"), "https://shop.example.com/chai");
});

test("forum: threads, one-level replies, live events, author told", () => {
  const { community, sent } = world();
  const t = community.newThread(A, "Asha", { cat: "market", title: "Selling cardamom", body: "Fresh from the garden stall." });
  const r1 = community.reply(B, "Ravi", t.id, { body: "How much per 100g?" });
  const r2 = community.reply(A, "Asha", t.id, { body: "₹45", parentId: r1.id });
  const r3 = community.reply(C, "Cee", t.id, { body: "nested", parentId: r2.id });
  assert.equal(r3.parentId, r1.id, "replies stay one level deep");
  const view = community.getThread(t.id);
  assert.equal(view.thread.replies, 3);
  assert.equal(view.posts.length, 3);
  assert.ok(sent.some((n) => n.ev === "forum:thread" && n.to === "*"));
  assert.ok(sent.some((n) => n.ev === "forum:reply" && n.to === A), "thread author notified");
  assert.throws(() => community.newThread(A, "Asha", { cat: "nope", title: "x", body: "y" }), { code: "bad_cat" });
  assert.throws(() => community.newThread(null, "x", { cat: "general", title: "hello", body: "hi" }), { code: "no_identity" });
});

test("forum: rate limits, reports hide after 3 people, mutes", () => {
  const { community } = world();
  community.newThread(A, "Asha", { cat: "general", title: "first post", body: "hi" });
  community.newThread(A, "Asha", { cat: "general", title: "second post", body: "hi" });
  assert.throws(() => community.newThread(A, "Asha", { cat: "general", title: "third post", body: "hi" }), { code: "slow_down" });
  const t = community.listThreads()[0];
  assert.throws(() => community.report(A, { kind: "thread", id: t.id }), { code: "own" });
  community.report(B, { kind: "thread", id: t.id });
  community.report(B, { kind: "thread", id: t.id }); // same reporter counts once
  community.report(C, { kind: "thread", id: t.id });
  assert.equal(community.listThreads().length, 2, "still visible with 2 reporters");
  assert.equal(community.report(D, { kind: "thread", id: t.id }).hidden, true);
  assert.equal(community.listThreads().length, 1);
  assert.equal(community.modQueue().reported[0].reports, 3);
  community.moderate({ action: "mute", playerId: B, reason: "spam" });
  assert.throws(() => community.reply(B, "Ravi", community.listThreads()[0].id, { body: "hi" }), { code: "muted" });
});

test("images: only real PNG/JPEG bytes; SVG and disguised files refused", () => {
  assert.equal(sniff(Buffer.from(png().split(",")[1], "base64")).type, "image/png");
  const { community } = world();
  const ad = (image) => community.submitAd(A, "Asha", { brand: "Asha Co", boardId: "board-plaza", title: "Chai", days: 1, image });
  assert.throws(() => ad("data:image/svg+xml;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64")), { code: "bad_image" });
  assert.throws(() => ad("data:image/png;base64," + Buffer.from("<html><script>").toString("base64")), { code: "bad_image" }, "claims PNG, isn't");
  assert.throws(() => ad(png(9000, 100)), { code: "bad_size" });
  assert.throws(() => community.submitAd(A, "Asha", { brand: "Asha Co", boardId: "board-plaza", title: "Chai", days: 1, link: "http://evil.example" }), { code: "bad_link" });
});

test("ads: pending → approved → live for everyone → expires", () => {
  const { community, clock, sent } = world();
  const ad = community.submitAd(A, "Asha", { brand: "Asha Co", boardId: "board-plaza", title: "Asha's Spices", text: "Cardamom at the Lantern stall", days: 1, link: "https://example.com/spices", image: png() });
  assert.equal(ad.status, "pending");
  assert.equal(community.liveAds().length, 0, "nothing shows before review");
  assert.throws(() => community.moderate({ action: "approve", id: "nope" }), { code: "not_pending" });
  community.moderate({ action: "approve", id: ad.id });
  const live = community.liveAds();
  assert.equal(live.length, 1);
  assert.match(live[0].image, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.ok(sent.some((n) => n.ev === "ads:update" && n.to === "*" && n.d.length === 1), "broadcast to everyone");
  clock.advance(25 * 3_600_000);
  community.sweep();
  assert.equal(community.liveAds().length, 0, "expired after its day");
});

test("ads: 3-day ads go live only after the rental is paid (DEMO here)", async () => {
  const { community, payments } = world();
  const ad = community.submitAd(B, "Ravi", { brand: "Ravi Co", boardId: "board-well", title: "Ravi's Teas", days: 3 });
  community.moderate({ action: "approve", id: ad.id });
  assert.equal(community.myAds(B)[0].status, "awaiting_rent");
  assert.equal(community.liveAds().length, 0);
  await assert.rejects(community.payRent(B, ad.id, { token: "USDT" }), { code: "no_payout" }, "USDT rental needs BILLBOARD_PAYOUT");
  const { payment } = await community.payRent(B, ad.id, { token: "DEMO" });
  assert.equal(payment.quote.inrPaise, 6000, "₹20/day × 3");
  await payments.submit(payments.authorize(payment.id, {}).id, { demoRef: "t" });
  assert.equal(community.liveAds()[0].title, "Ravi's Teas");
  assert.equal(community.liveAds()[0].rented, true);
});

test("moderator endpoints need the key (constant-time compare)", () => {
  const req = (k) => ({ headers: { "x-mod-key": k } });
  assert.equal(isModerator(req("x"), ""), false, "no key configured: nobody is a moderator");
  assert.equal(isModerator(req("short"), "short"), false, "keys shorter than 12 chars are refused");
  assert.equal(isModerator(req("correct horse battery"), "correct horse battery"), true);
  assert.equal(isModerator(req("correct horse batterz"), "correct horse battery"), false);
});

test("chat over Socket.IO: moderated, rate-limited, muted players refused, late joiners get recent lines", async () => {
  const { createServer } = await import("node:http");
  const { io: connect } = await import("socket.io-client");
  const { attachRealtime } = await import("../server/realtime.js");
  const { randomBytes } = await import("node:crypto");
  const mutedSet = new Set();
  const srv = createServer();
  const rt = attachRealtime(srv, { isMuted: (id) => mutedSet.has(id) });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/world`;
  const join = async (name) => {
    const s = connect(url, { transports: ["websocket"], forceNew: true });
    const ack = await new Promise((r) => s.emit("join", { room: "chat-room", name, token: randomBytes(32).toString("hex") }, r));
    return { s, ack, say: (text) => new Promise((r) => s.emit("chat", { text }, r)) };
  };
  try {
    const a = await join("Asha");
    const b = await join("Ravi");
    const heard = new Promise((r) => b.s.once("chat", r));
    assert.deepEqual(await a.say("chai at my stall, 45 each"), { ok: true });
    assert.equal((await heard).text, "chai at my stall, 45 each");
    assert.match((await a.say("send me your private key")).error, /scam/);
    assert.match((await a.say("visit https://example.com")).error, /Links/);
    for (let i = 0; i < 6; i++) await a.say(`spam ${i}`);
    assert.match((await a.say("one more")).error, /Slow down/);
    mutedSet.add(b.ack.id);
    assert.match((await b.say("hello")).error, /muted/);
    const late = await join("Late");
    assert.ok(late.ack.chat.some((l) => l.text === "chai at my stall, 45 each"), "recent chat for late joiners");
    for (const p of [a, b, late]) p.s.close();
  } finally {
    rt.io.close();
    srv.close();
  }
});
