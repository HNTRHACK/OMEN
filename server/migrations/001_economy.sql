CREATE TABLE economy_records (
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND data->>'id' = id),
  PRIMARY KEY (collection, id)
);
CREATE INDEX economy_owner ON economy_records (collection, (data->>'author'));
CREATE UNIQUE INDEX payment_transaction ON economy_records (lower(data->>'txHash'))
  WHERE collection = 'payments' AND data->>'txHash' IS NOT NULL AND data->>'state' <> 'FAILED';
CREATE TABLE uploads (
  name text PRIMARY KEY CHECK (name ~ '^[a-f0-9]{32}\.(png|jpg)$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 716800)
);
CREATE TABLE moderator_accounts (
  id uuid PRIMARY KEY,
  username text UNIQUE NOT NULL CHECK (username = lower(username)),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer', 'moderator', 'admin')),
  player_id text UNIQUE CHECK (player_id ~ '^[a-f0-9]{24}$'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE moderator_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES moderator_accounts(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_account ON moderator_sessions(account_id);
CREATE TABLE login_attempts (
  key text PRIMARY KEY,
  failures integer NOT NULL,
  started_at timestamptz NOT NULL
);
CREATE TABLE moderation_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES moderator_accounts(id),
  action text NOT NULL,
  target text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legacy_imports (
  source text PRIMARY KEY,
  digest text NOT NULL,
  records integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
