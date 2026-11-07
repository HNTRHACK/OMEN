import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { io as connect } from "socket.io-client";
import { attachRealtime, cleanName, cleanState, checkMerchantKey, merchantKeys, SCALE } from "../server/realtime.js";
import { sign, verifyWebhook, createWebhooks, parseHooks } from "../server/webhooks.js";
import { toCsv } from "../server/index.js";

let server, rt, base;
before(async () => {
  server = createServer();
  rt = attachRealtime(server, { merchantAccess: merchantKeys("maya-chai:s3cret") });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  rt.io.close();
  server.close();
});

const once = (s, ev) => new Promise((r) => s.once(ev, r));
const player = async (room, name, extra = {}) => {
  const s = connect(`${base}/world`, { transports: ["websocket"], forceNew: true });
  const ack = await new Promise((r) => s.emit("join", { room, name, outfit: 2, ...extra }, r));
  return { s, ack };
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("two players in a room see each other join, move, interact", async () => {
  const a = await player("blockhaven-1", "Asha");
  assert.ok(a.ack.id);
  assert.deepEqual(a.ack.players, []);
  const joined = once(a.s, "joined");
  const b = await player("blockhaven-1", "Ravi");
  assert.equal((await joined).name, "Ravi");
  assert.equal(b.ack.players[0].name, "Asha");

  const st = once(a.s, "states"); // batched by the server's world tick
  b.s.emit("state", { d: [0, 1.2, 0], f: [1, 0, 0], h: 0.4, sp: 3.5, air: true }); // slightly off-unit
  const [w] = await st; // compact: [id, dx, dy, dz, fx, fy, fz, h, sp, flags]
  assert.equal(w[0], b.ack.id);
  assert.deepEqual(w.slice(1, 4), [0, 1, 0], "server normalises the position vector");
  assert.equal(w[9] & 1, 1, "air flag");

  const act = once(a.s, "act");
  b.s.emit("act", { kind: "talk", target: "maya" });
  assert.deepEqual(await act, { id: b.ack.id, kind: "talk", target: "maya" });
  b.s.close();
  a.s.close();
});

test("rooms are isolated; junk and payment details are never relayed", async () => {
  const a = await player("room-a", "A");
  const c = await player("room-b", "C");
  let leaked = 0;
  a.s.on("states", () => leaked++);
  c.s.emit("state", { d: [0, 1, 0], f: [1, 0, 0] });
  const b = await player("room-a", "B");
  b.s.emit("state", { d: ["x", 1, 0], f: [1, 0, 0] }); // junk
  b.s.emit("state", { d: [0, 1e9, 0], f: [1, 0, 0] }); // absurd position
  const act = once(a.s, "act");
  b.s.emit("act", { kind: "paid", target: "maya-chai", amount: "999", address: "0xabc" });
  const got = await act;
  assert.deepEqual(Object.keys(got).sort(), ["id", "kind", "target"], "amount and address stripped");
  let unknown = 0;
  a.s.on("act", () => unknown++);
  b.s.emit("act", { kind: "rm -rf", target: "maya" });
  await pause(250); // > one world tick
  assert.equal(leaked, 0, "nothing from room-b and no junk state");
  assert.equal(unknown, 0, "unknown interaction kinds are dropped");
  for (const p of [a, b, c]) p.s.close();
});

test("bad room codes are refused", async () => {
  const s = connect(`${base}/world`, { transports: ["websocket"], forceNew: true });
  const bad = await new Promise((r) => s.emit("join", { room: "../etc", name: "x" }, r));
  assert.match(bad.error, /Room codes/);
  s.close();
});

test("reconnecting within the grace window resumes the same player (no duplicate, no leave)", async () => {
  const token = tok();
  const a = await player("resume-room", "Watcher");
  const b = await player("resume-room", "Flaky", { token });
  let left = 0;
  let joinedAgain = 0;
  a.s.on("left", () => left++);
  a.s.on("joined", () => joinedAgain++);
  b.s.close();
  await pause(200);
  const b2 = await player("resume-room", "Flaky", { resume: b.ack.id, token });
  assert.equal(b2.ack.id, b.ack.id, "same token resumes the same player");
  await pause(200);
  assert.equal(left, 0);
  assert.equal(joinedAgain, 0, "no duplicate join for a resume");
  a.s.close();
  b2.s.close();
});

test("public resume ids are rejected without a guest token", async () => {
  const victim = await player("resume-security", "Victim", { token: tok() });
  const attacker = await player("resume-security", "Attacker", { resume: victim.ack.id });
  assert.equal(attacker.ack.id, undefined, "tokenless resume IDs are not accepted");
  assert.match(attacker.ack.error, /Guest token required/i);
  victim.s.close();
  attacker.s.close();
});

test("merchant channel needs that merchant's key and only gets its own payments", async () => {
  const bad = connect(`${base}/merchant`, { transports: ["websocket"], forceNew: true, auth: { merchantId: "maya-chai", key: "wrong" } });
  assert.equal((await once(bad, "connect_error")).message, "unauthorized");
  bad.close();
  const m = connect(`${base}/merchant`, { transports: ["websocket"], forceNew: true, auth: { merchantId: "maya-chai", key: "s3cret" } });
  await once(m, "connect");
  const got = once(m, "payment");
  rt.notifyPayment({ id: "o1", merchant: { id: "orin-relay" }, state: "COMPLETED", quote: { inrPaise: 1, token: "USDT", tokenAmount: "1" }, upi: {} });
  rt.notifyPayment({ id: "o2", merchant: { id: "maya-chai" }, state: "COMPLETED", mode: "testnet", payer: "0xP", txHash: "0xT", quote: { inrPaise: 6000, token: "USDT", tokenAmount: "0.64" }, upi: { vpa: "maya.chai@blockhaven", note: "chai" }, risk: { secret: 1 } });
  const p = await got;
  assert.equal(p.id, "o2", "Orin's payment didn't reach Maya");
  assert.equal(p.inrPaise, 6000);
  assert.equal(p.risk, undefined);
  assert.equal(p.vpa, undefined);
  m.close();
});

test("helpers: names and states sanitised; merchant keys compared safely", () => {
  assert.equal(cleanName("  <b>Asha‮</b>  "), "bAsha/b");
  assert.equal(cleanName(""), "Courier");
  assert.equal(cleanName("x".repeat(40)).length, 16);
  assert.equal(cleanState({ d: [0, 1, 0], f: [0, 0, 0] }), null);
  assert.equal(cleanState({ d: [0, 1, 0], f: [1, 0, 0], h: 99 }).h, 3);
  const keys = merchantKeys("maya-chai:abc");
  assert.ok(checkMerchantKey(keys, "maya-chai", "abc"));
  assert.ok(!checkMerchantKey(keys, "maya-chai", "abcd"));
  assert.ok(!checkMerchantKey(keys, "orin-relay", "abc"));
});

test("webhooks: signed and verifiable; stale or tampered bodies rejected", () => {
  const body = JSON.stringify({ event: "payment.completed" });
  const h = sign("k", body);
  assert.ok(verifyWebhook("k", body, h));
  assert.ok(!verifyWebhook("k", body + " ", h), "tampered body");
  assert.ok(!verifyWebhook("other", body, h), "wrong secret");
  assert.ok(!verifyWebhook("k", body, sign("k", body, 1000)), "stale timestamp");
  assert.equal(parseHooks("maya-chai=http://evil.example/x,orin-relay=https://ok.example/h").size, 1, "plain http only for localhost");
});

test("webhooks: delivered once per event, retried on 5xx, not on 4xx", async () => {
  const calls = [];
  let status = 503;
  const wh = createWebhooks({
    hooks: new Map([["maya-chai", "https://merchant.example/hook"]]),
    secret: "k",
    retryMs: [0, 1, 1],
    fetchImpl: async (url, init) => {
      calls.push(init);
      const s = status;
      status = 200;
      return new Response("", { status: s });
    },
  });
  const p = { id: "o1", merchant: { id: "maya-chai" }, state: "COMPLETED", quote: { inrPaise: 1, token: "USDT", tokenAmount: "1" }, upi: {} };
  assert.equal((await wh.notify(p)).ok, true);
  assert.equal(calls.length, 2, "one retry after the 503");
  assert.ok(verifyWebhook("k", calls[1].body, calls[1].headers["x-omen-signature"]));
  assert.equal(await wh.notify(p), null, "the same event isn't sent twice");
  let n = 0;
  const four = createWebhooks({
    hooks: new Map([["maya-chai", "https://m.example/h"]]),
    secret: "k",
    retryMs: [0, 1, 1],
    fetchImpl: async () => {
      n++;
      return new Response("", { status: 400 });
    },
  });
  assert.equal((await four.notify({ ...p, id: "o2" })).ok, false);
  assert.equal(n, 1, "4xx is not retried");
});

test("CSV export escapes quotes and neutralises spreadsheet formulas", () => {
  const csv = toCsv([{ createdAt: 0, id: "a", state: "COMPLETED", mode: "testnet", inrPaise: 6000, token: "USDT", amount: "0.64", payer: '=HYPERLINK("x")', txHash: "0x1", relayed: true, inr: { label: "DEMO INR SETTLEMENT" } }]);
  const [head, row] = csv.trim().split("\n");
  assert.equal(head, "createdAt,id,state,mode,inrPaise,token,amount,payer,txHash,relayed,inr");
  assert.match(row, /,"'=HYPERLINK\(""x""\)",/);
  assert.match(row, /DEMO INR SETTLEMENT$/);
});

// ------------------------------------------------------------------ identity + appearance
import { randomBytes } from "node:crypto";
import { playerIdOf } from "../server/identity.js";
const tok = () => randomBytes(32).toString("hex");

test("guest token gives a stable id, even after leaving and rejoining", async () => {
  const t = tok();
  const a = await player("ident-room", "Asha", { token: t });
  assert.equal(a.ack.id, playerIdOf(t));
  a.s.close();
  await pause(150);
  const again = await player("ident-room", "Asha", { token: t });
  assert.equal(again.ack.id, a.ack.id);
  again.s.close();
});

test("opening the same courier in a second tab replaces the first: no duplicate", async () => {
  const t = tok();
  const watcher = await player("dup-room", "Watcher", { token: tok() });
  const first = await player("dup-room", "Asha", { token: t });
  const replaced = once(first.s, "replaced");
  const second = await player("dup-room", "Asha", { token: t });
  await replaced;
  assert.equal(second.ack.id, first.ack.id);
  const third = await player("dup-room", "Late", { token: tok() });
  assert.equal(third.ack.players.filter((p) => p.name === "Asha").length, 1, "one Asha in the room");
  for (const p of [watcher, first, second, third]) p.s.close();
});

test("looks are validated and broadcast; junk becomes defaults", async () => {
  const a = await player("look-room", "Asha", { token: tok(), look: { skin: 2, hat: 4, pet: 1, evil: "<script>", jacket: 999 } });
  const seen = once(a.s, "joined");
  const b = await player("look-room", "Ravi", { token: tok() });
  const asha = b.ack.players.find((p) => p.name === "Asha");
  assert.equal(asha.look.skin, 2);
  assert.equal(asha.look.hat, 4);
  assert.equal(asha.look.pet, 1);
  assert.equal(asha.look.jacket, 0, "out-of-range value reset");
  assert.equal(asha.look.evil, undefined, "unknown keys dropped");
  await seen;
  const changed = once(b.s, "look");
  a.s.emit("look", { pet: 3, hat: -1 });
  const l = await changed;
  assert.equal(l.look.pet, 3);
  assert.equal(l.look.hat, 0);
  a.s.close();
  b.s.close();
});

test("interest management: nearby movers every tick, distant movers only on the slow far tick", async () => {
  const a = await player("interest-1", "A");
  const b = await player("interest-1", "B");
  const c = await player("interest-1", "C");
  a.s.emit("state", { d: [0, 1, 0], f: [1, 0, 0] });
  c.s.emit("state", { d: [0, -1, 0], f: [1, 0, 0] }); // the far side of the planet
  b.s.emit("state", { d: [0.05, 1, 0], f: [1, 0, 0] }); // ~1.6 m away
  await pause(SCALE.tickMs * (SCALE.farEvery + 2)); // let the opening burst settle
  const seen = [];
  a.s.on("states", (list) => seen.push(...list.map((x) => [x[0], Date.now()])));
  const t0 = Date.now();
  b.s.emit("state", { d: [0.06, 1, 0], f: [1, 0, 0] });
  c.s.emit("state", { d: [0.01, -1, 0], f: [1, 0, 0] });
  await pause(SCALE.tickMs * (SCALE.farEvery + 2));
  const nearAt = seen.find(([id]) => id === b.ack.id)?.[1];
  const farAt = seen.find(([id]) => id === c.ack.id)?.[1];
  assert.ok(nearAt && nearAt - t0 <= SCALE.tickMs * 2 + 50, "nearby mover arrives within ~a tick");
  assert.ok(farAt, "distant mover still arrives (for distant stand-ins)");
  assert.equal(seen.filter(([id]) => id === a.ack.id).length, 0, "nobody is sent their own state");
  for (const p of [a, b, c]) p.s.close();
});

test("a full public world overflows into shards; private rooms keep their own cap", async () => {
  const saved = [SCALE.publicRoomMax, SCALE.privateRoomMax];
  SCALE.publicRoomMax = 2;
  SCALE.privateRoomMax = 1;
  try {
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(await player("blockhaven", `P${i}`, { token: (String(i) + "a").repeat(32) }));
    assert.deepEqual(ps.map((p) => p.ack.room), ["blockhaven", "blockhaven", "blockhaven-2"]);
    const x = await player("tiny-room", "X");
    const y = await player("tiny-room", "Y");
    assert.ok(x.ack.id && y.ack.code === "room_full");
    for (const p of [...ps, x, y]) p.s.close();
  } finally {
    [SCALE.publicRoomMax, SCALE.privateRoomMax] = saved;
  }
});
