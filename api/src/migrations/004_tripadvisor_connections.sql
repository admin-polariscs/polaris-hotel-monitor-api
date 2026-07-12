-- 004_tripadvisor_connections.sql
-- Idempotent, additive-only migration adding Tripadvisor Reputation Signal storage.
-- No DROP statements. Safe to run multiple times.
-- Stores ONLY data returned by the official Tripadvisor Content API. Tripadvisor is never
-- scraped; this table never stores fabricated or scraped reviews, only the limited recent
-- review set the official API returns.

CREATE TABLE IF NOT EXISTS tripadvisor_connections (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL,
  location_id TEXT,
  profile_url TEXT,
  rating NUMERIC,
  review_count INTEGER,
  photos_count INTEGER,
  latest_reviews_limited JSONB,
  status TEXT DEFAULT 'not_configured',
  raw_data JSONB,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tripadvisor_connections_hotel_id ON tripadvisor_connections(hotel_id);
CREATE INDEX IF NOT EXISTS idx_tripadvisor_connections_location_id ON tripadvisor_connections(location_id);
