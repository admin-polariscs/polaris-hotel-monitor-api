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
    res.json({ discoveredListings, competitors: comps.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch discovery data', message: err.message });
  }
});


// ---------------------------------------------------------------------------
// Google Business Profile connector
// Uses only the official Google OAuth2 + Business Profile APIs. Never scrapes
// reviews. Credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_OAUTH_REDIRECT_URI) are read only from environment variables and are
// never hardcoded or logged.

function getGoogleRedirectUri() {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI;
}

function googleEnvBooleans() {
  const hasGoogleClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasGoogleClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasGoogleOauthRedirectUri = !!process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const hasGoogleRedirectUri = !!process.env.GOOGLE_REDIRECT_URI;
  const redirectUriSelected = hasGoogleOauthRedirectUri
    ? 'GOOGLE_OAUTH_REDIRECT_URI'
    : (hasGoogleRedirectUri ? 'GOOGLE_REDIRECT_URI' : null);
  return { hasGoogleClientId, hasGoogleClientSecret, hasGoogleOauthRedirectUri, hasGoogleRedirectUri, redirectUriSelected };
}

// Temporary, staging-only diagnostic endpoint. Protected by DEBUG_TOKEN.
// Never returns actual secret values, only booleans. Remove before merging to main.
app.get('/debug/google-env', (req, res) => {
  const debugToken = process.env.DEBUG_TOKEN;
  if (!debugToken || req.query.token !== debugToken) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(googleEnvBooleans());
});

async function refreshGoogleAccessToken(connection) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !connection.refresh_token) return null;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refresh_token,
        grant_type: 'refresh_token'
      }).toString()
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token refresh failed:', tokens.error || tokens);
      return null;
    }
    const expiry = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await pool.query(
      'UPDATE google_connections SET access_token = $1, token_expiry = $2, updated_at = now() WHERE id = $3',
      [tokens.access_token, expiry, connection.id]
    );
    return tokens.access_token;
  } catch (err) {
    console.error('Google token refresh error:', err.message);
    return null;
  }
}

async function getValidGoogleAccessToken(connection) {
  const isExpired = !connection.token_expiry || new Date(connection.token_expiry).getTime() < Date.now() + 60000;
  if (!isExpired && connection.access_token) return connection.access_token;
  return refreshGoogleAccessToken(connection);
}

app.get('/connect/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = getGoogleRedirectUri();
  if (!clientId || !redirectUri) {
    return res.status(503).json({
      error: 'Google connector not configured',
      message: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI or GOOGLE_REDIRECT_URI.'
    });
  }
  let state = '';
  if (req.query.hotelId) {
    state = Buffer.from(JSON.stringify({ hotelId: req.query.hotelId })).toString('base64url');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/business.manage',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  });
  if (state) params.set('state', state);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).json({ error: 'Google OAuth error', message: String(error) });
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = getGoogleRedirectUri();
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(503).json({ error: 'Google connector not configured', message: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI or GOOGLE_REDIRECT_URI.' });
  }

  let hotelId = null;
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
      hotelId = decoded.hotelId || null;
    } catch (_) {
      hotelId = null;
    }
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Google token exchange failed:', tokens.error || tokens);
      return res.status(502).json({
        error: 'Token exchange failed',
        message: tokens.error_description || tokens.error || 'Unknown error'
      });
    }

    const expiry = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await pool.query(
      `INSERT INTO google_connections (hotel_id, access_token, refresh_token, token_expiry, scope, status)
       VALUES ($1, $2, $3, $4, $5, 'connected')`,
      [hotelId, tokens.access_token || null, tokens.refresh_token || null, expiry, tokens.scope || null]
    );

    res.json({ ok: true, message: 'Google account connected successfully.', hotelId: hotelId || null });
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message);
    res.status(500).json({ error: 'Google OAuth callback failed', message: err.message });
  }
});

const GOOGLE_LOCATIONS_CACHE_TTL_MS = 15 * 60 * 1000;
const GOOGLE_QUOTA_MESSAGE = 'Google Business Profile quota temporarily reached. Please try again in a few minutes.';
const GOOGLE_QUOTA_CACHE_WARNING = 'Google quota temporarily reached. Showing last synced locations.';
const GOOGLE_API_ACCESS_PENDING_STATUS = 'api_access_pending';
const GOOGLE_API_ACCESS_PENDING_TITLE = 'Google Business Profile API access pending';
const GOOGLE_API_ACCESS_PENDING_MESSAGE = 'Google OAuth is connected, but this Google Cloud project is still waiting for Google Business Profile API approval. Once Google approves the access request, Polaris will be able to sync locations and reviews.';

function isGoogleApiAccessPendingError(status, data) {
const errObj = (data && data.error) || {};
const reasonStatus = (errObj.status || '').toUpperCase();
const message = (errObj.message || '').toLowerCase();
if (reasonStatus === 'PERMISSION_DENIED') return true;
const details = Array.isArray(errObj.details) ? errObj.details : [];
for (const d of details) {
if (d && d.metadata && (d.metadata.quota_limit_value === '0' || d.metadata.quota_limit_value === 0)) return true;
if (d && Array.isArray(d.violations)) {
for (const v of d.violations) {
if (v && (v.quotaValue === '0' || v.quotaValue === 0)) return true;
}
}
if (d && typeof d.reason === 'string' && d.reason.toUpperCase() === 'SERVICE_DISABLED') return true;
}
if (message.indexOf('has not been used') !== -1) return true;
if (message.indexOf('is disabled') !== -1) return true;
if (message.indexOf('not enabled') !== -1) return true;
if (message.indexOf('does not have permission') !== -1) return true;
return false;
}

function isGoogleQuotaError(status, data) {
  if (status === 429) return true;
  const reason = (data && data.error && data.error.status) || '';
  const message = (data && data.error && data.error.message ? data.error.message : '').toLowerCase();
  return reason === 'RESOURCE_EXHAUSTED' || message.indexOf('quota') !== -1 || message.indexOf('rate limit') !== -1;
}

async function fetchGoogleWithBackoff(url, options, maxAttempts) {
  const attempts = maxAttempts || 4;
  let attempt = 0;
  let lastData = null;
  let lastStatus = null;
  while (attempt < attempts) {
    const r = await fetch(url, options);
    let data;
    try {
      data = await r.json();
    } catch (e) {
      data = null;
    }
    if (r.ok) return { ok: true, status: r.status, data };
    lastData = data;
    lastStatus = r.status;
if (isGoogleApiAccessPendingError(r.status, data)) {
return { ok: false, status: r.status, data, quota: false, accessPending: true };
}
if (isGoogleQuotaError(r.status, data) && attempt < attempts - 1) {
      const delayMs = 500 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
      continue;
    }
    return { ok: false, status: lastStatus, data: lastData, quota: isGoogleQuotaError(lastStatus, lastData) };
  }
  return { ok: false, status: lastStatus, data: lastData, quota: isGoogleQuotaError(lastStatus, lastData) };
}

async function fetchGoogleLocationsForConnection(connection, hotelId) {
  const accessToken = await getValidGoogleAccessToken(connection);
  if (!accessToken) {
    return { ok: false, tokenError: true };
  }

  const accountsResult = await fetchGoogleWithBackoff('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!accountsResult.ok) {
return { ok: false, quota: accountsResult.quota, accessPending: accountsResult.accessPending, data: accountsResult.data };
}

  const accounts = (accountsResult.data && accountsResult.data.accounts) || [];
  const results = [];
  let hotelDomain = null;
  if (hotelId) {
    const hotelRes = await pool.query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
    hotelDomain = hotelRes.rows.length ? hotelRes.rows[0].domain : null;
  }

  let hitQuotaMidway = false;
let hitAccessPendingMidway = false;

  for (const account of accounts) {
    const locResult = await fetchGoogleWithBackoff(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress,phoneNumbers,websiteUri`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!locResult.ok) {
if (locResult.accessPending) {
hitAccessPendingMidway = true;
results.push({ account: account.name, accountName: account.accountName, error: GOOGLE_API_ACCESS_PENDING_MESSAGE });
continue;
}
if (locResult.quota) {
hitQuotaMidway = true;
results.push({ account: account.name, accountName: account.accountName, error: GOOGLE_QUOTA_MESSAGE });
continue;
}
      results.push({
        account: account.name,
        accountName: account.accountName,
        error: (locResult.data && locResult.data.error && locResult.data.error.message) || 'Failed to list locations'
      });
      continue;
    }

    const locData = locResult.data || {};
    const locations = (locData.locations || []).map((loc) => {
      const addr = loc.storefrontAddress;
      const address = addr
        ? [addr.addressLines ? addr.addressLines.join(', ') : null, addr.locality, addr.administrativeArea, addr.postalCode, addr.regionCode]
            .filter(Boolean)
            .join(', ')
        : null;
      return {
        locationId: loc.name,
        name: account.accountName,
        title: loc.title,
        address,
        phone: (loc.phoneNumbers && loc.phoneNumbers.primaryPhone) || null,
        website: loc.websiteUri || null
      };
    });

    if (hotelId && hotelDomain) {
      const match = locations.find((loc) => loc.website && normaliseDomain(loc.website) === hotelDomain);
      if (match) {
        await pool.query(
          `UPDATE google_connections
           SET location_id = $1, location_name = $2, google_account_id = $3, google_account_name = $4,
               status = 'matched', updated_at = now()
           WHERE id = $5`,
          [match.locationId, match.title || match.name, account.name, account.accountName, connection.id]
        );
      }
    }

    results.push({ account: account.name, accountName: account.accountName, locations });
  }

  await pool.query(
    'UPDATE google_connections SET locations_cache = $1, locations_fetched_at = now(), updated_at = now() WHERE id = $2',
    [JSON.stringify(results), connection.id]
  );

  return { ok: true, results, hitQuotaMidway, hitAccessPendingMidway };
}

async function loadGoogleConnection(hotelId) {
  const connResult = hotelId
    ? await pool.query('SELECT * FROM google_connections WHERE hotel_id = $1 ORDER BY id DESC LIMIT 1', [hotelId])
    : await pool.query('SELECT * FROM google_connections ORDER BY id DESC LIMIT 1');
  return connResult.rows.length ? connResult.rows[0] : null;
}

app.get('/google/locations', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const hotelId = req.query.hotelId || null;
    const connection = await loadGoogleConnection(hotelId);

    if (!connection) {
      return res.status(404).json({
        error: 'No Google connection found',
        message: 'Connect a Google account first via /connect/google'
      });
    }

    if (connection.locations_cache && connection.locations_fetched_at) {
      const ageMs = Date.now() - new Date(connection.locations_fetched_at).getTime();
      if (ageMs < GOOGLE_LOCATIONS_CACHE_TTL_MS) {
        return res.json({
          accounts: connection.locations_cache,
          source: 'cache',
          cache: { hit: true, fetchedAt: connection.locations_fetched_at, ageSeconds: Math.round(ageMs / 1000) }
        });
      }
    }

    const fetchResult = await fetchGoogleLocationsForConnection(connection, hotelId);

    if (!fetchResult.ok) {
      if (fetchResult.tokenError) {
return res.status(502).json({ error: 'Unable to obtain a valid Google access token' });
}
if (fetchResult.accessPending) {
return res.json({
status: GOOGLE_API_ACCESS_PENDING_STATUS,
title: GOOGLE_API_ACCESS_PENDING_TITLE,
message: GOOGLE_API_ACCESS_PENDING_MESSAGE,
accounts: connection.locations_cache || [],
source: connection.locations_cache ? 'cache' : 'none'
});
}
if (fetchResult.quota) {
        if (connection.locations_cache) {
          return res.json({
            accounts: connection.locations_cache,
            source: 'cache',
            cache: { hit: true, stale: true, fetchedAt: connection.locations_fetched_at },
            warning: GOOGLE_QUOTA_CACHE_WARNING
          });
        }
        return res.status(429).json({ error: GOOGLE_QUOTA_MESSAGE });
      }
      return res.status(502).json({
        error: 'Failed to list Google Business accounts',
        message: (fetchResult.data && fetchResult.data.error && fetchResult.data.error.message) || 'Unknown error'
      });
    }

    const response = { accounts: fetchResult.results, source: 'live' };
if (fetchResult.hitAccessPendingMidway) {
response.status = GOOGLE_API_ACCESS_PENDING_STATUS;
response.title = GOOGLE_API_ACCESS_PENDING_TITLE;
response.warning = GOOGLE_API_ACCESS_PENDING_MESSAGE;
} else if (fetchResult.hitQuotaMidway) {
response.warning = GOOGLE_QUOTA_MESSAGE;
}
res.json(response);
  } catch (err) {
    console.error('Failed to list Google locations:', err.message);
    res.status(500).json({ error: 'Failed to list Google locations', message: err.message });
  }
});

app.post('/google/sync-locations', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const hotelId = (req.body && req.body.hotelId) || req.query.hotelId || null;
    const connection = await loadGoogleConnection(hotelId);

    if (!connection) {
      return res.status(404).json({
        error: 'No Google connection found',
        message: 'Connect a Google account first via /connect/google'
      });
    }

    const fetchResult = await fetchGoogleLocationsForConnection(connection, hotelId);

    if (!fetchResult.ok) {
      if (fetchResult.tokenError) {
return res.status(502).json({ error: 'Unable to obtain a valid Google access token' });
}
if (fetchResult.accessPending) {
return res.json({
status: GOOGLE_API_ACCESS_PENDING_STATUS,
title: GOOGLE_API_ACCESS_PENDING_TITLE,
message: GOOGLE_API_ACCESS_PENDING_MESSAGE,
accounts: connection.locations_cache || [],
source: connection.locations_cache ? 'cache' : 'none'
});
}
if (fetchResult.quota) {
        if (connection.locations_cache) {
          return res.json({
            accounts: connection.locations_cache,
            source: 'cache',
            cache: { hit: true, stale: true, fetchedAt: connection.locations_fetched_at },
            warning: GOOGLE_QUOTA_CACHE_WARNING
          });
        }
        return res.status(429).json({ error: GOOGLE_QUOTA_MESSAGE });
      }
      return res.status(502).json({
        error: 'Failed to list Google Business accounts',
        message: (fetchResult.data && fetchResult.data.error && fetchResult.data.error.message) || 'Unknown error'
      });
    }

    const response = { accounts: fetchResult.results, source: 'live', synced: true };
if (fetchResult.hitAccessPendingMidway) {
response.status = GOOGLE_API_ACCESS_PENDING_STATUS;
response.title = GOOGLE_API_ACCESS_PENDING_TITLE;
response.warning = GOOGLE_API_ACCESS_PENDING_MESSAGE;
} else if (fetchResult.hitQuotaMidway) {
response.warning = GOOGLE_QUOTA_MESSAGE;
}
res.json(response);
  } catch (err) {
    console.error('Failed to sync Google locations:', err.message);
    res.status(500).json({ error: 'Failed to sync Google locations', message: err.message });
  }
});
app.get('/hotels/:id/reviews', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const connResult = await pool.query(
      'SELECT * FROM google_connections WHERE hotel_id = $1 ORDER BY id DESC LIMIT 1',
      [req.params.id]
    );

    if (!connResult.rows.length) {
      return res.json({ connector: 'google', status: 'Google not connected' });
    }

    const connection = connResult.rows[0];
    if (!connection.location_id) {
      return res.json({ connector: 'google', status: 'Google connected, location not matched yet' });
    }

    const accessToken = await getValidGoogleAccessToken(connection);
    if (!accessToken) {
      return res.status(502).json({ error: 'Unable to obtain a valid Google access token' });
    }

    const reviewsRes = await fetch(`https://mybusiness.googleapis.com/v4/${connection.location_id}/reviews`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const reviewsData = await reviewsRes.json();
    if (!reviewsRes.ok) {
      return res.status(502).json({
        error: 'Failed to fetch Google reviews',
        message: (reviewsData.error && reviewsData.error.message) || 'Unknown error'
      });
    }

    res.json({
      connector: 'google',
      status: 'matched',
      locationId: connection.location_id,
      locationName: connection.location_name,
      reviews: (reviewsData.reviews || []).map((r) => ({
        reviewId: r.reviewId,
        reviewer: r.reviewer ? r.reviewer.displayName : null,
        starRating: r.starRating,
        comment: r.comment,
        createTime: r.createTime,
        updateTime: r.updateTime
      }))
    });
  } catch (err) {
    console.error('Failed to fetch hotel reviews:', err.message);
    res.status(500).json({ error: 'Failed to fetch reviews', message: err.message });
  }
});

console.log('Google connector environment check:', JSON.stringify(googleEnvBooleans()));

app.listen(port, () => {
    console.log(`Polaris Revenue Intelligence API v3.3 running on ${port}`);
});
