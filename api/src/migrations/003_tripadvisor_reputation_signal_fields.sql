-- 003_tripadvisor_reputation_signal_fields.sql
-- Idempotent, additive-only migration. Extends tripadvisor_connections with the fields needed
-- for conservative candidate-match confidence, sync verification, and sentiment/alert summary.
-- No DROP statements. No data is removed. Safe to run multiple times.

ALTER TABLE tripadvisor_connections
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS limited_recent_reviews JSONB,
  ADD COLUMN IF NOT EXISTS sentiment_summary JSONB,
  ADD COLUMN IF NOT EXISTS negative_review_detected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS urgent_negative_detected BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recommended_response_needed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recommended_action TEXT;

CREATE INDEX IF NOT EXISTS idx_tripadvisor_connections_verified ON tripadvisor_connections(verified);
