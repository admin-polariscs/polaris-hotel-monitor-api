// competitiveSet.js
// V3.23 Competitive Set Quality Layer.
// Separates raw Google Places output ("nearby hotel candidates") from a true,
// scored/classified competitive set. Server-side only, heuristic and transparent:
// every proxy field (chain_scale_proxy, price_band_proxy, market_type, etc.) is
// derived only from data we already have (hotel name/address/domain, Google Places
// official fields such as types/priceLevel/rating). Never invents ADR, never
// scrapes, never fabricates a competitor. Confidence and data_gaps are reported
// honestly wherever a signal is missing or only weakly inferred.
//
// V3.23.1: API shape normalization + explainability/guardrail fix. See PR notes.

import { haversineKm } from './googlePlaces.js';

// Ordinal chain-scale tiers, low to high.
const TIER_RANK = { economy: 1, midscale: 2, upper_midscale: 3, upscale: 4, upper_upscale: 5, luxury: 6 };
const PRICE_FROM_SCALE = {
      luxury: 'luxury', upper_upscale: 'luxury', upscale: 'premium',
      upper_midscale: 'upper_mid', midscale: 'mid', economy: 'budget'
};
const PRICE_RANK = { luxury: 5, premium: 4, upper_mid: 3, mid: 2, budget: 1 };

const PLACES_PRICE_LEVEL_MAP = {
      PRICE_LEVEL_FREE: 'budget',
      PRICE_LEVEL_INEXPENSIVE: 'budget',
      PRICE_LEVEL_MODERATE: 'mid',
      PRICE_LEVEL_EXPENSIVE: 'premium',
      PRICE_LEVEL_VERY_EXPENSIVE: 'luxury'
};

const LUXURY_RE = /\b(sofitel legend|ritz.?carlton|four seasons|st\.?\s*regis|waldorf astoria|mandarin oriental|the peninsula|bulgari|aman|rosewood|park hyatt|shangri-?la|banyan tree|raffles|belmond|the langham|anantara)\b/i;
const UPPER_UPSCALE_RE = /\b(intercontinental|jw marriott|westin|le meridien|autograph collection|curio collection|hyatt regency|sofitel(?! legend)|conrad|kimpton|andaz|the hoxton|hoxton)\b/i;
const UPSCALE_RE = /\b(marriott|renaissance|doubletree|hyatt place|crowne plaza|nh collection|melia|barcelo|hilton(?! garden))\b/i;
const UPPER_MIDSCALE_RE = /\b(hilton garden inn|courtyard by marriott|holiday inn(?! express)|best western plus|leonardo|van der valk)\b/i;
const MIDSCALE_RE = /\b(holiday inn express|best western|ibis styles|campanile|citizen ?m)\b/i;
const ECONOMY_RE = /\b(ibis budget|premier inn|travelodge|motel 6|f1 hotel|easyhotel)\b/i;

const HOSTEL_NAME_RE = /\bhostel\b/i;
const APARTHOTEL_RE = /\b(apart-?hotel|serviced\s*apartment)\b/i;
const BNB_RE = /\b(b\s*&\s*b|bed\s*and\s*breakfast|guest\s*house|guesthouse)\b/i;
const HOLIDAY_RENTAL_RE = /\b(holiday\s*home|vacation\s*rental|holiday\s*rental)\b/i;
const AIRPORT_RE = /\b(airport|schiphol|luchthaven)\b/i;
const RESORT_RE = /\b(resort|wellness)\b/i;

const EXCLUDE_STRONG_TYPES = new Set(['campground', 'rv_park', 'mobile_home_park', 'farmstay', 'cottage']);

// Chain-scale sources considered "weak" - a rough proxy only, never enough on its
// own to justify a strong/primary-qualifying fit reason.
const WEAK_CHAIN_SCALE_SOURCES = new Set(['rating_heuristic_fallback', 'no_signal', null, undefined]);
function isWeakChainScaleSource(source) {
      return WEAK_CHAIN_SCALE_SOURCES.has(source);
}

// --- Chain-scale / price-band proxies ------------------------------------------
function chainScaleFromName(name) {
      const n = String(name || '');
      if (LUXURY_RE.test(n)) return { tier: 'luxury', confidence: 0.7, source: 'name_brand_keyword' };
      if (UPPER_UPSCALE_RE.test(n)) return { tier: 'upper_upscale', confidence: 0.65, source: 'name_brand_keyword' };
      if (UPSCALE_RE.test(n)) return { tier: 'upscale', confidence: 0.6, source: 'name_brand_keyword' };
      if (UPPER_MIDSCALE_RE.test(n)) return { tier: 'upper_midscale', confidence: 0.55, source: 'name_brand_keyword' };
      if (MIDSCALE_RE.test(n)) return { tier: 'midscale', confidence: 0.5, source: 'name_brand_keyword' };
      if (ECONOMY_RE.test(n)) return { tier: 'economy', confidence: 0.6, source: 'name_brand_keyword' };
      return { tier: null, confidence: 0, source: 'no_signal' };
}

// Weak fallback from rating alone when no brand/keyword signal exists. Deliberately
// low confidence - this is a rough proxy only, never treated as authoritative.
function chainScaleFallback(rating) {
      if (typeof rating !== 'number') return { tier: 'unknown', confidence: 0.1, source: 'no_signal' };
      if (rating >= 4.5) return { tier: 'upper_upscale', confidence: 0.3, source: 'rating_heuristic_fallback' };
      if (rating >= 4.0) return { tier: 'upscale', confidence: 0.3, source: 'rating_heuristic_fallback' };
      if (rating >= 3.5) return { tier: 'upper_midscale', confidence: 0.25, source: 'rating_heuristic_fallback' };
      return { tier: 'midscale', confidence: 0.2, source: 'rating_heuristic_fallback' };
}

function resolveChainScale(name, rating) {
      const byName = chainScaleFromName(name);
      if (byName.tier) return byName;
      return chainScaleFallback(rating);
}

function resolvePriceBand(chainScaleTier, placePriceLevel) {
      if (placePriceLevel && PLACES_PRICE_LEVEL_MAP[placePriceLevel]) {
            return { tier: PLACES_PRICE_LEVEL_MAP[placePriceLevel], confidence: 0.6, source: 'google_places_price_level' };
      }
      if (chainScaleTier && PRICE_FROM_SCALE[chainScaleTier]) {
            return { tier: PRICE_FROM_SCALE[chainScaleTier], confidence: 0.3, source: 'derived_from_chain_scale_proxy' };
      }
      return { tier: 'unknown', confidence: 0.1, source: 'no_signal' };
}

// --- Positioning tags -----------------------------------------------------------
// Note: station/landmark references (e.g. "Centraal Station") are deliberately
// excluded from the "business" trigger - they describe location, not positioning.
function tagsFromName(name) {
      const n = String(name || '').toLowerCase();
      const tags = [];
      if (/legend|heritage|historic/.test(n)) tags.push('heritage');
      if (/luxury|palace|grand/.test(n)) tags.push('luxury');
      if (/boutique|hoxton|lifestyle|design hotel/.test(n)) tags.push('lifestyle');
      if (/\bbusiness\b/.test(n)) tags.push('business');
      if (/family|kids/.test(n)) tags.push('family');
      if (/conference|convention|meeting/.test(n)) tags.push('MICE');
      if (/resort|spa|wellness/.test(n)) tags.push('spa');
      if (/airport|schiphol|luchthaven/.test(n)) tags.push('airport');
      if (/budget|hostel|inn express|easyhotel/.test(n)) tags.push('budget');
      if (/extended stay|residence|apart-?hotel/.test(n)) tags.push('extended_stay');
      return [...new Set(tags)];
}

function jaccard(a, b) {
      if (!a.length && !b.length) return null;
      if (!a.length || !b.length) return 0.4;
      const sa = new Set(a);
      const sb = new Set(b);
      let shared = 0;
      for (const t of sa) if (sb.has(t)) shared++;
      return shared / new Set([...sa, ...sb]).size;
}

// --- Subject hotel profile -------------------------------------------------------
// Infers a competitive profile for the subject hotel from data we already have
// (name, address/city/country, extracted contact-page data if present). No new
// external calls are made here - this is intentionally conservative.
export function buildHotelProfile(hotel) {
      const dataGaps = [];
      const name = hotel && hotel.name ? hotel.name : '';
      const text = `${name} ${hotel && hotel.address ? hotel.address : ''} ${hotel && hotel.extracted_address ? hotel.extracted_address : ''}`.toLowerCase();

let marketType = 'city_center';
      let marketConfidence = 'low';
      let marketSource = 'default_assumption_no_strong_signal';
      if (AIRPORT_RE.test(text)) {
            marketType = 'airport'; marketConfidence = 'medium'; marketSource = 'name_or_address_keyword';
      } else if (RESORT_RE.test(text)) {
            marketType = 'resort'; marketConfidence = 'medium'; marketSource = 'name_or_address_keyword';
      } else {
            dataGaps.push('market_type defaulted to city_center - no strong airport/resort/suburban signal found in name or address');
      }

const scale = chainScaleFromName(name);
      if (!scale.tier) dataGaps.push('chain_scale_proxy unknown - no recognized brand/segment keyword in hotel name');
      const chainScaleProxy = scale.tier || 'unknown';

const priceBand = resolvePriceBand(scale.tier, null);
      if (priceBand.source !== 'google_places_price_level' && priceBand.tier === 'unknown') {
            dataGaps.push('price_band_proxy unknown - no chain-scale signal to derive it from');
      }

const positioningTags = tagsFromName(name);
      if (!positioningTags.length) dataGaps.push('no positioning_tags detected from hotel name');

dataGaps.push('room_count not available - no integration currently provides verified room counts');
      dataGaps.push('meeting_or_mice_signal, fnb_signal and spa_signal are name-keyword based only, not verified against the hotel website');

return {
      property_type: 'hotel',
      market_type: marketType,
      market_type_confidence: marketConfidence,
      market_type_source: marketSource,
      chain_scale_proxy: chainScaleProxy,
      chain_scale_confidence: scale.confidence,
      chain_scale_source: scale.source,
      price_band_proxy: priceBand.tier,
      price_band_confidence: priceBand.confidence,
      positioning_tags: positioningTags,
      room_count: null,
      meeting_or_mice_signal: /conference|convention|meeting|mice/.test(text) || null,
      fnb_signal: /restaurant|brasserie|bistro/.test(text) || null,
      spa_signal: /spa|wellness/.test(text) || null,
      data_gaps: dataGaps
};
}

// --- Dynamic radius ---------------------------------------------------------------
// Classification-relevance radius tiers (NOT the raw Google Places search radius -
// the search radius stays generous so borderline/excluded candidates like a distant
// airport hotel are still fetched and explained, never silently hidden).
// V3.25A: for city_center (and suburban/mixed) markets, searchRadiusMeters now follows the
// classification secondaryKm tier instead of a flat 20km. Combined with DISTANCE rankPreference
// in searchNearbyHotels(), this fixes a candidate-RECALL problem in dense city centers (a closer
// heritage/luxury hotel being crowded out of the raw Nearby Search results by more "popular"
// hotels farther away). Airport/resort search radii are intentionally left wider, unchanged.
export function resolveDynamicRadius(marketType) {
      switch (marketType) {
            case 'airport':
                  return { primaryKm: 5, secondaryKm: 15, searchRadiusMeters: 25000 };
            case 'resort':
                  return { primaryKm: 10, secondaryKm: 30, searchRadiusMeters: 40000 };
            case 'suburban':
            case 'mixed':
                  return { primaryKm: 3, secondaryKm: 10, searchRadiusMeters: 10000 };
            case 'city_center':
            default:
                  return { primaryKm: 2, secondaryKm: 5, searchRadiusMeters: 5000 };
      }
}

// --- Hard exclusion (evaluated before scoring) ------------------------------------
export function hardExclusionCheck(place, name, subjectProfile) {
      const types = Array.isArray(place.types) ? place.types : [];
      const n = String(name || '');

const strongTypeHits = types.filter((t) => EXCLUDE_STRONG_TYPES.has(t));
      if (strongTypeHits.length) {
            return {
                  excluded: true,
                  exclusion_reason: 'not_comparable_property_type',
                  exclusion_reasons: ['campground_rv_park_or_similar_non_hotel_type'],
                  exclusion_confidence: 0.95,
                  source_signals: [`google_places_type:${strongTypeHits.join(',')}`]
            };
      }

if (types.includes('hostel') || HOSTEL_NAME_RE.test(n)) {
      return {
            excluded: true,
            exclusion_reason: 'accommodation_type_mismatch',
            exclusion_reasons: ['hostel_not_comparable_with_full_service_hotel'],
            exclusion_confidence: types.includes('hostel') ? 0.95 : 0.75,
            source_signals: [types.includes('hostel') ? 'google_places_type:hostel' : 'name_pattern:hostel']
      };
}

if (types.includes('extended_stay_hotel') || APARTHOTEL_RE.test(n)) {
      return {
            excluded: true,
            exclusion_reason: 'accommodation_type_mismatch',
            exclusion_reasons: ['aparthotel_or_serviced_apartment_not_comparable'],
            exclusion_confidence: 0.7,
            source_signals: [types.includes('extended_stay_hotel') ? 'google_places_type:extended_stay_hotel' : 'name_pattern:aparthotel']
      };
}

if (types.includes('bed_and_breakfast') || types.includes('guest_house') || BNB_RE.test(n)) {
      return {
            excluded: true,
            exclusion_reason: 'accommodation_type_mismatch',
            exclusion_reasons: ['bnb_guesthouse_not_comparable_with_full_service_hotel'],
            exclusion_confidence: 0.8,
            source_signals: ['google_places_type_or_name:bnb_guesthouse']
      };
}

if (types.includes('private_guest_room') || HOLIDAY_RENTAL_RE.test(n)) {
      return {
            excluded: true,
            exclusion_reason: 'accommodation_type_mismatch',
            exclusion_reasons: ['holiday_rental_not_comparable_with_full_service_hotel'],
            exclusion_confidence: 0.7,
            source_signals: ['google_places_type_or_name:holiday_rental']
      };
}

if (AIRPORT_RE.test(n) && subjectProfile.market_type !== 'airport') {
      return { excluded: false, downgrade: 'airport_cluster_mismatch', downgrade_confidence: 0.7, source_signals: ['name_pattern:airport'] };
}

if ((types.includes('resort_hotel') || RESORT_RE.test(n)) && subjectProfile.market_type !== 'resort') {
      return {
            excluded: false,
            downgrade: 'resort_segment_mismatch',
            downgrade_confidence: 0.6,
            source_signals: [types.includes('resort_hotel') ? 'google_places_type:resort_hotel' : 'name_pattern:resort']
      };
}

return { excluded: false };
}

// --- Fit score --------------------------------------------------------------------
function locationRelevanceScore(distanceKm, primaryKm, secondaryKm) {
      if (distanceKm === null || distanceKm === undefined) return 30;
      if (distanceKm <= primaryKm) return 100;
      if (distanceKm <= secondaryKm) {
            const frac = (distanceKm - primaryKm) / (secondaryKm - primaryKm);
            return Math.round(100 - frac * 60);
      }
      const over = distanceKm - secondaryKm;
      return Math.max(0, Math.round(40 - over * 4));
}

// V3.23.1: reason-builder + guardrail fix. Chain-scale "same tier" matches only
// count as a strong, primary-qualifying reason when neither side's chain-scale
// proxy came from a weak source (rating-based fallback or no signal at all). A
// weak-sourced match still surfaces honestly, but as a data_gaps/weakness note,
// never as a false-positive strong reason. Price-band matches now generate a
// visible (but explicitly non-strong) reason - previously this signal was silently
// dropped even when it matched. Positioning overlap (jac >= 0.5) remains a strong
// reason, as it already required real, non-fallback overlap.
function computeFitScore(subjectProfile, candidateProfile, distanceKm, radius) {
      const reasons = [];
      const weaknesses = [];
      const dataGaps = [];
      let hasStrongReason = false;

const subjRank = TIER_RANK[subjectProfile.chain_scale_proxy] || null;
      const candRank = TIER_RANK[candidateProfile.chain_scale_proxy] || null;
      let segScore, segConf;
      if (subjRank && candRank) {
            const diff = Math.abs(subjRank - candRank);
            segScore = Math.max(0, 100 - diff * 25);
            segConf = 0.6;
            if (diff === 0) {
                  const weakMatch = isWeakChainScaleSource(subjectProfile.chain_scale_source) || isWeakChainScaleSource(candidateProfile.chain_scale_source);
                  if (weakMatch) {
                        weaknesses.push(`Chain-scale tiers appear to match (${subjectProfile.chain_scale_proxy}), but this is based on a weak signal (rating-based estimate, not a confirmed brand or segment), so it is not counted as a strong fit reason.`);
                        dataGaps.push('chain_scale_proxy match relies on a weak rating-based fallback for at least one property, not a confirmed brand/segment signal');
                  } else {
                        reasons.push(`Same chain-scale tier as subject hotel (${subjectProfile.chain_scale_proxy}).`);
                        hasStrongReason = true;
                  }
            } else if (diff >= 2) {
                  weaknesses.push(`Chain-scale tier is ${diff} levels away from the subject hotel (${candidateProfile.chain_scale_proxy} vs ${subjectProfile.chain_scale_proxy}).`);
            }
      } else {
            segScore = 50; segConf = 0.15;
            dataGaps.push('chain_scale_proxy unknown for one or both properties - segment fit defaulted to neutral');
      }

const subjPrice = subjectProfile.price_band_proxy;
      const candPrice = candidateProfile.price_band_proxy;
      let priceScore, priceConf;
      if (subjPrice && candPrice && PRICE_RANK[subjPrice] && PRICE_RANK[candPrice]) {
            const diff = Math.abs(PRICE_RANK[subjPrice] - PRICE_RANK[candPrice]);
            priceScore = Math.max(0, 100 - diff * 25);
            priceConf = candidateProfile.price_band_source === 'google_places_price_level' ? 0.5 : 0.3;
            if (diff === 0) {
                  reasons.push(`Similar price positioning to the subject hotel (${candPrice}). Note: price level alone does not confirm chain-scale or luxury positioning, so this is not treated as a strong reason on its own.`);
            } else if (diff >= 2) {
                  weaknesses.push(`Price band proxy is well below/above the subject hotel (${candPrice} vs ${subjPrice}).`);
            }
      } else {
            priceScore = 50; priceConf = 0.15;
            dataGaps.push('price_band_proxy unknown for one or both properties - price fit defaulted to neutral');
      }

const subjTags = subjectProfile.positioning_tags || [];
      const candTags = candidateProfile.positioning_tags || [];
      const jac = jaccard(subjTags, candTags);
      const posScore = jac === null ? 50 : Math.round(jac * 100);
      if (jac === null) dataGaps.push('no positioning_tags available for one or both properties - positioning fit defaulted to neutral');
      else if (jac === 0) weaknesses.push('Positioning tags do not overlap with the subject hotel.');
      else if (jac >= 0.5) {
            reasons.push('Shares meaningful positioning signals with the subject hotel.');
            hasStrongReason = true;
      }

const locScore = locationRelevanceScore(distanceKm, radius.primaryKm, radius.secondaryKm);
      if (distanceKm !== null && distanceKm <= radius.primaryKm) reasons.push(`Within the primary relevance radius (${distanceKm}km <= ${radius.primaryKm}km for this market type).`);
      else if (distanceKm !== null && distanceKm > radius.secondaryKm) weaknesses.push(`Distance (${distanceKm}km) is beyond the secondary relevance radius (${radius.secondaryKm}km) for this market type.`);

const scaleScore = 50;
      dataGaps.push('room_count not available for either property - scale fit defaulted to neutral');

const fit = segScore * 0.30 + priceScore * 0.25 + posScore * 0.20 + locScore * 0.15 + scaleScore * 0.10;
      const confidence = segConf * 0.30 + priceConf * 0.25 + (jac === null ? 0.15 : 0.5) * 0.20 + 0.7 * 0.15 + 0.1 * 0.10;

return {
      fit_score: Math.round(fit),
      fit_confidence: Math.round(confidence * 100) / 100,
      fit_reasons: reasons,
      weaknesses,
      data_gaps: dataGaps,
      has_strong_reason: hasStrongReason
};
}

// --- Candidate profile + main classification --------------------------------------
function buildCandidateProfile(place, name) {
      const scale = resolveChainScale(name, typeof place.rating === 'number' ? place.rating : null);
      const priceBand = resolvePriceBand(scale.tier, place.priceLevel || null);
      return {
            property_type: 'hotel',
            chain_scale_proxy: scale.tier || 'unknown',
            chain_scale_confidence: scale.confidence,
            chain_scale_source: scale.source,
            price_band_proxy: priceBand.tier,
            price_band_confidence: priceBand.confidence,
            price_band_source: priceBand.source,
            positioning_tags: tagsFromName(name)
      };
}

export function classifyCandidate(place, hotel, subjectProfile, origin, radius) {
      const name = (place.displayName && place.displayName.text) || 'Unknown property';
      const address = place.formattedAddress || '';
      const lat = place.location ? place.location.latitude : null;
      const lng = place.location ? place.location.longitude : null;
      const distance_km = Number.isFinite(lat) && Number.isFinite(lng)
      ? Math.round(haversineKm(origin.lat, origin.lng, lat, lng) * 10) / 10
            : null;
      const rating = typeof place.rating === 'number' ? place.rating : null;
      const review_count = typeof place.userRatingCount === 'number' ? place.userRatingCount : null;
      const website = place.websiteUri || null;
      const businessStatus = place.businessStatus || 'OPERATIONAL';
      const placeId = place.id || null;

const sameHotel =
      (placeId && hotel.google_place_id && placeId === hotel.google_place_id) ||
      (name && hotel.name && name.trim().toLowerCase() === String(hotel.name).trim().toLowerCase() && distance_km !== null && distance_km < 0.05);

const base = {
      place_id: placeId,
      name,
      address,
      website,
      distance_km,
      rating,
      review_count,
      google_maps_url: place.googleMapsUri || null
};

if (sameHotel) {
      return { ...base, classification: 'excluded', exclusion_reason: 'same_hotel', exclusion_reasons: ['this_is_the_subject_hotel_itself'], exclusion_confidence: 0.99, source_signals: ['place_id_or_name_match'] };
}
      if (businessStatus !== 'OPERATIONAL') {
            return { ...base, classification: 'excluded', exclusion_reason: 'business_closed', exclusion_reasons: ['business_marked_closed_on_google'], exclusion_confidence: 0.9, source_signals: ['google_places_business_status'] };
      }
      if (rating !== null && rating < 3.0) {
            return { ...base, classification: 'excluded', exclusion_reason: 'rating_too_low', exclusion_reasons: ['rating_below_reliable_competitor_threshold'], exclusion_confidence: 0.7, source_signals: ['google_places_rating'] };
      }
      if (review_count !== null && review_count < 10) {
            return { ...base, classification: 'excluded', exclusion_reason: 'insufficient_review_volume', exclusion_reasons: ['too_few_reviews_for_a_reliable_signal'], exclusion_confidence: 0.6, source_signals: ['google_places_review_count'] };
      }

const excl = hardExclusionCheck(place, name, subjectProfile);
      if (excl.excluded) {
            return {
                  ...base,
                  classification: 'excluded',
                  exclusion_reason: excl.exclusion_reason,
                  exclusion_reasons: excl.exclusion_reasons,
                  exclusion_confidence: excl.exclusion_confidence,
                  source_signals: excl.source_signals
            };
      }

const candidateProfile = buildCandidateProfile(place, name);
      candidateProfile.market_type = excl.downgrade === 'airport_cluster_mismatch' ? 'airport'
            : (excl.downgrade === 'resort_segment_mismatch' ? 'resort' : subjectProfile.market_type);

if (excl.downgrade && (distance_km === null || distance_km > radius.secondaryKm)) {
      return {
            ...base,
            ...candidateProfile,
            classification: 'excluded',
            exclusion_reason: excl.downgrade,
            exclusion_reasons: [excl.downgrade],
            exclusion_confidence: excl.downgrade_confidence,
            source_signals: excl.source_signals
      };
}

if (
      candidateProfile.chain_scale_source === 'name_brand_keyword' &&
      candidateProfile.chain_scale_proxy === 'economy' &&
      ['luxury', 'upper_upscale'].includes(subjectProfile.chain_scale_proxy)
      ) {
      return {
            ...base,
            ...candidateProfile,
            classification: 'excluded',
            exclusion_reason: 'segment_too_far_below_subject',
            exclusion_reasons: ['economy_segment_not_comparable_with_luxury_or_upper_upscale_subject'],
            exclusion_confidence: 0.65,
            source_signals: ['chain_scale_proxy:economy']
      };
}

const fit = computeFitScore(subjectProfile, candidateProfile, distance_km, radius);

const subjRank = TIER_RANK[subjectProfile.chain_scale_proxy] || null;
      const candRank = TIER_RANK[candidateProfile.chain_scale_proxy] || null;
      const isAspirational = subjRank && candRank && candRank > subjRank && distance_km !== null && distance_km <= radius.secondaryKm * 2 && fit.fit_score >= 40;

// V3.23.1 classification gate:
// 1) A candidate with zero fit_reasons can never be primary or secondary - it is
// capped at nearby_not_comparable, with a data_gaps note explaining why.
// 2) A candidate that reaches the primary fit_score threshold purely through
// weaker proxy signals (price/location) without any strong segment, chain-scale
// or positioning reason is downgraded to secondary, not primary, with a
// data_gaps note explaining the cap.
let classification;
      if (isAspirational) {
            classification = 'aspirational_competitor';
      } else if (fit.fit_reasons.length === 0) {
            classification = 'nearby_not_comparable';
            fit.data_gaps.push('Classification capped at nearby_not_comparable because no clear positive fit reasons could be established from available signals.');
      } else if (fit.fit_score >= 75 && distance_km !== null && distance_km <= radius.secondaryKm) {
            if (fit.has_strong_reason) {
                  classification = 'primary_competitor';
            } else {
                  classification = 'secondary_competitor';
                  fit.data_gaps.push('Fit score met the primary threshold, but classification was capped at secondary because supporting evidence relied only on weaker proxy signals (such as price level or distance) rather than a confirmed chain-scale or positioning match.');
            }
      } else if (fit.fit_score >= 55 && distance_km !== null && distance_km <= radius.secondaryKm) {
            classification = 'secondary_competitor';
      } else {
            classification = 'nearby_not_comparable';
      }

if (excl.downgrade) fit.weaknesses.push(`Flagged as a possible ${excl.downgrade.replace(/_/g, ' ')}.`);

return {
      ...base,
      ...candidateProfile,
      classification,
      fit_score: fit.fit_score,
      fit_confidence: fit.fit_confidence,
      fit_reasons: fit.fit_reasons,
      weaknesses: fit.weaknesses,
      data_gaps: fit.data_gaps
};
}
