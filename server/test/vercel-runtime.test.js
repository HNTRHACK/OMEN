import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { io } from 'socket.io-client';
import { createDatabase } from '../postgres.js';
import { createVercelRuntime } from '../vercel-runtime.js';
import { finalConfig } from '../final-block.js';

const connection = process.env.TEST_DATABASE_URL;
const wait = ms => new Promise(r => setTimeout(r, ms));
const event = (socket, name) => Promise.race([once(socket, name).then(([value]) => value), wait(8000).then(() => { throw new Error('Timed out: ' + name); })]);

test('two independent Function instances share World sessions, avatars, rooms, movement and committed points notifications', { skip: !connection && 'Set TEST_DATABASE_URL to an isolated local test database', timeout: 40000 }, async t => {
  const admin = new pg.Pool({ connectionString: connection });
  const schema = 'vercel_' + randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA ' + schema);
  const url = new URL(connection); url.searchParams.set('options', '-c search_path=' + schema);
  const database = createDatabase(url.href); await database.migrate();
  const runtimes = [], sockets = [];
  t.after(async () => {
    sockets.forEach(s => s.disconnect());
    for (const runtime of runtimes) await runtime.close();
    await database.close();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  });
  const config = finalConfig({ VITE_WORLD_APP_ID: 'app_test', WORLD_RP_ID: 'rp_test', WORLD_RP_SIGNING_KEY: '12'.repeat(32), WORLD_ENVIRONMENT: 'production' });
  const start = async () => {
    const runtime = await createVercelRuntime({ database: createDatabase(url.href), clusterPool: new pg.Pool({ connectionString: url.href }),
      finalOptions: { config, fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }) } });
    runtimes.push(runtime);
    await new Promise(r => runtime.server.listen(0, '127.0.0.1', r));
    runtime.base = `http://127.0.0.1:${runtime.server.address().port}`;
    return runtime;
  };
  const a = await start(), b = await start();
  const request = async (runtime, path, body, cookie) => {
    const r = await fetch(runtime.base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], data: await r.json() };
  };
  // HTTP doubles are confined to this test. Production always calls World's real verify API.
  const verify = (runtime, id) => request(runtime, '/api/verify', { result: { action: 'play-omen', environment: 'production', responses: [{ identifier: 'orb', nullifier: id }] } });
  const alice = await verify(a, '123'), bob = await verify(b, '456');
  assert.equal(alice.status, 200); assert.equal(bob.status, 200);
  const returning = await verify(b, '123');
  assert.equal(returning.data.returning, true);
  assert.deepEqual(returning.data.human.look, alice.data.human.look);
  assert.equal((await request(b, '/api/human', null, alice.cookie)).data.human.playerId, alice.data.human.playerId);
  assert.equal((await request(a, '/api/royale/join', {})).status, 401);
  const connect = async (runtime, namespace, path, cookie) => {
    const socket = io(runtime.base + namespace, { path, transports: ['websocket'], forceNew: true, ...(cookie ? { extraHeaders: { cookie } } : {}) });
    sockets.push(socket); await event(socket, 'connect'); return socket;
  };
  const sa = await connect(a, '/world', '/socket.io/'), sb = await connect(b, '/world', '/socket.io/');
  // Allow the adapter's first heartbeat to discover the independent instance.
  await wait(5500);
  const join = (s, token) => new Promise(r => s.emit('join', { room: 'pavilion-2', name: token[0], token, state: { d: [0,1,0], f: [1,0,0] } }, r));
  const first = await join(sa, 'a'.repeat(64));
  const joined = event(sa, 'joined');
  const second = await join(sb, 'b'.repeat(64));
  assert.equal(second.players[0]?.id, first.id);
  assert.equal((await joined).id, second.id);
  assert.equal(second.online, 2);
  const moved = event(sb, 'states');
  sa.emit('state', { d: [0,1,0], f: [1,0,0], h: 1, sp: 2 });
  assert.ok((await moved).some(row => row[0] === first.id));
  const royaleB = await connect(b, '/royale', '/royale-io/', bob.cookie);
  const changed = event(royaleB, 'royale:changed');
  assert.equal((await request(a, '/api/royale/join', { name: 'Alice' }, alice.cookie)).data.me.balance, 1000);
  await changed;
  await request(b, '/api/royale/join', { name: 'Bob' }, bob.cookie);
  const committed = event(royaleB, 'royale:activity');
  const stake = await request(a, '/api/royale/predictions', { marketId: 'game-wildcard', selection: 'yes', amount: 100, idempotencyKey: 'test-cross-instance-stake' }, alice.cookie);
  assert.equal(stake.status, 200); assert.equal(stake.data.me.balance, 900);
  assert.equal((await committed).type, 'stake');
  const snapshot = (await request(b, '/api/royale/state')).data;
  assert.equal(snapshot.markets.find(m => m.id === 'game-wildcard').pool, 100);
  assert.equal(snapshot.leaderboard.length, 2);
  const replay = await request(b, '/api/royale/predictions', { marketId: 'game-wildcard', selection: 'yes', amount: 100, idempotencyKey: 'test-cross-instance-stake' }, alice.cookie);
  assert.equal(replay.data.me.balance, 900); assert.equal(replay.data.replay, true);
  await request(b, '/api/human/logout', {}, alice.cookie);
  assert.equal((await request(a, '/api/human', null, alice.cookie)).data.human, null);
});
