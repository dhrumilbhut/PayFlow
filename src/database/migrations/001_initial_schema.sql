-- ============================================================
-- Migration: 001_initial_schema
-- Description: Core tables for the PayFlow payment system
-- Author: PayFlow Engineering
-- ============================================================
-- This file has two sections:
--   migrate:up   → applied when running  `npm run db:migrate`
--   migrate:down → applied when running  `npm run db:rollback`
--
-- RULES for writing rollbacks:
--   1. Down must exactly undo what Up did — no more, no less
--   2. Down runs in REVERSE order of Up (drop constraints before tables, etc.)
--   3. If Up creates TABLE A then TABLE B (B has FK to A),
--      Down must drop TABLE B first, then TABLE A
--   4. Down should be idempotent too — use IF EXISTS everywhere
-- ============================================================


-- ============================================================
-- migrate:up
-- ============================================================

-- Enable UUID generation extension
-- uuid-ossp provides uuid_generate_v4() for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── payments ─────────────────────────────────────────────────────────────────
-- Core payment record. Every payment starts here as PENDING
-- and transitions through the state machine to SUCCESS or FAILED.
-- UNIQUE on idempotency_key is what enforces "no duplicate payments".
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

-- ── payment_events ────────────────────────────────────────────────────────────
-- Append-only audit trail. Never UPDATE or DELETE from this table.
-- ON DELETE CASCADE: if a payment is deleted, its events go too.
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

-- ── webhook_events ────────────────────────────────────────────────────────────
-- Webhook deduplication table. external_event_id UNIQUE constraint
-- ensures the same webhook can never be processed twice.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_event_id VARCHAR(255) NOT NULL,
  payment_id        UUID         NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  payload           JSONB        NOT NULL DEFAULT '{}',
  processed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_events_external_event_id_unique UNIQUE (external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_payment_id ON webhook_events (payment_id);

-- ── Trigger: auto-update updated_at on payments ───────────────────────────────
-- Instead of manually setting updated_at in every UPDATE query,
-- this trigger fires automatically before any UPDATE on the payments row.
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


-- ============================================================
-- migrate:down
-- ============================================================
-- Reversal order is CRITICAL:
--   webhook_events references payments → drop webhook_events FIRST
--   payment_events references payments → drop payment_events SECOND
--   payments has no FK dependencies   → drop payments LAST
--   Then remove the trigger function
--
-- Why not just DROP SCHEMA CASCADE?
-- Too dangerous — it would nuke everything including schema_migrations.
-- Explicit drops are safer and document exactly what this migration owns.

DROP TRIGGER  IF EXISTS payments_set_updated_at ON payments;
DROP FUNCTION IF EXISTS set_updated_at();

-- Drop indexes explicitly (they'd be dropped with the table anyway,
-- but being explicit makes the rollback self-documenting)
DROP INDEX IF EXISTS idx_webhook_events_payment_id;
DROP INDEX IF EXISTS idx_payment_events_created_at;
DROP INDEX IF EXISTS idx_payment_events_event_type;
DROP INDEX IF EXISTS idx_payment_events_payment_id;
DROP INDEX IF EXISTS idx_payments_created_at;
DROP INDEX IF EXISTS idx_payments_next_retry_at;
DROP INDEX IF EXISTS idx_payments_status;

-- Drop tables in reverse FK dependency order
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS payments;
