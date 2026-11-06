CREATE TABLE btcinr_accounts (
  id text PRIMARY KEY,
  asset text NOT NULL CHECK (asset IN ('DEMO_BTC','DEMO_INR')),
  kind text NOT NULL CHECK (kind IN ('customer','merchant','system')),
  balance bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE(id,asset),
  CHECK (kind='system' OR balance >= 0),
  CHECK (kind <> 'customer' OR asset='DEMO_BTC'),
  CHECK (kind <> 'merchant' OR asset='DEMO_INR')
);
INSERT INTO btcinr_accounts(id,asset,kind) VALUES
  ('system_btc_issuance','DEMO_BTC','system'),
  ('system_btc_fx','DEMO_BTC','system'),
  ('system_inr_fx','DEMO_INR','system');

CREATE TABLE btcinr_customers (
  id text PRIMARY KEY CHECK (id ~ '^cus_[a-f0-9]{32}$'),
  player_id text UNIQUE NOT NULL CHECK (player_id ~ '^[a-f0-9]{24}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 24),
  account_id text UNIQUE NOT NULL REFERENCES btcinr_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE btcinr_merchants (
  id text PRIMARY KEY CHECK (id ~ '^mer_[a-f0-9]{32}$'),
  owner_player_id text UNIQUE NOT NULL CHECK (owner_player_id ~ '^[a-f0-9]{24}$'),
  business_name text NOT NULL CHECK (length(business_name) BETWEEN 2 AND 48),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 24),
  account_id text UNIQUE NOT NULL REFERENCES btcinr_accounts(id),
  access_hash text NOT NULL CHECK (access_hash ~ '^[a-f0-9]{64}$'),
  receive_code text UNIQUE NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE btcinr_merchant_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  merchant_id text NOT NULL REFERENCES btcinr_merchants(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX btcinr_sessions_merchant ON btcinr_merchant_sessions(merchant_id);
CREATE TABLE btcinr_login_attempts (key text PRIMARY KEY, failures integer NOT NULL, started_at timestamptz NOT NULL);
CREATE TABLE btcinr_requests (
  code text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9_-]{6,64}$'),
  merchant_id text NOT NULL REFERENCES btcinr_merchants(id),
  inr_paise bigint CHECK (inr_paise BETWEEN 1 AND 1000000),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 40),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((inr_paise IS NULL AND expires_at IS NULL) OR (inr_paise IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE TABLE btcinr_rates (
  id uuid PRIMARY KEY,
  paise_per_btc bigint NOT NULL CHECK (paise_per_btc BETWEEN 1 AND 100000000000000),
  source text NOT NULL CHECK (source IN ('coingecko','configured-demo')),
  fetched_at timestamptz NOT NULL,
  UNIQUE(paise_per_btc,source,fetched_at)
);
CREATE TABLE btcinr_quotes (
  id text PRIMARY KEY CHECK (id ~ '^qt_[a-f0-9]{32}$'),
  customer_id text NOT NULL REFERENCES btcinr_customers(id),
  merchant_id text NOT NULL REFERENCES btcinr_merchants(id),
  request_code text NOT NULL REFERENCES btcinr_requests(code),
  rate_id uuid NOT NULL REFERENCES btcinr_rates(id),
  inr_paise bigint NOT NULL CHECK (inr_paise BETWEEN 1 AND 1000000),
  btc_sats bigint NOT NULL CHECK (btc_sats > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE(id,customer_id,merchant_id,request_code,rate_id,inr_paise,btc_sats)
);
CREATE TABLE btcinr_journals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('funding','payment')),
  reference text UNIQUE NOT NULL,
  settlement text NOT NULL DEFAULT 'SIMULATED' CHECK (settlement='SIMULATED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE btcinr_entries (
  journal_id uuid NOT NULL REFERENCES btcinr_journals(id),
  account_id text NOT NULL,
  asset text NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  PRIMARY KEY(journal_id,account_id),
  FOREIGN KEY(account_id,asset) REFERENCES btcinr_accounts(id,asset)
);
CREATE INDEX btcinr_entries_account ON btcinr_entries(account_id);
CREATE TABLE btcinr_payments (
  id text PRIMARY KEY CHECK (id ~ '^pay_[a-f0-9]{32}$'),
  order_id text UNIQUE NOT NULL CHECK (order_id ~ '^ord_[a-f0-9]{32}$'),
  customer_id text NOT NULL REFERENCES btcinr_customers(id),
  merchant_id text NOT NULL REFERENCES btcinr_merchants(id),
  quote_id text UNIQUE NOT NULL,
  request_code text NOT NULL,
  single_use_request_code text UNIQUE REFERENCES btcinr_requests(code),
  rate_id uuid NOT NULL,
  inr_paise bigint NOT NULL,
  btc_sats bigint NOT NULL,
  idempotency_key uuid NOT NULL,
  journal_id uuid UNIQUE NOT NULL REFERENCES btcinr_journals(id),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(customer_id,idempotency_key),
  FOREIGN KEY(quote_id,customer_id,merchant_id,request_code,rate_id,inr_paise,btc_sats)
    REFERENCES btcinr_quotes(id,customer_id,merchant_id,request_code,rate_id,inr_paise,btc_sats),
  CHECK (COALESCE(receipt->>'id'=id AND receipt->>'orderId'=order_id
    AND receipt->>'settlement'='SIMULATED' AND receipt->>'status'='confirmed'
    AND (receipt->>'btcSats')::bigint=btc_sats AND (receipt->>'inrPaise')::bigint=inr_paise,false))
);
CREATE INDEX btcinr_customer_history ON btcinr_payments(customer_id,created_at DESC,id DESC);
CREATE INDEX btcinr_merchant_history ON btcinr_payments(merchant_id,created_at DESC,id DESC);
CREATE TABLE btcinr_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('customer','merchant','system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  settlement text NOT NULL DEFAULT 'SIMULATED' CHECK (settlement='SIMULATED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE btcinr_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event IN ('btcinr:payment','btcinr:balance')),
  customer_id text REFERENCES btcinr_customers(id),
  merchant_id text REFERENCES btcinr_merchants(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
CREATE INDEX btcinr_outbox_pending ON btcinr_outbox(id) WHERE published_at IS NULL;

CREATE FUNCTION btcinr_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_demo_record'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['btcinr_journals','btcinr_entries','btcinr_payments','btcinr_quotes','btcinr_rates','btcinr_requests','btcinr_audit'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION btcinr_immutable()',t);
  END LOOP;
END $$;

CREATE FUNCTION btcinr_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE btcinr_accounts SET balance=balance+NEW.amount,version=version+1 WHERE id=NEW.account_id;
  RETURN NEW;
END $$;
CREATE TRIGGER apply_entry AFTER INSERT ON btcinr_entries FOR EACH ROW EXECUTE FUNCTION btcinr_apply_entry();
CREATE FUNCTION btcinr_check_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT balance FROM btcinr_accounts WHERE id=NEW.id) <> COALESCE((SELECT sum(amount) FROM btcinr_entries WHERE account_id=NEW.id),0)
    THEN RAISE EXCEPTION 'ledger_balance_mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_account AFTER INSERT OR UPDATE ON btcinr_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION btcinr_check_account();

CREATE FUNCTION btcinr_check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j uuid; k text; ref text; n integer; p btcinr_payments%ROWTYPE; BEGIN
  IF TG_TABLE_NAME='btcinr_journals' THEN j:=NEW.id; ELSE j:=NEW.journal_id; END IF;
  SELECT kind,reference INTO k,ref FROM btcinr_journals WHERE id=j;
  SELECT count(*) INTO n FROM btcinr_entries WHERE journal_id=j;
  IF EXISTS(SELECT asset FROM btcinr_entries WHERE journal_id=j GROUP BY asset HAVING sum(amount) <> 0)
    THEN RAISE EXCEPTION 'unbalanced_demo_journal'; END IF;
  IF k='funding' THEN
    IF n<>2 OR NOT EXISTS(SELECT 1 FROM btcinr_entries e JOIN btcinr_customers c ON c.account_id=e.account_id
      WHERE e.journal_id=j AND e.asset='DEMO_BTC' AND e.amount=1000000 AND ref='fund:'||c.id)
      OR NOT EXISTS(SELECT 1 FROM btcinr_entries WHERE journal_id=j AND account_id='system_btc_issuance' AND amount=-1000000)
      THEN RAISE EXCEPTION 'invalid_demo_funding'; END IF;
  ELSE
    SELECT * INTO p FROM btcinr_payments WHERE journal_id=j;
    IF n<>4 OR p.id IS NULL OR ref<>'pay:'||p.id
      OR NOT EXISTS(SELECT 1 FROM btcinr_entries e JOIN btcinr_customers c ON c.account_id=e.account_id WHERE e.journal_id=j AND c.id=p.customer_id AND e.amount=-p.btc_sats)
      OR NOT EXISTS(SELECT 1 FROM btcinr_entries WHERE journal_id=j AND account_id='system_btc_fx' AND amount=p.btc_sats)
      OR NOT EXISTS(SELECT 1 FROM btcinr_entries e JOIN btcinr_merchants m ON m.account_id=e.account_id WHERE e.journal_id=j AND m.id=p.merchant_id AND e.amount=p.inr_paise)
      OR NOT EXISTS(SELECT 1 FROM btcinr_entries WHERE journal_id=j AND account_id='system_inr_fx' AND amount=-p.inr_paise)
      THEN RAISE EXCEPTION 'invalid_demo_payment_journal'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON btcinr_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION btcinr_check_journal();
CREATE CONSTRAINT TRIGGER balanced_entries AFTER INSERT ON btcinr_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION btcinr_check_journal();

CREATE FUNCTION btcinr_check_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r btcinr_rates%ROWTYPE; q btcinr_requests%ROWTYPE; BEGIN
  SELECT * INTO r FROM btcinr_rates WHERE id=NEW.rate_id;
  SELECT * INTO q FROM btcinr_requests WHERE code=NEW.request_code;
  IF NEW.merchant_id<>q.merchant_id OR (q.inr_paise IS NOT NULL AND NEW.inr_paise<>q.inr_paise)
    OR NEW.btc_sats<>ceil(NEW.inr_paise::numeric*100000000/r.paise_per_btc)
    OR NEW.expires_at>NEW.created_at+interval '60 seconds' OR NEW.expires_at>r.fetched_at+interval '120 seconds'
    OR NEW.expires_at<=clock_timestamp() OR r.fetched_at>clock_timestamp()+interval '5 seconds'
    THEN RAISE EXCEPTION 'invalid_demo_quote'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_quote BEFORE INSERT ON btcinr_quotes FOR EACH ROW EXECUTE FUNCTION btcinr_check_quote();
CREATE FUNCTION btcinr_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q btcinr_quotes%ROWTYPE; r btcinr_requests%ROWTYPE; owner_id text; payer_id text; BEGIN
  SELECT * INTO q FROM btcinr_quotes WHERE id=NEW.quote_id;
  SELECT * INTO r FROM btcinr_requests WHERE code=NEW.request_code;
  IF q.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'quote_expired'; END IF;
  IF r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'request_expired'; END IF;
  IF NEW.single_use_request_code IS DISTINCT FROM (CASE WHEN r.inr_paise IS NOT NULL THEN r.code ELSE NULL END)
    THEN RAISE EXCEPTION 'invalid_demo_request'; END IF;
  SELECT owner_player_id INTO owner_id FROM btcinr_merchants WHERE id=NEW.merchant_id;
  SELECT player_id INTO payer_id FROM btcinr_customers WHERE id=NEW.customer_id;
  IF owner_id=payer_id THEN RAISE EXCEPTION 'self_payment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_payment BEFORE INSERT ON btcinr_payments FOR EACH ROW EXECUTE FUNCTION btcinr_check_payment();
