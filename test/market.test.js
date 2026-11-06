import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarket, COINS } from "../server/market.js";

const row = (id, price) => ({ id, name: id, symbol: id.slice(0, 3), image: "", current_price: price, price_change_percentage_24h: -1.5, ath: price * 2, ath_date: "2025-10-06T00:00:00Z", atl: price / 100, atl_date: "2013-07-05T00:00:00Z", last_updated: "2026-11-06T08:49:48Z" });
function fakeGecko() {
  const calls = [];
  let down = false;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (down) return new Response("", { status: 429 });
    if (url.includes("/coins/markets")) {
      const inr = url.includes("vs_currency=inr");
      return Response.json(Object.values(COINS).map((c) => row(c.id, inr ? 9400 : 100)));
    }
    if (url.includes("/market_chart")) return Response.json({ prices: [[1, 100.123456789], [2, 101]] });
    return new Response("", { status: 404 });
  };
  return { calls, fetchImpl, setDown: (v) => (down = v) };
}

test("one coin = two batched market calls (USD+INR) + its chart; all fields present", async () => {
  const g = fakeGecko();
  const m = createMarket({ fetchImpl: g.fetchImpl });
  const btc = await m.coin("btc");
  assert.equal(g.calls.length, 3);
  assert.equal(btc.price.usd, 100);
  assert.equal(btc.price.inr, 9400);
  assert.equal(btc.ath.date, "2025-10-06T00:00:00Z");
  assert.equal(btc.atl.usd, 1);
  assert.equal(btc.change24h, -1.5);
  assert.equal(btc.launch.date, "2009-01-03");
  assert.equal(btc.lastUpdated, "2026-11-06T08:49:48Z");
  assert.equal(btc.chart.points[0][1], 100.123, "chart rounded to 6 significant digits");
  assert.equal(btc.stale, false);
  await m.coin("eth"); // markets cached, only eth's chart is new
  assert.equal(g.calls.length, 4);
});

test("concurrent requests share one fetch", async () => {
  const g = fakeGecko();
  const m = createMarket({ fetchImpl: g.fetchImpl });
  await Promise.all([m.coin("sol"), m.coin("sol"), m.coin("sol")]);
  assert.equal(g.calls.length, 3, "markets usd, markets inr, sol chart: once each");
});

test("CoinGecko down: last good data is served marked stale; nothing cached means an honest error", async () => {
  let t = 0;
  const g = fakeGecko();
  const m = createMarket({ fetchImpl: g.fetchImpl, now: () => t });
  await m.coin("usdt");
  t += 60 * 60_000; // everything expired
  g.setDown(true);
  const s = await m.coin("usdt");
  assert.equal(s.stale, true);
  assert.match(s.staleReason, /rate limit/);
  assert.equal(s.price.inr, 9400, "the last real price, not a made-up one");
  assert.equal(s.fetchedAt, 0, "and when it was fetched");
  const cold = createMarket({ fetchImpl: g.fetchImpl });
  await assert.rejects(cold.coin("usdt"), /rate limit/);
});

test("unknown coins are refused; every coin has curated, honest launch info", async () => {
  const m = createMarket({ fetchImpl: fakeGecko().fetchImpl });
  await assert.rejects(m.coin("doge"), { code: "unknown_coin" });
  for (const [sym, c] of Object.entries(COINS)) {
    assert.ok(c.about.length > 40, sym);
    assert.ok(c.launch.label, sym);
    assert.ok(c.launch.date === null || /^\d{4}-\d{2}(-\d{2})?$/.test(c.launch.date), sym);
  }
  assert.equal(COINS.wbt.launch.date, null, "unknown launch dates stay unknown");
});
