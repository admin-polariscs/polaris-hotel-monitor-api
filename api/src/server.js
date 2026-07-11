import express from 'express';
import cors from 'cors';
import { runHotelIntelligence } from './engines/intelligence.js';
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
      { section: 'consultant', score: null, summary: result.consultant ? result.consultant.headline : null, data: result.consultant }
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
                          url: item.searchUrl || null,
                          confidence: item.confidence,
                          verified: false,
                          status: item.verificationStatus || 'unverified',
                          rawData: item
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
      'SELECT id, platform, url, confidence, verified, status, first_seen_at, last_seen_at FROM discovered_listings WHERE hotel_id = $1 ORDER BY id DESC LIMIT 100',
      [req.params.id]
    );
    const comps = await pool.query(
      'SELECT id, name, website, city, platform_source, confidence, distance_km, first_seen_at, last_seen_at FROM competitors WHERE hotel_id = $1 ORDER BY id DESC LIMIT 100',
      [req.params.id]
    );
    res.json({ discoveredListings: listings.rows, competitors: comps.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch discovery data', message: err.message });
  }
});

app.listen(port, () => {
    console.log(`Polaris Revenue Intelligence API v3.3 running on ${port}`);
});
