CREATE TABLE player_accounts (
  id uuid PRIMARY KEY,
  avatar_id text UNIQUE NOT NULL CHECK (avatar_id ~ '^[a-f0-9]{24}$'),
  world_issuer text NOT NULL CHECK (world_issuer IN ('https://auth.world.org', 'https://sandbox.auth.world.org')),
  world_subject text COLLATE "C" NOT NULL CHECK (length(world_subject) BETWEEN 1 AND 512),
  display_name text NOT NULL DEFAULT 'Courier' CHECK (length(display_name) BETWEEN 2 AND 16),
  avatar_look jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(avatar_look) = 'object'),
  avatar_revision integer NOT NULL DEFAULT 0 CHECK (avatar_revision >= 0),
  avatar_updated_at timestamptz NOT NULL DEFAULT now(),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_issuer, world_subject)
);

CREATE TABLE player_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES player_accounts(id),
  auth_time timestamptz NOT NULL,
  assurance text NOT NULL CHECK (assurance IN ('https://world.org/oidc/acr/orb', 'https://world.org/oidc/acr/orb-face')),
  methods jsonb NOT NULL CHECK (jsonb_typeof(methods) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX player_sessions_account ON player_sessions(account_id);
CREATE INDEX player_sessions_expiry ON player_sessions(expires_at);

CREATE TABLE world_login_attempts (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  nonce text UNIQUE NOT NULL,
  pkce_verifier text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login', 'recover')),
  issuer text NOT NULL,
  client_id text NOT NULL,
  prior_session_hash text,
  code_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX world_attempts_expiry ON world_login_attempts(expires_at);

CREATE TABLE world_token_uses (
  issuer text NOT NULL,
  jti text COLLATE "C" NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(issuer, jti)
);
