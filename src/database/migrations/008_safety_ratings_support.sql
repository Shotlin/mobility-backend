-- 008_safety_ratings_support.sql — Raahi Phase 2 (spec 10, spec 02 §2)
-- Safety is a first-class domain: incidents + timeline, Guardian Journey,
-- Women Safety+ settings, trusted Safety Circle, protected destinations.

CREATE TABLE ratings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id      UUID NOT NULL REFERENCES rides(id),
  rater_id     UUID NOT NULL REFERENCES users(id),
  rater_role   VARCHAR(16) NOT NULL CHECK (rater_role IN ('PASSENGER','DRIVER')),
  target_id    UUID NOT NULL REFERENCES users(id),
  target_role  VARCHAR(16) NOT NULL CHECK (target_role IN ('PASSENGER','DRIVER')),
  score        SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment      VARCHAR(500),
  tags         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One rating per direction per ride
  UNIQUE (ride_id, rater_role)
);

-- ── Safety Circle + saved/protected destinations (spec 10 §3, §5, §11) ──
CREATE TABLE user_trusted_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_name VARCHAR(120) NOT NULL,
  phone_e164  VARCHAR(16) NOT NULL,
  relation    VARCHAR(40),
  share_rule  VARCHAR(24) NOT NULL DEFAULT 'SOS_ONLY'
                CHECK (share_rule IN ('SOS_ONLY','NIGHT_RIDES','PROTECTED_DESTINATIONS','ALL_RIDES','GUARDIAN_OVERDUE')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX user_trusted_contacts_user_idx ON user_trusted_contacts (user_id) WHERE is_active;

CREATE TABLE user_saved_places (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(40) NOT NULL,          -- HOME, WORK, HOSTEL, PG, COLLEGE...
  address     TEXT,
  location    geography(Point, 4326) NOT NULL,
  -- Protected destinations enable Guardian defaults + stricter monitoring.
  is_protected BOOLEAN NOT NULL DEFAULT false,
  guardian_default BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, label)
);
CREATE INDEX user_saved_places_user_idx ON user_saved_places (user_id);

CREATE TABLE user_safety_settings (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  women_safety_plus  BOOLEAN NOT NULL DEFAULT false,
  -- Automatic Guardian Journey on night rides / protected destinations
  guardian_night_rides BOOLEAN NOT NULL DEFAULT false,
  guardian_all_rides BOOLEAN NOT NULL DEFAULT false,
  discreet_sos_enabled BOOLEAN NOT NULL DEFAULT true,
  auto_share_with_circle VARCHAR(24) NOT NULL DEFAULT 'SOS_ONLY'
    CHECK (auto_share_with_circle IN ('NEVER','SOS_ONLY','NIGHT_RIDES','ALL_RIDES')),
  anomaly_check_optin BOOLEAN NOT NULL DEFAULT true,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Safety incidents (spec 10 §6, §14) ───────────────────────────────
CREATE TABLE safety_incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       UUID REFERENCES rides(id),
  reporter_id   UUID REFERENCES users(id),
  reporter_role VARCHAR(16) CHECK (reporter_role IN ('PASSENGER','DRIVER','OPERATOR','SYSTEM')),
  other_party_id UUID REFERENCES users(id),  -- driver when passenger reports, etc.
  source        VARCHAR(24) NOT NULL,
  severity      VARCHAR(12) NOT NULL DEFAULT 'MEDIUM',
  status        VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  -- Incident context snapshot (spec 10 §6): ride/user/driver/vehicle ids,
  -- latest location, route context — captured atomically at creation.
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  latest_location geography(Point, 4326),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES users(id),
  resolution_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT safety_source_chk CHECK (source IN
    ('PASSENGER_SOS','DRIVER_SOS','DISCREET_SOS','ROUTE_ANOMALY','UNEXPECTED_STOP',
     'GPS_LOSS','PIN_FAILURES','GUARDIAN_OVERDUE','OPERATOR')),
  CONSTRAINT safety_severity_chk CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT safety_status_chk CHECK (status IN
    ('OPEN','ACKNOWLEDGED','CONTACTING_USER','ESCALATED','EMERGENCY_SERVICES_REFERRED',
     'MONITORING','RESOLVED','CLOSED'))
);
-- SOS dedupe (spec 10 §6/§17): one ACTIVE incident per ride — repeated taps
-- escalate the same incident instead of creating thousands of records.
CREATE UNIQUE INDEX safety_incidents_active_ride_uidx ON safety_incidents (ride_id)
  WHERE ride_id IS NOT NULL AND status NOT IN ('RESOLVED','CLOSED');
-- Ride-less SOS: one active incident per reporter.
CREATE UNIQUE INDEX safety_incidents_active_reporter_uidx ON safety_incidents (reporter_id)
  WHERE ride_id IS NULL AND reporter_id IS NOT NULL AND status NOT IN ('RESOLVED','CLOSED');
CREATE INDEX safety_incidents_open_idx ON safety_incidents (status, severity, created_at DESC)
  WHERE status NOT IN ('RESOLVED','CLOSED');

CREATE TABLE safety_incident_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES safety_incidents(id) ON DELETE CASCADE,
  event_type  VARCHAR(40) NOT NULL,
  actor_id    UUID,
  actor_role  VARCHAR(16),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX safety_incident_events_idx ON safety_incident_events (incident_id, created_at);

-- ── Guardian Journey (spec 10 §4) ────────────────────────────────────
CREATE TABLE guardian_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id         UUID NOT NULL UNIQUE REFERENCES rides(id),
  passenger_id    UUID NOT NULL REFERENCES users(id),
  state           VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  -- Escalation ladder: reminder → second check → trusted contacts → ops
  reminder_count  SMALLINT NOT NULL DEFAULT 0,
  confirmed_safe_at TIMESTAMPTZ,
  escalated_at    TIMESTAMPTZ,
  escalation_level SMALLINT NOT NULL DEFAULT 0,
  confirm_deadline TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guardian_state_chk CHECK (state IN
    ('ACTIVE','CONFIRMED_SAFE','ESCALATED','CANCELLED','CLOSED'))
);
CREATE INDEX guardian_sessions_active_idx ON guardian_sessions (state, confirm_deadline)
  WHERE state = 'ACTIVE';

CREATE TRIGGER safety_incidents_updated_at BEFORE UPDATE ON safety_incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guardian_sessions_updated_at BEFORE UPDATE ON guardian_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_safety_settings_updated_at BEFORE UPDATE ON user_safety_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
