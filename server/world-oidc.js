import * as oidc from 'openid-client';
import { ApiError } from './payments.js';

export const WORLD_ISSUERS = { production: 'https://auth.world.org', sandbox: 'https://sandbox.auth.world.org' };
export const ORB_CLASSES = ['https://world.org/oidc/acr/orb', 'https://world.org/oidc/acr/orb-face'];
const unavailable = (cause) => Object.assign(new ApiError(503, 'world_id_unavailable', 'World ID authentication is temporarily unavailable. Start a new sign-in attempt.'), { cause });
const invalid = (cause) => Object.assign(new ApiError(401, 'world_id_invalid', 'World ID authentication could not be validated.'), { cause });

/** Only the automated tests replace HTTP transport. No environment variable bypasses verification. */
export function createWorldOidc(settings, { fetch: transport = globalThis.fetch } = {}) {
  const { environment = 'production', clientId = '', clientSecret = '', redirectUri = '' } = settings;
  const issuer = Object.hasOwn(WORLD_ISSUERS, environment) ? WORLD_ISSUERS[environment] : null;
  if (!issuer) throw new Error('WORLD_ID_ENVIRONMENT must be production or sandbox.');
  const configured = !!(clientId && clientSecret && redirectUri);
  if ((clientId || clientSecret || redirectUri) && !configured) throw new Error('Set all of WORLD_ID_CLIENT_ID, WORLD_ID_CLIENT_SECRET and WORLD_ID_REDIRECT_URI.');
  if (configured) {
    const callback = new URL(redirectUri);
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/auth/world/callback')
      throw new Error('WORLD_ID_REDIRECT_URI must be the exact HTTPS /api/auth/world/callback URL, without query or fragment.');
  }
  let cached;
  let cacheUntil = 0;
  const trustedUrl = (value) => {
    const url = new URL(value);
    if (url.origin !== issuer || url.username || url.password || url.hash) throw unavailable();
    return url;
  };
  const fetchWorld = async (url, options) => {
    trustedUrl(url);
    try {
      const response = await transport(url, { ...options, redirect: 'error', signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
      if (response.status >= 500 || response.status === 429) throw unavailable();
      return response;
    } catch (e) { throw unavailable(e); }
  };
  const client = async () => {
    if (!configured) throw new ApiError(503, 'world_id_not_configured', 'World ID credentials have not been configured. Guest access remains available.');
    if (!cached || Date.now() >= cacheUntil) {
      cacheUntil = Date.now() + 3_600_000;
      cached = oidc.discovery(new URL(issuer), clientId,
        { id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 5 }, oidc.ClientSecretBasic(clientSecret),
        { [oidc.customFetch]: fetchWorld, timeout: 8, execute: [oidc.enableNonRepudiationChecks] })
        .then((config) => {
          const metadata = config.serverMetadata();
          for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) trustedUrl(metadata[key]);
          if (metadata.authorization_response_iss_parameter_supported !== true || !metadata.code_challenge_methods_supported?.includes('S256')) throw unavailable();
          return config;
        }).catch(() => { cached = null; throw unavailable(); });
    }
    return cached;
  };
  return {
    issuer, clientId, environment,
    status: () => ({ configured, environment, provider: 'world-id', flow: 'authorization-code-pkce', requiredCredential: 'orb' }),
    async authorizationUrl(attempt) {
      const config = await client();
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, response_type: 'code', response_mode: 'query', scope: 'openid',
        state: attempt.state, nonce: attempt.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.pkce_verifier), code_challenge_method: 'S256',
        max_age: '300',
        claims: JSON.stringify({ id_token: { acr: { essential: true, values: ORB_CLASSES } } }),
      }).href;
    },
    async verify(query, attempt) {
      if (query.get('iss') !== issuer || attempt.issuer !== issuer || attempt.client_id !== clientId) throw invalid();
      const config = await client();
      const callback = new URL(redirectUri);
      callback.search = query.toString();
      try {
        const tokens = await oidc.authorizationCodeGrant(config, callback, {
          expectedState: query.get('state'), expectedNonce: attempt.nonce,
          pkceCodeVerifier: attempt.pkce_verifier, maxAge: 300, idTokenExpected: true,
        });
        const claims = tokens.claims();
        const now = Date.now() / 1000;
        const methods = claims?.amr;
        const methodSet = Array.isArray(methods) ? [...methods].sort().join(',') : '';
        if (!claims || claims.iss !== issuer || typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 512
          || typeof claims.jti !== 'string' || !claims.jti.length || claims.jti.length > 512
          || !ORB_CLASSES.includes(claims.acr) || !['pop', 'mfa,pop,user', 'face,pop,user'].includes(methodSet)
          || (claims.acr.endsWith('-face') && methodSet !== 'face,pop,user')
          || !Number.isSafeInteger(claims.auth_time) || claims.auth_time > now + 5 || claims.auth_time < now - 305
          || !Number.isSafeInteger(claims.iat) || claims.iat > now + 5 || claims.iat < new Date(attempt.created_at).getTime() / 1000 - 5
          || !Number.isSafeInteger(claims.exp) || claims.exp <= now) throw invalid();
        return { issuer, subject: claims.sub, jti: claims.jti, expiresAt: new Date(claims.exp * 1000),
          authTime: new Date(claims.auth_time * 1000), assurance: claims.acr, methods };
      } catch (e) {
        for (let cause = e; cause; cause = cause.cause) {
          if (cause instanceof ApiError) throw cause;
          if (cause.status >= 500 || ['invalid_client', 'invalid_scope', 'temporarily_unavailable', 'server_error'].includes(cause.error)) throw unavailable();
        }
        throw invalid(e);
      }
    },
  };
}
