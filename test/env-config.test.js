import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadServerEnv } from '../server/env.js';
import { finalConfig, createFinalBlock } from '../server/final-block.js';

const credentials = { VITE_WORLD_APP_ID: 'app_test', WORLD_RP_ID: 'rp_test', WORLD_RP_SIGNING_KEY: '12'.repeat(32) };

test('Node loads env files with local/mode precedence, quotes and comments; shell values win', t => {
  const root = mkdtempSync(join(tmpdir(), 'omen-env-'));
  t.after(() => rmSync(root, { recursive: true }));
  writeFileSync(join(root, '.env'), 'A=base\nB="quoted # value" # comment\nSHELL=file\n');
  writeFileSync(join(root, '.env.local'), 'A=local\n');
  writeFileSync(join(root, '.env.staging'), 'A=mode\n');
  writeFileSync(join(root, '.env.staging.local'), 'A=mode-local\n');
  const env = { SHELL: 'inherited' };
  loadServerEnv({ root, env, mode: 'staging' });
  assert.deepEqual(env, { SHELL: 'inherited', A: 'mode-local', B: 'quoted # value' });
});

test('World config distinguishes absent credentials from malformed private keys and rejects invalid environments', () => {
  assert.equal(finalConfig(credentials).issues.length, 0);
  assert.equal(finalConfig({ ...credentials, WORLD_RP_SIGNING_KEY: ' 0x' + credentials.WORLD_RP_SIGNING_KEY + ' ' }).issues.length, 0);
  assert.deepEqual(finalConfig({}).issues.map(i => i.reason), ['missing', 'missing', 'missing']);
  for (const key of ['0x' + 'ab'.repeat(20), 'not-a-key', '00'.repeat(32), 'ff'.repeat(32)]) {
    const cfg = finalConfig({ ...credentials, WORLD_RP_SIGNING_KEY: key });
    assert.equal(cfg.signingKey, '');
    assert.equal(cfg.issues[0].variable, 'WORLD_RP_SIGNING_KEY');
    assert.equal(cfg.issues[0].reason, 'invalid');
    assert.ok(!JSON.stringify(cfg.issues).includes(key));
  }
  assert.equal(finalConfig({ ...credentials, WORLD_ENVIRONMENT: 'typo' }).issues[0].variable, 'WORLD_ENVIRONMENT');
});

test('configuration and RP signing endpoints never return the signing key; invalid keys fail closed', async t => {
  let active = finalConfig(credentials);
  const store = { db: { humans: {}, sessions: {}, wallets: {} }, save() {} };
  let handler = createFinalBlock({ config: active, store });
  const server = createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configResponse = await (await fetch(base + '/api/world/config')).text();
  assert.equal(JSON.parse(configResponse).configured, true);
  assert.ok(!configResponse.includes(credentials.WORLD_RP_SIGNING_KEY));
  const signed = await fetch(base + '/api/world/rp-context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const context = await signed.text();
  assert.equal(signed.status, 200);
  assert.match(JSON.parse(context).rp_context.signature, /^0x[0-9a-f]{130}$/i);
  assert.ok(!context.includes(credentials.WORLD_RP_SIGNING_KEY));
  active = finalConfig({ ...credentials, WORLD_RP_SIGNING_KEY: '0x' + 'ab'.repeat(20) });
  handler = createFinalBlock({ config: active, store });
  const invalid = await (await fetch(base + '/api/world/config')).json();
  assert.equal(invalid.configured, false);
  assert.equal(invalid.issues[0].reason, 'invalid');
  assert.equal((await fetch(base + '/api/world/rp-context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
});
