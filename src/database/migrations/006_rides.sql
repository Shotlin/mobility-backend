-- 006_rides.sql — Raahi Phase 2 (spec 04 §1, §4-§6, §15, §16)
-- Quotes (immutable snapshots), booking requests, rides (state machine),
-- stops, versioned events, sampled location breadcrumbs.
-- Database-level guards for the two catastrophic invariants:
--   * one driver cannot own two active rides
--   * one ride has at most one assigned driver (conditional UPDATE +
--     offer uniqueness; see dispatch service + 50-driver race test)

CREATE TABLE ride_quotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  city_id             UUID NOT NULL REFERENCES cities(id),
  zone_id             UUID REFERENCES service_zones(id),
  vehicle_category_id UUID NOT NULL REFERENCES vehicle_categories(id),
  pickup              geography(Point, 4326) NOT NULL,
  pickup_address      TEXT,
  drop                geography(Point, 4326) NOT NULL,
  drop_address        TEXT,
  -- Route context (spec 04 §4) — provider + road distance/duration.
  route_provider      VARCHAR(24) NOT NULL,          -- ola_maps | cache
  route_distance_m    INTEGER NOT NULL CHECK (route_distance_m > 0),
  route_duration_s    INTEGER NOT NULL CHECK (route_duration_s > 0),
  route_polyline_enc  TEXT,
  -- Money (spec 04 §3: integer paise, no floats, ever).
  base_fare_paise     BIGINT NOT NULL CHECK (base_fare_paise >= 0),
  distance_fare_paise BIGINT NOT NULL CHECK (distance_fare_paise >= 0),
  duration_fare_paise BIGINT NOT NULL DEFAULT 0 CHECK (duration_fare_paise >= 0),
  waiting_paise       BIGINT NOT NULL DEFAULT 0,
  surge_bps           INTEGER NOT NULL DEFAULT 10000 CHECK (surge_bps >= 10000),
  surge_paise         BIGINT NOT NULL DEFAULT 0,
  platform_fee_paise  BIGINT NOT NULL DEFAULT 0,
  night_fee_paise     BIGINT NOT NULL DEFAULT 0,
  toll_paise          BIGINT NOT NULL DEFAULT 0,
  discount_paise      BIGINT NOT NULL DEFAULT 0,
  total_paise         BIGINT NOT NULL CHECK (total_paise >= 0),
  pricing_version     VARCHAR(24) NOT NULL,
  fare_rule_id        UUID REFERENCES fare_rules(id),
  surge_rule_id       UUID REFERENCES surge_rules(id),
  coupon_id           UUID REFERENCES coupons(id),
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ride_quotes_user_idx ON ride_quotes (user_id, created_at DESC);
CREATE INDEX ride_quotes_expiry_idx ON ride_quotes (expires_at);

CREATE TABLE ride_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  quote_id            UUID NOT NULL REFERENCES ride_quotes(id),
  vehicle_category_id UUID NOT NULL REFERENCES vehicle_categories(id),
  payment_method      VARCHAR(16) NOT NULL CHECK (payment_method IN ('CASH','RAZORPAY_UPI')),
  coupon_id           UUID REFERENCES coupons(id),
  -- Immutable booking context (route + breakdown copied from quote at booking).
  booking_snapshot    JSONB NOT NULL,
  idempotency_key     VARCHAR(80),
  cancelled_before_dispatch BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ride_requests_idem_uidx ON ride_requests (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ride_requests_user_idx ON ride_requests (user_id, created_at DESC);

CREATE TABLE rides (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID NOT NULL UNIQUE REFERENCES ride_requests(id),
  passenger_id        UUID NOT NULL REFERENCES users(id),
  driver_id           UUID REFERENCES users(id),
  vehicle_id          UUID REFERENCES vehicles(id),
  vehicle_category_id UUID NOT NULL REFERENCES vehicle_categories(id),
  city_id             UUID NOT NULL REFERENCES cities(id),
  zone_id             UUID REFERENCES service_zones(id),
  quote_id            UUID NOT NULL REFERENCES ride_quotes(id),
  -- Lifecycle (spec 04 §5)
  status              VARCHAR(24) NOT NULL DEFAULT 'SEARCHING',
  search_started_at   TIMESTAMPTZ,
  assigned_at         TIMESTAMPTZ,
  driver_en_route_at  TIMESTAMPTZ,
  driver_arrived_at   TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        UUID REFERENCES users(id),
  cancelled_by_role   VARCHAR(16),
  cancellation_reason VARCHAR(64),
  cancellation_comment TEXT,
  cancellation_fee_paise BIGINT NOT NULL DEFAULT 0,
  -- Geo (spec 04 §2)
  pickup              geography(Point, 4326) NOT NULL,
  pickup_address      TEXT,
  drop                geography(Point, 4326) NOT NULL,
  drop_address        TEXT,
  route_polyline_enc  TEXT,
  route_distance_m    INTEGER NOT NULL,
  route_duration_s    INTEGER NOT NULL,
  -- Fare at completion (server-authoritative; quote is the upfront estimate)
  final_total_paise   BIGINT,
  final_breakdown     JSONB,
  -- Trip PIN (spec 05 §9): server-generated, protected representation,
  -- NEVER sent to the driver. pin_salt + sha256(pin + salt) per attempt cost.
  trip_pin_hash       TEXT,
  trip_pin_salt       TEXT,
  trip_pin_attempts   SMALLINT NOT NULL DEFAULT 0,
  trip_pin_locked_until TIMESTAMPTZ,
  -- Search bookkeeping (spec 11 §5 dispatch monitor)
  search_wave_count   SMALLINT NOT NULL DEFAULT 0,
  no_driver_reason    VARCHAR(64),
  -- Versioning for realtime resync (spec 04 §16)
  ride_version        INTEGER NOT NULL DEFAULT 1,
  payment_method      VARCHAR(16) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rides_status_chk CHECK (status IN
    ('REQUESTED','SEARCHING','ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED',
     'IN_PROGRESS','COMPLETED','CANCELLED','NO_DRIVER_FOUND')),
  CONSTRAINT rides_payment_chk CHECK (payment_method IN ('CASH','RAZORPAY_UPI')),
  CONSTRAINT rides_pin_chk CHECK (
    (trip_pin_hash IS NULL AND trip_pin_salt IS NULL)
    OR (trip_pin_hash IS NOT NULL AND trip_pin_salt IS NOT NULL))
);
CREATE INDEX rides_status_active_idx ON rides (status)
  WHERE status IN ('SEARCHING','ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS');
CREATE INDEX rides_passenger_idx ON rides (passenger_id, created_at DESC);
CREATE INDEX rides_driver_idx ON rides (driver_id, created_at DESC);
CREATE INDEX rides_city_status_idx ON rides (city_id, status, created_at DESC);
-- INVARIANT (spec 04 §15): a driver owns at most one active ride.
CREATE UNIQUE INDEX rides_driver_active_uidx ON rides (driver_id)
  WHERE driver_id IS NOT NULL
    AND status IN ('ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS');

CREATE TABLE ride_stops (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  position    SMALLINT NOT NULL,
  location    geography(Point, 4326) NOT NULL,
  address     TEXT,
  arrived_at  TIMESTAMPTZ,
  UNIQUE (ride_id, position)
);

-- Versioned ride events (spec 04 §16): monotonic per ride; the socket
-- envelope carries ride_version; reconnect resync reads this table.
CREATE TABLE ride_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  ride_version  INTEGER NOT NULL,
  event_type    VARCHAR(48) NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id      UUID,
  actor_role    VARCHAR(16),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ride_id, ride_version)
);
CREATE INDEX ride_events_ride_idx ON ride_events (ride_id, ride_version);

-- Sampled breadcrumbs (spec 04 §11): async batch inserts ONLY — the live
-- path never writes here per event. Partition candidate (spec 04 §17).
CREATE TABLE ride_location_samples (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id   UUID NOT NULL,
  location    geography(Point, 4326) NOT NULL,
  accuracy_m  REAL,
  heading     REAL,
  speed_mps   REAL,
  captured_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ride_location_samples_ride_idx ON ride_location_samples (ride_id, captured_at);

CREATE TRIGGER rides_updated_at BEFORE UPDATE ON rides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
