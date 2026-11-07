-- Additive hosting support. Existing identities, ledgers and predictions are untouched.
CREATE TABLE final_block_state (
  id integer PRIMARY KEY CHECK (id = 1),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO final_block_state(id,data) VALUES (1, '{"humans":{},"sessions":{},"wallets":{},"signals":{}}');

CREATE TABLE socket_io_attachments (
  id bigserial UNIQUE,
  created_at timestamptz DEFAULT now(),
  payload bytea
);
CREATE INDEX socket_io_attachments_created ON socket_io_attachments(created_at);
