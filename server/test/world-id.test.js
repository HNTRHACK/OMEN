import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { io as connect } from 'socket.io-client';
import { createDatabase } from '../postgres.js';
import { createGateway } from '../index.js';
import { createWorldOidc, ORB_CLASSES, WORLD_ISSUERS } from '../world-oidc.js';
import { createWorldIdentity } from '../world-identity.js';
import { attachRealtime } from '../realtime.js';
import { playerIdOf } from '../identity.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forged = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const GUEST = 'a'.repeat(64);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const cookieValue = (res, name = 'omen_player') => res.headers.getSetCookie().find((v) => v.startsWith(name + '='))?.split(';')[0];

// This double replaces HTTP only. The production OIDC library verifies all real RSA signatures,
// discovery, issuer/audience/time/nonce claims and PKCE against these locally signed fixtures.
function fixtureProvider(environment = 'production') {
  const issuer = WORLD_ISSUERS[environment];
  const settings = { environment, clientId: 'omen-test-client', clientSecret: 'automated-tests-only', redirectUri: 'https://omen.example/api/auth/world/callback' };
  const grants = new Map(), calls = [];
  let outage = false;
  const fixture = {
    settings, calls,
    outage(value) { outage = value; },
    authorize(authorizationUrl, { subject = 'opaque-human-A', claims = {}, forgedSignature = false, alg = 'RS256', jti = randomUUID() } = {}) {
      const url = new URL(authorizationUrl);
      const code = randomBytes(24).toString('hex');
      grants.set(code, { subject, claims, forgedSignature, alg, jti, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
      return new URLSearchParams({ code, state: url.searchParams.get('state'), iss: issuer });
    },
    async fetch(url, options) {
      calls.push({ url, method: options.method });
      if (outage) return json({ error: 'temporarily_unavailable' }, 503);
      if (url === issuer + '/.well-known/openid-configuration') return json({
        issuer, authorization_endpoint: issuer + '/api/v1/authorize', token_endpoint: issuer + '/api/v1/token', jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'], authorization_response_iss_parameter_supported: true, code_challenge_methods_supported: ['S256'],
      });
      if (url === issuer + '/jwks') return json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] });
      assert.equal(url, issuer + '/api/v1/token');
      const form = new URLSearchParams(options.body);
      const grant = grants.get(form.get('code'));
      if (!grant || grant.used) return json({ error: 'invalid_grant' }, 400);
      grant.used = true;
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), settings.redirectUri);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), grant.challenge);
      const headers = new Headers(options.headers);
      assert.deepEqual(Buffer.from(headers.get('authorization').slice(6), 'base64').toString().split(':').map(decodeURIComponent), [settings.clientId, settings.clientSecret]);
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, sub: grant.subject, aud: settings.clientId, iat: now, exp: now + 300, auth_time: now,
        acr: ORB_CLASSES[0], amr: ['pop'], nonce: grant.nonce, jti: grant.jti, ...grant.claims };
      for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
      const input = [Buffer.from(JSON.stringify({ alg: grant.alg, kid: 'test-key' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      const signature = sign('RSA-SHA256', Buffer.from(input), grant.forgedSignature ? forged.privateKey : keys.privateKey).toString('base64url');
      return json({ id_token: input + '.' + signature, access_token: 'unused-test-access-token', token_type: 'Bearer', expires_in: 300 });
    },
  };
  fixture.provider = createWorldOidc(settings, { fetch: fixture.fetch });
  return fixture;
}

async function harness(t, { environment = 'production', configured = true } = {}) {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'wid_' + randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(process.env.TEST_DATABASE_URL);
  connection.searchParams.set('options', '-c search_path=' + schema);
  const database = createDatabase(connection.href);
  let app, server, rt;
  t.after(async () => {
    if (rt) await new Promise((resolve) => rt.io.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (app) await app.close(); else await database.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  await database.migrate();
  const fixture = fixtureProvider(environment);
  const provider = configured ? fixture.provider : createWorldOidc({ environment });
  const identity = createWorldIdentity(database, configured ? fixture.settings : { environment }, { provider, secure: false });
  const h = {
    database, fixture, identity,
    async request(path, body, cookie = '', extra = {}) {
      const res = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, headers: res.headers, data: res.status === 303 ? null : await res.json() };
    },
    async begin({ recover = false, cookie = '' } = {}) {
      const res = await this.request('/api/auth/world/start', recover ? { recover: true } : {}, cookie);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      return { authorizationUrl: res.data.authorizationUrl, cookie: cookieValue(res, 'omen_world_flow'), res };
    },
    async finish(begin, options = {}) {
      const query = fixture.authorize(begin.authorizationUrl, options);
      const result = await this.request('/api/auth/world/callback?' + query, undefined, begin.cookie);
      return { ...result, query, cookie: cookieValue(result) };
    },
    async login(options = {}) {
      const begin = await this.begin(options);
      const result = await this.finish(begin, options);
      assert.equal(result.status, 303, JSON.stringify(result.data));
      assert.equal(result.headers.get('location'), '/?world_id=success');
      assert.ok(result.cookie);
      return result;
    },
    async socket(cookie = '', payload = {}) {
      const socket = connect(this.base + '/world', { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
      t.after(() => socket.close());
      await once(socket, 'connect');
      const ack = await new Promise((resolve) => socket.emit('join', { room: 'world-test', name: 'Client name', ...payload }, resolve));
      return { socket, ack };
    },
  };
  app = createGateway({ database, legacyDir: null, worldIdentity: identity });
  await app.ready;
  server = createServer(app);
  rt = attachRealtime(server, { worldIdentity: identity });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.base = 'http://127.0.0.1:' + server.address().port;
  return h;
}

test('unconfigured World ID fails closed; anonymous and guest access never claim verification', async (t) => {
  const h = await harness(t, { configured: false });
  assert.equal((await h.request('/api/auth/world/status')).data.configured, false);
  assert.equal((await h.request('/api/auth/world/start', {})).status, 503);
  assert.deepEqual((await h.request('/api/auth/me')).data, { player: null });
  const me = (await h.request('/api/auth/me', undefined, '', { 'x-omen-token': GUEST })).data.player;
  assert.equal(me.avatarId, playerIdOf(GUEST)); assert.equal(me.verifiedHuman, false); assert.equal(me.accountId, null);
  assert.equal((await h.request('/api/avatar', undefined, '', { 'x-omen-token': GUEST })).status, 401);
  const guest = await h.socket('', { token: GUEST, verifiedHuman: true, accountId: randomUUID() });
  assert.equal(guest.ack.verifiedHuman, false);
});

test('invalid registrations fail closed and production cookies are Secure, HttpOnly and host scoped', async (t) => {
  assert.throws(() => createWorldOidc({ clientId: 'partial' }), /Set all/);
  assert.throws(() => createWorldOidc({ environment: '__proto__' }), /production or sandbox/);
  assert.throws(() => createWorldOidc({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://omen.example/api/auth/world/callback' }), /exact HTTPS/);
  const h = await harness(t);
  const secureIdentity = createWorldIdentity(h.database, h.fixture.settings, { provider: h.fixture.provider, secure: true });
  const start = await secureIdentity.start({ headers: {} });
  assert.match(start.__cookie, /^__Secure-omen_world_flow=.*HttpOnly; SameSite=Lax; Max-Age=300; Secure$/);
  const query = h.fixture.authorize(start.authorizationUrl);
  const callback = await secureIdentity.callback({ headers: { cookie: start.__cookie.split(';')[0] } }, query);
  assert.match(callback.__cookie[0], /^__Host-omen_player=.*Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
  assert.ok(!callback.__cookie[0].includes('Domain='));
});

test('first real-shaped signed authentication creates one private account and persistent owned avatar', async (t) => {
  const h = await harness(t);
  const begin = await h.begin();
  const url = new URL(begin.authorizationUrl);
  assert.equal(url.origin, WORLD_ISSUERS.production); assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('max_age'), '300');
  assert.deepEqual(JSON.parse(url.searchParams.get('claims')).id_token.acr.values, ORB_CLASSES);
  assert.match(begin.res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const login = await h.finish(begin);
  assert.equal(login.status, 303, JSON.stringify(login.data));
  const me = await h.request('/api/auth/me', undefined, login.cookie);
  assert.equal(me.data.player.verifiedHuman, true); assert.equal(me.data.player.authType, 'world-id');
  assert.match(me.data.player.avatarId, /^[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(me.data).includes('opaque-human-A')); assert.equal(me.data.player.sessionHash, undefined);
  const owned = await h.request('/api/avatar', undefined, login.cookie);
  assert.equal(owned.data.avatar.id, me.data.player.avatarId); assert.equal(owned.data.ownerAccountId, me.data.player.accountId);
  const stored = (await h.database.pool.query('SELECT * FROM player_sessions')).rows[0];
  assert.equal(stored.token_hash, sha256(login.cookie.split('=')[1]));
  assert.notEqual(stored.token_hash, login.cookie.split('=')[1]);
});

test('concurrent fresh logins and database constraints prevent duplicate account/avatar registration', async (t) => {
  const h = await harness(t);
  const starts = await Promise.all([h.begin(), h.begin()]);
  const results = await Promise.all(starts.map((start) => h.finish(start)));
  assert.ok(results.every((r) => r.status === 303));
  const players = await Promise.all(results.map((r) => h.request('/api/auth/me', undefined, r.cookie)));
  assert.equal(players[0].data.player.accountId, players[1].data.player.accountId);
  assert.equal(players[0].data.player.avatarId, players[1].data.player.avatarId);
  assert.equal((await h.database.pool.query('SELECT * FROM player_accounts')).rowCount, 1);
  await assert.rejects(h.database.pool.query('INSERT INTO player_accounts(id,avatar_id,world_issuer,world_subject) VALUES($1,$2,$3,$4)',
    [randomUUID(), randomBytes(12).toString('hex'), WORLD_ISSUERS.production, 'opaque-human-A']), { code: '23505' });
});

test('returning users and recovery retain avatar and revoke old device sessions', async (t) => {
  const h = await harness(t); const first = await h.login();
  const original = (await h.request('/api/avatar', undefined, first.cookie)).data;
  const saved = await h.request('/api/avatar', { displayName: 'Asha', look: { pet: 2, hat: 1 }, revision: 0 }, first.cookie);
  assert.equal(saved.status, 200);
  const returning = await h.login();
  assert.deepEqual((await h.request('/api/avatar', undefined, returning.cookie)).data, saved.data);
  const recovered = await h.login({ recover: true });
  assert.deepEqual((await h.request('/api/avatar', undefined, recovered.cookie)).data, saved.data);
  assert.equal(saved.data.avatar.id, original.avatar.id);
  assert.equal((await h.request('/api/auth/me', undefined, first.cookie)).status, 401);
  assert.equal((await h.request('/api/auth/me', undefined, returning.cookie)).status, 401);
  assert.equal((await h.database.pool.query('SELECT * FROM player_accounts')).rowCount, 1);
  const unknown = await h.finish(await h.begin({ recover: true }), { subject: 'different-world-id' });
  assert.equal(unknown.status, 404);
  assert.equal((await h.database.pool.query('SELECT * FROM player_accounts')).rowCount, 1);
});

test('forged signatures, unsigned/wrong-algorithm tokens and invalid verification claims create no accounts', async (t) => {
  const h = await harness(t);
  const now = Math.floor(Date.now() / 1000);
  const invalidCases = [
    { forgedSignature: true }, { alg: 'none' }, { alg: 'HS256' },
    { claims: { aud: 'another-app' } }, { claims: { iss: WORLD_ISSUERS.sandbox } },
    { claims: { nonce: 'forged-nonce' } }, { claims: { exp: now - 10 } },
    { claims: { iat: now + 600 } }, { claims: { auth_time: now + 600 } }, { claims: { auth_time: now - 1000 } },
    { claims: { acr: 'https://world.org/oidc/acr/selfie' } }, { claims: { acr: undefined } },
    { claims: { amr: [] } }, { claims: { amr: ['pop', 'mfa'] } }, { claims: { acr: ORB_CLASSES[1], amr: ['pop'] } },
    { claims: { sub: '' } }, { claims: { jti: undefined } }, { claims: { auth_time: undefined } },
  ];
  for (const options of invalidCases) {
    const result = await h.finish(await h.begin(), options);
    assert.equal(result.status, 401, JSON.stringify({ options, result: result.data }));
  }
  assert.equal((await h.database.pool.query('SELECT * FROM player_accounts')).rowCount, 0);
  assert.equal((await h.database.pool.query('SELECT * FROM player_sessions')).rowCount, 0);
});

test('browser binding, issuer checks and attempt expiry prevent login CSRF and mismatched callbacks', async (t) => {
  const h = await harness(t);
  const begin = await h.begin(); const query = h.fixture.authorize(begin.authorizationUrl);
  assert.equal((await h.request('/api/auth/world/callback?' + query)).status, 401);
  query.set('iss', WORLD_ISSUERS.sandbox);
  assert.equal((await h.request('/api/auth/world/callback?' + query, undefined, begin.cookie)).status, 401);
  query.set('iss', WORLD_ISSUERS.production);
  assert.equal((await h.request('/api/auth/world/callback?' + query, undefined, begin.cookie)).status, 409);
  const expired = await h.begin();
  await h.database.pool.query("UPDATE world_login_attempts SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [sha256(new URL(expired.authorizationUrl).searchParams.get('state'))]);
  assert.equal((await h.finish(expired)).status, 409);
  const duplicate = await h.begin(); const doubled = h.fixture.authorize(duplicate.authorizationUrl); doubled.append('state', doubled.get('state'));
  assert.equal((await h.request('/api/auth/world/callback?' + doubled, undefined, duplicate.cookie)).status, 400);
  assert.equal((await h.request('/api/auth/world/start', {}, '', { origin: 'https://attacker.example' })).status, 403);
});

test('one callback wins a race; code and ID-token replay cannot mint additional sessions', async (t) => {
  const h = await harness(t); const begin = await h.begin(); const query = h.fixture.authorize(begin.authorizationUrl, { jti: 'same-jti' });
  const path = '/api/auth/world/callback?' + query;
  const results = await Promise.all([h.request(path, undefined, begin.cookie), h.request(path, undefined, begin.cookie)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
  assert.equal((await h.request(path, undefined, begin.cookie)).status, 409);
  const repeatToken = await h.finish(await h.begin(), { jti: 'same-jti' });
  assert.equal(repeatToken.status, 409); assert.equal(repeatToken.data.error, 'proof_replayed');
  assert.equal((await h.database.pool.query('SELECT * FROM player_sessions')).rowCount, 1);
});

test('dependency failures never become approval and consume the failed attempt', async (t) => {
  const h = await harness(t); const begin = await h.begin(); const query = h.fixture.authorize(begin.authorizationUrl);
  h.fixture.outage(true);
  const failed = await h.request('/api/auth/world/callback?' + query, undefined, begin.cookie);
  assert.equal(failed.status, 503);
  h.fixture.outage(false);
  assert.equal((await h.request('/api/auth/world/callback?' + query, undefined, begin.cookie)).status, 409);
  assert.equal((await h.database.pool.query('SELECT * FROM player_sessions')).rowCount, 0);
});

test('sandbox accounts stay separate and never receive production verified-human badges', async (t) => {
  const h = await harness(t, { environment: 'sandbox' }); const login = await h.login();
  const me = (await h.request('/api/auth/me', undefined, login.cookie)).data.player;
  assert.equal(me.verifiedHuman, false); assert.equal(me.verificationEnvironment, 'sandbox');
  const socket = await h.socket(login.cookie, { verifiedHuman: true });
  assert.equal(socket.ack.verifiedHuman, false);
});

test('valid Orb passkey and Face Auth claims are accepted; email claims are not needed', async (t) => {
  const h = await harness(t);
  const passkey = await h.login({ claims: { amr: ['pop', 'user', 'mfa'] } });
  const face = await h.login({ claims: { acr: ORB_CLASSES[1], amr: ['pop', 'face', 'user'] } });
  const passkeyMe = (await h.request('/api/auth/me', undefined, passkey.cookie)).data.player;
  const faceMe = (await h.request('/api/auth/me', undefined, face.cookie)).data.player;
  assert.equal(faceMe.verifiedHuman, true); assert.equal(faceMe.avatarId, passkeyMe.avatarId);
  const invalid = await h.finish(await h.begin(), { claims: { acr: ORB_CLASSES[1], amr: ['pop', 'user', 'mfa'] } });
  assert.equal(invalid.status, 401);
});

test('avatar ownership, revision concurrency and existing advertising/marketplace use the authenticated identity', async (t) => {
  const h = await harness(t); const login = await h.login(); const attacker = await h.login({ subject: 'other-human' });
  assert.equal((await h.request('/api/avatar', { revision: 0, verifiedHuman: true }, login.cookie)).status, 400);
  assert.equal((await h.request('/api/avatar', { revision: 0, look: { pet: 999 } }, login.cookie)).status, 400);
  const updates = await Promise.all(['Asha', 'Ravi'].map((displayName) => h.request('/api/avatar', { revision: 0, displayName }, login.cookie)));
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
  const stranger = await h.request('/api/avatar', undefined, attacker.cookie);
  assert.equal(stranger.data.avatar.displayName, 'Courier');
  const ad = await h.request('/api/ads', { boardId: 'board-plaza', brand: 'Verified Shop', title: 'Tea today', days: 1 }, login.cookie);
  assert.equal(ad.status, 200);
  assert.equal((await h.request('/api/ads/mine', undefined, login.cookie)).data.ads[0].id, ad.data.id);
  assert.equal((await h.request('/api/ads/mine', undefined, attacker.cookie)).data.ads.length, 0);
  const guestAd = await h.request('/api/ads', { boardId: 'board-well', brand: 'Guest Shop', title: 'Tea tomorrow', days: 1 }, '', { 'x-omen-token': GUEST });
  assert.equal(guestAd.status, 200);
  assert.equal((await h.request('/api/ads/mine', undefined, '', { 'x-omen-token': GUEST })).data.ads[0].id, guestAd.data.id);
  assert.equal((await h.request('/api/ads/mine', undefined, login.cookie, { 'x-omen-token': GUEST })).data.ads.length, 1);
  assert.equal((await h.request('/api/shops/plot-lantern/claim', { name: 'Verified Tea' }, login.cookie)).status, 200);
  assert.equal((await h.request('/api/shops/mine', undefined, attacker.cookie)).data.shop, null);
});

test('expired, revoked, disabled and forged sessions cannot fall back to guest authorization', async (t) => {
  const h = await harness(t); const login = await h.login();
  await h.request('/api/auth/logout', {}, login.cookie);
  assert.equal((await h.request('/api/auth/me', undefined, login.cookie, { 'x-omen-token': GUEST })).status, 401);
  assert.equal((await h.request('/api/avatar', { revision: 0, displayName: 'Forged' }, 'omen_player=' + 'f'.repeat(64))).status, 401);
  const expired = await h.login();
  await h.database.pool.query("UPDATE player_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [sha256(expired.cookie.split('=')[1])]);
  assert.equal((await h.request('/api/auth/me', undefined, expired.cookie)).status, 401);
  const disabled = await h.login();
  await h.database.pool.query('UPDATE player_accounts SET disabled=true');
  assert.equal((await h.request('/api/auth/me', undefined, disabled.cookie)).status, 401);
  assert.equal((await h.finish(await h.begin())).status, 403);
});

test('multiplayer badges and appearance are server-authoritative and revocation removes the connected player', async (t) => {
  const h = await harness(t); const login = await h.login();
  const me = (await h.request('/api/auth/me', undefined, login.cookie)).data.player;
  await h.request('/api/avatar', { revision: 0, displayName: 'Saved Name', look: { hat: 2 } }, login.cookie);
  const watcher = await h.socket('', { token: GUEST, verifiedHuman: true });
  const joined = once(watcher.socket, 'joined');
  const player = await h.socket(login.cookie, { name: 'Forged Name', look: { hat: 4 }, verifiedHuman: false });
  const profile = (await joined)[0];
  assert.equal(profile.name, 'Saved Name'); assert.equal(profile.look.hat, 2); assert.equal(profile.verifiedHuman, true);
  assert.equal(profile.avatarRevision, 1);
  assert.equal(profile.avatarId, me.avatarId); assert.equal(profile.accountId, undefined); assert.equal(profile.sessionHash, undefined);
  const updated = once(watcher.socket, 'profile:update');
  await h.request('/api/avatar', { revision: 1, displayName: 'New Name' }, login.cookie);
  assert.equal((await updated)[0].name, 'New Name');
  const expired = once(player.socket, 'identity:expired'); const left = once(watcher.socket, 'left');
  await h.request('/api/auth/logout', {}, login.cookie);
  assert.equal((await expired)[0].error, 'session_expired'); assert.equal((await left)[0].id, me.avatarId);
  const denied = await h.socket(login.cookie);
  assert.ok(denied.ack.error); assert.equal(denied.ack.verifiedHuman, undefined);
  const impersonator = await h.socket('', { resume: me.avatarId, verifiedHuman: true });
  assert.match(impersonator.ack.error, /authenticated session/);
});

test('database revocation blocks the next socket packet, including a forged look update', async (t) => {
  const h = await harness(t); const login = await h.login(); const player = await h.socket(login.cookie);
  const expired = once(player.socket, 'identity:expired');
  await h.database.pool.query('UPDATE player_sessions SET revoked_at=now()');
  player.socket.emit('look', { hat: 4, verifiedHuman: true });
  assert.equal((await expired)[0].error, 'session_expired');
  assert.equal((await h.request('/api/auth/me', undefined, login.cookie)).status, 401);
});

test('sign-in rotation and all-session logout revoke prior credentials; accounts survive database reconnect', async (t) => {
  const h = await harness(t); const first = await h.login(); const second = await h.login({ cookie: first.cookie });
  assert.equal((await h.request('/api/auth/me', undefined, first.cookie)).status, 401);
  const secondPlayer = (await h.request('/api/auth/me', undefined, second.cookie)).data.player;
  const otherDevice = await h.login();
  await h.request('/api/auth/logout', { all: true }, second.cookie);
  assert.equal((await h.request('/api/auth/me', undefined, second.cookie)).status, 401);
  assert.equal((await h.request('/api/auth/me', undefined, otherDevice.cookie)).status, 401);
  const recovered = await h.login({ recover: true });
  const restartedDatabase = createDatabase(h.database.pool.options.connectionString);
  try {
    const restarted = createWorldIdentity(restartedDatabase, h.fixture.settings, { provider: h.fixture.provider, secure: false });
    const profile = await restarted.me({ headers: { cookie: recovered.cookie } });
    assert.equal(profile.player.accountId, secondPlayer.accountId); assert.equal(profile.player.avatarId, secondPlayer.avatarId);
  } finally { await restartedDatabase.close(); }
});
