import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.js';

test('Vite refuses an unavailable PostgreSQL backend before starting the outbox, with a sanitized destination', async () => {
  process.env.DATABASE_URL = 'postgresql://omen:private-test-password@127.0.0.1:1/omen';
  process.env.NODE_ENV = 'development';
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const plugin = config({ mode: 'development' }).plugins.find(plugin => plugin.name === 'omen-gateway');
    await assert.rejects(plugin.configureServer({ middlewares: { use() { assert.fail('Unready gateway must not mount'); } } }), error => {
      assert.match(error.message, /PostgreSQL backend not ready at 127\.0\.0\.1:1\/omen \(ECONNREFUSED\)/);
      assert.ok(!error.message.includes('private-test-password'));
      return true;
    });
    assert.ok(!errors.some(line => line.includes('outbox delivery deferred')));
  } finally { console.error = original; }
});
