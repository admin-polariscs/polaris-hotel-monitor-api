import express from 'express';
import cors from 'cors';
import { runHotelIntelligence, computeRevenueValue } from './engines/intelligence.js';
import { fetchTripadvisorData, getTripadvisorConnectorStatus, getTripadvisorApiKey, getTripadvisorApiMode, buildTripadvisorOtaEvidenceEntry, TRIPADVISOR_STATUS } from './engines/tripadvisor.js';
import {
    pool,
    normaliseDomain,
    findOrCreateHotel,
    createScan,
    completeScan,
    failScan,
    storeScanResult,
    storeDiscoveredListing,
    storeCompetitor
} from './db.js';

const app = express();
const port = process.env.PORT || 10000;

const allowed = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowed === '*' ? true : allowed.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '2mb' }));

const scans = [];

app.get('/health', (req, res) => {
    res.json({
          ok: true,
          product: 'Polaris Revenue Intelligence',
          version: '3.3.0',
          openai: !!process.env.OPENAI_API_KEY,
          pagespeed: !!process.env.PAGESPEED_API_KEY
    });
});

// Build one scan_results row per dashboard module/section from the intelligence result.
// This mirrors what the dashboard already shows - it does not add any new verification.
function buildSections(result) {
    const website = result.website || {};
    return [
      {
              section: 'overview',
              score: result.scores ? result.scores.overall : null,
              summary: result.entity ? result.entity.name : null,
              data: { entity: result.entity, scores: result.scores, finalUrl: result.finalUrl, generatedAt: result.generatedAt }
      },
      { section: 'website', score: null, summary: null, data: website },
      {
              section: 'booking_journey',
              score: result.scores ? result.scores.booking : null,
              summary: null,
              data: { hasBookingCta: website.hasBookingCta, bookingLinks: website.bookingLinks }
      },
      {
              section: 'performance',
              score: result.scores ? result.scores.performance : null,
              summary: null,
              data: result.performance
      },
      {
              section: 'trust_security',
              score: result.scores ? result.scores.trust : null,
              summary: null,
              data: {
                        hasGAorGTM: website.hasGAorGTM,
                        hasCookieSignals: website.hasCookieSignals,
                        hasHotelSchema: website.hasHotelSchema,
                        metaDescription: website.metaDescription
              }
      },
      { section: 'ota', score: result.scores ? result.scores.ota : null, summary: null, data: result.ota },
      { section: 'reviews', score: null, summary: result.reviews ? result.reviews.note : null, data: result.reviews },
      {
              section: 'ai_visibility',
              score: result.scores ? result.scores.aiVisibility : null,
              summary: null,
              data: result.aiVisibility
      },
      { section: 'competitors', score: null, summary: null, data: result.competitors },
      { section: 'revenue_leaks', score: null, summary: null, data: result.revenueLeaks },
      { section: 'consultant', score: null, summary: result.consultant ? result.consultant.headline : null, data: result.consultant },
        { section: 'ota_evidence', score: null, summary: null, data: result.ota_evidence },
        { section: 'revenue_value', score: result.revenue_value ? result.revenue_value.revenue_opportunity_score : null, summary: result.revenue_value ? result.revenue_value.management_summary : null, data: result.revenue_value }
        ];
}

async function persistScan({ scanRecord, hotelRecord, result }) {
    if (result.entity && result.entity.name) {
          await findOrCreateHotel({ domain: hotelRecord.domain, name: result.entity.name, website: result.finalUrl || hotelRecord.website });
    }

  const sections = buildSections(result);
    for (const section of sections) {
          await storeScanResult({ scanId: scanRecord.id, ...section });
    }

  if (result.ota && Array.isArray(result.ota.items)) {
  for (const item of result.ota.items) {
    await storeDiscoveredListing({
      hotelId: hotelRecord.id,
      platform: item.name,
      url: item.listingUrl || null,
      confidence: item.confidence,
      verified: false,
      status: item.listingUrl ? (item.verificationStatus || 'unverified') : (item.status || 'discovery_candidate'),
      rawData: { ...item, search_query: item.searchQuery || null, search_url: item.searchUrl || null }
    });
  }
}
if (result.competitors && Array.isArray(result.competitors.items)) {
        for (const item of result.competitors.items) {
                if (item.type === 'setup-needed') continue;
                await storeCompetitor({
                          hotelId: hotelRecord.id,
                          name: item.name,
                          website: item.website,
                          city: item.city,
                          platformSource: item.platform || item.source,
                          confidence: item.confidence,
                          distanceKm: item.distanceKm,
                          rawData: item
                });
        }
  }

  await completeScan(scanRecord.id);
}

// Avoids re-hitting the official API on every request/page refresh. A sync within this
// window returns the cached row instead of calling Tripadvisor again, unless force=true.
const TRIPADVISOR_SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

// Reflects the latest CACHED Tripadvisor connector state (from tripadvisor_connections)
// onto the Tripadvisor ota_evidence entry. No live Tripadvisor API call is made here - this
// only reads cached connector state, so it never consumes Tripadvisor quota or scrapes.
async function applyTripadvisorStatusToOtaEvidence(otaEvidence, hotelId) {
      const tripEntryIndex = Array.isArray(otaEvidence) ? otaEvidence.findIndex((e) => e.platform === 'Tripadvisor') : -1;
      if (tripEntryIndex === -1) return otaEvidence;
    
      if (!pool || !hotelId) return otaEvidence;
    
      try {
              const row = await pool.query(
                        'SELECT * FROM tripadvisor_connections WHERE hotel_id = $1 ORDER BY id DESC LIMIT 1',
                        [hotelId]
                      );
              if (!row.rows.length) return otaEvidence;
              const built = buildTripadvisorOtaEvidenceEntry(row.rows[0]);
              if (built) otaEvidence[tripEntryIndex] = built;
      } catch (err) {
              console.error('Failed to check Tripadvisor connector status for ota_evidence:', err.message);
      }
      return otaEvidence;
}

app.post('/scan', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

           const domain = normaliseDomain(url);
    let hotelRecord = null;
    let scanRecord = null;

           if (pool && domain) {
                 try {
                         hotelRecord = await findOrCreateHotel({ domain, name: domain, website: url });
                         scanRecord = await createScan({ hotelId: hotelRecord.id, requestedUrl: url });
                 } catch (dbErr) {
                         console.error('Database write failed (find/create hotel or create scan):', dbErr.message);
                         hotelRecord = null;
                         scanRecord = null;
                 }
           }

           try {
                 const result = await runHotelIntelligence(url);

                     await applyTripadvisorStatusToOtaEvidence(result.ota_evidence, hotelRecord ? hotelRecord.id : null);
                     result.revenue_value = computeRevenueValue({
                                 entity: result.entity,
                                 website: result.website,
                                 performance: result.performance,
                                 scores: result.scores,
                                 revenueLeaks: result.revenueLeaks,
                                 otaEvidence: result.ota_evidence
                     });

      if (pool && scanRecord && hotelRecord) {
              try {
                        await persistScan({ scanRecord, hotelRecord, result });
              } catch (persistErr) {
                        console.error('Database write failed while storing scan results:', persistErr.message);
                        try {
                                    await failScan(scanRecord.id, persistErr.message);
                        } catch (failErr) {
                                    console.error('Failed to mark scan as error after a persistence failure:', failErr.message);
                        }
              }
      }

      scans.unshift({ scanId: result.scanId, date: result.generatedAt, url: result.inputUrl, score: result.scores.overall });
                 res.json(result);
           } catch (err) {
                 if (pool && scanRecord) {
                         try {
                                   await failScan(scanRecord.id, err.message);
                         } catch (failErr) {
                                   console.error('Failed to mark scan as error:', failErr.message);
                         }
                 }
                 res.status(500).json({ error: 'Scan failed', message: err.message });
           }
});

app.get('/history', (req, res) => {
    res.json({ items: scans.slice(0, 50) });
});

app.get('/hotels', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    try {
          const result = await pool.query(
                  'SELECT id, name, website, domain, city, country, created_at, updated_at FROM hotels ORDER BY updated_at DESC LIMIT 200'
                );
          res.json({ items: result.rows });
    } catch (err) {
          res.status(500).json({ error: 'Failed to list hotels', message: err.message });
    }
});

app.get('/hotels/:id', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    try {
          const result = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.params.id]);
          if (!result.rows.length) return res.status(404).json({ error: 'Hotel not found' });
          res.json(result.rows[0]);
    } catch (err) {
          res.status(500).json({ error: 'Failed to fetch hotel', message: err.message });
    }
});

app.get('/hotels/:id/scans', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    try {
          const result = await pool.query(
                  'SELECT id, requested_url, scan_type, status, started_at, completed_at, error_message FROM scans WHERE hotel_id = $1 ORDER BY started_at DESC LIMIT 100',
                  [req.params.id]
                );
          res.json({ items: result.rows });
    } catch (err) {
          res.status(500).json({ error: 'Failed to fetch scans', message: err.message });
    }
});

app.get('/hotels/:id/discovery', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const listings = await pool.query(
      'SELECT id, platform, url, confidence, verified, status, raw_data, first_seen_at, last_seen_at FROM discovered_listings WHERE hotel_id = $1 ORDER BY id DESC LIMIT 100',
      [req.params.id]
    );
    const comps = await pool.query(
      'SELECT id, name, website, city, platform_source, confidence, distance_km, first_seen_at, last_seen_at FROM competitors WHERE hotel_id = $1 ORDER BY id DESC LIMIT 100',
      [req.params.id]
    );
    // Human-readable wording so the frontend/API never implies a search-style candidate is a
    // confirmed OTA listing. Only rows with a real url are described as a listing being found.
    const discoveredListings = listings.rows.map((row) => {
      const message = row.url
        ? (row.verified ? `${row.platform} listing verified` : `${row.platform} listing found (not yet verified)`)
        : `${row.platform} discovery candidate prepared`;
      return { ...row, message };
    });
          // Also surface the latest structured ota_evidence for this hotel (customer-safe
            // wording, revenue relevance and next actions per platform), from the most recent scan.
            let otaEvidence = [];
            try {
                        const otaEvidenceResult = await pool.query(
                                      `SELECT sr.data FROM scan_results sr
                                                 JOIN scans s ON s.id = sr.scan_id
                                                            WHERE s.hotel_id = $1 AND sr.section = 'ota_evidence'
                                                                       ORDER BY sr.id DESC LIMIT 1`,
                                      [req.params.id]
                                    );
                        otaEvidence = otaEvidenceResult.rows.length ? otaEvidenceResult.rows[0].data : [];
            } catch (otaErr) {
                        console.error('Failed to fetch latest ota_evidence:', otaErr.message);
            }
      
            res.json({ discoveredListings, competitors: comps.rows, otaEvidence });
  }
  catch (err) {
    res.status(500).json({ error: 'Failed to fetch discovery data', message: err.message });
  }
});

// Tripadvisor Reputation Signal - official API only (Terra by default, legacy Content API
// as a fallback). Limited recent-review and reputation alert source, not full review
// intelligence. Never scrapes Tripadvisor.
app.get('/tripadvisor/status', (req, res) => {
      res.json(getTripadvisorConnectorStatus());
});

function formatTripadvisorRow(row, source, messageOverride, wordingOverride) {
      const isTerra = row.api_mode === 'terra';
      const defaultLimitedMessage = isTerra
              ? 'Tripadvisor Terra data is available as a limited reputation signal.'
              : 'Tripadvisor data is available as a limited reputation signal.';
      return {
              status: row.status,
              api_mode: row.api_mode || null,
              message: messageOverride || (row.status === TRIPADVISOR_STATUS.LIMITED_DATA_AVAILABLE
                                                 ? defaultLimitedMessage
                                                 : 'Tripadvisor connector not configured yet.'),
              wording: wordingOverride || 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.',
              location_id: row.location_id,
              profile_url: row.profile_url,
              rating: row.rating,
              review_count: row.review_count,
              confidence: row.confidence,
              verified: row.verified,
              limited_recent_reviews: row.limited_recent_reviews || [],
              negative_review_detected: row.negative_review_detected,
              urgent_negative_detected: row.urgent_negative_detected,
              sentiment_summary: row.sentiment_summary,
              recommended_action: row.recommended_action,
              last_synced_at: row.last_synced_at,
              raw_data: row.raw_data,
              source
      };
}

// GET /hotels/:id/tripadvisor - read-only. Returns the cached Tripadvisor Reputation Signal.
// Never calls the live Tripadvisor API - call POST /hotels/:id/tripadvisor/sync to refresh it.
app.get('/hotels/:id/tripadvisor', async (req, res) => {
      if (!pool) return res.status(503).json({ error: 'Database not configured' });
      const hotelId = req.params.id;
    
      if (!getTripadvisorApiKey()) {
              return res.json({
                        status: TRIPADVISOR_STATUS.API_KEY_MISSING,
                        message: 'Tripadvisor connector not configured yet.',
                        wording: 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.',
                        location_id: null,
                        profile_url: null,
                        rating: null,
                        review_count: null,
                        confidence: null,
                        verified: false,
                        limited_recent_reviews: [],
                        negative_review_detected: false,
                        urgent_negative_detected: false,
                        sentiment_summary: null,
                        recommended_action: null,
                        last_synced_at: null,
                        raw_data: null
              });
      }
    
      try {
              const existing = await pool.query(
                        'SELECT * FROM tripadvisor_connections WHERE hotel_id = $1 ORDER BY id DESC LIMIT 1',
                        [hotelId]
                      );
              if (!existing.rows.length) {
                        return res.json({
                                    status: TRIPADVISOR_STATUS.NOT_CONFIGURED,
                                    message: 'No Tripadvisor sync has been run yet for this hotel. Call POST /hotels/:id/tripadvisor/sync first.',
                                    wording: 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.',
                                    location_id: null,
                                    profile_url: null,
                                    rating: null,
                                    review_count: null,
                                    confidence: null,
                                    verified: false,
                                    limited_recent_reviews: [],
                                    negative_review_detected: false,
                                    urgent_negative_detected: false,
                                    sentiment_summary: null,
                                    recommended_action: null,
                                    last_synced_at: null,
                                    raw_data: null
                        });
              }
          
              res.json(formatTripadvisorRow(existing.rows[0], 'cache'));
      } catch (err) {
              console.error('Failed to fetch Tripadvisor data:', err.message);
              res.status(500).json({ status: TRIPADVISOR_STATUS.ERROR, error: 'Failed to fetch Tripadvisor data', message: err.message });
      }
});

// POST /hotels/:id/tripadvisor/sync - the only route that calls the official Tripadvisor
// API. Finds the hotel via name/city/address/phone/website where available, picks the
// best candidate conservatively, fetches details + limited recent reviews, classifies them,
// and caches the result. Never scrapes Tripadvisor. Never fabricates reviews.
app.post('/hotels/:id/tripadvisor/sync', async (req, res) => {
      if (!pool) return res.status(503).json({ error: 'Database not configured' });
      const hotelId = req.params.id;
    
      if (!getTripadvisorApiKey()) {
              return res.json({
                        status: TRIPADVISOR_STATUS.API_KEY_MISSING,
                        message: 'Tripadvisor connector not configured yet.',
                        wording: 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.'
              });
      }
    
      try {
              const hotelResult = await pool.query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
              if (!hotelResult.rows.length) return res.status(404).json({ error: 'Hotel not found' });
              const hotel = hotelResult.rows[0];
          
              const existing = await pool.query(
                        'SELECT * FROM tripadvisor_connections WHERE hotel_id = $1 ORDER BY id DESC LIMIT 1',
                        [hotelId]
                      );
              const force = (req.query && req.query.force === 'true') || (req.body && req.body.force === true);
              if (!force && existing.rows.length && existing.rows[0].last_synced_at) {
                        const ageMs = Date.now() - new Date(existing.rows[0].last_synced_at).getTime();
                        if (ageMs < TRIPADVISOR_SYNC_MIN_INTERVAL_MS) {
                                    return res.json(formatTripadvisorRow(existing.rows[0], 'cache'));
                        }
              }
          
              const entity = {
                        name: hotel.name,
                        city: hotel.city || null,
                        address: hotel.address || null,
                        phone: hotel.phone || null,
                        domain: hotel.domain || null,
                        website: hotel.website || null
              };
              const data = await fetchTripadvisorData(entity);
          
              const insertResult = await pool.query(
                        `INSERT INTO tripadvisor_connections
                                (hotel_id, location_id, profile_url, rating, review_count, photos_count, confidence, verified,
                                         limited_recent_reviews, sentiment_summary, negative_review_detected, urgent_negative_detected,
                                                  recommended_response_needed, recommended_action, status, raw_data, api_mode, last_synced_at, updated_at)
                                                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(), now())
                                                                  RETURNING *`,
                        [
                                    hotelId,
                                    data.location_id,
                                    data.profile_url,
                                    data.rating,
                                    data.review_count,
                                    data.photos_count,
                                    data.confidence,
                                    !!data.verified,
                                    JSON.stringify(data.limited_recent_reviews || []),
                                    JSON.stringify(data.sentiment_summary || null),
                                    !!data.negative_review_detected,
                                    !!data.urgent_negative_detected,
                                    !!data.recommended_response_needed,
                                    data.recommended_action || null,
                                    data.status,
                                    JSON.stringify(data.raw_data || null),
                                    data.api_mode || getTripadvisorApiMode()
                                  ]
                      );
          
              res.json(formatTripadvisorRow(insertResult.rows[0], 'live', data.message, data.wording));
      } catch (err) {
              console.error('Failed to sync Tripadvisor data:', err.message);
              res.status(500).json({ status: TRIPADVISOR_STATUS.ERROR, error: 'Failed to sync Tripadvisor data', message: err.message });
      }
});

// GET /hotels/:id/revenue - latest revenue_value layer for this hotel (from the most
// recent completed scan). Read-only; does not trigger a new scan or any external API call.
app.get('/hotels/:id/revenue', async (req, res) => {
      if (!pool) return res.status(503).json({ error: 'Database not configured' });
      try {
              const result = await pool.query(
                        `SELECT sr.data, s.id as scan_id, s.completed_at, s.started_at
                               FROM scan_results sr
                                      JOIN scans s ON s.id = sr.scan_id
                                             WHERE s.hotel_id = $1 AND sr.section = 'revenue_value'
                                                    ORDER BY sr.id DESC LIMIT 1`,
                        [req.params.id]
                      );
              if (!result.rows.length) {
                        return res.status(404).json({
                                    error: 'No revenue value data found for this hotel yet',
                                    message: 'Run a scan first via POST /scan.'
                        });
              }
              const row = result.rows[0];
              res.json({
                        scanId: row.scan_id,
                        generatedAt: row.completed_at || row.started_at,
                        revenue_value: row.data
              });
      } catch (err) {
              res.status(500).json({ error: 'Failed to fetch revenue value', message: err.message });
      }
});

app.listen(port, () => {
    console.log(`Polaris Revenue Intelligence API v3.3 running on ${port}`);
});
