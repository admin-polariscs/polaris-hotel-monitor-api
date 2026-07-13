-- 005_hotel_location_confidence.sql
-- Idempotent, additive-only migration. Records how confident we are in a hotel's
-- resolved latitude/longitude (high, medium, low, or NULL for legacy/manual rows),
-- so the API can avoid building a competitive set on top of an unverified location.
-- No DROP statements. No data is removed. Safe to run multiple times.

ALTER TABLE hotels
ADD COLUMN IF NOT EXISTS location_confidence TEXT;
