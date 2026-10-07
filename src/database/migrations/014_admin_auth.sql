-- 014_admin_auth.sql — Phase 11
-- Dashboard admin credentials: password (bcrypt) + optional TOTP secret for
-- MFA (spec 05 §3: stronger policy + MFA for admins). Passengers/drivers
-- keep password-less OTP login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enforced BOOLEAN NOT NULL DEFAULT false;
