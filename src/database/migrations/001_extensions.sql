-- 001_extensions.sql — Raahi Phase 1
-- Required extensions for the ride-hailing schema (spec 04 §2).
-- PostGIS: geography points for pickup/drop, geometry polygons for service
-- zones, GiST indexes for proximity queries.
CREATE EXTENSION IF NOT EXISTS postgis;
-- pgcrypto: gen_random_uuid() if not provided natively by this PG version.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
