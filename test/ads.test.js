// Milestone A: the advertising economy. Brand + destination, slot capacity, genuine
// impressions/clicks, role separation for moderation, takedowns, and persistence across restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommunity } from "../server/community.js";
import { SLOTS_PER_BOARD } from "../shared/billboards.js";

const A = "a".repeat(24); // advertiser
const B = "b".repeat(24); // viewer
const C = "c".repeat(24); // another viewer
const D = "d".repeat(24);
const E = "e".repeat(24);

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

const SHOPS = { "plot-lantern": { id: "plot-lantern", name: "Asha's Chai Cart", owner: A }, "plot-east": { id: "plot-east", name: "Ravi's Teas", owner: B } };
function world(dir = null, clock = { t: 1_800_000_000_000 }) {
  const sent = [];
  const community = createCommunity({
    dir,
    now: () => clock.t,
    shopLookup: (id) => SHOPS[id] || null,
    notify: { all: (ev, d) => sent.push({ to: "*", ev, d }), player: (id, ev, d) => sent.push({ to: id, ev, d }) },
  });
  return { community, clock, sent, advance: (ms) => (clock.t += ms) };
}
const ad = (community, who, extra = {}) => community.submitAd(who, "Asha", { brand: "Asha's Chai", boardId: "board-plaza", title: "Masala chai", text: "Fresh every morning", days: 1, ...extra });

test("ads need a brand and headline; description up to 160 chars; scams refused", () => {
  const { community } = world();
  assert.throws(() => community.submitAd(A, "Asha", { boardId: "board-plaza", title: "Chai", days: 1 }), { code: "rejected" }, "brand required");
  assert.throws(() => community.submitAd(A, "Asha", { brand: "Asha", boardId: "board-plaza", days: 1 }), { code: "rejected" }, "headline required");
  assert.throws(() => ad(community, A, { text: "Send me your seed phrase for a free airdrop" }), { code: "rejected" });
  assert.throws(() => ad(community, A, { boardId: "board-nowhere" }), { code: "bad_board" });
  const long = "x".repeat(200);
  const a = ad(community, A, { text: long });
  assert.equal(a.text.length, 160);
  assert.equal(a.brand, "Asha's Chai");
});

test("destination: your own stall or one https link, never both, never someone else's stall", () => {
  const { community } = world();
  assert.throws(() => ad(community, A, { shopId: "plot-east" }), { code: "bad_shop" }, "Ravi's stall isn't Asha's to advertise");
  assert.throws(() => ad(community, A, { shopId: "plot-nowhere" }), { code: "bad_shop" });
  assert.throws(() => ad(community, A, { shopId: "plot-lantern", link: "https://example.com" }), { code: "one_destination" });
  for (const bad of ["http://example.com", "javascript:alert(1)", "https://user:pw@example.com/", "https://127.0.0.1/", "https://localhost/x"]) assert.throws(() => ad(community, A, { link: bad }), { code: "bad_link" }, bad);
  const a = ad(community, A, { shopId: "plot-lantern" });
  assert.deepEqual(a.shop, { id: "plot-lantern", name: "Asha's Chai Cart" });
  assert.equal(a.link, null);
});

test("slots: a hoarding holds SLOTS_PER_BOARD ads; full boards refuse new ads and approvals", () => {
  const { community, advance } = world();
  assert.equal(community.boards().find((b) => b.id === "board-plaza").free, SLOTS_PER_BOARD);
  const ids = [];
  for (const who of [A, B, C]) {
    ids.push(community.submitAd(who, "P", { brand: "Brand " + who[0], boardId: "board-plaza", title: "Hello", days: 1 }).id);
    advance(61_000);
  }
  community.moderate({ action: "approve", id: ids[0] });
  community.moderate({ action: "approve", id: ids[1] });
  const board = community.boards().find((b) => b.id === "board-plaza");
  assert.equal(board.free, 0);
  assert.ok(board.nextFreeAt > 0, "says when a slot frees up");
  assert.throws(() => community.moderate({ action: "approve", id: ids[2] }), { code: "board_full" }, "an approval can't overbook");
  assert.throws(() => community.submitAd(D, "P", { brand: "Dee", boardId: "board-plaza", title: "Hi", days: 1 }), { code: "board_full" });
  advance(25 * 3_600_000);
  community.sweep();
  assert.equal(community.boards().find((b) => b.id === "board-plaza").free, SLOTS_PER_BOARD, "slots free again after the ads end");
  community.moderate({ action: "approve", id: ids[2] });
  assert.equal(community.liveAds().length, 1);
});

test("an approved rental that is never confirmed frees its slot after 48 hours", () => {
  const { community, advance, sent } = world();
  const a = ad(community, A, { days: 3 });
  community.moderate({ action: "approve", id: a.id });
  assert.equal(community.boards().find((b) => b.id === "board-plaza").free, SLOTS_PER_BOARD - 1, "an approved rental holds a slot");
  advance(49 * 3_600_000);
  community.sweep();
  const mine = community.myAds(A)[0];
  assert.equal(mine.status, "expired");
  assert.match(mine.reason, /48 hours/);
  assert.equal(community.boards().find((b) => b.id === "board-plaza").free, SLOTS_PER_BOARD);
  assert.ok(sent.some((n) => n.to === A && n.ev === "ad:update" && n.d.status === "expired"), "advertiser told");
});

test("moderation is a separate role: a moderator can't approve or reject their own ad", () => {
  const { community } = world();
  const a = ad(community, A);
  assert.throws(() => community.moderate({ action: "approve", id: a.id }, { actor: A }), { code: "own_ad" });
  assert.throws(() => community.moderate({ action: "reject", id: a.id }, { actor: A }), { code: "own_ad" });
  assert.equal(community.liveAds().length, 0);
  community.moderate({ action: "approve", id: a.id }, { actor: B });
  assert.equal(community.liveAds().length, 1);
});

test("rejected, expired and taken-down ads never appear; the advertiser sees why", () => {
  const { community, advance, sent } = world();
  const r = ad(community, A);
  community.moderate({ action: "reject", id: r.id, reason: "Blurry image" });
  assert.equal(community.liveAds().length, 0);
  assert.equal(community.myAds(A)[0].reason, "Blurry image");
  assert.throws(() => community.moderate({ action: "approve", id: r.id }), { code: "not_pending" }, "a rejected ad can't be revived");
  assert.equal(community.recordView(B, r.id).counted, false, "no impressions for rejected ads");

  advance(61_000);
  const t = community.submitAd(A, "Asha", { brand: "Asha", boardId: "board-well", title: "Second", days: 1 });
  community.moderate({ action: "approve", id: t.id });
  assert.equal(community.liveAds().length, 1);
  community.moderate({ action: "takedown", id: t.id, reason: "Misleading" });
  assert.equal(community.liveAds().length, 0);
  assert.equal(community.myAds(A).find((x) => x.id === t.id).status, "removed");
  assert.ok(sent.some((n) => n.to === "*" && n.ev === "ads:update" && n.d.length === 0), "everyone's hoarding cleared live");
  assert.equal(community.recordView(B, t.id).counted, false);
});

test("impressions and clicks are genuine: live only, signed-in only, not your own, deduplicated", () => {
  const { community, advance } = world();
  const a = ad(community, A, { shopId: "plot-lantern" });
  assert.equal(community.recordView(B, a.id).counted, false, "pending ads earn nothing");
  community.moderate({ action: "approve", id: a.id });
  assert.throws(() => community.recordView(null, a.id), { code: "no_identity" });
  assert.equal(community.recordView(A, a.id).reason, "own_ad", "the advertiser's own views don't count");
  assert.equal(community.recordView(B, a.id).counted, true);
  assert.equal(community.recordView(B, a.id).reason, "recent", "the same viewer within 5 minutes is one impression");
  assert.equal(community.recordView(C, a.id).counted, true);
  advance(5 * 60_000 + 1);
  assert.equal(community.recordView(B, a.id).counted, true, "a returning viewer later is a new impression");
  assert.equal(community.recordClick(B, a.id, "details").counted, true);
  assert.equal(community.recordClick(B, a.id, "details").counted, false, "double click is one click");
  assert.equal(community.recordClick(B, a.id, "shop").counted, true, "opening the listing is its own click");
  assert.equal(community.recordClick(A, a.id, "shop").counted, false);
  const s = community.myAds(A)[0].stats;
  assert.deepEqual(s, { impressions: 3, uniqueViewers: 2, clicks: 2, uniqueClickers: 1, ctr: 50 }, "CTR = share of unique viewers who clicked");
  assert.equal(community.liveAds()[0].stats, undefined, "counters are private to the advertiser and moderators");
});

test("ads, their images and their counters survive a server restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "omen-ads-"));
  try {
    const clock = { t: 1_800_000_000_000 };
    const one = world(dir, clock);
    const a = ad(one.community, A, { image: png() });
    one.community.moderate({ action: "approve", id: a.id });
    one.community.recordView(B, a.id);
    one.community.recordClick(C, a.id, "details");
    const r = one.community.submitAd(E, "Eve", { brand: "Eve", boardId: "board-well", title: "Nope", days: 1 });
    one.community.moderate({ action: "reject", id: r.id });
    for (const c of Object.values(one.community._db)) c.flush();

    const two = world(dir, clock); // a fresh process reading the same data directory
    const live = two.community.liveAds();
    assert.equal(live.length, 1, "only the approved ad comes back live");
    assert.equal(live[0].title, "Masala chai");
    assert.ok(existsSync(join(dir, "uploads", live[0].image.split("/").pop())), "image file kept");
    assert.deepEqual(two.community.myAds(A)[0].stats, { impressions: 1, uniqueViewers: 1, clicks: 1, uniqueClickers: 1, ctr: 100 });
    assert.equal(two.community.myAds(E)[0].status, "rejected");
    assert.equal(readdirSync(join(dir, "uploads")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moderator queue shows destination, slot availability, live stats and recent decisions", () => {
  const { community, advance } = world();
  const a = ad(community, A, { shopId: "plot-lantern" });
  advance(61_000);
  const b = community.submitAd(B, "Ravi", { brand: "Ravi", boardId: "board-well", title: "Teas", days: 1, link: "https://example.com/teas" });
  let q = community.modQueue();
  assert.equal(q.pendingAds.length, 2);
  const pa = q.pendingAds.find((x) => x.id === a.id);
  assert.equal(pa.shop.name, "Asha's Chai Cart");
  assert.equal(pa.board.free, SLOTS_PER_BOARD);
  community.moderate({ action: "approve", id: a.id });
  community.moderate({ action: "reject", id: b.id, reason: "Off-topic" });
  community.recordView(C, a.id);
  q = community.modQueue();
  assert.equal(q.liveAds[0].stats.impressions, 1);
  assert.equal(q.decided[0].reason, "Off-topic");
});
