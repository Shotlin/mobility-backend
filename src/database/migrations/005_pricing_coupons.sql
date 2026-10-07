-- 005_pricing_coupons.sql — Raahi Phase 2 (spec 02 §7, spec 04 §3)
-- Fare rules versioned; ALL money in integer paise (spec 04 §3).

CREATE TABLE fare_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version             VARCHAR(24) NOT NULL,
  -- Applicability: city + optional zone + required category.
  city_id             UUID NOT NULL REFERENCES cities(id),
  zone_id             UUID REFERENCES service_zones(id),
  vehicle_category_id UUID NOT NULL REFERENCES vehicle_categories(id),
  -- Money components (spec 02 §7) — BIGINT paise, never float.
  base_fare_paise           BIGINT NOT NULL CHECK (base_fare_paise >= 0),
  min_fare_paise            BIGINT NOT NULL CHECK (min_fare_paise >= 0),
  per_km_paise              BIGINT NOT NULL CHECK (per_km_paise >= 0),
  per_minute_paise          BIGINT NOT NULL DEFAULT 0 CHECK (per_minute_paise >= 0),
  free_waiting_min          SMALLINT NOT NULL DEFAULT 0,
  waiting_per_min_paise     BIGINT NOT NULL DEFAULT 0 CHECK (waiting_per_min_paise >= 0),
  platform_fee_paise        BIGINT NOT NULL DEFAULT 0 CHECK (platform_fee_paise >= 0),
  night_fee_paise           BIGINT NOT NULL DEFAULT 0 CHECK (night_fee_paise >= 0),
  night_window              JSONB, -- {"start":"23:00","end":"05:00"}
  cancellation_fee_paise    BIGINT NOT NULL DEFAULT 0 CHECK (cancellation_fee_paise >= 0),
  -- Driver commission in basis points of fare (spec 02 §8 explicit commission).
  commission_bps            INTEGER NOT NULL DEFAULT 1500 CHECK (commission_bps BETWEEN 0 AND 10000),
  free_cancel_after_pickup_min SMALLINT NOT NULL DEFAULT 3,
  free_cancel_before_assign_s  SMALLINT NOT NULL DEFAULT 120,
  -- Toll/parking policy (spec 02 §7): PASS_THROUGH | INCLUDED | EXCLUDED
  toll_policy        VARCHAR(16) NOT NULL DEFAULT 'PASS_THROUGH',
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to       TIMESTAMPTZ,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fare_rules_toll_chk CHECK (toll_policy IN ('PASS_THROUGH','INCLUDED','EXCLUDED'))
);
-- One active rule per (version, city, zone?, category)
CREATE UNIQUE INDEX fare_rules_active_uidx ON fare_rules
  (version, city_id, vehicle_category_id, coalesce(zone_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;
CREATE INDEX fare_rules_lookup_idx ON fare_rules
  (city_id, vehicle_category_id, is_active, effective_from DESC);

CREATE TABLE surge_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id             UUID NOT NULL REFERENCES cities(id),
  zone_id             UUID REFERENCES service_zones(id),
  vehicle_category_id UUID REFERENCES vehicle_categories(id),
  -- Surge as basis points multiplier: 10000 = 1.0x, 15000 = 1.5x (spec 04 §4)
  multiplier_bps      INTEGER NOT NULL CHECK (multiplier_bps BETWEEN 10000 AND 30000),
  -- Optional time window (null = always)
  days_of_week        SMALLINT[], -- 0=Sunday .. 6=Saturday
  start_time          TIME,
  end_time            TIME,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users(id)
);
CREATE INDEX surge_rules_lookup_idx ON surge_rules (city_id, is_active);

CREATE TABLE coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(32) NOT NULL,
  description       VARCHAR(255),
  -- DISCOUNT: PERCENT (bps) or FLAT (paise), capped.
  discount_type     VARCHAR(8) NOT NULL CHECK (discount_type IN ('PERCENT','FLAT')),
  percent_bps       INTEGER CHECK (percent_bps BETWEEN 0 AND 10000),
  flat_paise        BIGINT CHECK (flat_paise IS NULL OR flat_paise >= 0),
  max_discount_paise BIGINT,
  min_fare_paise    BIGINT NOT NULL DEFAULT 0,
  city_id           UUID REFERENCES cities(id),
  vehicle_category_id UUID REFERENCES vehicle_categories(id),
  first_ride_only   BOOLEAN NOT NULL DEFAULT false,
  max_redemptions_total INTEGER,
  max_redemptions_per_user SMALLINT NOT NULL DEFAULT 1,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to          TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX coupons_code_uidx ON coupons (upper(code)) WHERE is_active;

CREATE TABLE coupon_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id   UUID NOT NULL REFERENCES coupons(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  ride_id     UUID,
  discount_paise BIGINT NOT NULL CHECK (discount_paise >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions (coupon_id, user_id);
