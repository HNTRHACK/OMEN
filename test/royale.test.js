// Bounty Royale ledger against real PostgreSQL (skipped without ROYALE_TEST_DATABASE_URL, a
// throwaway database: `node server/manage.js migrate` is run against it by the test).
//   ROYALE_TEST_DATABASE_URL=postgres://omen@127.0.0.1:55433/omen_royale_test node --test test/royale.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const URL_ = process.env.ROYALE_TEST_DATABASE_URL;
const skip = !URL_ && "set ROYALE_TEST_DATABASE_URL to a throwaway database";

async function setup() {
  const pg = (await import("../server/node_modules/pg/lib/index.js")).default;
  const admin = new pg.Client({ connectionString: URL_.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  const name = URL_.split("/").pop();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  execFileSync(process.execPath, ["server/manage.js", "migrate"], { env: { ...process.env, DATABASE_URL: URL_ }, stdio: "pipe" });
  const { createDatabase } = await import("../server/postgres.js");
  const { createAuth } = await import("../server/auth.js");
  const { createRoyale } = await import("../server/royale.js");
  const database = createDatabase(URL_);
  const auth = createAuth(database);
  await database.transaction(() => auth.provision({ username: "mod", password: "correct horse battery" }));
  const login = await database.transaction(() => auth.login({ headers: {}, socket: {} }, { username: "mod", password: "correct horse battery" }));
  const modReq = { headers: { cookie: login.__cookie.split(";")[0] } };
  // test sessions: what the World ID gate would have produced after World's verify API said yes
  const humans = { A: { playerId: "h_alice00000000000000" }, B: { playerId: "h_bob0000000000000000" }, C: { playerId: "h_carol00000000000000" } };
  const sessionOf = (req) => (humans[req.headers["x-test-human"]] ? { human: humans[req.headers["x-test-human"]] } : null);
  const royale = createRoyale({ pool: database.pool, database, auth, sessionOf });
  await royale.seed();
  const as = (who) => ({ headers: { "x-test-human": who } });
  return { royale, database, as, modReq };
}

let key = 0;
const k = () => `test-key-${++key}-xxxxxxxx`;

test("Bounty Royale: grant once, atomic stakes, locks, settlement, refunds, persistence", { skip }, async () => {
  const { royale, database, as, modReq } = await setup();
  try {
    // non-moderators can't touch results
    await assert.rejects(royale.importProjects(as("A"), { projects: [{ name: "X" }] }), (e) => e.status === 401);
    await royale.importProjects(modReq, { projects: [{ name: "Chai Chain" }, { name: "Mumbai Maps" }, { name: "Pixel Bazaar", isGame: true }, { name: "Dabba Pay" }] });

    // one grant per human, even if join is called twice
    const a1 = await royale.join(as("A"), { name: "Alice" });
    const a2 = await royale.join(as("A"), { name: "Alice" });
    assert.equal(a1.granted, true);
    assert.equal(a2.granted, false);
    assert.equal(a2.me.balance, 1000);
    await royale.join(as("B"), { name: "Bob" });
    await royale.join(as("C"), { name: "Carol" });
    await assert.rejects(royale.join({ headers: {} }, {}), (e) => e.status === 401);

    // concurrent stakes from two players on different markets
    const [ra, rb] = await Promise.all([
      royale.predict(as("A"), { marketId: "top3", selection: "chai-chain", amount: 300, idempotencyKey: k() }),
      royale.predict(as("B"), { marketId: "bounty-whitechain", selection: "dabba-pay", amount: 200, idempotencyKey: k() }),
    ]);
    assert.equal(ra.me.balance, 700);
    assert.equal(rb.me.balance, 800);

    // idempotent replay: same key, same pick → same prediction, charged once
    const key1 = k();
    const p1 = await royale.predict(as("B"), { marketId: "top3", selection: "chai-chain", amount: 100, idempotencyKey: key1 });
    const p2 = await royale.predict(as("B"), { marketId: "top3", selection: "chai-chain", amount: 100, idempotencyKey: key1 });
    assert.equal(p1.prediction.id, p2.prediction.id);
    assert.equal(p2.replay, true);
    assert.equal(p2.me.balance, 700);

    // duplicate pick, too many picks, overspend, bad selection
    await assert.rejects(royale.predict(as("B"), { marketId: "top3", selection: "chai-chain", amount: 5, idempotencyKey: k() }), (e) => e.code === "duplicate");
    await assert.rejects(royale.predict(as("C"), { marketId: "top3", selection: "mumbai-maps", amount: 1001, idempotencyKey: k() }), (e) => e.code === "bad_amount");
    await assert.rejects(royale.predict(as("C"), { marketId: "top3", selection: "nobody", amount: 5, idempotencyKey: k() }), (e) => e.code === "bad_selection");
    // a burst of parallel stakes can never push a balance below zero
    const burst = await Promise.allSettled(["mumbai-maps", "pixel-bazaar", "dabba-pay"].map((s) => royale.predict(as("C"), { marketId: "double-crown", selection: s, amount: 400, idempotencyKey: k() })));
    assert.equal(burst.filter((r) => r.status === "fulfilled").length, 2);
    let snap = await royale.snapshot("h_carol00000000000000");
    assert.equal(snap.me.balance, 200);
    await royale.predict(as("C"), { marketId: "top3", selection: "mumbai-maps", amount: 200, idempotencyKey: k() });

    // yes/no wildcard
    await royale.predict(as("A"), { marketId: "game-wildcard", selection: "yes", amount: 100, idempotencyKey: k() });
    await assert.rejects(royale.predict(as("A"), { marketId: "game-wildcard", selection: "no", amount: 100, idempotencyKey: k() }), (e) => e.code === "max_picks");

    // close: no more stakes; players can't settle
    await royale.closeMarket(modReq, "top3");
    await assert.rejects(royale.predict(as("A"), { marketId: "top3", selection: "pixel-bazaar", amount: 10, idempotencyKey: k() }), (e) => e.code === "market_locked");
    await assert.rejects(royale.settle(as("A"), "top3", { winners: ["chai-chain"], source: "x" }), (e) => e.status === 401);
    await assert.rejects(royale.settle(modReq, "top3", { winners: ["chai-chain"] }), (e) => e.status === 400); // needs a source

    // settle top3: pool = 300 (A) + 100 (B) + 200 (C) = 600; winners chai-chain (A 300, B 100)
    const s = await royale.settle(modReq, "top3", { winners: ["chai-chain", "pixel-bazaar"], source: "https://ethglobal.com/events/mumbai (test)" });
    assert.equal(s.pool, 600);
    const again = await royale.settle(modReq, "top3", { winners: ["mumbai-maps"], source: "x" });
    assert.equal(again.already, true); // idempotent: results can't be rewritten
    snap = await royale.snapshot("h_alice00000000000000");
    assert.equal(snap.me.balance, 700 - 100 + 450); // 300 × 600/400
    const bob = await royale.snapshot("h_bob0000000000000000");
    assert.equal(bob.me.balance, 700 + 150);
    const carol = await royale.snapshot("h_carol00000000000000");
    assert.equal(carol.me.balance, 0);
    assert.deepEqual(snap.markets.find((m) => m.id === "top3").winners, ["chai-chain", "pixel-bazaar"]);

    // void → full refunds
    await royale.settle(modReq, "double-crown", {}, { voided: true });
    assert.equal((await royale.snapshot("h_carol00000000000000")).me.balance, 800);

    // nobody picked the winner → refunds
    await royale.closeMarket(modReq, "bounty-whitechain");
    const nb = await royale.settle(modReq, "bounty-whitechain", { winners: ["mumbai-maps"], source: "test" });
    assert.equal(nb.refunded, true);
    assert.equal((await royale.snapshot("h_bob0000000000000000")).me.balance, 1050);

    // ledger: every change recorded; balances reconcile with the ledger
    const led = await royale.ledger(as("A"));
    assert.equal(led.ledger.at(-1).kind, "grant");
    const sums = (await database.pool.query("SELECT p.player_id, p.balance, sum(l.delta) AS s FROM royale_players p JOIN royale_ledger l USING (player_id) GROUP BY p.player_id, p.balance")).rows;
    for (const r of sums) assert.equal(String(r.balance), String(r.s), `ledger reconciles for ${r.player_id}`);

    // leaderboard
    const top = (await royale.snapshot()).leaderboard;
    assert.deepEqual(top.slice(0, 2).map((t) => [t.name, t.score]), [["Alice", 1150], ["Bob", 1050]]); // score = balance + open stakes
  } finally {
    await database.close();
  }
});
