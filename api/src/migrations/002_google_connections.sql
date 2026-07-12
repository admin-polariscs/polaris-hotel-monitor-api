-- 002_google_connections.sql
-- Idempotent, additive-only migration adding Google Business Profile OAuth connections.
-- No DROP statements. Safe to run multiple times.
-- Stores OAuth tokens returned by Google; never populate this file with real credentials.

CREATE TABLE IF NOT EXISTS google_connections (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER REFERENCES hotels(id) ON DELETE SET NULL,
    google_account_id TEXT,
    google_account_name TEXT,
    location_id TEXT,
    location_name TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expiry TIMESTAMPTZ,
    scope TEXT,
    status TEXT DEFAULT 'connected',
    connected_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS idx_google_connections_hotel_id ON google_connections(hotel_id);
CREATE INDEX IF NOT EXISTS idx_google_connections_location_id ON google_connections(location_id);
