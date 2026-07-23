// googlePlaces.js
// Google Places API (New) competitor discovery connector.
// Server-side only: the API key is read from process.env.GOOGLE_PLACES_API_KEY and
// is never sent to the browser or embedded in any client-facing response.
// This is completely separate from the Google Business Profile OAuth connector -
// there is no OAuth flow here and no Google login is required.
// Never scrapes Google/Tripadvisor pages. Never fabricates competitors.

const PLACES_API_BASE = 'https://places.googleapis.com/v1';

// Property types that are clearly a different kind of stay than a comparable hotel.
const EXCLUDE_STRONG_TYPES = new Set([
    'campground', 'rv_park', 'mobile_home_park', 'farmstay', 'cottage'
  ]);

// Property types that are sometimes comparable (large/high-rated hostels, guest houses,
// serviced apartments) but should be excluded by default unless the data shows they are
// genuinely comparable to a full-service hotel.
const ALT_LODGING_TYPES = new Set([
    'hostel', 'guest_house', 'private_guest_room', 'japanese_inn', 'budget_japanese_inn'
  ]);

const NAME_ALT_PATTERN = /\b(hostel|apartment|apart-?hotel|holiday\s*home|vacation\s*rental|serviced\s*apartment|b\s*&\s*b|bed\s*and\s*breakfast|guest\s*house|guesthouse)\b/i;

function getGooglePlacesApiKey() {
    return process.env.GOOGLE_PLACES_API_KEY || null;
}

function getCompetitorsConnectorStatus() {
    return {
          configured: !!getGooglePlacesApiKey(),
          provider: 'google_places',
          api: 'Places API (New)'
    };
}

function toRad(deg) {
    return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// googlePlaces.js

// ISO 3166-1 alpha-2 region codes for hotel countries we commonly see. Used only as an
// optional bias for Google Places Text Search (New) - never hardcoded to a single country.
// If a hotel's country is not in this map, no region bias is applied (graceful fallback).
const COUNTRY_REGION_CODES = {
    'belgium': 'BE', 'germany': 'DE', 'netherlands': 'NL', 'the netherlands': 'NL',
    'france': 'FR', 'luxembourg': 'LU', 'spain': 'ES', 'italy': 'IT', 'portugal': 'PT',
    'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
    'ireland': 'IE', 'austria': 'AT', 'switzerland': 'CH', 'denmark': 'DK', 'sweden': 'SE',
    'norway': 'NO', 'finland': 'FI', 'poland': 'PL', 'czech republic': 'CZ', 'czechia': 'CZ',
    'hungary': 'HU', 'greece': 'GR', 'croatia': 'HR', 'slovenia': 'SI', 'slovakia': 'SK',
    'romania': 'RO', 'bulgaria': 'BG', 'united states': 'US', 'usa': 'US',
    'united states of america': 'US', 'canada': 'CA', 'japan': 'JP', 'south korea': 'KR',
    'australia': 'AU', 'new zealand': 'NZ', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
    'india': 'IN', 'china': 'CN', 'singapore': 'SG', 'thailand': 'TH', 'uae': 'AE',
    'united arab emirates': 'AE'
};

const GENERIC_NAME_WORDS = new Set([
    'hotel', 'hotels', 'the', 'and', 'de', 'du', 'la', 'le', 'inn', 'suites', 'suite',
    'resort', 'residence', 'house', 'grand'
    ]);
// Returns a bare comparable hostname (no protocol, no www, no path) or null.
function normaliseHost(value) {
    if (!value) return null;
    try {
        const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
        const host = new URL(withProto).hostname.toLowerCase();
        return host.replace(/^www\./, '');
    } catch (err) {
        return String(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null;
    }
}

// Looks up an ISO region code for a hotel's country. Returns null (no bias applied)
// if the country is missing or not in the map - never restricts to one country.
function countryToRegionCode(country) {
    if (!country) return null;
    return COUNTRY_REGION_CODES[String(country).trim().toLowerCase()] || null;
}

function significantWords(name) {
    if (!name) return [];
    return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !GENERIC_NAME_WORDS.has(w));
}

// Dependency-free Jaccard-like similarity over significant (non-generic) words.
function nameSimilarity(a, b) {
    const wa = new Set(significantWords(a));
    const wb = new Set(significantWords(b));
    if (!wa.size || !wb.size) return 0;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / new Set([...wa, ...wb]).size;
}

// Pulls a specific Google addressComponents entry (e.g. country/locality) by type.
function extractAddressComponent(components, wantedTypes) {
    if (!Array.isArray(components)) return null;
    const found = components.find(c => Array.isArray(c.types) && c.types.some(t => wantedTypes.includes(t)));
    return found ? (found.longText || found.shortText || null) : null;
}

// Builds the Places Text Search query from whatever hotel context we have -
// never hardcoded to a single city or country.
function buildLocationQuery(hotel) {
    return [hotel.name, hotel.address, hotel.city, hotel.country]
    .filter(Boolean)
    .join(', ');
}
// Scores a single Places candidate against the source hotel's own profile.
// Returns { confidence: 'high'|'medium'|'low', reasons: [...], score, domainMatch, countryMatch, cityMatch }
function scoreLocationCandidate(candidate, hotel) {
    const reasons = [];
    let score = 0;
    
    const hotelHost = normaliseHost(hotel.website || hotel.domain);
    const candidateHost = normaliseHost(candidate.website);
    const domainMatch = !!(hotelHost && candidateHost && hotelHost === candidateHost);
    if (domainMatch) {
        score += 3;
        reasons.push('website domain matches hotel website');
    }
    
    let countryMatch = null;
    if (hotel.country) {
        const expected = String(hotel.country).trim().toLowerCase();
        const candidateCountry = (candidate.country_component || '').toLowerCase();
        const addr = (candidate.formatted_address || '').toLowerCase();
        countryMatch = (candidateCountry && (candidateCountry.includes(expected) || expected.includes(candidateCountry))) || addr.includes(expected);
        if (countryMatch) {
            score += 2;
            reasons.push('country matches expected country');
        } else {
            score -= 5;
            reasons.push('country does not match expected country');
        }
    }
    
    let cityMatch = null;
    if (hotel.city) {
        const expectedCity = String(hotel.city).trim().toLowerCase();
        const candidateCity = (candidate.city_component || '').toLowerCase();
        const addr = (candidate.formatted_address || '').toLowerCase();
        cityMatch = (candidateCity && candidateCity.includes(expectedCity)) || addr.includes(expectedCity);
        if (cityMatch) {
            score += 1;
            reasons.push('city matches expected city');
        } else {
            score -= 1;
            reasons.push('city does not match expected city');
        }
    }
    
    const sim = nameSimilarity(hotel.name, candidate.name);
    if (sim >= 0.5) {
        score += 1;
        reasons.push('name is a strong match');
    } else if (sim < 0.2 && !domainMatch) {
        score -= 1;
        reasons.push('name similarity is weak');
    }
    
    const hasContext = !!(hotel.address || hotel.city || hotel.country);
    if (!hasContext && !domainMatch) {
        score = Math.min(score, 0);
        reasons.push('no address/city/country context available to verify this match');
    }
    
    let confidence;
    if (countryMatch === false) {
        confidence = 'low';
    } else if (score >= 4) {
        confidence = 'high';
    } else if (score >= 2) {
        confidence = 'medium';
    } else {
        confidence = 'low';
    }
    
    return { confidence, reasons, score, domainMatch, countryMatch, cityMatch };
}

// Resolves a hotel's lat/lng via Google Places Text Search (New) when it is not
// already stored on the hotel record. Country-aware and hotel-profile-aware: builds
// its query from the hotel's own name/address/city/country, and applies a region bias
// only when the hotel's country maps to a known ISO region code. Never hardcoded to
// any single country. Read-only lookup, no scraping.
// Returns { top: <bestScoredCandidate|null>, candidates: [...scoredCandidates] }
async function resolveHotelLocation(hotel) {
    const key = getGooglePlacesApiKey();
    if (!key) return { top: null, candidates: [] };
    
    const query = buildLocationQuery(hotel);
    if (!query) return { top: null, candidates: [] };
    
    const regionCode = countryToRegionCode(hotel.country);
    
    try {
        const requestBody = { textQuery: query, maxResultCount: 5 };
        if (regionCode) requestBody.regionCode = regionCode;
        
        const r = await fetch(`${PLACES_API_BASE}/places:searchText`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': key,
                'X-Goog-FieldMask':
                    'places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.googleMapsUri,places.addressComponents'
            },
            body: JSON.stringify(requestBody)
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
            console.error('Google Places text search error', { status: r.status, data });
            return { top: null, candidates: [] };
        }
        const places = (data && Array.isArray(data.places)) ? data.places : [];
        
        const candidates = places
        .filter(place => place && place.location)
        .map(place => {
            const lat = place.location.latitude;
            const lng = place.location.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            const candidate = {
                place_id: place.id || null,
                name: (place.displayName && place.displayName.text) || null,
                formatted_address: place.formattedAddress || null,
                website: place.websiteUri || null,
                google_maps_url: place.googleMapsUri || null,
                lat,
                lng,
                country_component: extractAddressComponent(place.addressComponents, ['country']),
                city_component: extractAddressComponent(place.addressComponents, ['locality', 'postal_town', 'administrative_area_level_2'])
            };
            const scored = scoreLocationCandidate(candidate, hotel);
            return { ...candidate, ...scored };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
        
        return { top: candidates[0] || null, candidates };
    } catch (err) {
        console.error('Google Places text search request failed', err.message);
        return { top: null, candidates: [] };
    }
}

// Searches for lodging businesses within radiusMeters of the given coordinates using
// Google Places Nearby Search (New). Returns the raw place results (capped list, no
// pagination beyond what the API returns in a single call).
// Runs a single Google Places Nearby Search (New) pass with the given rankPreference.
// Returns the raw place results (single call, no pagination beyond the API response).
async function nearbySearchOnce(lat, lng, radiusMeters, rankPreference) {
    const key = getGooglePlacesApiKey();
    if (!key) return [];
    try {
        const r = await fetch(`${PLACES_API_BASE}/places:searchNearby`, {
                method: 'POST',
                headers: {
                          'Content-Type': 'application/json',
                          'X-Goog-Api-Key': key,
                          'X-Goog-FieldMask':
                                      'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.googleMapsUri,places.types,places.businessStatus,places.priceLevel'
                },
                body: JSON.stringify({
                          includedTypes: ['lodging'],
                          maxResultCount: 20,
                          rankPreference,
                          locationRestriction: {
                                      circle: {
                                                    center: { latitude: lat, longitude: lng },
                                                    radius: radiusMeters
                                      }
                          }
                })
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
                console.error('Google Places nearby search error', { status: r.status, rankPreference, data });
                return [];
        }
        return (data && Array.isArray(data.places)) ? data.places : [];
    } catch (err) {
        console.error('Google Places nearby search request failed', err.message);
        return [];
    }
}

// V3.25A.1: Hybrid candidate recall. Pure DISTANCE ranking floods ultra-dense city
// centers with the literal nearest micro-listings and pushes out prominent nearby
// hotels. Instead we run a relevance/prominence pass over the (tighter) radius, plus a
// supplemental distance-ranked pass over a small inner radius, then merge + dedupe.
// Each result is tagged with candidate_source so downstream can explain provenance.
// Universal - no hardcoded hotels or cities.
const INNER_DISTANCE_RADIUS_METERS = 2000;

async function searchNearbyHotels(lat, lng, radiusMeters = 20000) {
    const key = getGooglePlacesApiKey();
    if (!key) return [];

    const innerRadius = Math.min(radiusMeters, INNER_DISTANCE_RADIUS_METERS);

    const [popularityResults, distanceResults] = await Promise.all([
        nearbySearchOnce(lat, lng, radiusMeters, 'POPULARITY'),
        nearbySearchOnce(lat, lng, innerRadius, 'DISTANCE')
    ]);

    const merged = [];
    const seenIds = new Set();
    const addAll = (places, source) => {
        for (const p of places) {
            if (!p) continue;
            const id = p.id || null;
            if (id && seenIds.has(id)) continue;
            const nm = (p.displayName && p.displayName.text) || '';
            const dup = merged.find((m) => {
                const mn = (m.displayName && m.displayName.text) || '';
                return mn && nm && nameSimilarity(mn, nm) >= 0.8;
            });
            if (dup) continue;
            if (id) seenIds.add(id);
            merged.push({ ...p, candidate_source: source });
        }
    };
    addAll(popularityResults, 'nearby_popularity_search');
    addAll(distanceResults, 'nearby_distance_search');

    return merged;
}

// Scores and classifies a single Google Places result against the source hotel.
// Never presents every nearby hotel as a competitor - excludes/downranks hostels,
// apartments, holiday rentals, non-comparable B&Bs, very low rating/review volume,
// closed businesses, the same hotel, and clearly different positioning.
function classifyCompetitor(place, hotel, origin) {
    const name = (place.displayName && place.displayName.text) || 'Unknown property';
    const address = place.formattedAddress || '';
    const lat = place.location ? place.location.latitude : null;
    const lng = place.location ? place.location.longitude : null;
    const distance_km =
          Number.isFinite(lat) && Number.isFinite(lng)
        ? Math.round(haversineKm(origin.lat, origin.lng, lat, lng) * 10) / 10
            : null;
    const rating = typeof place.rating === 'number' ? place.rating : null;
    const review_count = typeof place.userRatingCount === 'number' ? place.userRatingCount : null;
    const website = place.websiteUri || null;
    const google_maps_url = place.googleMapsUri || null;
    const types = Array.isArray(place.types) ? place.types : [];
    const businessStatus = place.businessStatus || 'OPERATIONAL';
    const placeId = place.id || null;

  const reasons = [];
    let competitor_type;

  const sameHotel =
        (placeId && hotel.google_place_id && placeId === hotel.google_place_id) ||
        (name &&
               hotel.name &&
               name.trim().toLowerCase() === String(hotel.name).trim().toLowerCase() &&
               distance_km !== null &&
               distance_km < 0.05);

  const isAltLodging =
        types.some((t) => ALT_LODGING_TYPES.has(t)) || NAME_ALT_PATTERN.test(name);
    const isStronglyExcludedType = types.some((t) => EXCLUDE_STRONG_TYPES.has(t));

  if (sameHotel) {
        competitor_type = 'excluded';
        reasons.push('This is the same hotel.');
  } else if (businessStatus !== 'OPERATIONAL') {
        competitor_type = 'excluded';
        reasons.push('Business is marked as closed on Google.');
  } else if (isStronglyExcludedType) {
        competitor_type = 'excluded';
        reasons.push('Property type is not comparable (campground, RV park, farmstay or cottage).');
  } else if (rating !== null && rating < 3.0) {
        competitor_type = 'excluded';
        reasons.push('Rating is too low to be a comparable competitor.');
  } else if (review_count !== null && review_count < 10) {
        competitor_type = 'excluded';
        reasons.push('Too few reviews to be a reliable competitor signal.');
  } else if (isAltLodging) {
        const comparable = rating !== null && rating >= 4.2 && review_count !== null && review_count >= 50;
        if (comparable) {
                competitor_type = 'secondary_competitor';
                reasons.push('Hostel/apartment/B&B-style property, but rating and review volume make it comparable.');
        } else {
                competitor_type = 'excluded';
                reasons.push('Hostel, apartment, holiday-rental or B&B style property, not comparable to a full-service hotel.');
        }
  } else if (distance_km === null) {
        competitor_type = 'nearby_not_comparable';
        reasons.push('Distance could not be determined from Google Places data.');
  } else if (distance_km <= 5 && rating !== null && rating >= 3.5 && review_count !== null && review_count >= 20) {
        competitor_type = 'primary_competitor';
        reasons.push('Close distance with a comparable rating and review volume.');
  } else if (distance_km <= 20) {
        competitor_type = 'secondary_competitor';
        reasons.push('Within 20km and passes basic comparability checks.');
  } else {
        competitor_type = 'nearby_not_comparable';
        reasons.push('Outside the practical competitive radius.');
  }

  let confidence;
    if (competitor_type === 'primary_competitor') confidence = 0.85;
    else if (competitor_type === 'secondary_competitor') confidence = 0.65;
    else if (competitor_type === 'nearby_not_comparable') confidence = 0.35;
    else confidence = 0.2;
    if (rating === null || review_count === null) confidence = Math.max(0.1, confidence - 0.15);

  return {
        place_id: placeId,
        name,
        address,
        distance_km,
        rating,
        review_count,
        website,
        google_maps_url,
        competitor_type,
        confidence: Math.round(confidence * 100) / 100,
        reason: reasons.join(' ')
  };
}

export {
    getGooglePlacesApiKey,
    getCompetitorsConnectorStatus,
    resolveHotelLocation,
    searchNearbyHotels,
    classifyCompetitor,
    haversineKm
};
