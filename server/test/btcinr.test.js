import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { io as connect } from 'socket.io-client';
import { createDatabase } from '../postgres.js';
import { createWorldIdentity } from '../world-identity.js';
import { createGateway } from '../index.js';
import { createBtcInr } from '../btcinr.js';
import { attachRealtime } from '../realtime.js';
import { createBtcInrRates, ratePaise, satsForPaise } from '../btcinr-rates.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const asPlayer = (token = A) => ({ 'x-omen-token': token });
const asMerchant = (token) => ({ authorization: 'Bearer ' + token });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function harness(t, { quoteTtlMs, requestTtlMs, realtime = false } = {}) {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'b2_' + randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', '-c search_path=' + schema);
  const database = createDatabase(url.href);
  let app, server, rt;
  t.after(async () => {
    if (rt) await new Promise((resolve) => rt.io.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (app) await app.close(); else await database.close();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  });
  await database.migrate();
  const worldIdentity = createWorldIdentity(database, { environment: 'production' }, { secure: false });
  const rate = { inrPerBtc: '1000000.00', source: 'configured-demo', stale: false, fetchedAt: null };
  const rates = { current: async () => {
    if (rate.error) throw Object.assign(new Error('Rate unavailable'), { status: 503, code: 'rate_unavailable' });
    return { ...rate, fetchedAt: rate.fetchedAt ?? Date.now(), pair: 'BTC/INR', maxAgeMs: 120000, settlement: 'SIMULATED' };
  } };
  const service = createBtcInr(database, { worldIdentity, rates, quoteTtlMs, requestTtlMs, secure: false });
  app = createGateway({ database, worldIdentity, btcinr: service, legacyDir: null }); await app.ready;
  server = createServer(app);
  const h = {
    database, service, worldIdentity, rate, schema,
    attach() { if (!rt) rt = attachRealtime(server, { worldIdentity, btcinr: service }); },
    async request(path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(h.base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
    },
    async customer(token = A) {
      const result = await h.request('/api/btcinr/customer', { displayName: 'Payer' }, asPlayer(token));
      assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.customer;
    },
    async merchant(token = B) {
      const result = await h.request('/api/btcinr/merchants', { businessName: 'DEMO Chai', displayName: 'Merchant' }, asPlayer(token));
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return { ...result.data, cookie: result.headers.getSetCookie()[0].split(';')[0] };
    },
    async quote(code, inrPaise = 25000, token = A) {
      const result = await h.request('/api/btcinr/quotes', { requestCode: code, inrPaise }, asPlayer(token));
      assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.quote;
    },
    pay: (quote, key = randomUUID(), token = A) => h.request('/api/btcinr/payments', { quoteId: quote.id }, { ...asPlayer(token), 'Idempotency-Key': key }),
    async socket(auth, headers = {}) {
      h.attach();
      const socket = connect(h.base + '/btcinr', { transports: ['websocket'], forceNew: true, auth, extraHeaders: headers });
      t.after(() => socket.close()); await once(socket, 'connect'); return socket;
    },
    async invariant() {
      assert.equal((await database.pool.query('SELECT journal_id,asset FROM btcinr_entries GROUP BY journal_id,asset HAVING sum(amount)<>0')).rowCount, 0);
      assert.equal((await database.pool.query(`SELECT a.id FROM btcinr_accounts a LEFT JOIN btcinr_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.balance<>COALESCE(sum(e.amount),0)`)).rowCount, 0);
      assert.equal((await database.pool.query("SELECT 1 FROM btcinr_accounts WHERE kind<>'system' AND balance<0")).rowCount, 0);
    },
  };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.base = 'http://127.0.0.1:' + server.address().port;
  if (realtime) h.attach();
  return h;
}

test('exact integer rate conversion, explicit configured pricing, provider timestamps and stale failure paths', async () => {
  assert.equal(ratePaise('5734210.55'), 573421055n);
  const converted = satsForPaise(25000, ratePaise('5734210.55'));
  assert.equal(converted, 4360n);
  assert.ok(converted * ratePaise('5734210.55') >= 25000n * 100_000_000n);
  assert.ok((converted - 1n) * ratePaise('5734210.55') < 25000n * 100_000_000n);
  assert.throws(() => ratePaise('NaN')); assert.throws(() => ratePaise('1.234')); assert.throws(() => ratePaise('0'));
  const fixed = await createBtcInrRates({ demoRate: '5734210.55' }).current();
  assert.equal(fixed.source, 'configured-demo'); assert.equal(fixed.settlement, 'SIMULATED');
  let now = 1_800_000_000_000, calls = 0, broken = false;
  const rates = createBtcInrRates({ now: () => now, demoRate: '', fetchImpl: async (url) => {
    calls++; assert.match(url, /include_last_updated_at=true/);
    if (broken) throw new Error('offline');
    return new Response(JSON.stringify({ bitcoin: { inr: 5734210.55, last_updated_at: now / 1000 } }), { status: 200 });
  } });
  await Promise.all([rates.current(), rates.current()]); assert.equal(calls, 1);
  now += 121000; broken = true;
  assert.equal((await rates.current()).stale, true);
  await assert.rejects(createBtcInrRates({ demoRate: '', fetchImpl: async () => { throw new Error('offline'); } }).current(), { code: 'rate_unavailable' });
});

test('customer funding is exactly once under registration concurrency; balances are balanced and persistent', async (t) => {
  const h = await harness(t);
  const registrations = await Promise.all(Array.from({ length: 6 }, () => h.customer()));
  assert.ok(registrations.every((r) => r.id === registrations[0].id && r.balance.btcSats === '1000000'));
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_journals')).rowCount, 1);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_entries')).rowCount, 2);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_audit')).rowCount, 1);
  await h.invariant();
});

test('two-phone payment commits matching immutable SIMULATED receipts and exact debit/credit once', async (t) => {
  const h = await harness(t); await h.customer(); const merchant = await h.merchant();
  const scanned = await h.request('/api/btcinr/requests/' + merchant.merchant.receiveCode, undefined, asPlayer());
  assert.equal(scanned.data.request.inrPaise, null);
  const q = await h.quote(merchant.merchant.receiveCode);
  assert.equal(q.btcSats, '25000');
  const paid = await h.pay(q);
  assert.equal(paid.status, 201, JSON.stringify(paid.data)); assert.equal(paid.data.payment.status, 'confirmed');
  assert.equal(paid.data.payment.settlement, 'SIMULATED'); assert.match(paid.data.payment.label, /SIMULATED/);
  assert.ok(!/txHash|bank|utr|blockchain/i.test(JSON.stringify(paid.data)));
  const payer = await h.request('/api/btcinr/customer', undefined, asPlayer());
  const receiver = await h.request('/api/btcinr/merchant', undefined, asMerchant(merchant.session.token));
  assert.equal(payer.data.customer.balance.btcSats, '975000'); assert.equal(receiver.data.merchant.balance.inrPaise, 25000);
  const receiptA = await h.request('/api/btcinr/payments/' + paid.data.payment.id, undefined, asPlayer());
  const receiptB = await h.request('/api/btcinr/payments/' + paid.data.payment.id, undefined, { ...asMerchant(merchant.session.token), ...asPlayer(B) });
  assert.deepEqual(receiptA.data.payment, receiptB.data.payment); assert.deepEqual(receiptA.data.payment, paid.data.payment);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_entries WHERE journal_id=(SELECT journal_id FROM btcinr_payments LIMIT 1)')).rowCount, 4);
  await h.invariant();
});

test('duplicate concurrent retries return one payment; different keys and different quote bodies cannot double debit', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  const q = await h.quote(m.merchant.receiveCode), key = randomUUID();
  const retries = await Promise.all(Array.from({ length: 8 }, () => h.pay(q, key)));
  assert.equal(retries.filter((r) => r.status === 201).length, 1);
  assert.ok(retries.every((r) => [200,201].includes(r.status) && r.data.payment.id === retries[0].data.payment.id));
  assert.equal((await h.pay(q)).data.error, 'quote_used');
  const another = await h.quote(m.merchant.receiveCode);
  assert.equal((await h.pay(another, key)).status, 422);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 1);
  assert.equal((await h.request('/api/btcinr/customer', undefined, asPlayer())).data.customer.balance.btcSats, '975000');
  await h.invariant();
});

test('competing payments cannot overdraw; failed insufficient-funds attempts create no partial credit', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  const quotes = await Promise.all([h.quote(m.merchant.receiveCode, 600000), h.quote(m.merchant.receiveCode, 600000)]);
  const results = await Promise.all(quotes.map((q) => h.pay(q)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201,402]);
  assert.equal((await h.request('/api/btcinr/customer', undefined, asPlayer())).data.customer.balance.btcSats, '400000');
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(m.session.token))).data.merchant.balance.inrPaise, 600000);
  const failed = results.find((r) => r.status === 402); assert.equal(failed.data.error, 'insufficient_funds');
  assert.equal((await h.database.pool.query("SELECT * FROM btcinr_audit WHERE action='payment_rejected'")).rowCount, 1);
  await h.invariant();
});

test('independent pools serialize concurrent payments to one merchant without lost credits', async (t) => {
  const h = await harness(t); await h.customer(); await h.customer(C); const m = await h.merchant();
  const secondDb = createDatabase(h.database.pool.options.connectionString);
  const second = createBtcInr(secondDb, { worldIdentity: h.worldIdentity });
  try {
    const q1 = await h.quote(m.merchant.receiveCode, 70000), q2 = await h.quote(m.merchant.receiveCode, 80000, C);
    const results = await Promise.all([h.pay(q1), second.pay({ headers: { ...asPlayer(C), 'idempotency-key': randomUUID() } }, { quoteId: q2.id })]);
    assert.equal(results[0].status, 201); assert.equal(results[1].payment.status, 'confirmed');
    assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(m.session.token))).data.merchant.balance.inrPaise, 150000);
    await h.invariant();
  } finally { await secondDb.close(); }
});

test('fixed QR amounts are authoritative, expiring and single-use even across two different payers', async (t) => {
  const h = await harness(t); await h.customer(); await h.customer(C); const m = await h.merchant();
  const request = await h.request('/api/btcinr/merchant/requests', { inrPaise: 60000, reference: 'Table 4' }, asMerchant(m.session.token));
  assert.equal(request.status, 201);
  assert.equal((await h.request('/api/btcinr/quotes', { requestCode: request.data.request.code, inrPaise: 59999 }, asPlayer())).data.error, 'bad_amount');
  const q1 = await h.quote(request.data.request.code, 60000), q2 = await h.quote(request.data.request.code, 60000, C);
  const results = await Promise.all([h.pay(q1), h.pay(q2, randomUUID(), C)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201,409]);
  assert.equal(results.find((r) => r.status === 409).data.error, 'request_paid');
  await h.invariant();
});

test('expired quotes/requests and stale or unavailable reference rates cannot move funds; committed retries still work', async (t) => {
  const h = await harness(t, { quoteTtlMs: 250, requestTtlMs: 250 }); await h.customer(); const m = await h.merchant();
  const q = await h.quote(m.merchant.receiveCode); await delay(300);
  assert.equal((await h.pay(q)).data.error, 'quote_expired');
  const fixed = await h.request('/api/btcinr/merchant/requests', { inrPaise: 100 }, asMerchant(m.session.token)); await delay(300);
  assert.equal((await h.request('/api/btcinr/requests/' + fixed.data.request.code, undefined, asPlayer())).status, 410);
  h.rate.stale = true;
  assert.equal((await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise: 100 }, asPlayer())).data.error, 'rate_stale');
  h.rate.stale = false; h.rate.error = true;
  assert.equal((await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise: 100 }, asPlayer())).status, 503);
  h.rate.error = false; const fresh = await h.quote(m.merchant.receiveCode, 100), key = randomUUID(); const paid = await h.pay(fresh, key);
  assert.equal(paid.status, 201); await delay(300);
  const retry = await h.pay(fresh, key); assert.equal(retry.status, 200); assert.equal(retry.data.payment.id, paid.data.payment.id);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 1);
});

test('rate snapshots are immutable; a quote settles its original rate even after reference prices change', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  h.rate.inrPerBtc = '5734210.55';
  const q = await h.quote(m.merchant.receiveCode, 25000); assert.equal(q.btcSats, '4360');
  h.rate.inrPerBtc = '2000000.00';
  const paid = await h.pay(q); assert.equal(paid.status, 201);
  assert.equal(paid.data.payment.inrPerBtc, '5734210.55'); assert.equal(paid.data.payment.btcSats, '4360');
  await assert.rejects(h.database.pool.query('UPDATE btcinr_rates SET paise_per_btc=1'), /immutable_demo_record/);
});

test('injected failure after debit rolls back balances, postings, receipt and outbox; the same key can retry safely', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant(); const q = await h.quote(m.merchant.receiveCode), key = randomUUID();
  const before = (await h.database.pool.query('SELECT count(*) AS n FROM btcinr_outbox')).rows[0].n;
  await h.database.pool.query(`CREATE FUNCTION reject_demo_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.asset='DEMO_INR' THEN RAISE EXCEPTION 'injected_credit_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_credit BEFORE INSERT ON btcinr_entries FOR EACH ROW EXECUTE FUNCTION reject_demo_credit()`);
  assert.equal((await h.pay(q, key)).status, 500);
  assert.equal((await h.request('/api/btcinr/customer', undefined, asPlayer())).data.customer.balance.btcSats, '1000000');
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(m.session.token))).data.merchant.balance.inrPaise, 0);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 0);
  assert.equal((await h.database.pool.query('SELECT count(*) AS n FROM btcinr_outbox')).rows[0].n, before);
  await h.database.pool.query('DROP TRIGGER reject_credit ON btcinr_entries');
  assert.equal((await h.pay(q, key)).status, 201); await h.invariant();
});

test('append-only journals/audit/receipts and deferred balance constraints reject SQL tampering', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant(); await h.pay(await h.quote(m.merchant.receiveCode));
  for (const table of ['btcinr_entries','btcinr_journals','btcinr_payments','btcinr_audit'])
    await assert.rejects(h.database.pool.query('DELETE FROM ' + table), /immutable_demo_record/);
  await assert.rejects(h.database.pool.query("UPDATE btcinr_accounts SET balance=balance+1 WHERE kind='customer'"), /ledger_balance_mismatch/);
  const c = await h.database.pool.connect();
  try {
    await c.query('BEGIN');
    const journal = randomUUID();
    await c.query("INSERT INTO btcinr_journals(id,kind,reference) VALUES($1,'funding','forged-funding')", [journal]);
    await c.query("INSERT INTO btcinr_entries(journal_id,account_id,asset,amount) VALUES($1,'system_btc_issuance','DEMO_BTC',-10)", [journal]);
    await assert.rejects(c.query('COMMIT'), /unbalanced_demo_journal|invalid_demo_funding/);
  } finally { await c.query('ROLLBACK'); c.release(); }
  await h.invariant();
});

test('authorization separates roles, payer ownership, merchant ownership, self-payments and cross-origin operations', async (t) => {
  const h = await harness(t); await h.customer(); await h.customer(C); const m = await h.merchant();
  assert.equal((await h.request('/api/btcinr/customer')).status, 401);
  assert.equal((await h.request('/api/btcinr/customer', undefined, asMerchant(m.session.token))).status, 401);
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asPlayer())).status, 401);
  await h.customer(B);
  assert.equal((await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise: 100 }, asPlayer(B))).data.error, 'self_payment');
  const q = await h.quote(m.merchant.receiveCode);
  assert.equal((await h.pay(q, randomUUID(), C)).status, 404);
  assert.equal((await h.request('/api/btcinr/payments', { quoteId: q.id, btcSats: '1' }, { ...asPlayer(), 'Idempotency-Key': randomUUID() })).status, 400);
  assert.equal((await h.request('/api/btcinr/payments', { quoteId: q.id }, asPlayer())).status, 400);
  const paid = await h.pay(q);
  assert.equal((await h.request('/api/btcinr/payments/' + paid.data.payment.id, undefined, asPlayer(C))).status, 404);
  assert.equal((await h.request('/api/btcinr/payments?role=merchant', undefined, asPlayer())).status, 401);
  assert.equal((await h.request('/api/btcinr/merchant/session', { merchantId: m.merchant.id, accessCode: m.accessCode }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await h.request('/api/btcinr/merchant/session', undefined, { ...asMerchant(m.session.token), origin: 'https://attacker.example' }, 'DELETE')).status, 403);
  for (const inrPaise of [0,-1,1.5,'100',1000001,Number.MAX_SAFE_INTEGER])
    assert.equal((await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise }, asPlayer())).status, 400);
  assert.equal((await h.request('/api/payments/' + paid.data.payment.id)).status, 404);
  await h.invariant();
});

test('merchant recovery/login stores hashes, rotates credentials, expires sessions and throttles guesses', async (t) => {
  const h = await harness(t); const m = await h.merchant();
  assert.equal((await h.request('/api/btcinr/merchant', undefined, { cookie: m.cookie })).status, 200);
  const stored = (await h.database.pool.query('SELECT access_hash FROM btcinr_merchants')).rows[0];
  assert.equal(stored.access_hash, digest(m.accessCode));
  const login = await h.request('/api/btcinr/merchant/session', { merchantId: m.merchant.id, accessCode: m.accessCode }); assert.equal(login.status, 200);
  assert.equal(login.data.accessCode, undefined);
  assert.equal((await h.request('/api/btcinr/merchant/session', undefined, asMerchant(login.data.session.token), 'DELETE')).status, 204);
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(login.data.session.token))).status, 401);
  const recovered = await h.request('/api/btcinr/merchant/recover', {}, asPlayer(B)); assert.equal(recovered.status, 200);
  assert.equal(recovered.data.merchant.id, m.merchant.id); assert.notEqual(recovered.data.accessCode, m.accessCode);
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(m.session.token))).status, 401);
  assert.equal((await h.request('/api/btcinr/merchant/recover', {}, asPlayer(C))).status, 404);
  for (let i=0;i<5;i++) assert.equal((await h.request('/api/btcinr/merchant/session', { merchantId: m.merchant.id, accessCode: m.accessCode })).status, 401);
  assert.equal((await h.request('/api/btcinr/merchant/session', { merchantId: m.merchant.id, accessCode: recovered.data.accessCode })).status, 429);
});

test('both phones receive the same post-commit transaction, private balances, and revoked merchant sockets are disconnected', async (t) => {
  const h = await harness(t, { realtime: true }); await h.customer(); await h.customer(C); const m = await h.merchant();
  const a = await h.socket({ customerToken: A }), b = await h.socket({ merchantSession: m.session.token }), outsider = await h.socket({ customerToken: C });
  let leaked = 0; outsider.on('btcinr:payment', () => leaked++);
  const noticeA = once(a, 'btcinr:payment'), noticeB = once(b, 'btcinr:payment');
  const balanceA = once(a, 'btcinr:balance'), balanceB = once(b, 'btcinr:balance');
  const paid = await h.pay(await h.quote(m.merchant.receiveCode));
  assert.deepEqual((await noticeA)[0].payment, paid.data.payment);
  assert.deepEqual((await noticeB)[0].payment, paid.data.payment);
  assert.deepEqual((await balanceA)[0], { settlement: 'SIMULATED', label: paid.data.label, role: 'customer', balance: { btcSats: '975000' }, version: 2 });
  assert.deepEqual((await balanceB)[0], { settlement: 'SIMULATED', label: paid.data.label, role: 'merchant', balance: { inrPaise: 25000 }, version: 1 });
  await delay(75); assert.equal(leaked, 0);
  const expired = once(b, 'btcinr:session-expired');
  await h.request('/api/btcinr/merchant/session', undefined, asMerchant(m.session.token), 'DELETE');
  assert.equal((await expired)[0].error, 'session_expired');
  const invalid = connect(h.base + '/btcinr', { transports: ['websocket'], forceNew: true, auth: { merchantSession: m.session.token } });
  t.after(() => invalid.close()); assert.equal((await once(invalid, 'connect_error'))[0].message, 'unauthorized');
});

test('disconnected phones, lost responses and database reconnect recover persistent receipts without duplicate debits', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant(); const q = await h.quote(m.merchant.receiveCode), key = randomUUID();
  const first = await h.pay(q, key); assert.equal(first.status, 201); // caller discards this response, simulating a lost response
  const reopened = createDatabase(h.database.pool.options.connectionString);
  try {
    const restarted = createBtcInr(reopened, { worldIdentity: h.worldIdentity });
    const retry = await restarted.pay({ headers: { ...asPlayer(), 'idempotency-key': key } }, { quoteId: q.id });
    assert.equal(retry.replayed, true); assert.equal(retry.payment.id, first.data.payment.id);
    assert.equal((await restarted.getCustomer({ headers: asPlayer() })).customer.balance.btcSats, '975000');
    assert.equal((await restarted.getMerchant({ headers: asMerchant(m.session.token) })).merchant.balance.inrPaise, 25000);
  } finally { await reopened.close(); }
  h.attach(); const reconnected = await h.socket({ merchantSession: m.session.token });
  const history = await h.request('/api/btcinr/payments?role=merchant', undefined, asMerchant(m.session.token));
  assert.deepEqual(history.data.payments[0], first.data.payment); assert.ok(reconnected.connected);
  await h.invariant();
});

test('outbox retry is durable and cannot re-execute settlement; history pagination is scoped and stable', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  const receipts = [];
  for (let i=0;i<3;i++) receipts.push((await h.pay(await h.quote(m.merchant.receiveCode, 100 + i))).data.payment);
  await assert.rejects(h.service.drainOutbox(async () => { throw new Error('temporary transport failure'); }), /transport failure/);
  assert.ok((await h.database.pool.query('SELECT * FROM btcinr_outbox WHERE published_at IS NULL')).rowCount > 0);
  const delivered = []; await h.service.drainOutbox(async (row) => delivered.push(row));
  assert.equal(delivered.filter((r) => r.event === 'btcinr:payment').length, 3);
  assert.equal(await h.service.drainOutbox(async () => assert.fail('already published')), 0);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 3);
  const page = await h.request('/api/btcinr/payments?role=customer&limit=2', undefined, asPlayer());
  assert.equal(page.data.payments.length, 2); assert.ok(page.data.nextCursor);
  const next = await h.request('/api/btcinr/payments?role=customer&limit=2&before=' + page.data.nextCursor, undefined, asPlayer());
  assert.equal(next.data.payments.length, 1); assert.equal(next.data.nextCursor, null);
  assert.equal(new Set([...page.data.payments, ...next.data.payments].map((p) => p.id)).size, 3);
  await h.invariant();
});

test('World ID payer sessions take precedence over guests and revoked sessions cannot pay', async (t) => {
  const h = await harness(t); const accountId = randomUUID(), avatarId = randomBytes(12).toString('hex'), token = randomBytes(32).toString('hex');
  // Test-only session fixture. Actual World ID proof/signature verification is covered in world-id.test.js.
  await h.database.pool.query("INSERT INTO player_accounts(id,avatar_id,world_issuer,world_subject) VALUES($1,$2,'https://auth.world.org','b2-test-only')", [accountId, avatarId]);
  await h.database.pool.query("INSERT INTO player_sessions(token_hash,account_id,auth_time,assurance,methods,expires_at) VALUES($1,$2,clock_timestamp(),'https://world.org/oidc/acr/orb','[\"pop\"]',clock_timestamp()+interval '1 hour')", [digest(token), accountId]);
  const credentials = { cookie: 'omen_player=' + token, ...asPlayer() };
  assert.equal((await h.request('/api/btcinr/customer', { displayName: 'Verified Payer' }, credentials)).status, 200);
  const m = await h.merchant();
  const q = await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise: 100 }, credentials); assert.equal(q.status, 201);
  await h.database.pool.query('UPDATE player_sessions SET revoked_at=clock_timestamp()');
  assert.equal((await h.request('/api/btcinr/payments', { quoteId: q.data.quote.id }, { ...credentials, 'Idempotency-Key': randomUUID() })).status, 401);
  assert.equal((await h.request('/api/btcinr/customer', undefined, asPlayer())).status, 404);
  await h.invariant();
});

test('a deferred commit failure publishes no payment or balance notification and the same key can retry', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  await h.service.drainOutbox(async () => {});
  const a = await h.socket({ customerToken: A }), b = await h.socket({ merchantSession: m.session.token });
  const received = [];
  for (const socket of [a, b]) {
    socket.on('btcinr:payment', (data) => received.push(data));
    socket.on('btcinr:balance', (data) => received.push(data));
  }
  await h.database.pool.query(`CREATE FUNCTION reject_demo_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_commit_failure'; END $$;
    CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON btcinr_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_demo_commit()`);
  const q = await h.quote(m.merchant.receiveCode), key = randomUUID();
  assert.equal((await h.pay(q, key)).status, 500);
  await delay(75); assert.equal(received.length, 0);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 0);
  assert.equal((await h.database.pool.query("SELECT * FROM btcinr_journals WHERE kind='payment'")).rowCount, 0);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_outbox WHERE published_at IS NULL')).rowCount, 0);
  assert.equal((await h.service.getCustomer({ headers: asPlayer() })).customer.balance.btcSats, '1000000');
  assert.equal((await h.service.getMerchant({ headers: asMerchant(m.session.token) })).merchant.balance.inrPaise, 0);
  await h.database.pool.query('DROP TRIGGER reject_commit ON btcinr_payments');
  const committedA = once(a, 'btcinr:payment'), committedB = once(b, 'btcinr:payment');
  const retry = await h.pay(q, key); assert.equal(retry.status, 201);
  assert.deepEqual((await committedA)[0].payment, retry.data.payment);
  assert.deepEqual((await committedB)[0].payment, retry.data.payment);
  await h.invariant();
});

test('socket credentials and origins cannot subscribe to another account or mutate the ledger', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  h.attach();
  for (const [auth, extraHeaders] of [
    [{ customerToken: 'invalid' }, {}],
    [{ customerToken: A, merchantSession: 'invalid' }, {}],
    [{ customerToken: 'd'.repeat(64) }, {}],
    [{ merchantSession: m.session.token }, { Origin: 'https://attacker.example' }],
    [{ customerToken: A }, { Origin: 'null' }],
  ]) {
    const socket = connect(h.base + '/btcinr', { transports: ['websocket'], forceNew: true, reconnection: false, auth, extraHeaders });
    t.after(() => socket.close());
    assert.equal((await once(socket, 'connect_error'))[0].message, 'unauthorized');
  }
  const socket = await h.socket({ customerToken: A }, { Origin: h.base });
  socket.emit('join', { merchantId: m.merchant.id });
  socket.emit('btcinr:payment', { status: 'confirmed', inrPaise: 1000000 });
  socket.emit('btcinr:balance', { balance: { btcSats: '99999999999999999' } });
  await delay(75);
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 0);
  assert.equal((await h.service.getCustomer({ headers: asPlayer() })).customer.balance.btcSats, '1000000');
  assert.equal((await h.service.getMerchant({ headers: asMerchant(m.session.token) })).merchant.balance.inrPaise, 0);
  await h.database.pool.query('UPDATE btcinr_merchant_sessions SET expires_at=clock_timestamp()');
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(m.session.token))).status, 401);
  await h.invariant();
});

test('World ID customer pays with the same receipt on both authenticated phones and logout revokes its socket', async (t) => {
  const h = await harness(t), accountId = randomUUID(), avatarId = randomBytes(12).toString('hex'), token = randomBytes(32).toString('hex');
  await h.database.pool.query("INSERT INTO player_accounts(id,avatar_id,world_issuer,world_subject) VALUES($1,$2,'https://auth.world.org','b2-world-phone')", [accountId, avatarId]);
  await h.database.pool.query("INSERT INTO player_sessions(token_hash,account_id,auth_time,assurance,methods,expires_at) VALUES($1,$2,clock_timestamp(),'https://world.org/oidc/acr/orb','[\"pop\"]',clock_timestamp()+interval '1 hour')", [digest(token), accountId]);
  const headers = { cookie: 'omen_player=' + token };
  assert.equal((await h.request('/api/btcinr/customer', { displayName: 'World Payer' }, headers)).status, 200);
  const m = await h.merchant(); await h.service.drainOutbox(async () => {});
  const a = await h.socket({ role: 'customer' }, headers), b = await h.socket({ merchantSession: m.session.token });
  const qa = await h.request('/api/btcinr/quotes', { requestCode: m.merchant.receiveCode, inrPaise: 10000 }, headers);
  assert.equal(qa.status, 201);
  const noticeA = once(a, 'btcinr:payment'), noticeB = once(b, 'btcinr:payment');
  const paid = await h.request('/api/btcinr/payments', { quoteId: qa.data.quote.id }, { ...headers, 'Idempotency-Key': randomUUID() });
  assert.equal(paid.status, 201);
  assert.deepEqual((await noticeA)[0].payment, paid.data.payment);
  assert.deepEqual((await noticeB)[0].payment, paid.data.payment);
  assert.equal((await h.request('/api/btcinr/customer', undefined, headers)).data.customer.balance.btcSats, '990000');
  const receiptB = await h.request('/api/btcinr/payments/' + paid.data.payment.id, undefined, asMerchant(m.session.token));
  assert.deepEqual(receiptB.data.payment, paid.data.payment);
  const expired = once(a, 'btcinr:session-expired');
  assert.equal((await h.request('/api/auth/logout', {}, headers)).status, 200);
  assert.equal((await expired)[0].error, 'session_expired');
  assert.equal((await h.request('/api/btcinr/customer', undefined, headers)).status, 401);
  await h.invariant();
});

test('invalid history cursors fail as client errors; large satoshi quotes remain exact decimal strings', async (t) => {
  const h = await harness(t); await h.customer(); const m = await h.merchant();
  for (const value of ['not-json', Buffer.from(JSON.stringify({ id: 'pay_' + 'a'.repeat(32), at: Number.MAX_SAFE_INTEGER })).toString('base64url')]) {
    const response = await h.request('/api/btcinr/payments?role=customer&before=' + value, undefined, asPlayer());
    assert.equal(response.status, 400); assert.equal(response.data.error, 'bad_pagination');
  }
  h.rate.inrPerBtc = '0.01';
  const q = await h.quote(m.merchant.receiveCode, 1000000);
  assert.equal(q.btcSats, '100000000000000');
  assert.equal((await h.pay(q)).data.error, 'insufficient_funds');
  assert.equal((await h.database.pool.query('SELECT * FROM btcinr_payments')).rowCount, 0);
  await h.invariant();
});

test('merchant recovery racing an in-flight login revokes the session issued with the old access code', async (t) => {
  const h = await harness(t), m = await h.merchant(), gateKey = 1330464080;
  await h.database.pool.query(`CREATE FUNCTION gate_demo_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateKey}); RETURN NEW; END $$;
    CREATE TRIGGER gate_session BEFORE INSERT ON btcinr_merchant_sessions FOR EACH ROW EXECUTE FUNCTION gate_demo_session()`);
  const gate = await h.database.pool.connect();
  await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
  const login = h.service.loginMerchant({ headers: {}, omenClientIp: 'test-login-race' }, { merchantId: m.merchant.id, accessCode: m.accessCode });
  const waitFor = async (sql, count) => {
    const deadline = Date.now() + 5000;
    while (Number((await h.database.pool.query(sql)).rows[0].n) < count) {
      assert.ok(Date.now() < deadline, 'Expected transaction to reach the database lock'); await delay(10);
    }
  };
  let recovery;
  try {
    await waitFor(`SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND objid=${gateKey} AND NOT granted`, 1);
    recovery = h.service.recoverMerchant({ headers: asPlayer(B) });
    await waitFor(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock'
      AND pid IN (SELECT pid FROM pg_locks WHERE relation='btcinr_merchants'::regclass)
      AND (query LIKE 'SELECT m.%m.owner_player_id%' OR query LIKE 'INSERT INTO btcinr_merchant_sessions%')`, 2);
  } finally { await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]); gate.release(); }
  const [signed, recovered] = await Promise.all([login, recovery]);
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(signed.session.token))).status, 401);
  assert.equal((await h.request('/api/btcinr/merchant', undefined, asMerchant(recovered.session.token))).status, 200);
  assert.equal((await h.request('/api/btcinr/merchant/session', { merchantId: m.merchant.id, accessCode: m.accessCode })).status, 401);
});
