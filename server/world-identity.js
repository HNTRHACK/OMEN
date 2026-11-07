import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ApiError } from './payments.js';
import { playerIdOf, TOKEN_RE } from './identity.js';
import { cleanLook, LOOK_OPTIONS } from '../shared/look.js';
import { moderateText } from './moderation.js';
import { createWorldOidc } from './world-oidc.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const unauthorized = () => new ApiError(401, 'session_expired', 'Sign in again with World ID.');
const productionIssuer = 'https://auth.world.org';
const SESSION_SECONDS = 8 * 3600;

export function createWorldIdentity(database, settings, { provider = createWorldOidc(settings), secure = process.env.NODE_ENV === 'production' } = {}) {
  const events = new EventEmitter();
  const sessionCookie = secure ? '__Host-omen_player' : 'omen_player';
  const flowCookie = secure ? '__Secure-omen_world_flow' : 'omen_world_flow';
  const cookie = (name, value, age, path = '/') => `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const readCookie = (req, name) => {
    const matches = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(name + '='));
    return matches.length === 1 ? matches[0].slice(name.length + 1) : matches.length ? 'invalid' : '';
  };
  const credential = (req) => String(req.headers['x-omen-session'] || readCookie(req, sessionCookie));
  const sql = (...args) => database.state().client.query(...args);
  const activeSessionSql = `SELECT a.*, s.token_hash, s.expires_at, s.auth_time FROM player_sessions s
    JOIN player_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp() AND NOT a.disabled AND a.world_issuer=$2`;
  const principal = (row) => ({ accountId: row.id, avatarId: row.avatar_id, authType: 'world-id',
    verifiedHuman: row.world_issuer === productionIssuer, verificationEnvironment: row.world_issuer === productionIssuer ? 'production' : 'sandbox',
    sessionExpiresAt: new Date(row.expires_at).getTime(), sessionHash: row.token_hash });
  const avatar = (row) => ({ id: row.avatar_id, displayName: row.display_name, look: cleanLook(row.avatar_look),
    revision: row.avatar_revision, updatedAt: new Date(row.avatar_updated_at).getTime(), verifiedHuman: row.world_issuer === productionIssuer });
  const publicPlayer = (player) => {
    if (!player) return null;
    const { sessionHash, ...result } = player;
    return result;
  };
  const identity = {
    events,
    status: provider.status,
    async start(req, body = {}) {
      if (Object.keys(body).some((k) => k !== 'recover') || (body.recover !== undefined && typeof body.recover !== 'boolean'))
        throw new ApiError(400, 'bad_request', 'Send an empty object or {recover:true}.');
      const state = random(), browser = random();
      const attempt = { state, nonce: random(), pkce_verifier: randomBytes(48).toString('base64url') };
      const authorizationUrl = await provider.authorizationUrl(attempt);
      const old = credential(req);
      await database.transaction(async () => {
        await sql("DELETE FROM world_login_attempts WHERE expires_at < now() - interval '1 hour'");
        await sql("INSERT INTO world_login_attempts(state_hash,browser_hash,nonce,pkce_verifier,purpose,issuer,client_id,prior_session_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes')",
          [hash(state), hash(browser), attempt.nonce, attempt.pkce_verifier, body.recover ? 'recover' : 'login', provider.issuer, provider.clientId, TOKEN_RE.test(old) ? hash(old) : null]);
      });
      return { authorizationUrl, expiresIn: 300, __cookie: cookie(flowCookie, browser, 300, '/api/auth/world/callback') };
    },
    async callback(req, query) {
      for (const key of query.keys()) if (query.getAll(key).length !== 1) throw new ApiError(400, 'bad_callback', 'Repeated callback parameters are not accepted.');
      const state = query.get('state') || '';
      const browser = readCookie(req, flowCookie);
      if (!TOKEN_RE.test(state) || !TOKEN_RE.test(browser)) throw new ApiError(401, 'invalid_attempt', 'The sign-in attempt does not belong to this browser.');
      const code = query.get('code');
      if (code !== null && (!code.length || code.length > 4096)) throw new ApiError(400, 'bad_callback', 'Invalid authorization code.');
      let attempt;
      try {
        // Consumption commits BEFORE network verification. Even rejected/uncertain proofs cannot replay.
        attempt = await database.transaction(async () => (await sql(`UPDATE world_login_attempts
          SET consumed_at=now(), code_hash=$3 WHERE state_hash=$1 AND browser_hash=$2
          AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING *`,
          [hash(state), hash(browser), code ? hash(`${provider.issuer}:${code}`) : null])).rows[0]);
      } catch (e) {
        if (e.code === '23505') throw new ApiError(409, 'proof_replayed', 'This authorization code was already used.');
        throw e;
      }
      if (!attempt) throw new ApiError(409, 'attempt_used_or_expired', 'Start a new World ID sign-in attempt.');
      const proof = await provider.verify(query, attempt);
      const token = random();
      await database.transaction(async () => {
        if (proof.expiresAt.getTime() <= Date.now()) throw new ApiError(401, 'world_id_invalid', 'The authentication result expired before it could be accepted.');
        await sql('DELETE FROM world_token_uses WHERE expires_at <= now()');
        const used = await sql('INSERT INTO world_token_uses(issuer,jti,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [proof.issuer, proof.jti, proof.expiresAt]);
        if (!used.rowCount) throw new ApiError(409, 'proof_replayed', 'This authentication result was already used.');
        let account = (await sql('SELECT * FROM player_accounts WHERE world_issuer=$1 AND world_subject=$2', [proof.issuer, proof.subject])).rows[0];
        if (attempt.purpose === 'recover' && !account) throw new ApiError(404, 'account_not_found', 'No OMEN account is linked to this World ID.');
        if (!account) account = (await sql(`INSERT INTO player_accounts(id,avatar_id,world_issuer,world_subject)
          VALUES($1,$2,$3,$4) ON CONFLICT(world_issuer,world_subject) DO UPDATE SET last_verified_at=now() RETURNING *`,
          [randomUUID(), randomBytes(12).toString('hex'), proof.issuer, proof.subject])).rows[0];
        if (account.disabled) throw new ApiError(403, 'account_disabled', 'This OMEN account is disabled.');
        await sql('UPDATE player_accounts SET last_verified_at=now() WHERE id=$1', [account.id]);
        if (attempt.purpose === 'recover') {
          await sql('UPDATE player_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL', [account.id]);
          database.defer(() => events.emit('revoked', { accountId: account.id }));
        } else if (attempt.prior_session_hash) {
          await sql('UPDATE player_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [attempt.prior_session_hash]);
          database.defer(() => events.emit('revoked', { sessionHash: attempt.prior_session_hash }));
        }
        await sql("INSERT INTO player_sessions(token_hash,account_id,auth_time,assurance,methods,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '8 hours')",
          [hash(token), account.id, proof.authTime, proof.assurance, JSON.stringify(proof.methods)]);
      });
      return { __redirect: '/?world_id=success', __cookie: [cookie(sessionCookie, token, SESSION_SECONDS), cookie(flowCookie, '', 0, '/api/auth/world/callback')] };
    },
    async resolveRequest(req) {
      const token = credential(req);
      if (token) {
        if (!TOKEN_RE.test(token)) throw unauthorized();
        return database.transaction(async () => {
          const row = (await sql(activeSessionSql, [hash(token), provider.issuer])).rows[0];
          if (!row) throw unauthorized();
          return principal(row);
        });
      }
      const guest = String(req.headers['x-omen-token'] || '');
      return TOKEN_RE.test(guest) ? { accountId: null, avatarId: playerIdOf(guest), authType: 'guest', verifiedHuman: false, verificationEnvironment: null, sessionExpiresAt: null } : null;
    },
    async me(req) { return { player: publicPlayer(await identity.resolveRequest(req)) }; },
    async logout(req, { all = false } = {}) {
      if (typeof all !== 'boolean') throw new ApiError(400, 'bad_request', 'all must be a boolean.');
      const token = credential(req);
      await database.transaction(async () => {
        if (all) {
          const player = await identity.resolveRequest(req);
          if (!player?.accountId) throw unauthorized();
          await sql('UPDATE player_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL', [player.accountId]);
          database.defer(() => events.emit('revoked', { accountId: player.accountId }));
        } else if (TOKEN_RE.test(token)) {
          await sql('UPDATE player_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hash(token)]);
          database.defer(() => events.emit('revoked', { sessionHash: hash(token) }));
        }
      });
      return { ok: true, __cookie: cookie(sessionCookie, '', 0) };
    },
    async ownAvatar(req) {
      return database.transaction(async () => {
        const player = await identity.resolveRequest(req);
        if (!player?.accountId) throw unauthorized();
        const row = (await sql('SELECT * FROM player_accounts WHERE id=$1', [player.accountId])).rows[0];
        return { avatar: avatar(row), ownerAccountId: player.accountId };
      });
    },
    async updateAvatar(req, body) {
      if (Object.keys(body).some((k) => !['displayName', 'look', 'revision'].includes(k)) || !Number.isSafeInteger(body.revision) || body.revision < 0)
        throw new ApiError(400, 'bad_avatar', 'Send displayName and/or look with the current revision. Ownership and badges are assigned by the server.');
      let displayName;
      if (body.displayName !== undefined) {
        const checked = moderateText(body.displayName, { min: 2, max: 16, links: 0 });
        if (!checked.ok) throw new ApiError(400, 'bad_avatar', checked.reason);
        displayName = checked.text;
      }
      if (body.look !== undefined && (!body.look || typeof body.look !== 'object' || Array.isArray(body.look)
        || Object.entries(body.look).some(([key, value]) => !Object.hasOwn(LOOK_OPTIONS, key) || !Number.isInteger(value) || value < 0 || value >= LOOK_OPTIONS[key].length)))
        throw new ApiError(400, 'bad_avatar', 'Avatar options must be known, in-range integer indices.');
      return database.transaction(async () => {
        const player = await identity.resolveRequest(req);
        if (!player?.accountId) throw unauthorized();
        const { rows: [row] } = await sql(`UPDATE player_accounts SET display_name=COALESCE($2,display_name),
          avatar_look=COALESCE($3,avatar_look), avatar_revision=avatar_revision+1, avatar_updated_at=now()
          WHERE id=$1 AND avatar_revision=$4 RETURNING *`, [player.accountId, displayName ?? null, body.look === undefined ? null : JSON.stringify(cleanLook(body.look)), body.revision]);
        if (!row) throw new ApiError(409, 'avatar_conflict', 'Your avatar changed elsewhere. Reload it and retry.');
        const result = avatar(row);
        database.defer(() => events.emit('avatar', result));
        return { avatar: result, ownerAccountId: player.accountId };
      });
    },
    async activeSessions(hashes) {
      if (!hashes.length) return new Set();
      const result = await database.pool.query(`SELECT s.token_hash FROM player_sessions s JOIN player_accounts a ON a.id=s.account_id
        WHERE s.token_hash=ANY($1::text[]) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND NOT a.disabled AND a.world_issuer=$2`, [hashes, provider.issuer]);
      return new Set(result.rows.map((r) => r.token_hash));
    },
    async reservedAvatar(id) {
      return (await database.pool.query('SELECT 1 FROM player_accounts WHERE avatar_id=$1', [id])).rowCount > 0;
    },
  };
  return identity;
}
