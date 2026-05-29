-- Docker PostgreSQL init script
-- This file is executed automatically by the postgres container
-- on first startup (via docker-entrypoint-initdb.d/).
--
-- It simply runs the UP section of our first migration directly.
-- For subsequent migrations (002, 003...), use: npm run db:migrate
-- which connects to the running container.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS payments (
  id               UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  amount           NUMERIC(12, 2)  NOT NULL CHECK (amount > 0),
  status           VARCHAR(32)     NOT NULL DEFAULT 'PENDING',
  idempotency_key  VARCHAR(255)    NOT NULL,
  retry_count      INTEGER         NOT NULL DEFAULT 0,
  max_retries      INTEGER         NOT NULL DEFAULT 3,
  next_retry_at    TIMESTAMP WITH TIME ZONE,
  last_error       TEXT,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT payments_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT payments_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'SUCCESS', 'FAILED')
  )
);

CREATE INDEX IF NOT EXISTS idx_payments_status        ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_next_retry_at ON payments (next_retry_at);
CREATE INDEX IF NOT EXISTS idx_payments_created_at    ON payments (created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id  UUID         NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  event_type  VARCHAR(64)  NOT NULL,
  metadata    JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_event_type ON payment_events (event_type);
CREATE INDEX IF NOT EXISTS idx_payment_events_created_at ON payment_events (created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_event_id VARCHAR(255) NOT NULL,
  payment_id        UUID         NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  payload           JSONB        NOT NULL DEFAULT '{}',
  processed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_events_external_event_id_unique UNIQUE (external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_payment_id ON webhook_events (payment_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Bootstrap the schema_migrations table so `npm run db:migrate`
-- knows migration 001 is already applied.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          SERIAL       PRIMARY KEY,
  filename    VARCHAR(255) NOT NULL UNIQUE,
  checksum    VARCHAR(64)  NOT NULL,
  direction   VARCHAR(4)   NOT NULL DEFAULT 'up',
  executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Mark 001 as applied so the migration runner won't try to run it again.
INSERT INTO schema_migrations (filename, checksum)
VALUES ('001_initial_schema.sql', 'docker-init')
ON CONFLICT (filename) DO NOTHING;
