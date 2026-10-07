-- 011_rides_pin_verified.sql — Phase 6
-- Records WHEN the trip PIN was server-verified (gates trip start,
-- spec 05 §8: trip start requires server-verified PIN).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS trip_pin_verified_at TIMESTAMPTZ;

-- Dispatch diagnostics (spec 04 §6): which wave assigned the ride.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS assigned_wave SMALLINT;
