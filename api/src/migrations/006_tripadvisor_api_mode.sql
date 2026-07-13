-- 006_tripadvisor_api_mode.sql
-- Idempotent, additive-only migration. Records which Tripadvisor API mode (terra or
-- legacy_content_api) produced each cached tripadvisor_connections row, so cached reads via
-- GET /hotels/:id/tripadvisor can show the correct mode-specific customer message.
-- No DROP statements. No data is removed. Safe to run multiple times.

ALTER TABLE tripadvisor_connections
  ADD COLUMN IF NOT EXISTS api_mode TEXT;
