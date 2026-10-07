-- 003_users_auth.sql — Raahi Phase 2 (spec 04 §1, spec 05 §3)
-- Single users table for passengers, drivers and admin roles; device
-- sessions in auth_sessions (rotating refresh, revocation, spec 05 §3).

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      VARCHAR(16) NOT NULL,          -- +919xxxxxxxxx
  full_name       VARCHAR(120),
  email           VARCHAR(255),
  gender          VARCHAR(16),                   -- FEMALE/MALE/OTHER (safety prefs, opt-in)
  -- Canonical role (PASSENGER, DRIVER, SUPER_ADMIN, OPERATIONS, ...).
  -- Legacy tokens are normalized in code, not stored.
  role            VARCHAR(32) NOT NULL DEFAULT 'PASSENGER',
  profile_photo_url TEXT,
  is_blocked      BOOLEAN NOT NULL DEFAULT false,
  blocked_reason  TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  -- Abuse signals (spec 05 §17) — risk controls, not accusations.
  risk_flags      JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_role_chk CHECK (role IN (
    'PASSENGER','DRIVER','SUPER_ADMIN','OPERATIONS','CITY_OPERATIONS',
    'DRIVER_KYC_REVIEWER','FINANCE','SAFETY_OPERATOR','SUPPORT','READ_ONLY_ANALYST'
  ))
);
-- Partial unique: one account per phone per actor kind — admin roles may
-- reuse a phone? No: a phone is one identity; dashboards log into the same
-- identity with role-specific grants.
CREATE UNIQUE INDEX users_phone_uidx ON users (phone_e164);
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE auth_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version    INTEGER NOT NULL DEFAULT 1,
  device_fingerprint CHAR(64),                    -- sha256 hex (utils/session.js)
  ip_address         INET,
  user_agent         TEXT,
  device_type        VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  refresh_token_hash CHAR(64),                    -- sha256 of current refresh token
  is_revoked         BOOLEAN NOT NULL DEFAULT false,
  revoked_at         TIMESTAMPTZ,
  revoked_reason     VARCHAR(64),
  last_active_at     TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE is_revoked = false;
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);
CREATE INDEX auth_sessions_refresh_hash_idx ON auth_sessions (refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
