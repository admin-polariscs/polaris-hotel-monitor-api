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
