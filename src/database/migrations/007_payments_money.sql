-- 007_payments_money.sql — Raahi Phase 2 (spec 04 §1, §3, §7; spec 02 §8)
-- Payment intents/events, refunds, immutable driver ledger.

CREATE TABLE payment_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id           UUID NOT NULL UNIQUE REFERENCES rides(id),
  method            VARCHAR(16) NOT NULL CHECK (method IN ('CASH','RAZORPAY_UPI')),
  status            VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  amount_paise      BIGINT NOT NULL CHECK (amount_paise >= 0),   -- server-authoritative
  currency          VARCHAR(4) NOT NULL DEFAULT 'INR',
  provider          VARCHAR(24),                     -- razorpay
  provider_order_id VARCHAR(64),
  provider_payment_id VARCHAR(64),
  provider_signature TEXT,
  idempotency_key   VARCHAR(80),
  failure_reason    VARCHAR(120),
  captured_at       TIMESTAMPTZ,
  reconciled_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_status_chk CHECK (status IN
    ('PENDING','AUTHORIZED','CAPTURED','FAILED','CASH_DUE','CASH_COLLECTED',
     'REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED'))
);
CREATE INDEX payment_intents_provider_order_idx ON payment_intents (provider_order_id);
CREATE INDEX payment_intents_status_idx ON payment_intents (status) WHERE status IN ('PENDING','AUTHORIZED','CASH_DUE','REFUND_PENDING');

CREATE TABLE payment_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
  event_source      VARCHAR(16) NOT NULL CHECK (event_source IN ('WEBHOOK','API','WORKER')),
  provider_event_id VARCHAR(80),                     -- razorpay event id (dedupe)
  event_type        VARCHAR(48) NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_valid   BOOLEAN,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Webhook replay/dedupe (spec 05 §7, spec 09 §17)
  UNIQUE (payment_intent_id, provider_event_id)
);
CREATE INDEX payment_events_intent_idx ON payment_events (payment_intent_id, processed_at DESC);

CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  reason            VARCHAR(120),
  status            VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  provider_refund_id VARCHAR(64),
  idempotency_key   VARCHAR(80),
  requested_by      UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- ── Driver money (spec 02 §8: ledger generated from completed ride
-- accounting; every money movement represented immutably) ─────────────
CREATE TABLE driver_earnings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id           UUID NOT NULL UNIQUE REFERENCES rides(id),
  driver_id         UUID NOT NULL REFERENCES driver_profiles(user_id),
  fare_total_paise  BIGINT NOT NULL CHECK (fare_total_paise >= 0),
  commission_paise  BIGINT NOT NULL CHECK (commission_paise >= 0),
  net_earning_paise BIGINT NOT NULL CHECK (net_earning_paise >= 0),
  toll_paise        BIGINT NOT NULL DEFAULT 0,
  cancellation_fee_paise BIGINT NOT NULL DEFAULT 0,
  pricing_version   VARCHAR(24) NOT NULL,
  breakdown         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX driver_earnings_driver_idx ON driver_earnings (driver_id, created_at DESC);

-- Append-only ledger. No UPDATE grants in production; corrections are new
-- ADJUSTMENT entries, never mutations (spec 03 §17 invariant).
CREATE TABLE driver_ledger (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id     UUID NOT NULL REFERENCES driver_profiles(user_id),
  entry_type    VARCHAR(24) NOT NULL CHECK (entry_type IN
    ('RIDE_EARNING','COMMISSION','TOLL_REIMBURSEMENT','CANCELLATION_FEE',
     'BONUS','ADJUSTMENT','PAYOUT')),
  amount_paise  BIGINT NOT NULL,           -- signed: positive credit, negative debit
  balance_after_paise BIGINT NOT NULL,
  ride_id       UUID REFERENCES rides(id),
  payout_id     UUID,
  reference     VARCHAR(80),               -- provider payout ref etc.
  description   VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX driver_ledger_driver_idx ON driver_ledger (driver_id, id);

CREATE TABLE driver_payouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         UUID NOT NULL REFERENCES driver_profiles(user_id),
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
  status            VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','HELD')),
  method            VARCHAR(8) NOT NULL DEFAULT 'UPI' CHECK (method IN ('UPI','BANK')),
  provider          VARCHAR(24),
  provider_ref      VARCHAR(80),
  failure_reason    VARCHAR(160),
  period_from       TIMESTAMPTZ,
  period_to         TIMESTAMPTZ,
  approved_by       UUID REFERENCES users(id),  -- four-eyes where required (spec 05 §10)
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX driver_payouts_driver_idx ON driver_payouts (driver_id, created_at DESC);
CREATE INDEX driver_payouts_status_idx ON driver_payouts (status) WHERE status IN ('PENDING','PROCESSING','FAILED');

CREATE TRIGGER payment_intents_updated_at BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
