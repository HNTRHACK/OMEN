import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './payments.js';

const scrypt = promisify(derive);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const COOKIE = 'omen_mod';
const HOURS = 8;
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const denied = () => new ApiError(401, 'unauthorized', 'Sign in with a moderator account.');
const publicAccount = (a) => ({ id: a.id, username: a.username, role: a.role, playerId: a.player_id });

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new ApiError(400, 'bad_password', 'Passwords must contain 12–256 characters.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64, options)).toString('hex')}`;
}
async function matches(password, encoded) {
  const [salt, expected] = encoded.split(':');
  const actual = await scrypt(password, salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function createAuth(database, { secure = process.env.NODE_ENV === 'production' } = {}) {
  const sql = (...args) => database.state().client.query(...args);
  const tokenOf = (req) => /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1]
    || String(req.headers['x-mod-key'] || '') // compatibility: this is an individual, expiring session, never MODERATOR_KEY
    || new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie || '')?.[1] || '';
  const cookie = (token, age = HOURS * 3600) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  return {
    async provision({ username, password, role = 'moderator', playerId = null, disabled = false }) {
      username = String(username || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || !['reviewer', 'moderator', 'admin'].includes(role) || (playerId !== null && !/^[a-f0-9]{24}$/.test(playerId)))
        throw new ApiError(400, 'bad_account', 'Invalid username, role or player ID.');
      const encoded = await passwordHash(password);
      const { rows: [account] } = await sql(`INSERT INTO moderator_accounts(id,username,password_hash,role,player_id,disabled)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,
        role=EXCLUDED.role, player_id=EXCLUDED.player_id, disabled=EXCLUDED.disabled RETURNING *`, [randomUUID(), username, encoded, role, playerId, disabled]);
      await sql('DELETE FROM moderator_sessions WHERE account_id=$1', [account.id]);
      return publicAccount(account);
    },
    async login(req, { username, password }) {
      username = String(username || '').trim().toLowerCase();
      password = typeof password === 'string' ? password : '';
      if (password.length > 256 || username.length > 64) throw denied();
      const ip = req.omenClientIp || req.socket.remoteAddress || '?';
      const keys = [hash(`ip:${ip}`), hash(`account:${username}`)];
      await sql("DELETE FROM login_attempts WHERE started_at < now() - interval '15 minutes'");
      const recent = await sql('SELECT failures FROM login_attempts WHERE key = ANY($1::text[])', [keys]);
      if (recent.rows.some((r) => r.failures >= 5)) return { __error: { status: 429, error: 'login_limited', message: 'Too many login attempts. Try again in 15 minutes.' } };
      const { rows: [account] } = await sql('SELECT * FROM moderator_accounts WHERE username=$1', [username]);
      // The same expensive hash also runs for missing accounts.
      const encoded = account?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`;
      if (!(await matches(password, encoded)) || !account || account.disabled) {
        for (const key of keys) await sql('INSERT INTO login_attempts(key,failures,started_at) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET failures=login_attempts.failures+1', [key]);
        return { __error: { status: 401, error: 'unauthorized', message: 'Invalid username or password.' } };
      }
      await sql('DELETE FROM login_attempts WHERE key = ANY($1::text[])', [keys]);
      await sql('DELETE FROM moderator_sessions WHERE expires_at <= now()');
      const token = randomBytes(32).toString('hex');
      await sql("INSERT INTO moderator_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [hash(token), account.id]);
      return { token, expiresIn: HOURS * 3600, account: publicAccount(account), __cookie: cookie(token) };
    },
    async account(req, permission = 'review') {
      const token = tokenOf(req);
      if (!/^[a-f0-9]{64}$/.test(token)) throw denied();
      const { rows: [account] } = await sql(`SELECT a.* FROM moderator_accounts a JOIN moderator_sessions s ON s.account_id=a.id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT a.disabled`, [hash(token)]);
      if (!account) throw denied();
      const roles = permission === 'admin' ? ['admin'] : permission === 'moderate' ? ['moderator', 'admin'] : ['reviewer', 'moderator', 'admin'];
      if (!roles.includes(account.role)) throw new ApiError(403, 'forbidden', 'Your account does not have this permission.');
      return publicAccount(account);
    },
    async logout(req) {
      await sql('DELETE FROM moderator_sessions WHERE token_hash=$1', [hash(tokenOf(req))]);
      return { ok: true, __cookie: cookie('', 0) };
    },
    async audit(account, body) {
      await sql('INSERT INTO moderation_audit(account_id,action,target,reason) VALUES($1,$2,$3,$4)', [account.id, String(body.action).slice(0, 32), String(body.id || body.playerId || '').slice(0, 100), String(body.reason || '').slice(0, 120)]);
    },
  };
}
