-- 009_platform_infra.sql — Raahi Phase 2 (spec 04 §1, §15; spec 05 §15; spec 11 §14)
-- Support, notifications, audit, outbox, idempotency, platform controls.

CREATE TABLE support_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id     UUID NOT NULL REFERENCES users(id),
  actor_type   VARCHAR(16) NOT NULL CHECK (actor_type IN ('PASSENGER','DRIVER')),
  ride_id      UUID REFERENCES rides(id),
  payment_intent_id UUID REFERENCES payment_intents(id),
  incident_id  UUID REFERENCES safety_incidents(id),
  category     VARCHAR(40) NOT NULL,
  subject      VARCHAR(160) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_ON_USER','RESOLVED','CLOSED')),
  assigned_to  UUID REFERENCES users(id),
  sla_due_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_actor_idx ON support_tickets (actor_id, created_at DESC);

CREATE TABLE support_ticket_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id),
  author_role VARCHAR(16) NOT NULL,          -- PASSENGER/DRIVER/SUPPORT/SYSTEM
  is_internal BOOLEAN NOT NULL DEFAULT false, -- operator internal notes
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX support_ticket_messages_idx ON support_ticket_messages (ticket_id, created_at);

CREATE TABLE notification_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      UUID NOT NULL,
  channel      VARCHAR(12) NOT NULL CHECK (channel IN ('FCM','SMS','SOCKET','INBOX')),
  template_key VARCHAR(64),
  title        VARCHAR(160),
  body         TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       VARCHAR(12) NOT NULL DEFAULT 'QUEUED'
                 CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  failure_reason VARCHAR(160),
  ride_id      UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notification_logs_user_idx ON notification_logs (user_id, created_at DESC);

-- Notification templates editable from dashboard (spec 11 §14)
CREATE TABLE notification_templates (
  template_key VARCHAR(64) PRIMARY KEY,
  channel      VARCHAR(12) NOT NULL CHECK (channel IN ('FCM','SMS','SOCKET')),
  title        VARCHAR(160) NOT NULL,
  body         TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  updated_by   UUID REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit logs (spec 05 §15): append-only, includes before/after
-- summary, actor, request context, reason for high-risk actions.
CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id      UUID,
  actor_type    VARCHAR(16) NOT NULL DEFAULT 'SYSTEM'
                  CHECK (actor_type IN ('PASSENGER','DRIVER','ADMIN','SYSTEM','PROVIDER')),
  action        VARCHAR(64) NOT NULL,
  target_type   VARCHAR(32),
  target_id     TEXT,
  before_summary JSONB,
  after_summary JSONB,
  reason        TEXT,
  request_id    TEXT,
  trace_id      TEXT,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- ── Outbox (spec 03 §11) — columns match runtime/workers.js poller.
CREATE TABLE outbox_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     VARCHAR(64) NOT NULL,
  aggregate_type VARCHAR(32) NOT NULL,
  aggregate_id   UUID NOT NULL,
  payload        JSONB NOT NULL,
  correlation_id TEXT,
  causation_id   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at   TIMESTAMPTZ
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (created_at)
  WHERE published_at IS NULL;

-- ── Idempotency (spec 06 §8, spec 09 §6) — columns match utils/idempotency.js
CREATE TABLE idempotency_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key               VARCHAR(80) NOT NULL,
  user_id           UUID NOT NULL,
  route             VARCHAR(120),
  request_hash      CHAR(64) NOT NULL,
  status            VARCHAR(12) NOT NULL DEFAULT 'PROCESSING'
                      CHECK (status IN ('PROCESSING','COMPLETE')),
  response_snapshot JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (key, user_id)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ── Platform controls (spec 11 §14) ─────────────────────────────────
CREATE TABLE platform_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seeds: maintenance_mode, min_passenger_app_version, min_driver_app_version
INSERT INTO platform_settings (key, value) VALUES
  ('maintenance_mode', '{"enabled": false}'::jsonb),
  ('min_passenger_app_version', '{"android": "0.0.0", "ios": "0.0.0"}'::jsonb),
  ('min_driver_app_version', '{"android": "0.0.0", "ios": "0.0.0"}'::jsonb),
  ('emergency_config', '{"emergency_number": "112"}'::jsonb);

CREATE TABLE feature_flags (
  flag_key    VARCHAR(64) PRIMARY KEY,
  is_enabled  BOOLEAN NOT NULL DEFAULT false,
  description VARCHAR(255),
  rollout     JSONB NOT NULL DEFAULT '{}'::jsonb, -- {percent, cities:[]}
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Driver live-selfie re-verification checkpoints (spec 10 §12)
CREATE TABLE driver_reverifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID NOT NULL REFERENCES driver_profiles(user_id),
  trigger     VARCHAR(24) NOT NULL CHECK (trigger IN ('RISK_SCORE','RANDOM','OPERATOR','ACCOUNT_SHARING_SUSPECT')),
  status      VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PASSED','FAILED','EXPIRED','MANUAL_REVIEW')),
  selfie_doc_id UUID REFERENCES driver_documents(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

CREATE TRIGGER support_tickets_updated_at BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_templates_updated_at BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER feature_flags_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
