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

// Resolves a hotel's lat/lng via Google Places Text Search (New) when it is not
// already stored on the hotel record. Read-only lookup, no scraping.
async function resolveHotelLocation(hotel) {
    const key = getGooglePlacesApiKey();
    if (!key) return null;

  const query = [hotel.name, hotel.address, hotel.city, hotel.country]
      .filter(Boolean)
      .join(', ');
    if (!query) return null;

  try {
        const r = await fetch(`${PLACES_API_BASE}/places:searchText`, {
                method: 'POST',
                headers: {
                          'Content-Type': 'application/json',
                          'X-Goog-Api-Key': key,
                          'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress'
                },
                body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
                console.error('Google Places text search error', { status: r.status, data });
                return null;
        }
        const place = data && Array.isArray(data.places) ? data.places[0] : null;
        if (!place || !place.location) return null;
        const lat = place.location.latitude;
        const lng = place.location.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng, place_id: place.id || null, formatted_address: place.formattedAddress || null };
  } catch (err) {
        console.error('Google Places text search request failed', err.message);
        return null;
  }
}

// Searches for lodging businesses within radiusMeters of the given coordinates using
// Google Places Nearby Search (New). Returns the raw place results (capped list, no
// pagination beyond what the API returns in a single call).
async function searchNearbyHotels(lat, lng, radiusMeters = 20000) {
    const key = getGooglePlacesApiKey();
    if (!key) return [];

  try {
        const r = await fetch(`${PLACES_API_BASE}/places:searchNearby`, {
                method: 'POST',
                headers: {
                          'Content-Type': 'application/json',
                          'X-Goog-Api-Key': key,
                          'X-Goog-FieldMask':
                                      'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.googleMapsUri,places.types,places.businessStatus'
                },
                body: JSON.stringify({
                          includedTypes: ['lodging'],
                          maxResultCount: 20,
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
                console.error('Google Places nearby search error', { status: r.status, data });
                return [];
        }
        return (data && Array.isArray(data.places)) ? data.places : [];
  } catch (err) {
        console.error('Google Places nearby search request failed', err.message);
        return [];
  }
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
