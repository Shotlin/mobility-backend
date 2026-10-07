-- 004_drivers_vehicles.sql — Raahi Phase 2 (spec 04 §1, §8)
-- Driver profiles (operational state SEPARATE from approval state),
-- KYC documents (private storage refs), vehicles, assignments.

CREATE TABLE driver_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Approval / KYC lifecycle (spec 04 §8) — PENDING/APPROVED/SUSPENDED/REJECTED/EXPIRED_DOCUMENTS
  approval_state     VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  approval_changed_at TIMESTAMPTZ,
  approval_note      TEXT,
  -- Operational lifecycle (spec 04 §8) — OFFLINE/ONLINE_IDLE/RIDE_OFFERED/TO_PICKUP/ARRIVED_WAITING/ON_TRIP
  operational_state  VARCHAR(24) NOT NULL DEFAULT 'OFFLINE',
  state_changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Home city; per-zone eligibility derived from zones + assignments.
  city_id            UUID REFERENCES cities(id),
  active_vehicle_id  UUID,                       -- FK added after vehicles exists
  -- Latest persisted location (spec 04 §2: optional durable last_location).
  last_location      geography(Point, 4326),
  last_location_at   TIMESTAMPTZ,
  -- Dispatch controls
  dispatch_blocked_until TIMESTAMPTZ,           -- cooldown after declines/fraud signals
  total_rides        INTEGER NOT NULL DEFAULT 0,
  rating_sum         INTEGER NOT NULL DEFAULT 0,
  rating_count       INTEGER NOT NULL DEFAULT 0,
  cancellation_count INTEGER NOT NULL DEFAULT 0,
  -- Bank/UPI payout details (encrypted fields when sensitive; masked in APIs)
  payout_bank_json   JSONB,
  payout_upi_vpa     VARCHAR(120),
  kyc_verified_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_approval_chk CHECK (approval_state IN
    ('PENDING','APPROVED','SUSPENDED','REJECTED','EXPIRED_DOCUMENTS')),
  CONSTRAINT driver_operational_chk CHECK (operational_state IN
    ('OFFLINE','ONLINE_IDLE','RIDE_OFFERED','TO_PICKUP','ARRIVED_WAITING','ON_TRIP'))
);
CREATE INDEX driver_profiles_approval_idx ON driver_profiles (approval_state);
CREATE INDEX driver_profiles_state_idx ON driver_profiles (operational_state) WHERE operational_state != 'OFFLINE';
CREATE INDEX driver_profiles_city_idx ON driver_profiles (city_id);

CREATE TABLE vehicles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES vehicle_categories(id),
  owner_user_id   UUID NOT NULL REFERENCES users(id),
  make            VARCHAR(60),
  model           VARCHAR(60),
  color           VARCHAR(40),
  registration_number VARCHAR(20) NOT NULL,     -- e.g. KA05H4521
  registration_certificate_verified BOOLEAN NOT NULL DEFAULT false,
  seating_capacity SMALLINT NOT NULL DEFAULT 4,
  model_year      SMALLINT,
  photo_urls      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX vehicles_reg_uidx ON vehicles (upper(registration_number)) WHERE is_active;
CREATE INDEX vehicles_owner_idx ON vehicles (owner_user_id);

ALTER TABLE driver_profiles
  ADD CONSTRAINT driver_profiles_active_vehicle_fk
  FOREIGN KEY (active_vehicle_id) REFERENCES vehicles(id);

CREATE TABLE driver_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES driver_profiles(user_id) ON DELETE CASCADE,
  vehicle_id      UUID REFERENCES vehicles(id), -- RC/insurance/PUC are per-vehicle
  doc_type        VARCHAR(24) NOT NULL,
  -- Private object storage refs (spec 05 §6) — never public CDN URLs.
  storage_provider VARCHAR(24) NOT NULL DEFAULT 'cloudinary',
  storage_public_id VARCHAR(255),
  storage_url_enc TEXT,                          -- encrypted full ref if needed
  document_number_enc TEXT,                      -- encrypted licence/RC numbers
  expiry_date     DATE,
  status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  reviewer_user_id UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_documents_type_chk CHECK (doc_type IN
    ('SELFIE','DRIVING_LICENCE','VEHICLE_RC','INSURANCE','PUC','BANK_OR_UPI')),
  CONSTRAINT driver_documents_status_chk CHECK (status IN
    ('PENDING','APPROVED','REJECTED','EXPIRED'))
);
-- One pending/approved doc per (driver, type, vehicle)
CREATE UNIQUE INDEX driver_documents_type_uidx
  ON driver_documents (driver_id, doc_type, coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('PENDING','APPROVED');
CREATE INDEX driver_documents_expiry_idx ON driver_documents (expiry_date)
  WHERE status = 'APPROVED' AND expiry_date IS NOT NULL;

CREATE TABLE driver_vehicle_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID NOT NULL REFERENCES driver_profiles(user_id),
  vehicle_id  UUID NOT NULL REFERENCES vehicles(id),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);
-- One ACTIVE vehicle per driver (spec 02 §3)
CREATE UNIQUE INDEX driver_vehicle_active_uidx
  ON driver_vehicle_assignments (driver_id) WHERE is_active;

CREATE TRIGGER driver_profiles_updated_at BEFORE UPDATE ON driver_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER driver_documents_updated_at BEFORE UPDATE ON driver_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
