-- 009_social_activity_monitor.sql
-- Idempotent, additive-only migration for the Social Activity Monitor (v3.14).
-- Turns the Meta connector foundation into real Instagram/Facebook activity
-- monitoring. No DROP statements. No data is removed. Safe to run multiple times.
-- raw_data columns are internal-only and are never returned by any customer-facing
-- API response.

CREATE TABLE IF NOT EXISTS social_activity_snapshots (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    scan_id INTEGER,
    snapshot_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    profile_id TEXT,
    profile_name TEXT,
    profile_url TEXT,
    followers_count INTEGER,
    page_likes_count INTEGER,
    posts_last_7_days INTEGER,
    posts_last_14_days INTEGER,
    posts_last_30_days INTEGER,
    likes_last_30_days INTEGER,
    comments_last_30_days INTEGER,
    avg_likes_per_post_30_days NUMERIC,
    avg_comments_per_post_30_days NUMERIC,
    last_post_date TIMESTAMPTZ,
    days_since_last_post INTEGER,
    best_post_url TEXT,
    best_post_likes INTEGER,
    status TEXT NOT NULL DEFAULT 'access_needed',
    recommended_action TEXT,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS social_posts (
    id SERIAL PRIMARY KEY,
    hotel_id INTEGER NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_post_id TEXT NOT NULL,
    post_url TEXT,
    post_date TIMESTAMPTZ,
    message_preview TEXT,
    media_type TEXT,
    like_count INTEGER,
    comment_count INTEGER,
    share_count INTEGER,
    raw_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, provider, provider_post_id)
  );

CREATE INDEX IF NOT EXISTS idx_social_activity_snapshots_hotel_id ON social_activity_snapshots(hotel_id);
CREATE INDEX IF NOT EXISTS idx_social_activity_snapshots_hotel_provider_date ON social_activity_snapshots(hotel_id, provider, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_hotel_id ON social_posts(hotel_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_post_date ON social_posts(post_date);
