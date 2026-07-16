-- 010_meta_page_mapping.sql
-- Idempotent, additive-only migration for Meta Page Mapping (V3.21). Adds one
-- row per hotel recording which Facebook Page / Instagram Business account has
-- been confirmed - via auto-match or manual confirmation - as the correct one
-- for that hotel's social monitoring. No DROP statements. No existing data is
-- removed or altered. Safe to run multiple times.

CREATE TABLE IF NOT EXISTS social_page_mappings (
      id SERIAL PRIMARY KEY,
      hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
      facebook_page_id TEXT,
      facebook_page_name TEXT,
      facebook_page_url TEXT,
      instagram_business_account_id TEXT,
      instagram_username TEXT,
      instagram_profile_url TEXT,
      mapping_status TEXT NOT NULL DEFAULT 'not_mapped',
      mapping_confidence INTEGER,
      mapping_source TEXT,
      mapped_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (hotel_id)
    );

CREATE INDEX IF NOT EXISTS idx_social_page_mappings_hotel_id ON social_page_mappings(hotel_id);
