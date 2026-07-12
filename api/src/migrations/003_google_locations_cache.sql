-- 003_google_locations_cache.sql
-- Idempotent, additive-only migration adding a locations cache to google_connections.
-- No DROP statements. Safe to run multiple times.

ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS locations_cache JSONB;
ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS locations_fetched_at TIMESTAMPTZ;
