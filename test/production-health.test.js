import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/index.js';

test('health checks query PostgreSQL directly without taking the economy lock and fail closed on outage', async t => {
  let unavailable = false, queries = 0;
  const database = { transaction() { assert.fail('Health must not load or lock the economy'); }, pool: { async query(q) {
    queries++; assert.equal(q.text, 'SELECT 1'); assert.equal(q.query_timeout, 2000);
    if (unavailable) throw Object.assign(new Error('private-connection-details'), { code: '08006' });
  } } };
  const server = createServer(createApp({ service: {}, publicConfig: () => ({}), database }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  assert.deepEqual(await (await fetch(url)).json(), { ok: true });
  unavailable = true;
  const failed = await fetch(url); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'unavailable', message: 'Database health check failed.' });
  assert.equal(queries, 2);
});
