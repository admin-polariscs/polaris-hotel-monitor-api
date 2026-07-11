-- 001_init.sql
-- Idempotent, additive-only schema for Polaris scan history foundation.
-- No DROP statements. Safe to run multiple times.

CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS hotels (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT,
    domain TEXT,
    city TEXT,
    country TEXT,
    address TEXT,
    phone TEXT,
    google_place_id TEXT,
    booking_engine TEXT,
    latitude NUMERIC,
    longitude NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS scans (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
    requested_url TEXT,
    scan_type TEXT DEFAULT 'full',
    status TEXT DEFAULT 'started',
    started_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ,
    error_message TEXT
  );

CREATE TABLE IF NOT EXISTS scan_results (
    id SERIAL PRIMARY KEY,
    scan_id INTEGER REFERENCES scans(id) ON DELETE CASCADE,
    section TEXT NOT NULL,
    score NUMERIC,
    summary TEXT,
    data JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS discovered_listings (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    url TEXT,
    confidence NUMERIC,
    verified BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'discovered',
    raw_data JSONB,
    first_seen_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at TIMESTAMPTZ DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS competitors (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    website TEXT,
    city TEXT,
    platform_source TEXT,
    confidence NUMERIC,
    distance_km NUMERIC,
    raw_data JSONB,
    first_seen_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at TIMESTAMPTZ DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS idx_hotels_domain ON hotels(domain);
CREATE INDEX IF NOT EXISTS idx_scans_hotel_id ON scans(hotel_id);
CREATE INDEX IF NOT EXISTS idx_scan_results_scan_id ON scan_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_discovered_listings_hotel_id ON discovered_listings(hotel_id);
CREATE INDEX IF NOT EXISTS idx_competitors_hotel_id ON competitors(hotel_id);
