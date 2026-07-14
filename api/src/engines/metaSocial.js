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
        fields: 'id,name,link,fan_count,followers_count,access_token,instagram_business_account{id,username,name,profile_picture_url}',
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
