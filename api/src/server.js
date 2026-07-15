import express from 'express';
import cors from 'cors';
import { runHotelIntelligence, computeRevenueValue } from './engines/intelligence.js';
import { fetchTripadvisorData, getTripadvisorConnectorStatus, getTripadvisorApiKey, getTripadvisorApiMode, buildTripadvisorOtaEvidenceEntry, TRIPADVISOR_STATUS } from './engines/tripadvisor.js';
import { getCompetitorsConnectorStatus, getGooglePlacesApiKey, resolveHotelLocation, searchNearbyHotels, classifyCompetitor } from './engines/googlePlaces.js';
import { discoverContactPage } from './engines/contactPage.js';
import {
        getMetaConnectorStatus,
        encodeState,
        decodeState,
        buildMetaLoginUrl,
        encryptToken,
        decryptToken,
        exchangeCodeForToken,
        exchangeForLongLivedToken,
        fetchMetaUser,
        fetchFacebookPages,
fetchFacebookPagesWithTokens,
        	fetchFacebookPagePosts,
        	fetchInstagramProfile,
        	fetchInstagramMedia,
        	META_SCOPES
} from './engines/metaSocial.js';
import { computeActivityMetrics, instagramStatus, facebookStatus, recommendedAction, alertForProvider } from './engines/socialActivity.js';
import {
    pool,
    normaliseDomain,
    findOrCreateHotel,
    createScan,
    completeScan,
    failScan,
    storeScanResult,
    storeDiscoveredListing,
    storeCompetitor,
        upsertMetaConnection,
        getMetaConnectionByHotelId,
        upsertSocialProfile,
        getSocialProfilesByHotelId,
        	upsertSocialPost,
        	insertSocialActivitySnapshot,
        	getRecentSocialActivitySnapshots,
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

// GET /competitors/status - Google Places (New) competitor discovery connector status.
// Server-side key only, never exposed to the client. No OAuth/login involved.
app.get('/competitors/status', (req, res) => {
        res.json(getCompetitorsConnectorStatus());
});

// POST /hotels/:id/competitors/discover - finds potential hotel competitors within
// 20km of the hotel using Google Places API (New). Scores and classifies each result
// instead of returning every nearby hotel as a competitor.
app.post('/hotels/:id/competitors/discover', async (req, res) => {
        if (!pool) return res.status(503).json({ error: 'Database not configured' });
        const hotelId = req.params.id;

             if (!getGooglePlacesApiKey()) {
                         return res.json({
                                         status: 'not_configured',
                                         message: 'Google Places competitor discovery is not configured yet.'
                         });
             }

             try {
                         const hotelResult = await pool.query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
                         if (!hotelResult.rows.length) return res.status(404).json({ error: 'Hotel not found' });
                         const hotel = hotelResult.rows[0];

            let lat = hotel.latitude !== null ? Number(hotel.latitude) : null;
                 let lng = hotel.longitude !== null ? Number(hotel.longitude) : null;
                 let locationSource = 'stored';
                 let locationConfidence = hotel.location_confidence || null;
                 let contactPageUrl = hotel.contact_page_url || null;
                 
                 if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                     const contact = await discoverContactPage(hotel);
                     
                     if (contact) {
                         contactPageUrl = contact.contact_page_url;
                         await pool.query(
                             `UPDATE hotels SET
                             contact_page_url = $1,
                             extracted_address = $2,
                             extracted_city = $3,
                             extracted_country = $4,
                             extracted_phone = $5,
                             extracted_email = $6,
                             extracted_social_links = $7,
                             contact_confidence = $8,
                             updated_at = now()
                             WHERE id = $9`,
                             [
                                 contact.contact_page_url || null,
                                 contact.extracted_address || null,
                                 contact.extracted_city || null,
                                 contact.extracted_country || null,
                                 contact.extracted_phone || null,
                                 contact.extracted_email || null,
                                 contact.extracted_social_links ? JSON.stringify(contact.extracted_social_links) : null,
                                 contact.contact_confidence || null,
                                 hotelId
                                 ]
                             );
                     }
                     
                     const contactGaveDirectLatLng = !!(contact && Number.isFinite(contact.extracted_lat) && Number.isFinite(contact.extracted_lng));
                     const contactGaveAddressContext = !!(contact && (contact.extracted_address || contact.extracted_city || contact.extracted_country));
                     
                     if (contactGaveDirectLatLng) {
                         lat = contact.extracted_lat;
                         lng = contact.extracted_lng;
                         locationSource = 'structured_data';
                         locationConfidence = 'high';
                         
                         await pool.query(
                             `UPDATE hotels SET
                             latitude = $1,
                             longitude = $2,
                             address = COALESCE(address, $3),
                             city = COALESCE(city, $4),
                             country = COALESCE(country, $5),
                             location_confidence = $6,
                             updated_at = now()
                             WHERE id = $7`,
                             [lat, lng, contact.extracted_address || null, contact.extracted_city || null, contact.extracted_country || null, locationConfidence, hotelId]
                             );
                     } else {
                         const hotelForQuery = contactGaveAddressContext ? {
                             ...hotel,
                             address: hotel.address || contact.extracted_address || null,
                             city: hotel.city || (contact.extracted_postal_code ? `${contact.extracted_postal_code} ${contact.extracted_city || ''}`.trim() : contact.extracted_city) || null,
                             country: hotel.country || contact.extracted_country || null
                         } : hotel;
                         
                         const resolved = await resolveHotelLocation(hotelForQuery);
                         const top = resolved && resolved.top ? resolved.top : null;
                         
                         if (!top || top.confidence === 'low') {
                             await pool.query(
                                 "UPDATE hotels SET location_confidence = 'low', updated_at = now() WHERE id = $1",
                                 [hotelId]
                                 );
                             return res.json({
                                 status: 'location_needs_verification',
                                 message: 'Hotel location needs verification before competitive set discovery.',
                                 location_confidence: 'low',
                                 location_source: 'needs_verification',
                                 contact_page_url: contactPageUrl,
                                 candidate_matches: (resolved ? resolved.candidates : []).map((c) => ({
                                     place_id: c.place_id,
                                     name: c.name,
                                     formatted_address: c.formatted_address,
                                     website: c.website,
                                     lat: c.lat,
                                     lng: c.lng,
                                     confidence: c.confidence,
                                     reasons: c.reasons
                                 }))
                             });
                         }
                         
                         lat = top.lat;
                         lng = top.lng;
                         locationConfidence = top.confidence;
                         locationSource = contactGaveAddressContext ? 'contact_page_plus_google_places' : 'google_places_verified';
                         
                         await pool.query(
                             `UPDATE hotels SET
                             latitude = $1,
                             longitude = $2,
                             google_place_id = $3,
                             address = COALESCE(address, $4),
                             city = COALESCE(city, $5),
                             country = COALESCE(country, $6),
                             location_confidence = $7,
                             updated_at = now()
                             WHERE id = $8`,
                             [
                                 lat,
                                 lng,
                                 top.place_id || null,
                                 top.formatted_address || null,
                                 top.city_component || null,
                                 top.country_component || null,
                                 locationConfidence,
                                 hotelId
                                 ]
                             );
                     }
                 } else if (locationSource === 'stored' && !locationConfidence) {
                     // Pre-existing stored coordinates from before location verification was introduced.
                     // Trusted as-is so we don't break hotels that were already working correctly.
                     locationConfidence = 'high';
                 }
                 
                 const MAX_RAW_CANDIDATES = 60;
                 const MAX_PRIMARY = 5;
                 const MAX_SECONDARY = 7;
                 const MAX_VISIBLE_TOTAL = 12;

    const rawCandidates = (await searchNearbyHotels(lat, lng, 20000)).slice(0, MAX_RAW_CANDIDATES);
                 const classified = rawCandidates.map((c) => classifyCompetitor(c, hotel, { lat, lng }));

    const byRank = (a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        const da = a.distance_km === null ? Infinity : a.distance_km;
        const db = b.distance_km === null ? Infinity : b.distance_km;
        return da - db;
    };

    const primaryAll = classified.filter((c) => c.competitor_type === 'primary_competitor').sort(byRank);
                 const secondaryAll = classified.filter((c) => c.competitor_type === 'secondary_competitor').sort(byRank);
                 const nearbyNotComparable = classified.filter((c) => c.competitor_type === 'nearby_not_comparable').sort(byRank);
                 const excludedList = classified.filter((c) => c.competitor_type === 'excluded');

    const primaryVisible = primaryAll.slice(0, MAX_PRIMARY);
                 let secondaryVisible = secondaryAll.slice(0, MAX_SECONDARY);
                 if (primaryVisible.length + secondaryVisible.length > MAX_VISIBLE_TOTAL) {
                     secondaryVisible = secondaryVisible.slice(0, Math.max(0, MAX_VISIBLE_TOTAL - primaryVisible.length));
                 }

    // Idempotent by design: replace this hotel's Google Places competitive set rather
    // than appending, so repeated discover calls update instead of duplicating rows.
    // Only useful candidates (primary/secondary) are persisted - nearby_not_comparable
    // and excluded are returned in the response for transparency only, never stored.
    await pool.query(
        "DELETE FROM competitors WHERE hotel_id = $1 AND platform_source = 'google_places'",
        [hotelId]
        );

    for (const item of [...primaryVisible, ...secondaryVisible]) {
        await storeCompetitor({
            hotelId,
            name: item.name,
            website: item.website || null,
            city: hotel.city || null,
            platformSource: 'google_places',
            confidence: item.confidence,
            distanceKm: item.distance_km,
            rawData: item
        });
    }

    res.json({
        hotel_id: Number(hotelId),
        location_source: locationSource,
        location_confidence: locationConfidence,
        contact_page_url: contactPageUrl,
        primary_competitors: primaryVisible,
        secondary_competitors: secondaryVisible,
        nearby_not_comparable: nearbyNotComparable,
        excluded: excludedList,
        summary: {
            raw_candidates_found: rawCandidates.length,
            primary_count: primaryVisible.length,
            secondary_count: secondaryVisible.length,
            nearby_not_comparable_count: nearbyNotComparable.length,
            excluded_count: excludedList.length
        }
    });
             } catch (err) {
                 console.error('Competitor discovery error', err);
                 res.status(500).json({ error: 'Failed to discover competitors', message: err.message });
             }
});

// GET /hotels/:id/competitors - cached Google Places competitive set for this hotel.
// Read-only; never makes a live API call. Call the /discover endpoint above to refresh.
// Only primary/secondary competitors are ever persisted (excluded rows are never stored).
app.get('/hotels/:id/competitors', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    try {
        const result = await pool.query(
            "SELECT id, name, website, city, platform_source, confidence, distance_km, raw_data, first_seen_at, last_seen_at FROM competitors WHERE hotel_id = $1 AND platform_source = 'google_places' ORDER BY confidence DESC NULLS LAST, distance_km ASC NULLS LAST",
            [req.params.id]
            );
        const rows = result.rows;
        const primary = rows.filter((r) => r.raw_data && r.raw_data.competitor_type === 'primary_competitor');
        const secondary = rows.filter((r) => r.raw_data && r.raw_data.competitor_type === 'secondary_competitor');
        res.json({
            hotel_id: Number(req.params.id),
            primary_competitors: primary,
            secondary_competitors: secondary,
            summary: {
                primary_count: primary.length,
                secondary_count: secondary.length
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch competitors', message: err.message });
    }
});

// PATCH /hotels/:id/profile - updates basic hotel profile fields (name/address/city/
// country/phone). Generic and reusable - needed so a hotel's own city/country/address
// context can be recorded and used by location resolution. Text fields only.
app.patch('/hotels/:id/profile', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const hotelId = req.params.id;
    const { name, address, city, country, phone } = req.body || {};
    
    const fields = [];
    const values = [];
    let i = 1;
    if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
    if (address !== undefined) { fields.push(`address = $${i++}`); values.push(address); }
    if (city !== undefined) { fields.push(`city = $${i++}`); values.push(city); }
    if (country !== undefined) { fields.push(`country = $${i++}`); values.push(country); }
    if (phone !== undefined) { fields.push(`phone = $${i++}`); values.push(phone); }
    
    if (!fields.length) {
        return res.status(400).json({ error: 'No profile fields provided. Accepted fields: name, address, city, country, phone.' });
    }
    
    try {
        values.push(hotelId);
        const result = await pool.query(
            `UPDATE hotels SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
            values
            );
        if (!result.rows.length) return res.status(404).json({ error: 'Hotel not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update hotel profile', message: err.message });
    }
});

// POST /hotels/:id/competitors/reset-location - clears a hotel's resolved location
// (latitude/longitude/google_place_id/location_confidence) and deletes its previously
// discovered google_places competitor rows. Generic/reusable for correcting any hotel
// with bad geo data, not specific to any single property.
app.post('/hotels/:id/competitors/reset-location', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const hotelId = req.params.id;
    
    try {
        const hotelResult = await pool.query(
            `UPDATE hotels SET
            latitude = NULL,
            longitude = NULL,
            google_place_id = NULL,
            location_confidence = NULL,
            updated_at = now()
            WHERE id = $1
            RETURNING *`,
            [hotelId]
            );
        if (!hotelResult.rows.length) return res.status(404).json({ error: 'Hotel not found' });
        
        const deleted = await pool.query(
            "DELETE FROM competitors WHERE hotel_id = $1 AND platform_source = 'google_places' RETURNING id",
            [hotelId]
            );
        
        res.json({
            hotel_id: Number(hotelId),
            location_cleared: true,
            competitors_deleted: deleted.rows.length
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset hotel location', message: err.message });
    }
});

// GET /meta/status - customer/ops-safe connector status. Never returns the app
// secret or any token, only whether the connector is configured.
app.get('/meta/status', (req, res) => {
        res.json(getMetaConnectorStatus());
});

// GET /connect/meta?hotelId=:id - starts the Meta Login flow for a given hotel.
// hotelId is embedded in a signed state string so /oauth/meta/callback can recover
// it safely. Redirects the browser to Meta's own login/consent screen.
app.get('/connect/meta', (req, res) => {
        const status = getMetaConnectorStatus();
        if (!status.configured) {
                    return res.status(503).json({ error: 'Meta connector not configured', status: 'missing_env' });
        }
        const hotelId = req.query.hotelId || null;
        const state = encodeState(hotelId);
        res.redirect(buildMetaLoginUrl(state));
});

// GET /oauth/meta/callback - Meta redirects here after login/consent. Exchanges
// the authorization code for an access token server-side (never in the browser),
// extends it to a long-lived token where possible, and stores the connection.
// Responds with a small, non-technical confirmation page - never with the token.
app.get('/oauth/meta/callback', async (req, res) => {
        const status = getMetaConnectorStatus();
        if (!status.configured) {
                    return res.status(503).send('Meta connection is not available right now. Please try again later.');
        }
    
        const { code, state, error: metaError } = req.query;
    
        if (metaError) {
                    return res.status(200).send('Meta connection was not completed. You can close this window and try again from your dashboard.');
        }
        if (!code) {
                    return res.status(400).send('Meta connection is missing required information. Please try again from your dashboard.');
        }
    
        const { hotelId, invalid } = decodeState(state);
        if (invalid || !hotelId) {
                    return res.status(400).send('Meta connection could not be verified. Please restart the connection from your dashboard.');
        }
        if (!pool) return res.status(503).send('This service is not fully configured yet. Please try again later.');
    
        try {
                    const tokenResult = await exchangeCodeForToken(code);
                    let accessToken = tokenResult.access_token;
                    let expiresInSeconds = tokenResult.expires_in || null;
            
                    try {
                                    const longLived = await exchangeForLongLivedToken(accessToken);
                                    if (longLived && longLived.access_token) {
                                                        accessToken = longLived.access_token;
                                                        expiresInSeconds = longLived.expires_in || expiresInSeconds;
                                    }
                    } catch (longLivedErr) {
                                    // Non-fatal: keep the short-lived token if the long-lived exchange fails.
                                    console.error('Meta long-lived token exchange failed', longLivedErr.message);
                    }
            
                    const metaUser = await fetchMetaUser(accessToken).catch(() => null);
                    const tokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
            
                    await upsertMetaConnection({
                                    hotelId,
                                    metaUserId: metaUser ? metaUser.id : null,
                                    accessToken: encryptToken(accessToken),
                                    tokenExpiresAt,
                                    scopes: META_SCOPES,
                                    status: 'connected',
                                    rawData: { meta_user_name: metaUser ? metaUser.name : null }
                    });
            
                    res.status(200).send('Your Meta account is connected. You can close this window and return to your dashboard.');
        } catch (err) {
                    console.error('Meta OAuth callback error', err.message);
                    res.status(500).send('We could not complete the Meta connection. Please try again from your dashboard.');
        }
});

// --- Social Activity Monitor (v3.14) helpers -----------------------------------
// Normalizes a raw Facebook Page post into the shape computeActivityMetrics expects.
function normalizeFacebookPost(post) {
        const reactions = post.reactions && post.reactions.summary ? post.reactions.summary.total_count : null;
        const comments = post.comments && post.comments.summary ? post.comments.summary.total_count : null;
        const shares = post.shares ? post.shares.count : null;
        return {
                id: post.id,
                date: post.created_time ? new Date(post.created_time) : null,
                likeCount: reactions || 0,
                commentCount: comments || 0,
                shareCount: shares || 0,
                url: post.permalink_url || null,
                mediaType: 'post',
                captionPreview: post.message ? String(post.message).slice(0, 140) : null
        };
}

// Normalizes a raw Instagram media item into the shape computeActivityMetrics expects.
function normalizeInstagramMedia(media) {
        return {
                id: media.id,
                date: media.timestamp ? new Date(media.timestamp) : null,
                likeCount: media.like_count || 0,
                commentCount: media.comments_count || 0,
                shareCount: 0,
                url: media.permalink || null,
                mediaType: media.media_type || null,
                captionPreview: media.caption ? String(media.caption).slice(0, 140) : null
        };
}

// Persists normalized posts idempotently and returns the computed metrics/status
// for one provider. Never throws - permission/API errors are caught by the caller.
async function syncProviderActivity({ hotelId, provider, profileId, profileName, profileUrl, followersCount, pageLikesCount, posts }) {
        for (const post of posts) {
                if (!post.id) continue;
                await upsertSocialPost({
                        hotelId,
                        provider,
                        providerPostId: String(post.id),
                        postUrl: post.url,
                        postDate: post.date,
                        messagePreview: post.captionPreview,
                        mediaType: post.mediaType,
                        likeCount: post.likeCount,
                        commentCount: post.commentCount,
                        shareCount: post.shareCount,
                        rawData: { id: post.id }
                });
        }
        
        const metrics = computeActivityMetrics(posts);
        const status = provider === 'instagram' ? instagramStatus(metrics) : facebookStatus(metrics);
        const action = recommendedAction(provider, status);
        
        const snapshot = await insertSocialActivitySnapshot({
                hotelId,
                provider,
                profileId,
                profileName,
                profileUrl,
                followersCount,
                pageLikesCount,
                postsLast7Days: metrics.posts_last_7_days,
                postsLast14Days: metrics.posts_last_14_days,
                postsLast30Days: metrics.posts_last_30_days,
                likesLast30Days: metrics.likes_last_30_days,
                commentsLast30Days: metrics.comments_last_30_days,
                avgLikesPerPost30Days: metrics.avg_likes_per_post_30_days,
                avgCommentsPerPost30Days: metrics.avg_comments_per_post_30_days,
                lastPostDate: metrics.last_post_date,
                daysSinceLastPost: metrics.days_since_last_post,
                bestPostUrl: metrics.best_post_url,
                bestPostLikes: metrics.best_post_likes,
                status,
                recommendedAction: action,
                rawData: null
        });
        
        return snapshot;
}

// Builds the customer-safe detail block for one provider from its latest snapshot.
// monitoring_active is only ever true when a snapshot with real post data exists.
function buildProviderDetail(provider, profileFromDb, snapshots) {
        const latest = snapshots && snapshots.length ? snapshots[0] : null;
        const monitoringActive = !!(latest && ['ok', 'warning', 'critical'].includes(latest.status));
        
        if (!monitoringActive) {
                return {
                        profile_found: !!profileFromDb,
                        monitoring_active: false,
                        profile_url: profileFromDb ? profileFromDb.profile_url : null,
                        status: latest ? latest.status : 'access_needed'
                };
        }
        
        return {
                profile_found: true,
                monitoring_active: true,
                profile_url: latest.profile_url,
                followers_count: latest.followers_count !== null ? Number(latest.followers_count) : null,
                last_post_date: latest.last_post_date,
                days_since_last_post: latest.days_since_last_post,
                posts_last_14_days: latest.posts_last_14_days,
                posts_last_30_days: latest.posts_last_30_days,
                likes_last_30_days: latest.likes_last_30_days,
                avg_likes_per_post_30_days: latest.avg_likes_per_post_30_days !== null ? Number(latest.avg_likes_per_post_30_days) : null,
                comments_last_30_days: latest.comments_last_30_days,
                status: latest.status,
                recommended_action: latest.recommended_action
        };
}

function buildTrend(igSnapshots, fbSnapshots) {
        function totals(snapshots) {
                const latest = snapshots && snapshots.length ? snapshots[0] : null;
                if (!latest || !['ok', 'warning', 'critical'].includes(latest.status)) return null;
                return {
                        followers: latest.followers_count !== null ? Number(latest.followers_count) : 0,
                        avgLikes: latest.avg_likes_per_post_30_days !== null ? Number(latest.avg_likes_per_post_30_days) : 0,
                        posts30: latest.posts_last_30_days || 0
                };
        }
        function previousTotals(snapshots) {
                const previous = snapshots && snapshots.length > 1 ? snapshots[1] : null;
                if (!previous || !['ok', 'warning', 'critical'].includes(previous.status)) return null;
                return {
                        followers: previous.followers_count !== null ? Number(previous.followers_count) : 0,
                        avgLikes: previous.avg_likes_per_post_30_days !== null ? Number(previous.avg_likes_per_post_30_days) : 0,
                        posts30: previous.posts_last_30_days || 0
                };
        }
        
        const currentIg = totals(igSnapshots);
        const currentFb = totals(fbSnapshots);
        const previousIg = previousTotals(igSnapshots);
        const previousFb = previousTotals(fbSnapshots);
        
        if ((!currentIg && !currentFb) || (!previousIg && !previousFb)) return null;
        
        const currentFollowers = (currentIg ? currentIg.followers : 0) + (currentFb ? currentFb.followers : 0);
        const previousFollowers = (previousIg ? previousIg.followers : 0) + (previousFb ? previousFb.followers : 0);
        const currentPosts = (currentIg ? currentIg.posts30 : 0) + (currentFb ? currentFb.posts30 : 0);
        const previousPosts = (previousIg ? previousIg.posts30 : 0) + (previousFb ? previousFb.posts30 : 0);
        
        const currentAvgLikesValues = [currentIg, currentFb].filter(Boolean).map((v) => v.avgLikes);
        const previousAvgLikesValues = [previousIg, previousFb].filter(Boolean).map((v) => v.avgLikes);
        const currentAvgLikes = currentAvgLikesValues.length ? currentAvgLikesValues.reduce((a, b) => a + b, 0) / currentAvgLikesValues.length : 0;
        const previousAvgLikes = previousAvgLikesValues.length ? previousAvgLikesValues.reduce((a, b) => a + b, 0) / previousAvgLikesValues.length : 0;
        
        return {
                followers_delta_since_previous_scan: currentFollowers - previousFollowers,
                avg_likes_delta_since_previous_scan: Math.round((currentAvgLikes - previousAvgLikes) * 10) / 10,
                posting_frequency_delta: currentPosts - previousPosts
        };
}

// GET /hotels/:id/social - customer-safe connection/monitoring status for a hotel.
// Never returns tokens, scopes, or raw Graph API data.
app.get('/hotels/:id/social', async (req, res) => {
        if (!pool) return res.status(503).json({ error: 'Database not configured' });
        const hotelId = req.params.id;
        
        try {
                const connection = await getMetaConnectionByHotelId(hotelId);
                const profiles = await getSocialProfilesByHotelId(hotelId);
                
                if (!connection || connection.status !== 'connected') {
                        return res.json({
                                status: 'access_needed',
                                instagram: { profile_found: false, profile_url: null, monitoring_active: false },
                                facebook: { profile_found: false, profile_url: null, monitoring_active: false },
                                message: 'Meta access needed'
                        });
                }
                
                const facebookProfile = profiles.find((p) => p.provider === 'facebook') || null;
                const instagramProfile = profiles.find((p) => p.provider === 'instagram') || null;
                
                const igSnapshots = await getRecentSocialActivitySnapshots(hotelId, 'instagram', 2);
                const fbSnapshots = await getRecentSocialActivitySnapshots(hotelId, 'facebook', 2);
                
                const instagram = buildProviderDetail('instagram', instagramProfile, igSnapshots);
                const facebook = buildProviderDetail('facebook', facebookProfile, fbSnapshots);
                
                const alerts = [alertForProvider('instagram', instagram.status), alertForProvider('facebook', facebook.status)].filter(Boolean);
                const trend = buildTrend(igSnapshots, fbSnapshots);
                
                res.json({
                        status: 'connected',
                        instagram,
                        facebook,
                        alerts,
                        trend: trend || undefined,
                        message: 'Meta connected'
                });
        } catch (err) {
                res.status(500).json({ error: 'Failed to fetch social status', message: err.message });
        }
});

// POST /hotels/:id/social/sync - retrieves real Instagram/Facebook activity via the
// official Graph API where permissions allow, stores posts + a snapshot per
// provider, and never fails the whole dashboard on a permissions problem.
app.post('/hotels/:id/social/sync', async (req, res) => {
        if (!pool) return res.status(503).json({ error: 'Database not configured' });
        const hotelId = req.params.id;
        
        try {
                const connection = await getMetaConnectionByHotelId(hotelId);
                if (!connection || connection.status !== 'connected' || !connection.access_token) {
                        return res.json({ status: 'access_needed', message: 'Meta access needed' });
                }
                
                const accessToken = decryptToken(connection.access_token);
                if (!accessToken) {
                        return res.json({ status: 'access_needed', message: 'Meta access needed' });
                }
                
                let pages = [];
                try {
                        pages = await fetchFacebookPagesWithTokens(accessToken);
                } catch (graphErr) {
                        console.error('Meta sync error (fetchFacebookPagesWithTokens)', graphErr.message);
                        return res.json({
                                status: 'error',
                                message: 'Social partner follow-up needed',
                                instagram: { profile_found: false, profile_url: null, monitoring_active: false },
                                facebook: { profile_found: false, profile_url: null, monitoring_active: false }
                        });
                }
                
                const primaryPage = pages.length ? pages[0] : null;
                
                if (primaryPage) {
                        await upsertSocialProfile({
                                hotelId,
                                provider: 'facebook',
                                profileName: primaryPage.name || null,
                                profileUrl: primaryPage.link || null,
                                providerAccountId: primaryPage.id,
                                facebookPageId: primaryPage.id,
                                status: 'active',
                                rawData: { page_id: primaryPage.id, page_name: primaryPage.name || null }
                        });
                        
                        const pageToken = primaryPage.access_token || accessToken;
                        
                        try {
                                const rawPosts = await fetchFacebookPagePosts(primaryPage.id, pageToken);
                                const posts = rawPosts.map(normalizeFacebookPost);
                                await syncProviderActivity({
                                        hotelId,
                                        provider: 'facebook',
                                        profileId: primaryPage.id,
                                        profileName: primaryPage.name || null,
                                        profileUrl: primaryPage.link || null,
                                        followersCount: null,
                                        pageLikesCount: primaryPage.fan_count || primaryPage.followers_count || null,
                                        posts
                                });
                        } catch (fbPostsErr) {
                                console.error('Meta sync error (fetchFacebookPagePosts)', fbPostsErr.message);
                                await insertSocialActivitySnapshot({
                                        hotelId,
                                        provider: 'facebook',
                                        profileId: primaryPage.id,
                                        profileName: primaryPage.name || null,
                                        profileUrl: primaryPage.link || null,
                                        status: 'permission_needed',
                                        recommendedAction: recommendedAction('facebook', 'permission_needed')
                                });
                        }
                        
                        if (primaryPage.instagram_business_account && primaryPage.instagram_business_account.id) {
                                const igId = primaryPage.instagram_business_account.id;
                                const igUsernameFallback = primaryPage.instagram_business_account.username || null;
                                const instagramUrl = igUsernameFallback ? `https://www.instagram.com/${igUsernameFallback}/` : null;
                                
                                try {
                                        const igProfile = await fetchInstagramProfile(igId, pageToken);
                                        const igUsername = igProfile.username || igUsernameFallback;
                                        const igUrl = igUsername ? `https://www.instagram.com/${igUsername}/` : instagramUrl;
                                        
                                        await upsertSocialProfile({
                                                hotelId,
                                                provider: 'instagram',
                                                profileName: igProfile.name || igUsername || null,
                                                profileUrl: igUrl,
                                                providerAccountId: igId,
                                                facebookPageId: primaryPage.id,
                                                instagramBusinessAccountId: igId,
                                                status: 'active',
                                                rawData: { username: igUsername }
                                        });
                                        
                                        const rawMedia = await fetchInstagramMedia(igId, pageToken);
                                        const media = rawMedia.map(normalizeInstagramMedia);
                                        
                                        await syncProviderActivity({
                                                hotelId,
                                                provider: 'instagram',
                                                profileId: igId,
                                                profileName: igProfile.name || igUsername || null,
                                                profileUrl: igUrl,
                                                followersCount: igProfile.followers_count || null,
                                                pageLikesCount: null,
                                                posts: media
                                        });
                                } catch (igErr) {
                                        console.error('Meta sync error (instagram)', igErr.message);
                                        await insertSocialActivitySnapshot({
                                                hotelId,
                                                provider: 'instagram',
                                                profileId: igId,
                                                profileName: null,
                                                profileUrl: instagramUrl,
                                                status: 'permission_needed',
                                                recommendedAction: recommendedAction('instagram', 'permission_needed')
                                        });
                                }
                        }
                }
                
                const profiles = await getSocialProfilesByHotelId(hotelId);
                const facebookProfile = profiles.find((p) => p.provider === 'facebook') || null;
                const instagramProfile = profiles.find((p) => p.provider === 'instagram') || null;
                
                const igSnapshots = await getRecentSocialActivitySnapshots(hotelId, 'instagram', 2);
                const fbSnapshots = await getRecentSocialActivitySnapshots(hotelId, 'facebook', 2);
                
                const instagram = buildProviderDetail('instagram', instagramProfile, igSnapshots);
                const facebook = buildProviderDetail('facebook', facebookProfile, fbSnapshots);
                const alerts = [alertForProvider('instagram', instagram.status), alertForProvider('facebook', facebook.status)].filter(Boolean);
                const trend = buildTrend(igSnapshots, fbSnapshots);
                
                res.json({
                        status: 'connected',
                        instagram,
                        facebook,
                        alerts,
                        trend: trend || undefined,
                        message: 'Meta connected',
                        pages_visible: pages.length
                });
        } catch (err) {
                console.error('Meta social sync error', err.message);
                res.status(500).json({ error: 'Failed to sync social profiles', message: err.message });
        }
});

app.listen(port, () => {
    console.log(`Polaris Revenue Intelligence API v3.3 running on ${port}`);
});
