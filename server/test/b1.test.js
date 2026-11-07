import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import sharp from 'sharp';
import { io as connect } from 'socket.io-client';
import { createDatabase, COLLECTIONS } from '../postgres.js';
import { createAuth } from '../auth.js';
import { createGateway } from '../index.js';
import { attachRealtime } from '../realtime.js';
import { playerIdOf } from '../identity.js';
import { SLOTS_PER_BOARD } from '../../shared/billboards.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. Tests use isolated temporary schemas.');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const adBody = (extra = {}) => ({ boardId: 'board-plaza', brand: 'Asha Chai', title: 'Fresh masala chai', text: 'Open today', days: 1, ...extra });
const encoded = (token) => createHash('sha256').update(token).digest('hex');

async function harness(t, { migrate = true } = {}) {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `b1_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  let server, app, rt;
  t.after(async () => {
    if (rt) await new Promise((resolve) => rt.io.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (app) await app.close(); else await database.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  if (migrate) await database.migrate();
  const auth = createAuth(database, { secure: false });
  const events = [];
  return {
    database, auth, admin, schema, events,
    async account(username = 'moderator', role = 'moderator', playerId = null) {
      return database.transaction(() => auth.provision({ username, role, playerId, password: 'correct horse battery staple' }));
    },
    async serve() {
      app = createGateway({ database, legacyDir: null, notify: {
        all: (event, data) => { events.push({ event, data }); rt?.toAll(event, data); },
        player: (id, event, data) => { events.push({ id, event, data }); rt?.toPlayer(id, event, data); },
      } });
      server = createServer(app);
      rt = attachRealtime(server, { isMuted: (id) => database.transaction(() => app.community.muted(id)) });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.base = `http://127.0.0.1:${server.address().port}`;
      this.app = app;
      return this;
    },
    async request(path, body, headers = {}) {
      const res = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    },
    async login(username = 'moderator') {
      const r = await this.request('/api/mod/login', { username, password: 'correct horse battery staple' });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
      assert.equal(r.data.__cookie, undefined);
      return r.data.token;
    },
  };
}

test('migrations are atomic, repeatable and detect edited applied SQL', async (t) => {
  const h = await harness(t);
  await h.database.migrate();
  assert.equal((await h.database.pool.query('SELECT * FROM schema_migrations')).rowCount, readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).length);
  await h.database.pool.query("UPDATE schema_migrations SET digest='changed'");
  await assert.rejects(h.database.migrate(), /Applied migration changed/);
});

test('a failed migration rolls back every DDL statement', async (t) => {
  const h = await harness(t, { migrate: false });
  await h.database.pool.query('CREATE TABLE uploads(conflict text)');
  await assert.rejects(h.database.migrate(), /already exists/);
  assert.equal((await h.database.pool.query("SELECT to_regclass('economy_records') AS name")).rows[0].name, null);
  assert.equal((await h.database.pool.query("SELECT to_regclass('schema_migrations') AS name")).rows[0].name, null);
});

test('legacy import preserves complete records, counters, accounts and source bytes; rerun never overwrites', async (t) => {
  const h = await harness(t);
  const dir = mkdtempSync(join(tmpdir(), 'omen-b1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of COLLECTIONS) writeFileSync(join(dir, `${name}.json`), JSON.stringify([{ id: `${name}-1`, stats: { impressions: 57, clicks: 4 }, nested: { untouched: true } }]));
  assert.equal(await h.database.importLegacy(dir), COLLECTIONS.length);
  assert.equal(await h.database.importLegacy(dir), 0);
  for (const name of COLLECTIONS) {
    const original = readFileSync(join(dir, `${name}.json`), 'utf8');
    const actual = (await h.database.pool.query('SELECT data FROM economy_records WHERE collection=$1', [name])).rows[0].data;
    assert.deepEqual(actual, JSON.parse(original)[0]);
  }
  writeFileSync(join(dir, 'ads.json'), '[{"id":"changed"}]');
  await assert.rejects(h.database.importLegacy(dir), /source changed/);
  assert.equal((await h.database.pool.query('SELECT * FROM economy_records')).rowCount, COLLECTIONS.length);
});

test('malformed files and ID conflicts cannot partially import', async (t) => {
  const h = await harness(t);
  const dir = mkdtempSync(join(tmpdir(), 'omen-b1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'payments.json'), '[{"id":"payment-1"}]');
  writeFileSync(join(dir, 'ads.json'), '{broken');
  await assert.rejects(h.database.importLegacy(dir));
  assert.equal((await h.database.pool.query('SELECT * FROM economy_records')).rowCount, 0);
  writeFileSync(join(dir, 'ads.json'), '[{"id":"ad-1"}]');
  await h.database.transaction(() => h.database.collection('ads').set('ad-1', { id: 'ad-1', existing: true }));
  await assert.rejects(h.database.importLegacy(dir), /Import conflict/);
  assert.equal((await h.database.pool.query("SELECT * FROM economy_records WHERE collection='payments'")).rowCount, 0);
  assert.equal((await h.database.pool.query('SELECT * FROM legacy_imports')).rowCount, 0);
});

test('the repository legacy data can be imported without losing a single field', async (t) => {
  const h = await harness(t);
  const dir = new URL('../data/', import.meta.url);
  let count = 0;
  for (const name of COLLECTIONS) if (existsSync(new URL(`${name}.json`, dir))) count += JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')).length;
  assert.equal(await h.database.importLegacy(fileURLToPath(dir)), count);
  for (const name of COLLECTIONS) {
    const file = new URL(`${name}.json`, dir);
    if (!existsSync(file)) continue;
    for (const record of JSON.parse(readFileSync(file, 'utf8'))) {
      const actual = (await h.database.pool.query('SELECT data FROM economy_records WHERE collection=$1 AND id=$2', [name, record.id])).rows[0].data;
      assert.deepEqual(actual, record);
    }
  }
});

test('accounts enforce roles, hashed credentials, revocation, expiry and no shared-key fallback', async (t) => {
  const h = await harness(t);
  await h.account(); await h.account('reviewer', 'reviewer'); await h.serve();
  assert.equal((await h.request('/api/mod/queue')).status, 401);
  assert.equal((await h.request('/api/mod/queue', undefined, { 'x-mod-key': 'old-shared-moderator-key' })).status, 401);
  const reviewer = await h.login('reviewer');
  const token = await h.login();
  const credential = (await h.database.pool.query("SELECT password_hash FROM moderator_accounts WHERE username='moderator'")).rows[0];
  assert.ok(!credential.password_hash.includes('correct horse'));
  const sessions = (await h.database.pool.query('SELECT token_hash FROM moderator_sessions')).rows;
  assert.ok(sessions.some((s) => s.token_hash === encoded(token)));
  assert.ok(sessions.every((s) => s.token_hash !== token));
  const ad = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  assert.equal(ad.status, 200);
  assert.equal((await h.request('/api/mod/queue', undefined, { authorization: `Bearer ${reviewer}` })).status, 200);
  assert.equal((await h.request('/api/mod', { action: 'approve', id: ad.data.id }, { authorization: `Bearer ${reviewer}` })).status, 403);
  assert.equal((await h.request('/api/mod', { action: 'delete', kind: 'ad', id: ad.data.id }, { authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await h.request('/api/mod', { action: 'approve', id: ad.data.id }, { 'x-mod-key': token })).status, 200);
  assert.equal((await h.database.pool.query('SELECT * FROM moderation_audit')).rowCount, 1);
  await h.request('/api/mod/logout', {}, { authorization: `Bearer ${token}` });
  assert.equal((await h.request('/api/mod/me', undefined, { authorization: `Bearer ${token}` })).status, 401);
  const fresh = await h.login();
  await h.database.pool.query('UPDATE moderator_sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [encoded(fresh)]);
  assert.equal((await h.request('/api/mod/me', undefined, { authorization: `Bearer ${fresh}` })).status, 401);
  const disabled = await h.login();
  await h.database.pool.query("UPDATE moderator_accounts SET disabled=true WHERE username='moderator'");
  assert.equal((await h.request('/api/mod/me', undefined, { authorization: `Bearer ${disabled}` })).status, 401);
});

test('persistent login throttling and cross-origin protection apply to moderator login', async (t) => {
  const h = await harness(t); await h.account(); await h.serve();
  assert.equal((await h.request('/api/mod/login', {}, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await h.request('/api/mod/login', {}, { origin: 'null' })).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await h.request('/api/mod/login', { username: 'moderator', password: 'wrong' })).status, 401);
  assert.equal((await h.request('/api/mod/login', { username: 'moderator', password: 'correct horse battery staple' })).status, 429);
  assert.equal((await h.database.pool.query('SELECT * FROM login_attempts')).rowCount, 2);
});

test('bound moderator identity cannot be omitted or replaced to moderate own campaign', async (t) => {
  const h = await harness(t); await h.account('moderator', 'admin', playerIdOf(OWNER)); await h.serve();
  const token = await h.login();
  const ad = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  for (const action of ['approve', 'reject', 'hide', 'unhide', 'delete']) {
    const r = await h.request('/api/mod', { action, kind: 'ad', id: ad.data.id }, { authorization: `Bearer ${token}`, 'x-omen-token': OTHER });
    assert.equal(r.status, 403); assert.equal(r.data.error, 'own_ad');
  }
  assert.equal((await h.database.pool.query('SELECT * FROM moderation_audit')).rowCount, 0);
});

test('concurrent approval cannot overbook a board, including across two database pools', async (t) => {
  const h = await harness(t); await h.account(); await h.serve();
  const token = await h.login();
  const ids = [];
  for (let i = 0; i < SLOTS_PER_BOARD + 1; i++) ids.push((await h.request('/api/ads', adBody(), { 'x-omen-token': randomBytes(32).toString('hex') })).data.id);
  const results = await Promise.all(ids.map((id) => h.request('/api/mod', { action: 'approve', id }, { authorization: `Bearer ${token}` })));
  assert.equal(results.filter((r) => r.status === 200).length, SLOTS_PER_BOARD);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  const second = createDatabase(h.database.pool.options.connectionString);
  try {
    const adId = ids.find((id) => results[ids.indexOf(id)].status === 200);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? second : h.database).transaction(async () => {
      const ad = (i % 2 ? second : h.database).collection('ads').get(adId);
      const before = ad.stats.impressions;
      await new Promise((resolve) => setTimeout(resolve, 3));
      ad.stats.impressions = before + 1;
    })));
    const row = (await h.database.pool.query("SELECT data FROM economy_records WHERE collection='ads' AND id=$1", [adId])).rows[0].data;
    assert.equal(row.stats.impressions, 12);
  } finally { await second.close(); }
});

test('rental is idempotent; payment privacy and DEMO settlement survive a database reconnect', async (t) => {
  const h = await harness(t); await h.account(); await h.serve();
  const token = await h.login();
  const { data: ad } = await h.request('/api/ads', adBody({ days: 3 }), { 'x-omen-token': OWNER });
  await h.request('/api/mod', { action: 'approve', id: ad.id }, { authorization: `Bearer ${token}` });
  const rents = await Promise.all(Array.from({ length: 5 }, () => h.request(`/api/ads/${ad.id}/rent`, { token: 'DEMO' }, { 'x-omen-token': OWNER })));
  assert.ok(rents.every((r) => r.status === 200));
  const id = rents[0].data.payment.id;
  assert.ok(rents.every((r) => r.data.payment.id === id));
  assert.equal((await h.database.pool.query("SELECT * FROM economy_records WHERE collection='payments'")).rowCount, 1);
  for (const suffix of ['', '/risk', '/authorize', '/submit', '/cancel', '/relay']) {
    assert.equal((await h.request(`/api/payments/${id}${suffix}`, suffix ? {} : undefined, { 'x-omen-token': OTHER })).status, 404);
  }
  assert.equal((await h.request(`/api/payments/${id}/authorize`, {}, { 'x-omen-token': OWNER })).status, 200);
  const settled = await h.request(`/api/payments/${id}/submit`, { demoRef: 'b1' }, { 'x-omen-token': OWNER });
  assert.equal(settled.data.state, 'COMPLETED'); assert.equal(settled.data.payout.simulated, true);
  assert.equal((await h.request('/api/ads')).data.ads[0].id, ad.id);
  const reopened = createDatabase(h.database.pool.options.connectionString);
  try {
    await reopened.transaction(() => {
      assert.equal(reopened.collection('ads').get(ad.id).status, 'live');
      assert.equal(reopened.collection('payments').get(id).state, 'COMPLETED');
    });
  } finally { await reopened.close(); }
});

test('statistics deduplicate concurrent and restarted requests; private fields stay private', async (t) => {
  const h = await harness(t); await h.account(); await h.serve(); const token = await h.login();
  const { data: ad } = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  await h.request('/api/mod', { action: 'approve', id: ad.id }, { authorization: `Bearer ${token}` });
  const counted = await Promise.all(Array.from({ length: 10 }, () => h.request(`/api/ads/${ad.id}/seen`, {}, { 'x-omen-token': OTHER })));
  assert.equal(counted.filter((r) => r.data.counted).length, 1);
  assert.equal((await h.request(`/api/ads/${ad.id}/seen`, {}, { 'x-omen-token': OWNER })).data.reason, 'own_ad');
  const mine = await h.request('/api/ads/mine', undefined, { 'x-omen-token': OWNER });
  assert.equal(mine.data.ads[0].stats.impressions, 1);
  assert.equal((await h.request('/api/ads/mine', undefined, { 'x-omen-token': OTHER })).data.ads.length, 0);
  assert.equal((await h.request('/api/ads')).data.ads[0].stats, undefined);
  const restarted = createGateway({ database: createDatabase(h.database.pool.options.connectionString), legacyDir: null });
  try {
    const result = await restarted.database.transaction(() => restarted.community.recordView(playerIdOf(OTHER), ad.id));
    assert.equal(result.reason, 'recent');
  } finally { await restarted.close(); }
});

test('uploads are decoded, stored in PostgreSQL, gated before approval and revoked on takedown', async (t) => {
  const h = await harness(t); await h.account(); await h.serve(); const token = await h.login();
  const image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  const bad = `data:image/png;base64,${image.subarray(0, 33).toString('base64')}`;
  assert.equal((await h.request('/api/ads', adBody({ image: bad }), { 'x-omen-token': OWNER })).status, 400);
  const created = await h.request('/api/ads', adBody({ image: `data:image/png;base64,${image.toString('base64')}` }), { 'x-omen-token': OWNER });
  assert.equal(created.status, 200);
  const path = created.data.image;
  assert.equal((await h.request(path)).status, 404);
  assert.equal((await h.request(path, undefined, { 'x-omen-token': OTHER })).status, 404);
  assert.equal((await h.request(path, undefined, { 'x-omen-token': OWNER })).status, 200);
  assert.equal((await h.request(path, undefined, { cookie: `omen_media=${OWNER}` })).status, 200);
  assert.equal((await h.request(path, undefined, { cookie: `omen_mod=${token}` })).status, 200);
  assert.match(created.headers.get('set-cookie'), /Path=\/uploads\/; HttpOnly/);
  await h.request('/api/mod', { action: 'approve', id: created.data.id }, { authorization: `Bearer ${token}` });
  const visible = await h.request(path);
  assert.equal(visible.status, 200); assert.equal(visible.headers.get('cache-control'), 'private, no-store');
  assert.equal((await sharp(visible.data).metadata()).width, 128);
  await h.request('/api/mod', { action: 'takedown', id: created.data.id }, { authorization: `Bearer ${token}` });
  assert.equal((await h.request(path)).status, 404);
});

test('rollback emits no notifications and persists no partial campaign', async (t) => {
  const h = await harness(t); await h.serve();
  await assert.rejects(h.database.transaction(() => {
    h.app.community.submitAd(playerIdOf(OWNER), 'Asha', adBody());
    throw new Error('injected failure');
  }), /injected failure/);
  assert.equal(h.events.length, 0);
  assert.equal((await h.database.pool.query("SELECT * FROM economy_records WHERE collection='ads'")).rowCount, 0);
});

test('real WebSocket clients receive committed approval, expiry and takedown synchronization', async (t) => {
  const h = await harness(t); await h.account(); await h.serve(); const token = await h.login();
  const socket = connect(h.base + '/world', { transports: ['websocket'], forceNew: true });
  t.after(() => socket.close());
  await once(socket, 'connect');
  await new Promise((resolve) => socket.emit('join', { room: 'b1-room', token: OWNER, name: 'Asha' }, resolve));
  const { data: ad } = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  const broadcast = once(socket, 'ads:update');
  const privateUpdate = once(socket, 'ad:update');
  await h.request('/api/mod', { action: 'approve', id: ad.id }, { authorization: `Bearer ${token}` });
  assert.equal((await broadcast)[0][0].id, ad.id);
  assert.equal((await privateUpdate)[0].status, 'live');
  const removed = once(socket, 'ads:update');
  await h.request('/api/mod', { action: 'takedown', id: ad.id }, { authorization: `Bearer ${token}` });
  assert.deepEqual((await removed)[0], []);
  const { data: expiring } = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  await h.request('/api/mod', { action: 'approve', id: expiring.id }, { authorization: `Bearer ${token}` });
  const expiry = once(socket, 'ad:update');
  await h.database.transaction(() => {
    h.database.collection('ads').get(expiring.id).expiresAt = Date.now() - 1;
    h.app.community.sweep();
  });
  assert.equal((await expiry)[0].status, 'expired');
});

test('startup refuses unimported or changed legacy data, with no JSON fallback', async (t) => {
  const h = await harness(t);
  const dir = mkdtempSync(join(tmpdir(), 'omen-b1-ready-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ads.json'), '[{"id":"existing-ad"}]');
  await assert.rejects(h.database.verifyReady(dir), /Import\/reconcile legacy/);
  await h.database.importLegacy(dir);
  await h.database.verifyReady(dir);
  writeFileSync(join(dir, 'ads.json'), '[{"id":"changed-ad"}]');
  await assert.rejects(h.database.verifyReady(dir), /Import\/reconcile legacy/);
  await h.database.pool.query('DELETE FROM schema_migrations');
  await assert.rejects(h.database.verifyReady(null), /missing or modified migration/);
});

test('public resume IDs cannot replace an authenticated player or receive private events', async (t) => {
  const h = await harness(t); await h.serve();
  const owner = connect(h.base + '/world', { transports: ['websocket'], forceNew: true });
  const attacker = connect(h.base + '/world', { transports: ['websocket'], forceNew: true });
  t.after(() => { owner.close(); attacker.close(); });
  await Promise.all([once(owner, 'connect'), once(attacker, 'connect')]);
  await new Promise((resolve) => owner.emit('join', { room: 'owner-room', name: 'Owner', token: OWNER }, resolve));
  const refused = await new Promise((resolve) => attacker.emit('join', { room: 'owner-room', name: 'Attacker', resume: playerIdOf(OWNER) }, resolve));
  assert.match(refused.error, /guest token/);
  // A different room has no matching player to reject. It must still never authorize private delivery.
  await new Promise((resolve) => attacker.emit('join', { room: 'other-room', name: 'Attacker', resume: playerIdOf(OWNER) }, resolve));
  let leaked = false;
  attacker.on('ad:update', () => { leaked = true; });
  await h.account(); const token = await h.login();
  const { data: ad } = await h.request('/api/ads', adBody(), { 'x-omen-token': OWNER });
  const ownerUpdate = once(owner, 'ad:update');
  await h.request('/api/mod', { action: 'approve', id: ad.id }, { authorization: `Bearer ${token}` });
  assert.equal((await ownerUpdate)[0].status, 'live');
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(leaked, false);
});
