-- 002_core_reference.sql — Raahi Phase 2 (spec 04 §1, §2)
-- Cities, service zones (PostGIS polygons), vehicle categories.

-- ── cities ───────────────────────────────────────────────────────────
CREATE TABLE cities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  state         VARCHAR(120),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  -- Bookings enabled (spec 11 §8) — lets ops close a city without deploy.
  bookings_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Default map viewport for dashboards/apps (center + zoom).
  center        geography(Point, 4326),
  default_zoom  SMALLINT,
  timezone      VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX cities_name_state_uidx ON cities (lower(name), lower(coalesce(state, '')));

-- ── service_zones (spec 04 §2: geometry polygon/multipolygon) ────────
CREATE TABLE service_zones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id       UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  boundary      geometry(MultiPolygon, 4326) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  bookings_enabled BOOLEAN NOT NULL DEFAULT true,
  operating_hours JSONB, -- {"mon":[["06:00","23:00"]], ...} null = 24x7
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT service_zones_city_fk FOREIGN KEY (city_id) REFERENCES cities(id)
);
CREATE INDEX service_zones_city_idx ON service_zones (city_id) WHERE is_active;
CREATE INDEX service_zones_boundary_gix ON service_zones USING GIST (boundary);
CREATE UNIQUE INDEX service_zones_city_name_uidx ON service_zones (city_id, lower(name));

-- ── vehicle_categories (Bike/Auto/Cab families; server-driven, spec 13 §6) ──
CREATE TABLE vehicle_categories (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(32) NOT NULL,        -- BIKE, AUTO, CAB, CAB_PRIME...
  display_name   VARCHAR(80) NOT NULL,
  description    VARCHAR(255),
  icon_url       TEXT,
  -- Seating capacity (driver excluded) — Bike 1, Auto 3, Cab 4...
  capacity       SMALLINT NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 8),
  sort_order     SMALLINT NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  -- Eligibility requirements a driver/vehicle must satisfy (spec 11 §7).
  eligibility    JSONB NOT NULL DEFAULT '{}'::jsonb, -- {minVehicleAgeYears, licenceClass, ...}
  feature_flags  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX vehicle_categories_code_uidx ON vehicle_categories (lower(code));

-- ── city-category availability (spec 11 §7: per-city enable/disable) ──
CREATE TABLE city_vehicle_categories (
  city_id             UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  vehicle_category_id UUID NOT NULL REFERENCES vehicle_categories(id) ON DELETE CASCADE,
  zone_ids            UUID[] , -- null = all zones of the city
  is_active           BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (city_id, vehicle_category_id)
);

-- updated_at touch trigger shared by all tables that declare updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cities_updated_at BEFORE UPDATE ON cities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER service_zones_updated_at BEFORE UPDATE ON service_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vehicle_categories_updated_at BEFORE UPDATE ON vehicle_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
