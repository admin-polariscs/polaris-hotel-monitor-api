-- 008_meta_social_connector.sql
-- Idempotent, additive-only migration. Creates the foundation tables for the Meta
-- (Facebook Login) connector: one OAuth connection record per hotel, and the social
-- profiles (Facebook Pages / Instagram Business accounts) discovered for that hotel
-- via the official Meta Graph API. No scraping is ever involved.
-- No DROP statements. No data is removed. Safe to run multiple times.
-- access_token is encrypted by the application layer (AES-256-GCM, keyed from
-- META_APP_SECRET) before it is written here - never stored or returned in plain
-- text, and never sent to the frontend.

CREATE TABLE IF NOT EXISTS meta_connections (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    meta_user_id TEXT,
    access_token TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes JSONB,
    status TEXT NOT NULL DEFAULT 'connected',
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id)
  );

CREATE TABLE IF NOT EXISTS social_profiles (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    profile_name TEXT,
    profile_url TEXT,
    provider_account_id TEXT,
    facebook_page_id TEXT,
    instagram_business_account_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_synced_at TIMESTAMPTZ,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, provider, provider_account_id)
  );

CREATE INDEX IF NOT EXISTS idx_meta_connections_hotel_id ON meta_connections(hotel_id);
CREATE INDEX IF NOT EXISTS idx_social_profiles_hotel_id ON social_profiles(hotel_id);
