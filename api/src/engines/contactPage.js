// contactPage.js
// Contact Page Discovery + NAP (Name/Address/Phone) extraction.
// Finds and parses a hotel's OWN public contact page (never third-party platforms)
// to improve address/city/country/phone/social detection before falling back to a
// plain Google Places text search. This directly helps prevent wrong global matches
// (e.g. a Brussels hotel being resolved to a same-named property in another country).
//
// Crawl limits: never crawls the whole site, checks at most MAX_CANDIDATE_PAGES
// internal pages, applies a per-request timeout, and fails gracefully (returns null)
// on any network/parse error. Only ever fetches pages on the hotel's own hostname.

const MAX_CANDIDATE_PAGES = 10;
const FETCH_TIMEOUT_MS = 8000;

const CONTACT_KEYWORDS = [
    'contact', 'contact-us', 'contacteer-ons', 'contactez', 'kontakt',
    'route', 'location', 'find us', 'visit us'
  ];

const COMMON_PATHS = [
    '/contact', '/contact/', '/contact-us', '/contact-us/',
    '/nl/contact', '/fr/contact', '/en/contact', '/de/contact',
    '/contacteer-ons', '/contactez-nous', '/kontakt'
  ];
function normaliseHost(value) {
  if (!value) return null;
  try {
    const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
  } catch (err) {
    return null;
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'PolarisHotelMonitorBot/1.0 (+contact-page-discovery)' }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
// Extracts (href, text) pairs for every <a> tag in raw HTML. Lightweight regex-based
// parsing - this is intentionally not a full HTML parser, just enough to find links.
function extractLinks(html) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ href, text });
  }
  return links;
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

function looksLikeContactLink(href, text) {
  const haystack = `${href} ${text}`.toLowerCase();
  return CONTACT_KEYWORDS.some((k) => haystack.includes(k));
}

// Finds up to MAX_CANDIDATE_PAGES candidate contact-page URLs on the hotel's own
// hostname: links from the homepage that look contact-related, common contact paths,
// and (if reachable) entries from sitemap.xml that look contact-related.
async function findCandidatePages(homepageUrl, homepageHtml, hostname) {
  const candidates = [];
  const seen = new Set();

function addCandidate(url) {
  if (!url) return;
  let normalised;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase().replace(/^www\./, '') !== hostname) return;
    parsed.hash = '';
    normalised = parsed.toString();
  } catch (err) {
    return;
  }
  if (seen.has(normalised)) return;
  seen.add(normalised);
  candidates.push(normalised);
}

if (homepageHtml) {
  const links = extractLinks(homepageHtml);
  for (const { href, text } of links) {
    if (!looksLikeContactLink(href, text)) continue;
    addCandidate(resolveUrl(href, homepageUrl));
  }
}

const origin = new URL(homepageUrl).origin;
  for (const path of COMMON_PATHS) {
    addCandidate(resolveUrl(path, origin));
  }

if (candidates.length < MAX_CANDIDATE_PAGES) {
  const sitemapHtml = await fetchWithTimeout(`${origin}/sitemap.xml`, FETCH_TIMEOUT_MS);
  if (sitemapHtml) {
    const locRe = /<loc>(.*?)<\/loc>/gi;
    let match;
    while ((match = locRe.exec(sitemapHtml)) !== null) {
      const url = match[1].trim();
      if (looksLikeContactLink(url, '')) addCandidate(url);
    }
  }
}

return candidates.slice(0, MAX_CANDIDATE_PAGES);
}
// Parses schema.org JSON-LD blocks looking for Hotel / LocalBusiness / LodgingBusiness
// entries, returning address/geo/sameAs data if found.
function extractJsonLd(html) {
  const results = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch (err) {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const type = item['@type'];
      const types = Array.isArray(type) ? type : [type];
      const isRelevant = types.some((t) => typeof t === 'string' && /hotel|lodgingbusiness|localbusiness/i.test(t));
      if (isRelevant) results.push(item);
    }
  }
  return results;
}

function firstString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === 'object') return value.name || value['@id'] || null;
  return null;
}

function extractSocialLinksFromHtml(html) {
  const social = { instagram: null, facebook: null, linkedin: null };
  const patterns = {
    instagram: /https?:\/\/(www\.)?instagram\.com\/[^\s"'<>]+/i,
    facebook: /https?:\/\/(www\.)?facebook\.com\/[^\s"'<>]+/i,
    linkedin: /https?:\/\/(www\.)?linkedin\.com\/[^\s"'<>]+/i
  };
  for (const key of Object.keys(patterns)) {
    const match = html.match(patterns[key]);
    if (match) social[key] = match[0];
  }
  return social;
}

function extractGoogleMapsLink(html) {
  const match = html.match(/https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)[^\s"'<>]*/i);
  return match ? match[0] : null;
}
// --- Plain-text (non JSON-LD) address + coordinate detection -------------------
// Many hotel contact pages render their NAP block as a simple <ul>/<li> list rather
// than schema.org markup, e.g.
//   <li>Sofitel Legend The Grand Amsterdam</li>
//   <li>Oudezijds Voorburgwal 197</li>
//   <li>1012 EX Amsterdam - The Netherlands</li>
// The functions below detect that pattern so such pages are no longer treated as
// having no address at all.

// Extracts the stripped text content of every <li>...</li> element in raw HTML.
function extractListItemLines(html) {
  const lines = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = match[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
    if (text) lines.push(text);
  }
  return lines;
}

// Matches a "<postal code> <city>" line, optionally followed by " - Country" or
// ", Country". Handles formats such as:
//   "1012 EX Amsterdam - The Netherlands"  (Dutch: 4 digits + 2 letters)
//   "75008 Paris, France"                  (French: 5 digits)
//   "10115 Berlin, Germany"                (German: 5 digits)
const POSTAL_CITY_COUNTRY_RE =
  /^([A-Z0-9][A-Z0-9-]{1,9})\s+([A-Za-z\u00C0-\u017F](?:[A-Za-z\u00C0-\u017F .'-])*?)(?:\s*[-,]\s*(.+))?$/;

function parsePostalCityCountry(line) {
  if (!line) return null;
  const trimmed = line.trim();
  const match = trimmed.match(POSTAL_CITY_COUNTRY_RE);
  if (!match) return null;
  const postalCode = match[1].trim();
  const city = match[2].trim();
  const country = match[3] ? match[3].trim() : null;
  if (!/\d/.test(postalCode)) return null;
  if (!city) return null;
  return { postalCode, city, country };
}

// Heuristic for "does this line look like a street address" (has a house number,
// isn't a phone/e-mail/postal-code line, and isn't unreasonably long).
function looksLikeStreetLine(line) {
  if (!line || line.length > 80) return false;
  if (/@/.test(line)) return false;
  if (/^tel:?/i.test(line) || /^(phone|fax|e-mail|email)\s*:/i.test(line)) return false;
  if (parsePostalCityCountry(line)) return false;
  return /\d/.test(line) && /[A-Za-z]/.test(line);
}

// Loose, case/accent-insensitive substring comparison used only as a soft signal
// for confidence scoring - never used to accept/reject an address on its own.
function namesRoughlyMatch(a, b) {
  if (!a || !b) return false;
  const normalise = (s) => s
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// Scans plain <li> text lines for a postal/city/country match, then looks
// backwards for an adjacent street line and hotel-name line, combining them per
// the standard NAP block layout: name / street + number / postal + city + country.
function extractPlainTextAddress(lines, hotelName) {
  for (let i = 0; i < lines.length; i += 1) {
    const postal = parsePostalCityCountry(lines[i]);
    if (!postal) continue;

  let street = null;
    let name = null;
    for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
      if (!street && looksLikeStreetLine(lines[j])) {
        street = lines[j];
        continue;
      }
      if (street && !name && lines[j].length <= 90) {
        name = lines[j];
        break;
      }
    }

  if (!street) continue;

  return {
    streetAddress: street,
    postalCode: postal.postalCode,
    addressLocality: postal.city,
    addressCountry: postal.country,
    nameNearby: name,
    nameMatchesHotel: namesRoughlyMatch(name, hotelName) || namesRoughlyMatch(street, hotelName)
  };
  }
  return null;
}

// Fallback coordinate detection for pages that render lat/lng as visible text or
// map-widget data attributes rather than JSON-LD, e.g. a Leaflet/OpenStreetMap
// embed showing "52.371111 / 4.895433" or data-lat="52.371111" data-lng="4.895433".
function extractLooseLatLng(html) {
  const attrMatch = html.match(
    /data-(?:lat|latitude)=["']?(-?\d{1,3}\.\d+)["']?[^>]{0,80}?data-(?:lng|lon|longitude)=["']?(-?\d{1,3}\.\d+)["']?/i
    );
  if (attrMatch) {
    const lat = Number(attrMatch[1]);
    const lng = Number(attrMatch[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

const looseMatch = html.match(/(-?\d{1,3}\.\d{3,8})[^0-9\-]{1,80}?(-?\d{1,3}\.\d{3,8})/);
  if (looseMatch) {
    const lat = Number(looseMatch[1]);
    const lng = Number(looseMatch[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}
function extractLatLng(html, jsonLdItems) {
  for (const item of jsonLdItems) {
    const geo = item.geo;
    if (geo && typeof geo === 'object' && geo.latitude !== undefined && geo.longitude !== undefined) {
      const lat = Number(geo.latitude);
      const lng = Number(geo.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  const match = html.match(/"latitude"\s*:\s*"?(-?\d{1,3}\.\d+)"?[^}]*"longitude"\s*:\s*"?(-?\d{1,3}\.\d+)"?/i);
  if (match) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return extractLooseLatLng(html);
}

function extractEmail(html) {
  const match = html.match(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/);
  return match ? match[0] : null;
}

function extractPhone(html) {
  const telMatch = html.match(/href=["']tel:([^"']+)["']/i);
  if (telMatch) return telMatch[1].trim();
  const match = html.match(/\+\d{1,3}[\s.\/-]?\(?\d{1,4}\)?[\s.\/-]?\d{2,4}[\s.\/-]?\d{2,4}[\s.\/-]?\d{0,4}/);
  return match ? match[0].trim() : null;
}
// Parses a single contact-page candidate's HTML into structured NAP data.
// hotelName is optional and only used as a soft signal (name_matches_hotel) for
// confidence scoring - it never gates whether an address is accepted.
function parseContactPage(html, pageUrl, hotelName) {
  const jsonLdItems = extractJsonLd(html);
  let structuredAddress = null;
  let name = null;
  let sameAs = [];

for (const item of jsonLdItems) {
  if (!structuredAddress && item.address && typeof item.address === 'object') {
    structuredAddress = {
      streetAddress: item.address.streetAddress || null,
      postalCode: item.address.postalCode || null,
      addressLocality: item.address.addressLocality || null,
      addressCountry: firstString(item.address.addressCountry)
    };
  }
  if (!name && item.name) {
    name = firstString(item.name);
  }
  if (item.sameAs) {
    const links = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
    sameAs = sameAs.concat(links.filter((l) => typeof l === 'string'));
  }
}

let addressSource = structuredAddress ? 'structured_data' : null;
  let nameMatchesHotel = false;

if (!structuredAddress) {
  const listLines = extractListItemLines(html);
  const plainAddress = extractPlainTextAddress(listLines, hotelName);
  if (plainAddress) {
    structuredAddress = {
      streetAddress: plainAddress.streetAddress,
      postalCode: plainAddress.postalCode,
      addressLocality: plainAddress.addressLocality,
      addressCountry: plainAddress.addressCountry
    };
    addressSource = 'plain_text';
    nameMatchesHotel = plainAddress.nameMatchesHotel;
    if (!name) name = plainAddress.nameNearby;
  }
} else {
  nameMatchesHotel = namesRoughlyMatch(name, hotelName);
}

const latLng = extractLatLng(html, jsonLdItems);
  const socialFromHtml = extractSocialLinksFromHtml(html);
  for (const link of sameAs) {
    if (/instagram\.com/i.test(link)) socialFromHtml.instagram = socialFromHtml.instagram || link;
    if (/facebook\.com/i.test(link)) socialFromHtml.facebook = socialFromHtml.facebook || link;
    if (/linkedin\.com/i.test(link)) socialFromHtml.linkedin = socialFromHtml.linkedin || link;
  }

return {
  page_url: pageUrl,
  name,
  structured_address: structuredAddress,
  address_source: addressSource,
  name_matches_hotel: nameMatchesHotel,
  lat_lng: latLng,
  google_maps_url: extractGoogleMapsLink(html),
  phone: extractPhone(html),
  email: extractEmail(html),
  social_links: socialFromHtml,
  has_structured_data: jsonLdItems.length > 0 && addressSource === 'structured_data'
};
}
// Scores how useful a parsed contact page result is, and builds the flattened
// extraction shape used by the rest of the system.
function buildExtractionResult(parsed) {
  const addr = parsed.structured_address;
  const extracted_address = addr && addr.streetAddress ? addr.streetAddress : null;
  const extracted_city = addr && addr.addressLocality ? addr.addressLocality : null;
  const extracted_country = addr && addr.addressCountry ? addr.addressCountry : null;
  const extracted_postal_code = addr && addr.postalCode ? addr.postalCode : null;

const hasFullAddress = !!(extracted_address && (extracted_city || extracted_country));
  const hasPartialAddress = !!(extracted_address || extracted_city || extracted_country);

let contact_confidence = 'low';
  let source = parsed.address_source || 'contact_page';

if (parsed.lat_lng) {
  contact_confidence = 'high';
} else if (hasFullAddress) {
  // A street address plus postal/city/country - regardless of whether it came
  // from JSON-LD or a plain <li> block - is enough to be confident. A full NAP
  // block should never be scored "low".
  contact_confidence = 'high';
} else if (hasPartialAddress) {
  contact_confidence = 'medium';
} else if (parsed.name_matches_hotel && (parsed.phone || parsed.email)) {
  contact_confidence = 'medium';
} else if (parsed.phone || parsed.email) {
  contact_confidence = 'low';
}

if (!addr) source = 'contact_page';

return {
  contact_page_url: parsed.page_url,
  extracted_name: parsed.name || null,
  extracted_address,
  extracted_city,
  extracted_country,
  extracted_postal_code,
  extracted_phone: parsed.phone || null,
  extracted_email: parsed.email || null,
  extracted_google_maps_url: parsed.google_maps_url || null,
  extracted_lat: parsed.lat_lng ? parsed.lat_lng.lat : null,
  extracted_lng: parsed.lat_lng ? parsed.lat_lng.lng : null,
  extracted_social_links: parsed.social_links || null,
  name_matches_hotel: parsed.name_matches_hotel || false,
  contact_confidence,
  source
};
}

function rank(result) {
  if (result.contact_confidence === 'high') return 2;
  if (result.contact_confidence === 'medium') return 1;
  return 0;
}

// Main entry point. Discovers and parses the hotel's own contact page(s) - never
// third-party platforms - and returns the best extraction result found, or null if
// nothing useful could be found (fails gracefully; never throws).
async function discoverContactPage(hotel) {
  const homepageUrl = hotel.website || (hotel.domain ? `https://${hotel.domain}` : null);
  if (!homepageUrl) return null;
  const hostname = normaliseHost(hotel.website || hotel.domain);
  if (!hostname) return null;

try {
  const homepageHtml = await fetchWithTimeout(homepageUrl, FETCH_TIMEOUT_MS);
  const candidates = await findCandidatePages(homepageUrl, homepageHtml, hostname);

  let best = null;
  for (const candidateUrl of candidates) {
    const html = await fetchWithTimeout(candidateUrl, FETCH_TIMEOUT_MS);
    if (!html) continue;
    const parsed = parseContactPage(html, candidateUrl, hotel.name);
    const result = buildExtractionResult(parsed);
    if (!best || rank(result) > rank(best)) {
      best = result;
    }
    if (result.contact_confidence === 'high') break;
  }
  return best;
} catch (err) {
  console.error('Contact page discovery failed', err.message);
  return null;
}
}

export { discoverContactPage };
