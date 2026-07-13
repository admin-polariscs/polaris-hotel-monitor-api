-- 006_hotel_contact_page_extraction.sql
-- Idempotent, additive-only migration. Records what was found when the hotel's own
-- public website contact page was discovered and parsed (contact page discovery /
-- NAP extraction), so location resolution can use the hotel's own published address
-- context before falling back to a plain Google Places text search.
-- No DROP statements. No data is removed. Safe to run multiple times.

ALTER TABLE hotels
ADD COLUMN IF NOT EXISTS contact_page_url TEXT,
ADD COLUMN IF NOT EXISTS extracted_address TEXT,
ADD COLUMN IF NOT EXISTS extracted_city TEXT,
ADD COLUMN IF NOT EXISTS extracted_country TEXT,
ADD COLUMN IF NOT EXISTS extracted_phone TEXT,
ADD COLUMN IF NOT EXISTS extracted_email TEXT,
ADD COLUMN IF NOT EXISTS extracted_social_links JSONB,
ADD COLUMN IF NOT EXISTS contact_confidence TEXT;
