-- Bounty Royale: free, non-transferable, non-redeemable OMEN points. No deposits, withdrawals or payouts.
CREATE TABLE royale_players (
  player_id text PRIMARY KEY,                  -- the World ID human (one nullifier per action → one player)
  display_name text NOT NULL DEFAULT '',
  balance bigint NOT NULL CHECK (balance >= 0),
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE royale_projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  team text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  is_game boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE royale_markets (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('top3', 'bounty', 'double', 'wildcard')),
  title text NOT NULL,
  sponsor text,
  max_picks int NOT NULL DEFAULT 1 CHECK (max_picks BETWEEN 1 AND 10),
  kind text NOT NULL DEFAULT 'projects' CHECK (kind IN ('projects', 'yesno')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'settled', 'void')),
  lock_at timestamptz NOT NULL,
  winners jsonb,
  result_source text,
  settled_at timestamptz,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE royale_predictions (
  id text PRIMARY KEY,
  player_id text NOT NULL REFERENCES royale_players(player_id),
  market_id text NOT NULL REFERENCES royale_markets(id),
  selection text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  idem_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome text CHECK (outcome IN ('won', 'lost', 'refunded')),
  payout bigint,
  UNIQUE (player_id, market_id, selection),
  UNIQUE (player_id, idem_key)
);
CREATE INDEX royale_predictions_market ON royale_predictions(market_id);
CREATE INDEX royale_predictions_recent ON royale_predictions(created_at DESC);

CREATE TABLE royale_ledger (
  id bigserial PRIMARY KEY,
  player_id text NOT NULL REFERENCES royale_players(player_id),
  delta bigint NOT NULL,
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  kind text NOT NULL CHECK (kind IN ('grant', 'stake', 'payout', 'refund')),
  ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, kind, ref)
);

CREATE TABLE royale_audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
