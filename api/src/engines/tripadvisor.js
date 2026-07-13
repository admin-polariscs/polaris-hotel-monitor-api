// tripadvisor.js
// Tripadvisor Reputation Signal - dual-mode connector supporting Tripadvisor Terra (default)
// and the legacy Content API (fallback mode), selected via TRIPADVISOR_API_MODE.
// This is a limited recent-review and reputation alert source, not full review intelligence.
// Never scrapes Tripadvisor pages. Never claims full review coverage. Never fabricates reviews.
// Credentials are read only from process.env.TRIPADVISOR_API_KEY - never hardcoded or logged.

const TRIPADVISOR_TERRA_API_BASE = 'https://terra.tripadvisor.com/api';
const TRIPADVISOR_LEGACY_API_BASE = 'https://api.content.tripadvisor.com/api/v1';

export const TRIPADVISOR_API_MODES = {
      TERRA: 'terra',
      LEGACY_CONTENT_API: 'legacy_content_api'
};

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
export const TRIPADVISOR_TERRA_LIMITED_DATA_MESSAGE = 'Tripadvisor Terra data is available as a limited reputation signal.';
export const TRIPADVISOR_CUSTOMER_WORDING = 'Tripadvisor Reputation Signal uses limited recent review data available through the official API.';
export const TRIPADVISOR_LIMITED_HISTORY_WORDING = 'Limited recent reviews are not a complete review history.';
export const TRIPADVISOR_EARLY_WARNING_WORDING = 'Use this as an early-warning signal, not as a full review analytics source.';

export function getTripadvisorApiKey() {
      return process.env.TRIPADVISOR_API_KEY || null;
}

// Reads TRIPADVISOR_API_MODE from the environment. Defaults to Terra, and any unrecognised
// value also falls back to Terra rather than silently using the legacy API.
export function getTripadvisorApiMode() {
      const raw = String(process.env.TRIPADVISOR_API_MODE || '').toLowerCase().trim();
      if (raw === TRIPADVISOR_API_MODES.LEGACY_CONTENT_API) return TRIPADVISOR_API_MODES.LEGACY_CONTENT_API;
      return TRIPADVISOR_API_MODES.TERRA;
}

function limitedDataMessageForMode(mode) {
      return mode === TRIPADVISOR_API_MODES.TERRA ? TRIPADVISOR_TERRA_LIMITED_DATA_MESSAGE : TRIPADVISOR_LIMITED_DATA_MESSAGE;
}

// Lightweight, no-network status check. Never calls the live API - just reports whether the
// connector is configured. Used by GET /tripadvisor/status.
export function getTripadvisorConnectorStatus() {
      const key = getTripadvisorApiKey();
      const mode = getTripadvisorApiMode();
      if (!key) {
                return {
                              status: TRIPADVISOR_STATUS.API_KEY_MISSING,
                              configured: false,
                              api_mode: mode,
                              message: TRIPADVISOR_NOT_CONFIGURED_MESSAGE,
                              wording: TRIPADVISOR_CUSTOMER_WORDING
                };
      }
      return {
                status: TRIPADVISOR_STATUS.CONNECTED,
                configured: true,
                api_mode: mode,
                message: mode === TRIPADVISOR_API_MODES.TERRA
                    ? 'Tripadvisor Terra connector configured.'
                              : 'Tripadvisor official API key is configured.',
                wording: TRIPADVISOR_CUSTOMER_WORDING
      };
}

// --- Low-level HTTP helpers, one per mode. Both are server-side only; the key is never
// returned to the client and never logged. -----------------------------------------------
async function terraFetch(path, params) {
      const key = getTripadvisorApiKey();
      if (!key) return { ok: false, reason: 'api_key_missing' };
      const qs = new URLSearchParams(params || {});
      const queryString = qs.toString();
      const url = `${TRIPADVISOR_TERRA_API_BASE}${path}${queryString ? `?${queryString}` : ''}`;
      try {
                const r = await fetch(url, {
                              headers: { accept: 'application/json', 'X-API-KEY': key }
                });
                const data = await r.json().catch(() => null);
                if (!r.ok) {
                              console.error('Tripadvisor Terra API error', { path, status: r.status });
                              return { ok: false, reason: 'api_error', status: r.status, data };
                }
                return { ok: true, data };
      } catch (err) {
                console.error('Tripadvisor Terra network error', { path, message: err.message });
                return { ok: false, reason: 'network_error', message: err.message };
      }
}

async function legacyFetch(path, params) {
      const key = getTripadvisorApiKey();
      if (!key) return { ok: false, reason: 'api_key_missing' };
      const qs = new URLSearchParams({ ...params, key, language: 'en' });
      try {
                const r = await fetch(`${TRIPADVISOR_LEGACY_API_BASE}${path}?${qs.toString()}`, {
                              headers: { accept: 'application/json' }
                });
                const data = await r.json().catch(() => null);
                if (!r.ok) {
                              console.error('Tripadvisor legacy Content API error', { path, status: r.status });
                              return { ok: false, reason: 'api_error', status: r.status, data };
                }
                return { ok: true, data };
      } catch (err) {
                console.error('Tripadvisor legacy Content API network error', { path, message: err.message });
                return { ok: false, reason: 'network_error', message: err.message };
      }
}

// --- Conservative candidate matching helpers (no external calls; pure string comparison) -------
// Shared by both modes - both Terra and legacy candidates are normalised into the same
// { location_id, name, address_obj: { city } } shape before reaching this logic.
function normaliseForMatch(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameSimilarityScore(a, b) {
      const na = normaliseForMatch(a);
      const nb = normaliseForMatch(b);
      if (!na || !nb) return 0;
      if (na === nb) return 1;
      if (na.includes(nb) || nb.includes(na)) return 0.8;
      const ta = new Set(na.split(' '));
      const tb = new Set(nb.split(' '));
      let overlap = 0;
      ta.forEach((t) => { if (tb.has(t)) overlap += 1; });
      const denom = Math.max(ta.size, tb.size) || 1;
      return overlap / denom;
}

// Picks the best Location Search candidate conservatively using name + city (and address/phone
// when the API echoes them back). Never assumes a match - always returns a bounded confidence.
function pickBestTripadvisorCandidate(candidates, entity) {
      let best = null;
      let bestScore = -1;
      for (const candidate of candidates) {
                const nameScore = nameSimilarityScore(entity.name, candidate.name);
                const candidateCity = candidate.address_obj && (candidate.address_obj.city || candidate.address_obj.state);
                let cityScore = 0.5;
                if (entity.city && candidateCity) {
                              cityScore = normaliseForMatch(entity.city) === normaliseForMatch(candidateCity) ? 1 : 0;
                }
                const score = (nameScore * 0.7) + (cityScore * 0.3);
                if (score > bestScore) {
                              bestScore = score;
                              best = candidate;
                }
      }
      return { candidate: best, score: Math.max(bestScore, 0) };
}

// Conservative confidence mapping: never auto-reports full certainty (capped at 90) and only
// treats a match as "verified" when both name and city evidence are strong.
function tripadvisorCandidateConfidence(score) {
      const confidence = Math.round(30 + score * 60);
      return Math.max(0, Math.min(90, confidence));
}

// --- Terra normalisation helpers ----------------------------------------------------------
function primaryLocalisedValue(arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      const primary = arr.find((x) => x && x.primary) || arr.find((x) => x && x.language === 'en') || arr[0];
      return (primary && typeof primary.value === 'string') ? primary.value : null;
}

function normaliseTerraLocationForMatch(location) {
      if (!location) return null;
      const address = Array.isArray(location.addresses) && location.addresses.length ? location.addresses[0] : null;
      return {
                location_id: location.id,
                name: primaryLocalisedValue(location.names),
                address_obj: { city: (address && address.city) || null }
      };
}

function normaliseTerraDetails(details) {
      const d = details || {};
      const overall = d.traveler_ratings && d.traveler_ratings.overall;
      return {
                web_url: (d.urls && d.urls.tripadvisor && d.urls.tripadvisor.main) || null,
                rating: (overall && typeof overall.rating === 'number') ? overall.rating : null,
                num_reviews: (overall && typeof overall.count === 'number') ? overall.count : null,
                photo_count: (d.photos && typeof d.photos.total_count === 'number') ? d.photos.total_count : null
      };
}

function normaliseTerraReview(review) {
      const r = review || {};
      return {
                id: r.id || null,
                text: primaryLocalisedValue(r.text) || '',
                title: primaryLocalisedValue(r.title) || null,
                rating: typeof r.rating === 'number' ? r.rating : null,
                published_date: r.publish_ts || null
      };
}

// Provides location search - maps Tripadvisor candidates by name/city/address/phone.
// Does not scrape search results pages; uses the documented Terra or legacy Content API search
// endpoint only, depending on TRIPADVISOR_API_MODE. Never assumes the top result is correct
// without a name/city comparison.
async function searchTripadvisorLocation(entity) {
      const mode = getTripadvisorApiMode();
      const query = [entity.name, entity.city || '', entity.address || ''].filter(Boolean).join(' ').trim();
      if (!query) return { ok: false, reason: 'no_query' };

    let candidates;
      if (mode === TRIPADVISOR_API_MODES.TERRA) {
                const result = await terraFetch('/locations/search', { query, category: 'HOTEL', size: 10 });
                if (!result.ok) return result;
                const rawCandidates = (result.data && result.data.data) || [];
                candidates = rawCandidates
                    .map((item) => item && item.location)
                    .filter(Boolean)
                    .map(normaliseTerraLocationForMatch)
                    .filter(Boolean);
      } else {
                const params = { searchQuery: query, category: 'hotels' };
                if (entity.phone) params.phone = entity.phone;
                if (entity.address) params.address = entity.address;
                const result = await legacyFetch('/location/search', params);
                if (!result.ok) return result;
                candidates = (result.data && result.data.data) || [];
      }

    if (!candidates.length) return { ok: false, reason: 'no_match' };
      const { candidate, score } = pickBestTripadvisorCandidate(candidates, entity);
      if (!candidate) return { ok: false, reason: 'no_match' };
      const confidence = tripadvisorCandidateConfidence(score);
      const verified = confidence >= 85;
      return { ok: true, locationId: candidate.location_id, candidate, confidence, verified, matchScore: score };
}

// Official Location Details - rating, review_count, profile_url (web_url), photos_count.
// Normalised to a common shape regardless of mode.
async function getTripadvisorLocationDetails(locationId) {
      const mode = getTripadvisorApiMode();
      if (mode === TRIPADVISOR_API_MODES.TERRA) {
                const result = await terraFetch(`/locations/${encodeURIComponent(locationId)}`, {});
                if (!result.ok) return result;
                return { ok: true, data: normaliseTerraDetails(result.data) };
      }
      const result = await legacyFetch(`/location/${encodeURIComponent(locationId)}/details`, {});
      if (!result.ok) return result;
      return { ok: true, data: result.data };
}

// Official Location Reviews - returns only a limited set of the most recent reviews
// (as provided by the API). We never request more than what the current plan/mode returns and never
// paginate/scrape beyond it. If the current plan/mode does not provide review text, this
// returns an empty (but ok) review list rather than failing the whole sync.
async function getTripadvisorLocationReviews(locationId) {
      const mode = getTripadvisorApiMode();
      if (mode === TRIPADVISOR_API_MODES.TERRA) {
                const result = await terraFetch(`/locations/${encodeURIComponent(locationId)}/reviews`, { size: 10, sort_by: 'MOST_RECENT' });
                if (!result.ok) return result;
                const rawReviews = (result.data && result.data.data) || [];
                return { ok: true, reviews: rawReviews.map(normaliseTerraReview) };
      }
      const result = await legacyFetch(`/location/${encodeURIComponent(locationId)}/reviews`, {});
      if (!result.ok) return result;
      const reviews = (result.data && result.data.data) || [];
      return { ok: true, reviews };
}

// --- local rule-based review classification (default path, always available) ----------------
const URGENT_TERMS = [
      'bed bug', 'bedbug', 'mold', 'mould', 'unsafe', 'assault', 'theft', 'stolen', 'fire alarm',
      'food poisoning', 'infestation', 'sewage', 'no hot water', 'roach', 'cockroach', 'scam', 'fraud',
      'dirty', 'rude', 'aggressive', 'disgusting', 'cancelled', 'overcharged', 'no refund', 'terrible service'
  ];
const NEGATIVE_TERMS = [
      'dirty', 'rude', 'broken', 'terrible', 'awful', 'worst', 'disgusting', 'refund', 'unclean',
      'noisy', 'noise', 'smell', 'poor service', 'never again', 'disappointed', 'overpriced'
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

async function classifyReviewWithAi(reviewText) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      try {
                const prompt = `Classify this hotel review into exactly one label: positive, neutral, negative, or urgent_negative. urgent_negative means the review mentions safety, health, hygiene emergencies or crime (e.g. bed bugs, mold, assault, theft, food poisoning). Return ONLY compact JSON with key label.\n\nReview: ${String(reviewText || '').slice(0, 1500)}`;
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

function buildAlerts(classifiedReviews) {
      const negative_review_detected = classifiedReviews.some((r) => r.classification === 'negative' || r.classification === 'urgent_negative');
      const urgent_negative_detected = classifiedReviews.some((r) => r.classification === 'urgent_negative');
      const recommended_response_needed = negative_review_detected || urgent_negative_detected;
      return { negative_review_detected, urgent_negative_detected, recommended_response_needed };
}

function buildSentimentSummary(classifiedReviews) {
      const counts = { positive: 0, neutral: 0, negative: 0, urgent_negative: 0 };
      classifiedReviews.forEach((r) => {
                if (Object.prototype.hasOwnProperty.call(counts, r.classification)) counts[r.classification] += 1;
      });
      const total = classifiedReviews.length;
      let overall = 'no_data';
      if (total > 0) {
                if (counts.urgent_negative > 0) overall = 'urgent_negative_present';
                else if (counts.negative > counts.positive) overall = 'mostly_negative';
                else if (counts.positive > counts.negative) overall = 'mostly_positive';
                else overall = 'mixed';
      }
      return { ...counts, total, overall };
}

function buildRecommendedAction(alerts, sentimentSummary) {
      if (alerts.urgent_negative_detected) {
                return 'Urgent: respond to the recent urgent negative review(s) as a priority and check for the reported issue on-site.';
      }
      if (alerts.negative_review_detected) {
                return 'Respond to recent negative feedback and monitor for recurring issues.';
      }
      if (sentimentSummary.total > 0) {
                return 'No urgent issues detected in the limited recent reviews. Continue monitoring periodically.';
      }
      return 'No recent reviews were returned by the official API yet. Continue monitoring periodically.';
}

const EMPTY_SENTIMENT_SUMMARY = { positive: 0, neutral: 0, negative: 0, urgent_negative: 0, total: 0, overall: 'no_data' };

export async function fetchTripadvisorData(entity) {
      const key = getTripadvisorApiKey();
      const mode = getTripadvisorApiMode();

    if (!key) {
              return {
                            status: TRIPADVISOR_STATUS.API_KEY_MISSING,
                            api_mode: mode,
                            message: TRIPADVISOR_NOT_CONFIGURED_MESSAGE,
                            wording: TRIPADVISOR_CUSTOMER_WORDING,
                            location_id: null,
                            profile_url: null,
                            rating: null,
                            review_count: null,
                            photos_count: null,
                            confidence: null,
                            verified: false,
                            limited_recent_reviews: [],
                            negative_review_detected: false,
                            urgent_negative_detected: false,
                            recommended_response_needed: false,
                            sentiment_summary: null,
                            recommended_action: null,
                            raw_data: null,
                            last_synced_at: new Date().toISOString()
              };
    }

    const searchResult = await searchTripadvisorLocation(entity);
      if (!searchResult.ok) {
                return {
                              status: TRIPADVISOR_STATUS.UNAVAILABLE,
                              api_mode: mode,
                              message: 'Tripadvisor location could not be confidently matched via the official API.',
                              wording: TRIPADVISOR_CUSTOMER_WORDING,
                              location_id: null,
                              profile_url: null,
                              rating: null,
                              review_count: null,
                              photos_count: null,
                              confidence: null,
                              verified: false,
                              limited_recent_reviews: [],
                              negative_review_detected: false,
                              urgent_negative_detected: false,
                              recommended_response_needed: false,
                              sentiment_summary: EMPTY_SENTIMENT_SUMMARY,
                              recommended_action: 'No confident Tripadvisor match found yet; try syncing again once more hotel details are available.',
                              raw_data: { searchError: searchResult.reason || null, searchErrorStatus: searchResult.status || null, searchErrorDetail: searchResult.data || null },
                              last_synced_at: new Date().toISOString()
                };
      }

    const locationId = searchResult.locationId;
      const detailsResult = await getTripadvisorLocationDetails(locationId);
      const reviewsResult = await getTripadvisorLocationReviews(locationId);

    if (!detailsResult.ok) {
              return {
                            status: TRIPADVISOR_STATUS.ERROR,
                            api_mode: mode,
                            message: 'Tripadvisor details could not be retrieved from the official API.',
                            wording: TRIPADVISOR_CUSTOMER_WORDING,
                            location_id: locationId,
                            profile_url: null,
                            rating: null,
                            review_count: null,
                            photos_count: null,
                            confidence: searchResult.confidence,
                            verified: searchResult.verified,
                            limited_recent_reviews: [],
                            negative_review_detected: false,
                            urgent_negative_detected: false,
                            recommended_response_needed: false,
                            sentiment_summary: EMPTY_SENTIMENT_SUMMARY,
                            recommended_action: 'Tripadvisor details unavailable right now; try syncing again later.',
                            raw_data: { detailsError: detailsResult.reason || null, detailsErrorStatus: detailsResult.status || null, detailsErrorDetail: detailsResult.data || null },
                            last_synced_at: new Date().toISOString()
              };
    }

    const details = detailsResult.data || {};
      const reviews = reviewsResult.ok ? reviewsResult.reviews : [];
      const classifiedReviews = await classifyReviews(reviews);
      const alerts = buildAlerts(classifiedReviews);
      const sentimentSummary = buildSentimentSummary(classifiedReviews);
      const recommendedAction = buildRecommendedAction(alerts, sentimentSummary);

    return {
              status: TRIPADVISOR_STATUS.LIMITED_DATA_AVAILABLE,
              api_mode: mode,
              message: limitedDataMessageForMode(mode),
              wording: TRIPADVISOR_CUSTOMER_WORDING,
              location_id: locationId,
              profile_url: details.web_url || null,
              rating: details.rating ? Number(details.rating) : null,
              review_count: details.num_reviews ? Number(details.num_reviews) : null,
              photos_count: details.photo_count ? Number(details.photo_count) : null,
              confidence: searchResult.confidence,
              verified: searchResult.verified,
              limited_recent_reviews: classifiedReviews,
              negative_review_detected: alerts.negative_review_detected,
              urgent_negative_detected: alerts.urgent_negative_detected,
              recommended_response_needed: alerts.recommended_response_needed,
              sentiment_summary: sentimentSummary,
              recommended_action: recommendedAction,
              raw_data: { details, reviewsAvailable: reviewsResult.ok, searchCandidate: searchResult.candidate || null },
              last_synced_at: new Date().toISOString()
    };
}

export function buildTripadvisorOtaEvidenceEntry(tripadvisorRow) {
      if (!tripadvisorRow) return null;
      const status = tripadvisorRow.status === TRIPADVISOR_STATUS.LIMITED_DATA_AVAILABLE
          ? 'limited_data_available'
                : (tripadvisorRow.status === TRIPADVISOR_STATUS.CONNECTED ? 'connected' : tripadvisorRow.status);
      const dataSource = (status === 'limited_data_available' || status === 'connected') ? 'official_api' : 'unavailable';
      const confidence = (typeof tripadvisorRow.confidence === 'number' && tripadvisorRow.confidence !== null)
          ? tripadvisorRow.confidence
                : (status === 'limited_data_available' ? 70 : 20);
      return {
                platform: 'Tripadvisor',
                status,
                confidence,
                verified: !!tripadvisorRow.verified,
                data_source: dataSource,
                listing_url: tripadvisorRow.profile_url || null,
                customer_message: tripadvisorRow.message || TRIPADVISOR_CUSTOMER_WORDING,
                revenue_relevance: 'Medium to High - Tripadvisor influences guest research and trust; urgent negative reviews can affect direct and indirect bookings quickly.',
                next_action: status === 'limited_data_available'
                    ? 'Monitor reputation signal and verify profile consistency.'
                              : 'Connect the official Tripadvisor API to enable the reputation signal.',
                raw_data: { rating: tripadvisorRow.rating || null, review_count: tripadvisorRow.review_count || null }
      };
}
