-- 011_competitive_set_quality_layer.sql
-- Idempotent, additive-only migration for V3.23 Competitive Set Quality Layer.
-- Adds subject-hotel profiling columns to hotels (used to separate raw Google
-- Places "nearby hotel candidates" from a scored/classified "competitive set").
-- No DROP statements. No existing data removed or altered. Safe to run multiple times.

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS property_type TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS market_type TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS chain_scale_proxy TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS price_band_proxy TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS positioning_tags JSONB;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS room_count INTEGER;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS meeting_or_mice_signal BOOLEAN;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS fnb_signal BOOLEAN;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS spa_signal BOOLEAN;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS competitive_profile_confidence TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS competitive_profile_source TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS competitive_profile_data_gaps JSONB;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS competitive_profile_updated_at TIMESTAMPTZ;
