// db.js
// Persistence helpers for hotels, scans, scan_results, discovered_listings and competitors.
// Reads connection info ONLY from the DATABASE_URL environment variable. Never hardcode credentials here.
// All queries in this file are additive (INSERT/UPDATE/SELECT) - no DROP or destructive statements.
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
          connectionString,
          ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
  })
    : null;

// Normalise a hotel URL/domain for matching:
// remove protocol, remove leading www., lowercase, strip path/query/hash and trailing slash.
// Example: https://www.hotelmarivaux.be/rooms/?lang=nl -> hotelmarivaux.be
export function normaliseDomain(inputUrl) {
    if (!inputUrl) return null;
    let value = String(inputUrl).trim().toLowerCase();
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    value = value.replace(/^www\./, '');
    value = value.split(/[/?#]/)[0];
    return value || null;
}

export async function findOrCreateHotel({ domain, name, website }) {
    if (!pool) throw new Error('Database not configured (DATABASE_URL missing)');
    const existing = await pool.query('SELECT * FROM hotels WHERE domain = $1', [domain]);
    if (existing.rows.length) {
          const hotel = existing.rows[0];
          if (name && name !== hotel.name) {
                  const updated = await pool.query(
                            'UPDATE hotels SET name = $1, updated_at = now() WHERE id = $2 RETURNING *',
                            [name, hotel.id]
                          );
                  return updated.rows[0];
          }
          return hotel;
    }
    const inserted = await pool.query(
          'INSERT INTO hotels (name, website, domain) VALUES ($1, $2, $3) RETURNING *',
          [name || domain, website || null, domain]
        );
    return inserted.rows[0];
}

export async function createScan({ hotelId, requestedUrl }) {
    const result = await pool.query(
          "INSERT INTO scans (hotel_id, requested_url, scan_type, status) VALUES ($1, $2, 'full', 'started') RETURNING *",
          [hotelId, requestedUrl]
        );
    return result.rows[0];
}

export async function completeScan(scanId) {
    await pool.query("UPDATE scans SET status = 'completed', completed_at = now() WHERE id = $1", [scanId]);
}

export async function failScan(scanId, errorMessage) {
    await pool.query(
          "UPDATE scans SET status = 'error', completed_at = now(), error_message = $2 WHERE id = $1",
          [scanId, String(errorMessage || 'Unknown error').slice(0, 2000)]
        );
}

export async function storeScanResult({ scanId, section, score, summary, data }) {
    await pool.query(
          'INSERT INTO scan_results (scan_id, section, score, summary, data) VALUES ($1, $2, $3, $4, $5)',
          [scanId, section, score === undefined || score === null ? null : score, summary || null, data === undefined ? null : JSON.stringify(data)]
        );
}

export async function storeDiscoveredListing({ hotelId, platform, url, confidence, verified, status, rawData }) {
    await pool.query(
          'INSERT INTO discovered_listings (hotel_id, platform, url, confidence, verified, status, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [
                  hotelId,
                  platform,
                  url || null,
                  confidence === undefined ? null : confidence,
                  verified === true,
                  status || 'discovered',
                  rawData === undefined ? null : JSON.stringify(rawData)
                ]
        );
}

export async function storeCompetitor({ hotelId, name, website, city, platformSource, confidence, distanceKm, rawData }) {
    await pool.query(
          'INSERT INTO competitors (hotel_id, name, website, city, platform_source, confidence, distance_km, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
                  hotelId,
                  name,
                  website || null,
                  city || null,
                  platformSource || null,
                  confidence === undefined ? null : confidence,
                  distanceKm === undefined ? null : distanceKm,
                  rawData === undefined ? null : JSON.stringify(rawData)
                ]
        );
}

// --- Meta (Facebook Login) connector persistence ------------------------------
// One meta_connections row per hotel (unique on hotel_id). access_token is stored
// already-encrypted by the caller (see engines/metaSocial.js) - this file never
// encrypts/decrypts, it only persists whatever string it is given.

export async function upsertMetaConnection({ hotelId, metaUserId, accessToken, tokenExpiresAt, scopes, status, rawData }) {
    const result = await pool.query(
          `INSERT INTO meta_connections (hotel_id, meta_user_id, access_token, token_expires_at, scopes, status, raw_data)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (hotel_id) DO UPDATE SET
                           meta_user_id = EXCLUDED.meta_user_id,
                                  access_token = EXCLUDED.access_token,
                                         token_expires_at = EXCLUDED.token_expires_at,
                                                scopes = EXCLUDED.scopes,
                                                       status = EXCLUDED.status,
                                                              raw_data = EXCLUDED.raw_data,
                                                                     updated_at = now()
                                                                          RETURNING *`,
          [
                  hotelId,
                  metaUserId || null,
                  accessToken || null,
                  tokenExpiresAt || null,
                  scopes === undefined ? null : JSON.stringify(scopes),
                  status || 'connected',
                  rawData === undefined ? null : JSON.stringify(rawData)
                ]
        );
    return result.rows[0];
}

export async function getMetaConnectionByHotelId(hotelId) {
    const result = await pool.query('SELECT * FROM meta_connections WHERE hotel_id = $1', [hotelId]);
    return result.rows[0] || null;
}

// One social_profiles row per (hotel_id, provider, provider_account_id). Repeated
// syncs update the existing row rather than duplicating it.
export async function upsertSocialProfile({
    hotelId,
    provider,
    profileName,
    profileUrl,
    providerAccountId,
    facebookPageId,
    instagramBusinessAccountId,
    status,
    rawData
}) {
    const result = await pool.query(
          `INSERT INTO social_profiles (
                 hotel_id, provider, profile_name, profile_url, provider_account_id,
                        facebook_page_id, instagram_business_account_id, status, last_synced_at, raw_data
                             )
                                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
                                       ON CONFLICT (hotel_id, provider, provider_account_id) DO UPDATE SET
                                              profile_name = EXCLUDED.profile_name,
                                                     profile_url = EXCLUDED.profile_url,
                                                            facebook_page_id = EXCLUDED.facebook_page_id,
                                                                   instagram_business_account_id = EXCLUDED.instagram_business_account_id,
                                                                          status = EXCLUDED.status,
                                                                                 last_synced_at = now(),
                                                                                        raw_data = EXCLUDED.raw_data,
                                                                                               updated_at = now()
                                                                                                    RETURNING *`,
          [
                  hotelId,
                  provider,
                  profileName || null,
                  profileUrl || null,
                  providerAccountId || null,
                  facebookPageId || null,
                  instagramBusinessAccountId || null,
                  status || 'active',
                  rawData === undefined ? null : JSON.stringify(rawData)
                ]
        );
    return result.rows[0];
}

export async function getSocialProfilesByHotelId(hotelId) {
    const result = await pool.query(
          'SELECT * FROM social_profiles WHERE hotel_id = $1 ORDER BY provider ASC',
          [hotelId]
        );
    return result.rows;
}


// --- Social Activity Monitor (v3.14) persistence -------------------------------
// social_posts is upserted idempotently on (hotel_id, provider, provider_post_id)
// so repeated syncs update existing posts rather than duplicating them.
// social_activity_snapshots gets one new row per sync/scan (append-only history).

export async function upsertSocialPost({
  hotelId,
  provider,
  providerPostId,
  postUrl,
  postDate,
  messagePreview,
  mediaType,
  likeCount,
  commentCount,
  shareCount,
  rawData
}) {
  const result = await pool.query(
    `INSERT INTO social_posts (
    hotel_id, provider, provider_post_id, post_url, post_date, message_preview,
    media_type, like_count, comment_count, share_count, raw_data
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (hotel_id, provider, provider_post_id) DO UPDATE SET
    post_url = EXCLUDED.post_url,
    post_date = EXCLUDED.post_date,
    message_preview = EXCLUDED.message_preview,
    media_type = EXCLUDED.media_type,
    like_count = EXCLUDED.like_count,
    comment_count = EXCLUDED.comment_count,
    share_count = EXCLUDED.share_count,
    raw_data = EXCLUDED.raw_data,
    updated_at = now()
    RETURNING *`,
    [
      hotelId,
      provider,
      providerPostId,
      postUrl || null,
      postDate || null,
      messagePreview || null,
      mediaType || null,
      likeCount === undefined ? null : likeCount,
      commentCount === undefined ? null : commentCount,
      shareCount === undefined ? null : shareCount,
      rawData === undefined ? null : JSON.stringify(rawData)
      ]
    );
  return result.rows[0];
}

export async function insertSocialActivitySnapshot({
  hotelId,
  provider,
  scanId,
  profileId,
  profileName,
  profileUrl,
  followersCount,
  pageLikesCount,
  postsLast7Days,
  postsLast14Days,
  postsLast30Days,
  likesLast30Days,
  commentsLast30Days,
  avgLikesPerPost30Days,
  avgCommentsPerPost30Days,
  lastPostDate,
  daysSinceLastPost,
  bestPostUrl,
  bestPostLikes,
  status,
  recommendedAction,
  rawData
}) {
  const result = await pool.query(
    `INSERT INTO social_activity_snapshots (
    hotel_id, provider, scan_id, profile_id, profile_name, profile_url, followers_count,
    page_likes_count, posts_last_7_days, posts_last_14_days, posts_last_30_days,
    likes_last_30_days, comments_last_30_days, avg_likes_per_post_30_days,
    avg_comments_per_post_30_days, last_post_date, days_since_last_post, best_post_url,
    best_post_likes, status, recommended_action, raw_data
    )
    VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
    )
    RETURNING *`,
    [
      hotelId,
      provider,
      scanId || null,
      profileId || null,
      profileName || null,
      profileUrl || null,
      followersCount === undefined ? null : followersCount,
      pageLikesCount === undefined ? null : pageLikesCount,
      postsLast7Days === undefined ? null : postsLast7Days,
      postsLast14Days === undefined ? null : postsLast14Days,
      postsLast30Days === undefined ? null : postsLast30Days,
      likesLast30Days === undefined ? null : likesLast30Days,
      commentsLast30Days === undefined ? null : commentsLast30Days,
      avgLikesPerPost30Days === undefined ? null : avgLikesPerPost30Days,
      avgCommentsPerPost30Days === undefined ? null : avgCommentsPerPost30Days,
      lastPostDate || null,
      daysSinceLastPost === undefined ? null : daysSinceLastPost,
      bestPostUrl || null,
      bestPostLikes === undefined ? null : bestPostLikes,
      status || 'access_needed',
      recommendedAction || null,
      rawData === undefined ? null : JSON.stringify(rawData)
      ]
    );
  return result.rows[0];
}

// Most recent snapshots for a hotel/provider, newest first. Used to build the
// customer-safe response and to compute trend deltas (row 0 = latest, row 1 = previous).
export async function getRecentSocialActivitySnapshots(hotelId, provider, limit = 2) {
  const result = await pool.query(
    'SELECT * FROM social_activity_snapshots WHERE hotel_id = $1 AND provider = $2 ORDER BY snapshot_date DESC LIMIT $3',
    [hotelId, provider, limit]
    );
  return result.rows;
}
