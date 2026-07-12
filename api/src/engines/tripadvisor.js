// tripadvisor.js
// Tripadvisor Reputation Signal - uses ONLY the official Tripadvisor Content API.
// This is a limited recent-review and reputation alert source, not full review intelligence.
// Never scrapes Tripadvisor pages. Never claims full review coverage. Never fabricates reviews.
// Credentials are read only from process.env.TRIPADVISOR_API_KEY - never hardcoded or logged.

const TRIPADVISOR_API_BASE = 'https://api.content.tripadvisor.com/api/v1';

export const TRIPADVISOR_STATUS = {
  NOT_CONFIGURED: 'not_configured',
  API_KEY_MISSING: 'api_key_missing',
  CONNECTED: 'connected',
  LIMITED_DATA_AVAILABLE: 'limited_data_available',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error'
};

export const TRIPADVISOR_NOT_CONFIGURED_MESSAGE = 'Tripadvisor connector not configured yet.';
export const TRIPADVISOR_LIMITED_DATA_MESSAGE = 'Tripadvisor data is available as a limited reputation signal.';
export const TRIPADVISOR_CUSTOMER_WORDING = 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.';

export function getTripadvisorApiKey() {
  return process.env.TRIPADVISOR_API_KEY || null;
}

// Lightweight, no-network status check. Never calls the live API - just reports whether the
// connector is configured. Used by GET /tripadvisor/status.
export function getTripadvisorConnectorStatus() {
  const key = getTripadvisorApiKey();
  if (!key) {
    return {
      status: TRIPADVISOR_STATUS.API_KEY_MISSING,
      configured: false,
      message: TRIPADVISOR_NOT_CONFIGURED_MESSAGE,
      wording: TRIPADVISOR_CUSTOMER_WORDING
    };
  }
  return {
    status: TRIPADVISOR_STATUS.CONNECTED,
    configured: true,
    message: 'Tripadvisor official API key is configured.',
    wording: TRIPADVISOR_CUSTOMER_WORDING
  };
}

async function tripadvisorFetch(path, params) {
  const key = getTripadvisorApiKey();
  if (!key) return { ok: false, reason: 'api_key_missing' };
  const qs = new URLSearchParams({ ...params, key, language: 'en' });
  try {
    const r = await fetch(`${TRIPADVISOR_API_BASE}${path}?${qs.toString()}`, {
      headers: { accept: 'application/json' }
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'network_error', message: err.message };
  }
}

// Official Location Search - finds the Tripadvisor location_id for a hotel by name/address.
// Does not scrape search results pages; uses the documented Content API search endpoint only.
async function searchTripadvisorLocation(entity) {
  const query = [entity.name, entity.city || ''].filter(Boolean).join(' ');
  if (!query) return { ok: false, reason: 'no_query' };
  const result = await tripadvisorFetch('/location/search', { searchQuery: query, category: 'hotels' });
  if (!result.ok) return result;
  const candidates = (result.data && result.data.data) || [];
  if (!candidates.length) return { ok: false, reason: 'no_match' };
  return { ok: true, locationId: candidates[0].location_id, candidate: candidates[0] };
}

// Official Location Details - rating, review_count, profile_url (web_url), photos_count.
async function getTripadvisorLocationDetails(locationId) {
  const result = await tripadvisorFetch(`/location/${encodeURIComponent(locationId)}/details`, {});
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

// Official Location Reviews - returns only a limited set of the most recent reviews
// (as provided by the API). We never request more than what the API returns and never
// paginate/scrape beyond it.
async function getTripadvisorLocationReviews(locationId) {
  const result = await tripadvisorFetch(`/location/${encodeURIComponent(locationId)}/reviews`, {});
  if (!result.ok) return result;
  const reviews = (result.data && result.data.data) || [];
  return { ok: true, reviews };
}

// --- Local rule-based review classification (default path, always available) -----------------
const URGENT_TERMS = [
  'bed bug', 'bedbug', 'mold', 'mould', 'unsafe', 'assault', 'theft', 'stolen', 'fire alarm',
  'food poisoning', 'infestation', 'sewage', 'no hot water', 'roach', 'cockroach', 'scam', 'fraud'
];
const NEGATIVE_TERMS = [
  'dirty', 'rude', 'broken', 'terrible', 'awful', 'worst', 'disgusting', 'refund', 'unclean',
  'noisy', 'smell', 'poor service', 'never again', 'disappointed', 'overpriced'
];
const POSITIVE_TERMS = [
  'amazing', 'wonderful', 'excellent', 'clean', 'friendly', 'great', 'lovely', 'perfect',
  'comfortable', 'helpful staff', 'highly recommend', 'best hotel'
];

function classifyReviewLocal(reviewText, rating) {
  const text = String(reviewText || '').toLowerCase();
  const hasUrgent = URGENT_TERMS.some((t) => text.includes(t));
  if (hasUrgent) return 'urgent_negative';
  const numericRating = Number(rating);
  const hasNegativeWord = NEGATIVE_TERMS.some((t) => text.includes(t));
  const hasPositiveWord = POSITIVE_TERMS.some((t) => text.includes(t));
  if ((Number.isFinite(numericRating) && numericRating <= 2) || hasNegativeWord) return 'negative';
  if ((Number.isFinite(numericRating) && numericRating >= 4) || hasPositiveWord) return 'positive';
  return 'neutral';
}

// Conservative OpenAI classification fallback - only used when OPENAI_API_KEY is configured.
// Any failure (missing key, network error, bad JSON) silently falls back to the local rules
// above; it never blocks or replaces the local classification with an invented result.
async function classifyReviewWithAi(reviewText) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const prompt = `Classify this hotel review into exactly one label: positive, neutral, negative, or urgent_negative. urgent_negative means the review mentions safety, health, hygiene emergencies or crime (e.g. bed bugs, mold, assault, theft, food poisoning). Return ONLY compact JSON with key label.\n\nReview: ${String(reviewText || '').slice(0, 1000)}`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0, response_format: { type: 'json_object' } })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const label = parsed && parsed.label;
    if (['positive', 'neutral', 'negative', 'urgent_negative'].includes(label)) return label;
    return null;
  } catch {
    return null;
  }
}

async function classifyReview(reviewText, rating) {
  const aiLabel = await classifyReviewWithAi(reviewText);
  if (aiLabel) return aiLabel;
  return classifyReviewLocal(reviewText, rating);
}

async function classifyReviews(reviews) {
  const classified = [];
  for (const rev of reviews) {
    const text = rev.text || rev.title || '';
    const label = await classifyReview(text, rev.rating);
    classified.push({
      id: rev.id || null,
      rating: rev.rating || null,
      publishedDate: rev.published_date || null,
      title: rev.title || null,
      textPreview: String(text || '').slice(0, 280),
      classification: label
    });
  }
  return classified;
}

// Alert logic - purely derived from the classified, limited review set above.
function buildAlerts(classifiedReviews) {
  const negative_review_detected = classifiedReviews.some((r) => r.classification === 'negative' || r.classification === 'urgent_negative');
  const urgent_terms_detected = classifiedReviews.some((r) => r.classification === 'urgent_negative');
  const recommended_response_needed = negative_review_detected || urgent_terms_detected;
  return { negative_review_detected, urgent_terms_detected, recommended_response_needed };
}

// Full orchestration for GET /hotels/:id/tripadvisor. Never scrapes; only calls the official
// Content API endpoints (search -> details -> reviews). Any failure at any stage degrades
// gracefully to an honest status (unavailable/error) rather than fabricating data.
export async function fetchTripadvisorData(entity) {
  const key = getTripadvisorApiKey();
  if (!key) {
    return {
      status: TRIPADVISOR_STATUS.API_KEY_MISSING,
      message: TRIPADVISOR_NOT_CONFIGURED_MESSAGE,
      wording: TRIPADVISOR_CUSTOMER_WORDING,
      location_id: null,
      profile_url: null,
      rating: null,
      review_count: null,
      photos_count: null,
      latest_reviews_limited: [],
      alerts: { negative_review_detected: false, urgent_terms_detected: false, recommended_response_needed: false },
      raw_data: null,
      last_synced_at: new Date().toISOString()
    };
  }

  const searchResult = await searchTripadvisorLocation(entity);
  if (!searchResult.ok) {
    return {
      status: TRIPADVISOR_STATUS.UNAVAILABLE,
      message: 'Tripadvisor location could not be confidently matched via the official API.',
      wording: TRIPADVISOR_CUSTOMER_WORDING,
      location_id: null,
      profile_url: null,
      rating: null,
      review_count: null,
      photos_count: null,
      latest_reviews_limited: [],
      alerts: { negative_review_detected: false, urgent_terms_detected: false, recommended_response_needed: false },
      raw_data: { searchError: searchResult.reason || null },
      last_synced_at: new Date().toISOString()
    };
  }

  const locationId = searchResult.locationId;
  const detailsResult = await getTripadvisorLocationDetails(locationId);
  const reviewsResult = await getTripadvisorLocationReviews(locationId);

  if (!detailsResult.ok) {
    return {
      status: TRIPADVISOR_STATUS.ERROR,
      message: 'Tripadvisor details could not be retrieved from the official API.',
      wording: TRIPADVISOR_CUSTOMER_WORDING,
      location_id: locationId,
      profile_url: null,
      rating: null,
      review_count: null,
      photos_count: null,
      latest_reviews_limited: [],
      alerts: { negative_review_detected: false, urgent_terms_detected: false, recommended_response_needed: false },
      raw_data: { detailsError: detailsResult.reason || null },
      last_synced_at: new Date().toISOString()
    };
  }

  const details = detailsResult.data || {};
  const reviews = reviewsResult.ok ? reviewsResult.reviews : [];
  const classifiedReviews = await classifyReviews(reviews);
  const alerts = buildAlerts(classifiedReviews);

  return {
    status: TRIPADVISOR_STATUS.LIMITED_DATA_AVAILABLE,
    message: TRIPADVISOR_LIMITED_DATA_MESSAGE,
    wording: TRIPADVISOR_CUSTOMER_WORDING,
    location_id: locationId,
    profile_url: details.web_url || null,
    rating: details.rating ? Number(details.rating) : null,
    review_count: details.num_reviews ? Number(details.num_reviews) : null,
    photos_count: details.photo_count ? Number(details.photo_count) : null,
    latest_reviews_limited: classifiedReviews,
    alerts,
    raw_data: { details, reviewsAvailable: reviewsResult.ok, searchCandidate: searchResult.candidate || null },
    last_synced_at: new Date().toISOString()
  };
}

// V3.9.x: builds the Tripadvisor entry for the ota_evidence layer, from already-stored
// (cached) Tripadvisor connector data - never a live API call during /scan, so a scan never
// consumes Tripadvisor API quota. If no Tripadvisor data has been synced yet for this hotel,
// the caller should leave the default discovery_candidate entry from buildOtaEvidence untouched.
export function buildTripadvisorOtaEvidenceEntry(tripadvisorRow) {
  if (!tripadvisorRow) return null;
  const status = tripadvisorRow.status === TRIPADVISOR_STATUS.LIMITED_DATA_AVAILABLE
    ? 'limited_data_available'
    : (tripadvisorRow.status === TRIPADVISOR_STATUS.CONNECTED ? 'connected' : tripadvisorRow.status);
  const dataSource = (status === 'limited_data_available' || status === 'connected') ? 'official_api' : 'unavailable';
  return {
    platform: 'Tripadvisor',
    status,
    confidence: status === 'limited_data_available' ? 70 : 20,
    data_source: dataSource,
    listing_url: tripadvisorRow.profile_url || null,
    customer_message: tripadvisorRow.message || TRIPADVISOR_CUSTOMER_WORDING,
    revenue_relevance: 'Medium to High - Tripadvisor influences guest research and trust; urgent negative reviews can affect direct and indirect bookings quickly.',
    next_action: status === 'limited_data_available'
      ? 'Monitor reputation signal and review profile consistency.'
      : 'Connect the official Tripadvisor Content API to enable the reputation signal.',
    raw_data: { rating: tripadvisorRow.rating || null, review_count: tripadvisorRow.review_count || null }
  };
}
