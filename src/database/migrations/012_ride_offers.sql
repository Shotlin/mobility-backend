-- 012_ride_offers.sql — Phase 6 (spec 04 §6)
-- Dispatch offers: state machine, TTL, wave + scoring metadata.
CREATE TABLE ride_offers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id              UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id            UUID NOT NULL REFERENCES users(id),
  vehicle_id           UUID REFERENCES vehicles(id),
  dispatch_wave        SMALLINT NOT NULL DEFAULT 0,
  distance_to_pickup_m INTEGER,
  eta_to_pickup_s      INTEGER,
  scoring              JSONB NOT NULL DEFAULT '{}'::jsonb,
  offered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL,
  responded_at         TIMESTAMPTZ,
  state                VARCHAR(28) NOT NULL DEFAULT 'OFFERED',
  CONSTRAINT ride_offers_state_chk CHECK (state IN
    ('OFFERED','ACCEPTED','DECLINED','EXPIRED','LOST_TO_ANOTHER_DRIVER','CANCELLED'))
);
-- One offer per (ride, driver) — re-offers upsert, never duplicate.
CREATE UNIQUE INDEX ride_offers_ride_driver_uidx ON ride_offers (ride_id, driver_id);
CREATE INDEX ride_offers_driver_idx ON ride_offers (driver_id, state, offered_at DESC);
CREATE INDEX ride_offers_active_idx ON ride_offers (ride_id, state) WHERE state = 'OFFERED';
CREATE INDEX ride_offers_expiry_idx ON ride_offers (expires_at) WHERE state = 'OFFERED';
