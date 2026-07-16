// metaSocial.js
// Meta (Facebook Login) connector. Uses the official Meta Graph API only - no
// scraping of Facebook or Instagram pages, ever.
// META_APP_ID / META_APP_SECRET / META_REDIRECT_URI are read server-side only from
// environment variables and are NEVER sent to the browser or embedded in any
// client-facing response. Access tokens are encrypted at rest (AES-256-GCM, keyed
// from META_APP_SECRET) before being persisted, and are never returned to the
// frontend by any route in this codebase.

import crypto from 'crypto';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_DIALOG_BASE = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

// Minimum scopes needed for account discovery and read-only monitoring.
// Re-evaluate after real-world testing - App Review may be required for some of
// these once the app leaves Development mode.
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'];

export function getMetaAppId() {
    return process.env.META_APP_ID || null;
}

export function getMetaAppSecret() {
    return process.env.META_APP_SECRET || null;
}

export function getMetaRedirectUri() {
    return process.env.META_REDIRECT_URI || null;
}

// Customer-safe + ops-safe connector status. Never includes the app secret or any
// token. Used by GET /meta/status.
export function getMetaConnectorStatus() {
    const configured = !!(getMetaAppId() && getMetaAppSecret() && getMetaRedirectUri());
    return {
          configured,
          redirect_uri: getMetaRedirectUri(),
          status: configured ? 'configured' : 'missing_env',
          message: configured
            ? 'Meta connector configured.'
                  : 'Meta connector missing app credentials.'
    };
}

function getStateSecret() {
    // Falls back gracefully if META_APP_SECRET isn't set yet, but the OAuth flow
  // itself requires it (Meta's token exchange needs the app secret), so in
  // practice this only runs unsigned when the connector is already "missing_env".
  return getMetaAppSecret() || getMetaRedirectUri() || 'polaris-meta-state-fallback';
}

// Encodes hotelId into a signed, URL-safe state string so /oauth/meta/callback can
// recover which hotel initiated the login without trusting an unsigned client value.
export function encodeState(hotelId) {
    const payload = JSON.stringify({
          hotelId: hotelId === undefined || hotelId === null ? null : String(hotelId),
          ts: Date.now()
    });
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', getStateSecret()).update(payloadB64).digest('base64url');
    return `${payloadB64}.${sig}`;
}

// Verifies and decodes a state string. Returns { hotelId, invalid } - invalid is
// true if the signature doesn't match or the payload can't be parsed.
export function decodeState(state) {
    if (!state || typeof state !== 'string' || !state.includes('.')) {
          return { hotelId: null, invalid: true };
    }
    const [payloadB64, sig] = state.split('.');
    const expectedSig = crypto.createHmac('sha256', getStateSecret()).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(String(sig));
    const expectedBuf = Buffer.from(expectedSig);
    const validSig = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    if (!validSig) return { hotelId: null, invalid: true };

  try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        return { hotelId: payload.hotelId || null, invalid: false };
  } catch (err) {
        return { hotelId: null, invalid: true };
  }
}

export function buildMetaLoginUrl(state) {
    const params = new URLSearchParams({
          client_id: getMetaAppId(),
          redirect_uri: getMetaRedirectUri(),
          state,
          scope: META_SCOPES.join(','),
          response_type: 'code'
    });
    return `${OAUTH_DIALOG_BASE}?${params.toString()}`;
}

// --- Token encryption helpers -------------------------------------------------
// AES-256-GCM, key derived from META_APP_SECRET. Never logged, never exposed via
// any API response. Internal storage only.

function getEncryptionKey() {
    const secret = getMetaAppSecret();
    if (!secret) return null;
    return crypto.createHash('sha256').update(secret).digest();
}

export function encryptToken(plainText) {
    const key = getEncryptionKey();
    if (!key || plainText === undefined || plainText === null) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(payload) {
    const key = getEncryptionKey();
    if (!key || !payload) return null;
    try {
          const raw = Buffer.from(payload, 'base64');
          const iv = raw.subarray(0, 12);
          const tag = raw.subarray(12, 28);
          const data = raw.subarray(28);
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
          return null;
    }
}

// --- Graph API calls (server-side only) ---------------------------------------

async function graphFetch(url) {
    const resp = await fetch(url);
    let data;
    try {
          data = await resp.json();
    } catch (err) {
          throw new Error('Meta returned an unexpected response');
    }
    if (!resp.ok || data.error) {
          const message = data && data.error && data.error.message ? data.error.message : 'Meta Graph API request failed';
          const err = new Error(message);
          err.graphError = (data && data.error) || null;
          err.status = resp.status;
          throw err;
    }
    return data;
}

// Exchanges the OAuth "code" for a short-lived user access token.
export async function exchangeCodeForToken(code) {
    const params = new URLSearchParams({
          client_id: getMetaAppId(),
          redirect_uri: getMetaRedirectUri(),
          client_secret: getMetaAppSecret(),
          code
    });
    return graphFetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
}

// Exchanges a short-lived user token for a long-lived one (~60 days).
export async function exchangeForLongLivedToken(shortLivedToken) {
    const params = new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: getMetaAppId(),
          client_secret: getMetaAppSecret(),
          fb_exchange_token: shortLivedToken
    });
    return graphFetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
}

// Basic Meta user identity (id/name only) so we can store meta_user_id.
export async function fetchMetaUser(accessToken) {
    const params = new URLSearchParams({ fields: 'id,name', access_token: accessToken });
    return graphFetch(`${GRAPH_BASE}/me?${params.toString()}`);
}

// Facebook Pages the connected user manages, with linked Instagram Business
// account (if any) expanded inline. Returns [] rather than throwing when the
// user simply has no pages - only throws on a genuine API/permission error.
export async function fetchFacebookPages(accessToken) {
    const params = new URLSearchParams({
          fields: 'id,name,link,instagram_business_account{id,username,name}',
          access_token: accessToken
    });
    const data = await graphFetch(`${GRAPH_BASE}/me/accounts?${params.toString()}`);
    return Array.isArray(data.data) ? data.data : [];
}


// --- Social Activity Monitor (v3.14) additions ---------------------------------
// Still official Graph API only, no scraping. These calls add the fields needed
// to compute real Instagram/Facebook activity metrics (v3.14): page access
// tokens, follower/fan counts, and recent posts/media with engagement counts.

// Facebook Pages with page access token + fan/follower counts + linked IG account.
export async function fetchFacebookPagesWithTokens(accessToken) {
    const params = new URLSearchParams({
        fields: 'id,name,link,website,fan_count,followers_count,access_token,location{city,country},instagram_business_account{id,username,name,profile_picture_url}',
        access_token: accessToken
    });
    const data = await graphFetch(`${GRAPH_BASE}/me/accounts?${params.toString()}`);
    return Array.isArray(data.data) ? data.data : [];
}

// Recent Facebook Page posts (message, timestamps, reactions/comments/shares).
// Uses the Page access token where available.
export async function fetchFacebookPagePosts(pageId, pageAccessToken, limit = 25) {
    const params = new URLSearchParams({
        fields: 'id,message,created_time,permalink_url,reactions.summary(true),comments.summary(true),shares',
        limit: String(limit),
        access_token: pageAccessToken
    });
    const data = await graphFetch(`${GRAPH_BASE}/${pageId}/posts?${params.toString()}`);
    return Array.isArray(data.data) ? data.data : [];
}

// Instagram Business/Creator account profile fields (followers/media counts).
export async function fetchInstagramProfile(igUserId, pageAccessToken) {
    const params = new URLSearchParams({
        fields: 'id,username,name,profile_picture_url,followers_count,media_count',
        access_token: pageAccessToken
    });
    return graphFetch(`${GRAPH_BASE}/${igUserId}?${params.toString()}`);
}

// Recent Instagram media (caption, timestamp, permalink, media type, like/comment counts).
export async function fetchInstagramMedia(igUserId, pageAccessToken, limit = 25) {
    const params = new URLSearchParams({
        fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count',
        limit: String(limit),
        access_token: pageAccessToken
    });
    const data = await graphFetch(`${GRAPH_BASE}/${igUserId}/media?${params.toString()}`);
    return Array.isArray(data.data) ? data.data : [];
}

// --- Meta Page Mapping (V3.21) matching -----------------------------------------
// Scores a single Facebook Page (as returned by fetchFacebookPagesWithTokens)
// against a hotel's known identity signals: website-detected Facebook/Instagram
// links, hotel domain/name, and city/country. This is the only place a Page is
// ever chosen for a hotel - "the first Page returned by Meta" is never trusted.
const NAME_STOPWORDS = new Set(['hotel', 'the', 'and', 'de', 'le', 'la', 'inn', 'suites', 'resort']);

function normalizeText(value) {
    	return (value || '')
    		.toLowerCase()
    		.normalize('NFKD')
    		.replace(/[\u0300-\u036f]/g, '')
    		.replace(/[^a-z0-9]+/g, ' ')
    		.trim();
}

function nameTokens(value) {
    	return normalizeText(value).split(' ').filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t));
}

function extractDomain(url) {
    	if (!url) return null;
    	try {
            		const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            		return u.hostname.replace(/^www\./, '').toLowerCase();
        } catch (e) {
            		return null;
        }
}

function normalizeUrlForCompare(url) {
    	return (url || '')
    		.toLowerCase()
    		.replace(/^https?:\/\//, '')
    		.replace(/^www\./, '')
    		.replace(/\/$/, '')
    		.split('?')[0];
}

function urlsMatch(a, b) {
    	if (!a || !b) return false;
    	return normalizeUrlForCompare(a) === normalizeUrlForCompare(b);
}

function usernameFromInstagramUrl(url) {
    	if (!url) return null;
    	const m = url.match(/instagram\.com\/([^\/?]+)/i);
    	return m ? m[1].toLowerCase() : null;
}

// Returns { score, reasons[] } for one Facebook Page candidate against one hotel.
// Positive signals (exact URL/username match, domain match, name match, city/
// country match) add points; conflicting domain/name subtract points. Scoring
// mirrors the V3.21 spec: >=85 auto_matched, 60-84 needs_confirmation, else not_mapped.
export function scoreFacebookPageCandidate(page, hotel) {
    	let score = 0;
    	const reasons = [];

	const socialLinks = (hotel && hotel.extracted_social_links) || {};
    	const hotelFacebookUrl = socialLinks.facebook || null;
    	const hotelInstagramUrl = socialLinks.instagram || null;
    	const hotelDomain = (hotel && hotel.domain) || extractDomain(hotel && hotel.website);
    	const igAccount = page.instagram_business_account || null;
    	const igUsername = igAccount ? (igAccount.username || null) : null;

	if (hotelFacebookUrl && page.link && urlsMatch(hotelFacebookUrl, page.link)) {
        		score += 100;
        		reasons.push('exact_facebook_url_match');
    }

	const hotelIgUsername = usernameFromInstagramUrl(hotelInstagramUrl);
    	if (hotelIgUsername && igUsername && hotelIgUsername === igUsername.toLowerCase()) {
            		score += 95;
            		reasons.push('exact_instagram_username_match');
        }

	const pageWebsiteDomain = extractDomain(page.website);
    	let domainConflict = false;
    	if (hotelDomain && pageWebsiteDomain) {
            		if (pageWebsiteDomain === hotelDomain) {
                        			score += 90;
                        			reasons.push('page_website_domain_match');
                    } else {
                        			domainConflict = true;
                    }
        }

	const hotelTokens = new Set(nameTokens(hotel && hotel.name));
    	const pageTokens = new Set(nameTokens(page.name));
    	let nameConflict = false;
    	if (hotelTokens.size && pageTokens.size) {
            		const intersection = [...hotelTokens].filter((t) => pageTokens.has(t));
            		const union = new Set([...hotelTokens, ...pageTokens]);
            		const jaccard = intersection.length / union.size;
            		const containment = intersection.length / Math.min(hotelTokens.size, pageTokens.size);
            		if (jaccard >= 0.6 || containment >= 0.8) {
                        			score += 80;
                        			reasons.push('strong_name_match');
                    } else if (intersection.length > 0) {
                        			score += 40;
                        			reasons.push('partial_name_match');
                    } else {
                        			nameConflict = true;
                    }
        }

	const hotelCity = ((hotel && hotel.city) || '').toLowerCase().trim();
    	const hotelCountry = ((hotel && hotel.country) || '').toLowerCase().trim();
    	const pageCity = (page.location && page.location.city ? page.location.city : '').toLowerCase().trim();
    	const pageCountry = (page.location && page.location.country ? page.location.country : '').toLowerCase().trim();
    	if ((hotelCity && pageCity && hotelCity === pageCity) || (hotelCountry && pageCountry && hotelCountry === pageCountry)) {
            		score += 10;
            		reasons.push('city_or_country_match');
        }

	if (domainConflict && nameConflict) {
        		score -= 30;
        		reasons.push('conflicting_domain_and_name');
    } else if (domainConflict) {
        		score -= 15;
        		reasons.push('conflicting_domain');
    } else if (nameConflict && reasons.length === 0) {
        		score -= 20;
        		reasons.push('conflicting_name');
    }

	return { score, reasons };
}

// mapping_status tier for a given score, per the V3.21 thresholds.
export function mappingStatusForScore(score) {
    	if (score >= 85) return 'auto_matched';
    	if (score >= 60) return 'needs_confirmation';
    	return 'not_mapped';
}

// Builds the customer/admin-safe candidate shape for GET /hotels/:id/social/candidates.
// Never includes access_token or any other raw Graph API/debug data.
export function buildSocialPageCandidate(page, hotel, isTopCandidate) {
    	const { score, reasons } = scoreFacebookPageCandidate(page, hotel);
    	const igAccount = page.instagram_business_account || null;
    	const igUsername = igAccount ? (igAccount.username || null) : null;
    	return {
            		page_id: page.id,
            		page_name: page.name || null,
            		page_url: page.link || null,
            		page_website: page.website || null,
            		linked_instagram_business_account_id: igAccount ? igAccount.id : null,
            		linked_instagram_username: igUsername,
            		linked_instagram_profile_url: igUsername ? `https://www.instagram.com/${igUsername}/` : null,
            		match_score: score,
            		match_reasons: reasons,
            		recommended: !!isTopCandidate && score >= 60
        };
}
