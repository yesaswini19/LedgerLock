-- LedgerLine schema. Safe to re-run. Amounts are integer paise (BIGINT), never floats.
-- Convention: balance = credits - debits for EVERY account, including the EXTERNAL account,
-- so SUM(balance) over all accounts is always 0 (money is never created or lost).

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','holder','auditor')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  actor_id    BIGINT REFERENCES users(id),
  target_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_id_idx ON audit_events (id DESC);

CREATE TABLE IF NOT EXISTS accounts (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   BIGINT REFERENCES users(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','external')),
  balance    BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Backstop: even if application code has a bug, the database refuses a negative customer balance.
  CONSTRAINT no_negative_balance CHECK (kind = 'external' OR balance >= 0),
  CONSTRAINT owner_matches_kind CHECK ((kind = 'customer' AND owner_id IS NOT NULL)
                                    OR (kind = 'external' AND owner_id IS NULL))
);
-- Exactly one EXTERNAL account: the counterparty of every deposit and withdrawal.
CREATE UNIQUE INDEX IF NOT EXISTS one_external_account ON accounts (kind) WHERE kind = 'external';
INSERT INTO accounts (name, kind) SELECT 'EXTERNAL', 'external'
  WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE kind = 'external');

CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','transfer')),
  from_account_id BIGINT NOT NULL REFERENCES accounts(id),
  to_account_id   BIGINT NOT NULL REFERENCES accounts(id),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  initiated_by    BIGINT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  CHECK (from_account_id <> to_account_id),
  UNIQUE (initiated_by, idempotency_key)      -- second line of defence against double posting
);

-- Double-entry: every transaction has one debit row and one credit row of equal amount.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  txn_id        BIGINT NOT NULL REFERENCES transactions(id),
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  balance_after BIGINT NOT NULL,
  initiated_by  BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL,
  prev_hash     TEXT,                          -- hash chain per account: tampering is detectable
  hash          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account_idx ON ledger_entries (account_id, id);

-- Refused attempts and detected duplicate replays. Written outside the money transaction.
CREATE TABLE IF NOT EXISTS attempts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT REFERENCES users(id),
  action          TEXT NOT NULL,
  from_account_id BIGINT,
  to_account_id   BIGINT,
  amount          BIGINT,
  idempotency_key TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('refused','replayed')),
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_from_idx ON attempts (from_account_id);
CREATE INDEX IF NOT EXISTS attempts_to_idx ON attempts (to_account_id);

-- Idempotency: one row per (user, key). Inserted FIRST inside the money transaction,
-- so a concurrent duplicate blocks on the unique index until the first request commits.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id         BIGINT NOT NULL REFERENCES users(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Append-only enforcement: UPDATE, DELETE and TRUNCATE raise an error.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
FOREACH t IN ARRAY ARRAY['ledger_entries','transactions','attempts','audit_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_mutate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t || '_no_mutate', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION audit_transaction_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_events (action, actor_id, target_id, details, created_at)
  VALUES ('money.' || NEW.type, NEW.initiated_by, NEW.id::text,
    jsonb_build_object('fromAccountId', NEW.from_account_id, 'toAccountId', NEW.to_account_id,
      'amount', NEW.amount), NEW.created_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transactions_audit_insert ON transactions;
CREATE TRIGGER transactions_audit_insert AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION audit_transaction_insert();
