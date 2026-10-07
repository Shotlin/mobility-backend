-- 010_rides_request_hash.sql — Phase 5
-- Booking idempotency: payload hash stored beside the idempotency key so a
-- key reused with a DIFFERENT body is rejected (spec 09 §6).
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS request_hash CHAR(64);
