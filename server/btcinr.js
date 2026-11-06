import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ApiError } from './payments.js';
import { playerFromRequest } from './identity.js';
import { moderateText } from './moderation.js';
import { createBtcInrRates, ratePaise, rateText, satsForPaise, simulated, RATE_MAX_AGE_MS, QUOTE_TTL_MS } from './btcinr-rates.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = (prefix) => prefix + '_' + randomUUID().replaceAll('-', '');
const ms = (date) => date ? new Date(date).getTime() : null;
const MAX_PAISE = 1_000_000;
const KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (status, code, message) => new ApiError(status, code, message);
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, 'bad_request', 'Unexpected request fields.');
}
function text(raw, max, min = 2) {
  if (typeof raw !== 'string' || raw.trim().length > max) throw fail(400, 'bad_name', `Use ${min}–${max} characters.`);
  const checked = moderateText(raw, { min, max, links: 0 });
  if (!checked.ok) throw fail(400, 'bad_name', checked.reason);
  return checked.text;
}
function amount(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAISE) throw fail(400, 'bad_amount', 'DEMO payments must be ₹0.01–₹10,000, expressed as integer paise.');
  return value;
}

export function createBtcInr(database, { worldIdentity, rates = createBtcInrRates(), quoteTtlMs = QUOTE_TTL_MS, requestTtlMs = 15 * 60_000, secure = process.env.NODE_ENV === 'production' } = {}) {
  if (!(quoteTtlMs > 0 && quoteTtlMs <= QUOTE_TTL_MS) || !(requestTtlMs > 0)) throw new Error('Invalid DEMO quote/request lifetime');
  const events = new EventEmitter();
  const cookieName = secure ? '__Host-omen_btcinr_merchant' : 'omen_btcinr_merchant';
  const cookie = (value, age = 28800) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const credential = (req) => {
    if (req.headers.authorization) return /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization)?.[1] || 'invalid';
    const found = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(cookieName + '='));
    return found.length === 1 ? found[0].slice(cookieName.length + 1) : found.length ? 'invalid' : '';
  };
  async function transaction(fn, notify = false) {
    const client = await database.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='10s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      result = await fn(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    if (notify) events.emit('outbox');
    return result;
  }
  const audit = (c, actorType, actorId, action, target, details = {}) => c.query('INSERT INTO btcinr_audit(actor_type,actor_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)', [actorType, actorId, action, target, JSON.stringify(details)]);
  const post = (c, journal, account, asset, value) => c.query('INSERT INTO btcinr_entries(journal_id,account_id,asset,amount) VALUES($1,$2,$3,$4)', [journal, account, asset, String(value)]);
  const enqueue = (c, event, payload, customerId = null, merchantId = null) => c.query('INSERT INTO btcinr_outbox(event,customer_id,merchant_id,payload) VALUES($1,$2,$3,$4)', [event, customerId, merchantId, JSON.stringify(payload)]);
  const customerView = (row) => ({ ...simulated, id: row.id, displayName: row.display_name, balance: { btcSats: row.balance }, version: Number(row.version), createdAt: ms(row.created_at) });
  const merchantView = (row) => ({ ...simulated, id: row.id, businessName: row.business_name, displayName: row.display_name, balance: { inrPaise: Number(row.balance) }, version: Number(row.version), receiveCode: row.receive_code, createdAt: ms(row.created_at) });
  const requestView = (row) => ({ ...simulated, code: row.code, merchant: { id: row.merchant_id, businessName: row.business_name }, inrPaise: row.inr_paise === null ? null : Number(row.inr_paise), reference: row.reference, expiresAt: ms(row.expires_at) });
  async function actor(req) {
    const player = worldIdentity ? await worldIdentity.resolveRequest(req) : { avatarId: playerFromRequest(req) };
    if (!player?.avatarId) throw fail(401, 'no_identity', 'Authenticate as an OMEN player first.');
    return player;
  }
  async function checkActor(c, player) {
    if (!player.sessionHash) return;
    const active = await c.query(`SELECT 1 FROM player_sessions s JOIN player_accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND a.id=$2 AND a.avatar_id=$3 AND NOT a.disabled AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() FOR SHARE OF s,a`, [player.sessionHash, player.accountId, player.avatarId]);
    if (!active.rowCount) throw fail(401, 'session_expired', 'Sign in again with World ID.');
  }
  async function customer(c, player, lock = false) {
    await checkActor(c, player);
    const { rows: [row] } = await c.query(`SELECT c.*,a.balance,a.version FROM btcinr_customers c JOIN btcinr_accounts a ON a.id=c.account_id WHERE c.player_id=$1${lock ? ' FOR UPDATE OF c' : ''}`, [player.avatarId]);
    if (!row) throw fail(404, 'no_account', 'Create your DEMO BTC account first.');
    return row;
  }
  const merchantSql = `SELECT m.*,a.balance,a.version FROM btcinr_merchants m JOIN btcinr_accounts a ON a.id=m.account_id`;
  const activeMerchantSql = `SELECT m.*,a.balance,a.version,s.token_hash,s.expires_at FROM btcinr_merchant_sessions s
    JOIN btcinr_merchants m ON m.id=s.merchant_id JOIN btcinr_accounts a ON a.id=m.account_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND NOT m.disabled
    AND NOT EXISTS(SELECT 1 FROM player_accounts p WHERE p.avatar_id=m.owner_player_id AND p.disabled)`;
  async function merchant(c, req, lock = false) {
    const token = credential(req);
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail(401, 'unauthorized', 'A separate merchant session is required.');
    const { rows: [row] } = await c.query(activeMerchantSql + (lock ? ' FOR SHARE OF s,m' : ''), [hash(token)]);
    if (!row) throw fail(401, 'session_expired', 'Sign in to the merchant account again.');
    return row;
  }
  async function request(c, code, lock = false) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(code))) throw fail(404, 'request_not_found', 'No such DEMO payment request.');
    const { rows: [row] } = await c.query(`SELECT r.*,m.business_name,m.owner_player_id,m.account_id FROM btcinr_requests r
      JOIN btcinr_merchants m ON m.id=r.merchant_id WHERE r.code=$1 AND NOT m.disabled
      AND NOT EXISTS(SELECT 1 FROM player_accounts p WHERE p.avatar_id=m.owner_player_id AND p.disabled)${lock ? ' FOR UPDATE OF r' : ''}`, [code]);
    if (!row) throw fail(404, 'request_not_found', 'No such DEMO payment request.');
    if (row.expires_at && ms(row.expires_at) <= Date.now()) throw fail(410, 'request_expired', 'This DEMO receiving request has expired.');
    if (row.inr_paise !== null && (await c.query('SELECT 1 FROM btcinr_payments WHERE single_use_request_code=$1', [code])).rowCount)
      throw fail(409, 'request_paid', 'This fixed DEMO request has already been paid.');
    return row;
  }
  async function issueMerchantSession(c, row, accessCode = undefined) {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 28_800_000);
    await c.query('INSERT INTO btcinr_merchant_sessions(token_hash,merchant_id,expires_at) VALUES($1,$2,$3)', [hash(token), row.id, expires]);
    return { ...simulated, merchant: merchantView(row), session: { token, expiresAt: expires.getTime() }, ...(accessCode ? { accessCode } : {}), __cookie: cookie(token) };
  }
  const accessCode = () => randomBytes(20).toString('hex').toUpperCase().match(/.{1,5}/g).join('-');
  const api = {
    events, worldIdentity,
    rate: () => rates.current(),
    async getCustomer(req) { const player = await actor(req); return transaction(async (c) => ({ ...simulated, customer: customerView(await customer(c, player)) })); },
    async registerCustomer(req, body) {
      fields(body, ['displayName']); const name = text(body.displayName, 24); const player = await actor(req);
      return transaction(async (c) => {
        await checkActor(c, player);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['btcinr-owner:' + player.avatarId]);
        let row = (await c.query('SELECT * FROM btcinr_customers WHERE player_id=$1', [player.avatarId])).rows[0];
        if (!row) {
          const customerId = id('cus'), accountId = id('acct');
          await c.query("INSERT INTO btcinr_accounts(id,asset,kind) VALUES($1,'DEMO_BTC','customer')", [accountId]);
          row = (await c.query('INSERT INTO btcinr_customers(id,player_id,display_name,account_id) VALUES($1,$2,$3,$4) RETURNING *', [customerId, player.avatarId, name, accountId])).rows[0];
          const journal = randomUUID();
          await c.query("INSERT INTO btcinr_journals(id,kind,reference) VALUES($1,'funding',$2)", [journal, 'fund:' + customerId]);
          await post(c, journal, 'system_btc_issuance', 'DEMO_BTC', -1_000_000n);
          await post(c, journal, accountId, 'DEMO_BTC', 1_000_000n);
          await audit(c, 'customer', customerId, 'demo_funded', customerId, { btcSats: '1000000', journalId: journal });
        } else await c.query('UPDATE btcinr_customers SET display_name=$2 WHERE id=$1', [row.id, name]);
        const result = customerView(await customer(c, player));
        await enqueue(c, 'btcinr:balance', { ...simulated, role: 'customer', balance: result.balance, version: result.version }, row.id);
        return { ...simulated, customer: result };
      }, true);
    },
    async registerMerchant(req, body) {
      fields(body, ['businessName', 'displayName']); const business = text(body.businessName, 48), name = text(body.displayName, 24);
      const player = await actor(req), code = accessCode();
      return transaction(async (c) => {
        await checkActor(c, player);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['btcinr-owner:' + player.avatarId]);
        if ((await c.query('SELECT 1 FROM btcinr_merchants WHERE owner_player_id=$1', [player.avatarId])).rowCount) throw fail(409, 'merchant_exists', 'This player already owns a merchant. Sign in or use merchant recovery.');
        const merchantId = id('mer'), accountId = id('acct'), receive = id('rq_static');
        await c.query("INSERT INTO btcinr_accounts(id,asset,kind) VALUES($1,'DEMO_INR','merchant')", [accountId]);
        await c.query('INSERT INTO btcinr_merchants(id,owner_player_id,business_name,display_name,account_id,access_hash,receive_code) VALUES($1,$2,$3,$4,$5,$6,$7)', [merchantId, player.avatarId, business, name, accountId, hash(code), receive]);
        await c.query('INSERT INTO btcinr_requests(code,merchant_id) VALUES($1,$2)', [receive, merchantId]);
        const row = (await c.query(merchantSql + ' WHERE m.id=$1', [merchantId])).rows[0];
        await audit(c, 'merchant', merchantId, 'merchant_created', merchantId);
        return { ...await issueMerchantSession(c, row, code), __status: 201 };
      });
    },
    async loginMerchant(req, body) {
      fields(body, ['merchantId', 'accessCode']);
      if (typeof body.merchantId !== 'string' || body.merchantId.length > 80 || typeof body.accessCode !== 'string' || body.accessCode.length > 100) throw fail(401, 'bad_credentials', 'Invalid merchant credentials.');
      const keys = [hash('btcinr-ip:' + (req.omenClientIp || req.socket?.remoteAddress || '?')), hash('btcinr-merchant:' + body.merchantId)];
      return transaction(async (c) => {
        // One lock orders the shared IP and merchant-attempt counters without deadlocks.
        await c.query('SELECT pg_advisory_xact_lock(1330464079)');
        await c.query("DELETE FROM btcinr_login_attempts WHERE started_at<clock_timestamp()-interval '15 minutes'");
        const limits = await c.query('SELECT failures FROM btcinr_login_attempts WHERE key=ANY($1::text[])', [keys]);
        if (limits.rows.some((v) => v.failures >= 5)) return { __error: { status: 429, error: 'login_limited', message: 'Too many merchant login attempts. Try again in 15 minutes.' } };
        // Keep the credential check and session issuance ordered with access-code recovery.
        const row = (await c.query(merchantSql + ' WHERE m.id=$1 AND NOT m.disabled AND NOT EXISTS(SELECT 1 FROM player_accounts p WHERE p.avatar_id=m.owner_player_id AND p.disabled) FOR SHARE OF m', [body.merchantId])).rows[0];
        if (!row || !timingSafeEqual(Buffer.from(hash(body.accessCode)), Buffer.from(row.access_hash))) {
          for (const key of keys) await c.query('INSERT INTO btcinr_login_attempts(key,failures,started_at) VALUES($1,1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET failures=btcinr_login_attempts.failures+1', [key]);
          return { __error: { status: 401, error: 'bad_credentials', message: 'Invalid merchant credentials.' } };
        }
        await c.query('DELETE FROM btcinr_login_attempts WHERE key=ANY($1::text[])', [keys]);
        await audit(c, 'merchant', row.id, 'merchant_login', row.id);
        return issueMerchantSession(c, row);
      });
    },
    async recoverMerchant(req) {
      const player = await actor(req), code = accessCode();
      const result = await transaction(async (c) => {
        await checkActor(c, player);
        const row = (await c.query(merchantSql + ' WHERE m.owner_player_id=$1 AND NOT m.disabled FOR UPDATE OF m', [player.avatarId])).rows[0];
        if (!row) throw fail(404, 'merchant_not_found', 'This player does not own a merchant.');
        await c.query('UPDATE btcinr_merchants SET access_hash=$2 WHERE id=$1', [row.id, hash(code)]);
        await c.query('UPDATE btcinr_merchant_sessions SET revoked_at=clock_timestamp() WHERE merchant_id=$1 AND revoked_at IS NULL', [row.id]);
        await audit(c, 'merchant', row.id, 'merchant_recovered', row.id);
        return issueMerchantSession(c, row, code);
      });
      events.emit('revoked', { merchantId: result.merchant.id });
      return result;
    },
    async logoutMerchant(req) {
      const token = credential(req);
      await transaction(async (c) => {
        const row = await merchant(c, req);
        await c.query('UPDATE btcinr_merchant_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hash(token)]);
        await audit(c, 'merchant', row.id, 'merchant_logout', row.id);
      });
      events.emit('revoked', { merchantSessionHash: hash(token) });
      return { __status: 204, __cookie: cookie('', 0) };
    },
    getMerchant: (req) => transaction(async (c) => ({ ...simulated, merchant: merchantView(await merchant(c, req)) })),
    async createRequest(req, body) {
      fields(body, ['inrPaise', 'reference']); const paise = amount(body.inrPaise); const reference = body.reference === undefined ? '' : text(body.reference, 40, 0);
      return transaction(async (c) => {
        const owner = await merchant(c, req, true);
        const row = (await c.query('INSERT INTO btcinr_requests(code,merchant_id,inr_paise,reference,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *', [id('rq'), owner.id, paise, reference, new Date(Date.now() + requestTtlMs)])).rows[0];
        await audit(c, 'merchant', owner.id, 'request_created', row.code);
        return { ...simulated, request: requestView({ ...row, business_name: owner.business_name }), __status: 201 };
      });
    },
    async getRequest(req, code) {
      const player = await actor(req);
      return transaction(async (c) => { await checkActor(c, player); return { ...simulated, request: requestView(await request(c, code)) }; });
    },
    async createQuote(req, body) {
      fields(body, ['requestCode', 'inrPaise']); const paise = amount(body.inrPaise); const player = await actor(req);
      const snapshot = await rates.current();
      const rate = ratePaise(snapshot.inrPerBtc);
      if (snapshot.stale || !Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt > Date.now() + 5000 || Date.now() - snapshot.fetchedAt >= RATE_MAX_AGE_MS)
        throw fail(409, 'rate_stale', 'Get a fresh BTC reference rate before quoting.');
      return transaction(async (c) => {
        const payer = await customer(c, player), receiving = await request(c, body.requestCode);
        if (receiving.owner_player_id === player.avatarId) throw fail(403, 'self_payment', 'Payer and merchant must be separate players.');
        if (receiving.inr_paise !== null && Number(receiving.inr_paise) !== paise) throw fail(400, 'bad_amount', 'Confirm the merchant-fixed amount exactly.');
        const stamp = new Date(snapshot.fetchedAt);
        const savedRate = (await c.query('INSERT INTO btcinr_rates(id,paise_per_btc,source,fetched_at) VALUES($1,$2,$3,$4) ON CONFLICT(paise_per_btc,source,fetched_at) DO NOTHING RETURNING id', [randomUUID(), String(rate), snapshot.source, stamp])).rows[0]
          || (await c.query('SELECT id FROM btcinr_rates WHERE paise_per_btc=$1 AND source=$2 AND fetched_at=$3', [String(rate), snapshot.source, stamp])).rows[0];
        const createdAt = Date.now(), expiresAt = Math.min(createdAt + quoteTtlMs, snapshot.fetchedAt + RATE_MAX_AGE_MS, receiving.expires_at ? ms(receiving.expires_at) : Infinity);
        if (expiresAt <= Date.now()) throw fail(409, 'rate_stale', 'The reference rate expired while creating this quote.');
        const quoteId = id('qt'), sats = satsForPaise(paise, rate).toString();
        await c.query('INSERT INTO btcinr_quotes(id,customer_id,merchant_id,request_code,rate_id,inr_paise,btc_sats,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [quoteId, payer.id, receiving.merchant_id, receiving.code, savedRate.id, paise, sats, new Date(createdAt), new Date(expiresAt)]);
        await audit(c, 'customer', payer.id, 'quote_created', quoteId);
        return { ...simulated, __status: 201, quote: { ...simulated, id: quoteId, requestCode: receiving.code, merchant: { id: receiving.merchant_id, businessName: receiving.business_name }, inrPaise: paise, btcSats: sats, inrPerBtc: rateText(rate), rateSource: snapshot.source, rateFetchedAt: snapshot.fetchedAt, createdAt, expiresAt } };
      });
    },
    async pay(req, body) {
      fields(body, ['quoteId']);
      const key = String(req.headers['idempotency-key'] || '');
      if (!KEY.test(key)) throw fail(400, 'bad_idempotency_key', 'Send a UUID v4 Idempotency-Key and reuse it for retries.');
      if (!/^qt_[a-f0-9]{32}$/.test(String(body.quoteId))) throw fail(404, 'quote_not_found', 'No such quote.');
      const player = await actor(req);
      let payerId;
      try {
        return await transaction(async (c) => {
          const payer = await customer(c, player, true); payerId = payer.id;
          const old = (await c.query('SELECT quote_id,receipt FROM btcinr_payments WHERE customer_id=$1 AND idempotency_key=$2', [payer.id, key])).rows[0];
          if (old) {
            if (old.quote_id !== body.quoteId) throw fail(422, 'idempotency_conflict', 'This key belongs to a different payment request.');
            return { ...simulated, payment: old.receipt, replayed: true };
          }
          const q = (await c.query('SELECT q.*,r.paise_per_btc,r.source,r.fetched_at FROM btcinr_quotes q JOIN btcinr_rates r ON r.id=q.rate_id WHERE q.id=$1 AND q.customer_id=$2 FOR UPDATE OF q', [body.quoteId, payer.id])).rows[0];
          if (!q) throw fail(404, 'quote_not_found', 'No such quote.');
          if ((await c.query('SELECT 1 FROM btcinr_payments WHERE quote_id=$1', [q.id])).rowCount) throw fail(409, 'quote_used', 'This quote has already been paid.');
          if (ms(q.expires_at) <= Date.now()) throw fail(410, 'quote_expired', 'This quote expired. Review a new quote before paying.');
          const receiving = await request(c, q.request_code, true);
          if (receiving.owner_player_id === player.avatarId) throw fail(403, 'self_payment', 'Payer and merchant must be separate players.');
          const accounts = (await c.query('SELECT * FROM btcinr_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[payer.account_id, receiving.account_id, 'system_btc_fx', 'system_inr_fx']])).rows;
          const balance = accounts.find((a) => a.id === payer.account_id);
          const merchantBalance = accounts.find((a) => a.id === receiving.account_id);
          if (BigInt(balance.balance) < BigInt(q.btc_sats)) throw fail(402, 'insufficient_funds', 'Not enough DEMO BTC for this quote.');
          if (BigInt(merchantBalance.balance) + BigInt(q.inr_paise) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(409, 'balance_limit', 'The merchant DEMO balance limit was reached.');
          const paymentId = id('pay'), orderId = id('ord'), journal = randomUUID(), stamp = Date.now();
          const receipt = { id: paymentId, orderId, status: 'confirmed', failureCode: null, customer: { id: payer.id, displayName: payer.display_name }, merchant: { id: receiving.merchant_id, businessName: receiving.business_name },
            inrPaise: Number(q.inr_paise), btcSats: q.btc_sats, inrPerBtc: rateText(q.paise_per_btc), rateSource: q.source, rateFetchedAt: ms(q.fetched_at), reference: receiving.reference,
            createdAt: stamp, confirmedAt: stamp, version: 1, ...simulated };
          await c.query("INSERT INTO btcinr_journals(id,kind,reference) VALUES($1,'payment',$2)", [journal, 'pay:' + paymentId]);
          await c.query(`INSERT INTO btcinr_payments(id,order_id,customer_id,merchant_id,quote_id,request_code,single_use_request_code,rate_id,inr_paise,btc_sats,idempotency_key,journal_id,receipt,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [paymentId, orderId, payer.id, receiving.merchant_id, q.id, q.request_code, receiving.inr_paise === null ? null : receiving.code, q.rate_id, q.inr_paise, q.btc_sats, key, journal, JSON.stringify(receipt), new Date(stamp)]);
          await post(c, journal, payer.account_id, 'DEMO_BTC', -BigInt(q.btc_sats));
          await post(c, journal, 'system_btc_fx', 'DEMO_BTC', q.btc_sats);
          await post(c, journal, 'system_inr_fx', 'DEMO_INR', -BigInt(q.inr_paise));
          await post(c, journal, receiving.account_id, 'DEMO_INR', q.inr_paise);
          await audit(c, 'customer', payer.id, 'payment_confirmed', paymentId, { journalId: journal, quoteId: q.id, btcSats: q.btc_sats, inrPaise: Number(q.inr_paise) });
          await enqueue(c, 'btcinr:payment', { ...simulated, payment: receipt }, payer.id, receiving.merchant_id);
          for (const [role, accountId, owner] of [['customer', payer.account_id, payer.id], ['merchant', receiving.account_id, receiving.merchant_id]]) {
            const row = (await c.query('SELECT balance,version FROM btcinr_accounts WHERE id=$1', [accountId])).rows[0];
            await enqueue(c, 'btcinr:balance', { ...simulated, role, balance: role === 'customer' ? { btcSats: row.balance } : { inrPaise: Number(row.balance) }, version: Number(row.version) }, role === 'customer' ? owner : null, role === 'merchant' ? owner : null);
          }
          return { ...simulated, __status: 201, payment: receipt };
        }, true);
      } catch (e) {
        if (['quote_expired', 'request_expired'].includes(e.message)) e = fail(410, e.message, 'The DEMO quote or receiving request expired. Review a new quote.');
        if (payerId) await transaction((c) => audit(c, 'customer', payerId, 'payment_rejected', body.quoteId, { code: e.code || 'transaction_failed' })).catch(() => {});
        throw e;
      }
    },
    async getPayment(req, paymentId) {
      return transaction(async (c) => {
        const receipt = (await c.query('SELECT * FROM btcinr_payments WHERE id=$1', [paymentId])).rows[0];
        if (!receipt) throw fail(404, 'payment_not_found', 'No such DEMO receipt.');
        const owner = await api.readScope(c, req);
        if (receipt.customer_id !== owner.customerId && receipt.merchant_id !== owner.merchantId) throw fail(404, 'payment_not_found', 'No such DEMO receipt.');
        return { ...simulated, payment: receipt.receipt };
      });
    },
    async readScope(c, req, role) {
      let customerId = null, merchantId = null;
      if (role !== 'customer' && credential(req)) merchantId = (await merchant(c, req)).id;
      if (role !== 'merchant' && (req.headers['x-omen-token'] || req.headers['x-omen-session'] || /(?:omen_player|__Host-omen_player)=/.test(req.headers.cookie || ''))) {
        try { const player = await actor(req); customerId = (await customer(c, player)).id; }
        catch (e) { if (!merchantId || role === 'customer' || ![401,404].includes(e.status)) throw e; }
      }
      if (!customerId && !merchantId) throw fail(401, 'unauthorized', 'Authenticate as the payer or receiving merchant.');
      return { customerId, merchantId };
    },
    async history(req, params) {
      const role = params.get('role') || 'customer', limit = Number(params.get('limit') || 20);
      if (!['customer', 'merchant'].includes(role) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, 'bad_pagination', 'Use customer/merchant history and a limit from 1 to 100.');
      let cursor = null;
      if (params.has('before')) {
        try { cursor = JSON.parse(Buffer.from(params.get('before'), 'base64url').toString()); } catch { throw fail(400, 'bad_pagination', 'Invalid history cursor.'); }
        if (!cursor || !/^pay_[a-f0-9]{32}$/.test(cursor.id) || !Number.isSafeInteger(cursor.at) || !Number.isFinite(new Date(cursor.at).getTime())) throw fail(400, 'bad_pagination', 'Invalid history cursor.');
      }
      return transaction(async (c) => {
        const owner = await api.readScope(c, req, role), column = role === 'customer' ? 'customer_id' : 'merchant_id';
        const rows = (await c.query(`SELECT id,receipt,created_at FROM btcinr_payments WHERE ${column}=$1
          AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`,
          [role === 'customer' ? owner.customerId : owner.merchantId, cursor ? new Date(cursor.at) : null, cursor?.id || '', limit + 1])).rows;
        const more = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
        return { ...simulated, payments: page.map((r) => r.receipt), nextCursor: more ? Buffer.from(JSON.stringify({ at: ms(last.created_at), id: last.id })).toString('base64url') : null };
      });
    },
    async socketIdentity(handshake) {
      const auth = handshake.auth || {}, requested = auth.role ? [auth.role] : auth.customerToken || auth.merchantSession ? [auth.customerToken && 'customer', auth.merchantSession && 'merchant'].filter(Boolean) : ['customer', 'merchant'];
      if (requested.some((r) => !['customer', 'merchant'].includes(r))) throw fail(401, 'unauthorized', 'Invalid DEMO socket role.');
      const req = { headers: { ...handshake.headers, ...(auth.customerToken ? { 'x-omen-token': auth.customerToken } : {}), ...(auth.merchantSession ? { authorization: 'Bearer ' + auth.merchantSession } : {}) } };
      let player = null;
      if (requested.includes('customer')) {
        try { player = await actor(req); } catch (e) { if (auth.role === 'customer' || auth.customerToken) throw e; }
      }
      return transaction(async (c) => {
        const context = {};
        if (player) {
          try { context.customerId = (await customer(c, player)).id; context.player = player; } catch (e) { if (auth.role === 'customer' || auth.customerToken || e.status !== 404) throw e; }
        }
        if (requested.includes('merchant') && credential(req)) {
          const row = await merchant(c, req); context.merchantId = row.id; context.merchantSessionHash = row.token_hash;
        }
        if (!context.customerId && !context.merchantId) throw fail(401, 'unauthorized', 'An enrolled DEMO customer or merchant session is required.');
        return context;
      });
    },
    async validSocket(context) {
      if (context.player?.sessionHash && !(await worldIdentity.activeSessions([context.player.sessionHash])).has(context.player.sessionHash)) return false;
      if (context.merchantSessionHash && !(await database.pool.query(activeMerchantSql, [context.merchantSessionHash])).rowCount) return false;
      return true;
    },
    async drainOutbox(deliver) {
      return transaction(async (c) => {
        const rows = (await c.query('SELECT * FROM btcinr_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED')).rows;
        for (const row of rows) await deliver(row);
        if (rows.length) await c.query('UPDATE btcinr_outbox SET published_at=clock_timestamp() WHERE id=ANY($1::bigint[])', [rows.map((r) => r.id)]);
        return rows.length;
      });
    },
  };
  return api;
}
