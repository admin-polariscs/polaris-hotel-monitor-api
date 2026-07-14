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
const r = await fetch(url, {
signal: controller.signal,
  redirect: 'follow',
  headers: { 'User-Agent': 'PolarisHotelMonitorBot/1.0 (+contact-page-discovery)' }
});
if (!r.ok) return null;
return await r.text();
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
  const haystack = `${href || ''} ${text || ''}`.toLowerCase();
    return CONTACT_KEYWORDS.some((kw) => haystack.includes(kw));
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
const locRe = /<loc>([^<]+)<\/loc>/gi;
let m;
while ((m = locRe.exec(sitemapHtml)) !== null) {
const url = m[1].trim();
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
const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
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
const m = html.match(patterns[key]);
if (m) social[key] = m[0];
}
return social;
}

function extractGoogleMapsLink(html) {
const m = html.match(/https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)[^\s"'<>]*/i);
return m ? m[0] : null;
}

function extractLatLng(html, jsonLdItems) {
for (const item of jsonLdItems) {
const geo = item.geo;
if (geo && (geo.latitude || geo.latitude === 0) && (geo.longitude || geo.longitude === 0)) {
const lat = Number(geo.latitude);
const lng = Number(geo.longitude);
if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
}
}
const m = html.match(/"latitude"\s*:\s*"?(-?\d{1,3}\.\d+)"?[^}]*"longitude"\s*:\s*"?(-?\d{1,3}\.\d+)"?/i);
if (m) {
const lat = Number(m[1]);
const lng = Number(m[2]);
if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
}
return null;
}

function extractEmail(html) {
const m = html.match(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/);
return m ? m[0] : null;
}

function extractPhone(html) {
const telMatch = html.match(/href=["']tel:([^"']+)["']/i);
if (telMatch) return telMatch[1].trim();
const m = html.match(/\+\d{1,3}[\s.\/-]?\(?\d{1,4}\)?[\s.\/-]?\d{2,4}[\s.\/-]?\d{2,4}[\s.\/-]?\d{0,4}/);
return m ? m[0].trim() : null;
}

// Parses a single contact-page candidate's HTML into structured NAP data.
function parseContactPage(html, pageUrl) {
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
if (!name && item.name) name = firstString(item.name);
if (item.sameAs) {
const links = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
sameAs = sameAs.concat(links.filter((l) => typeof l === 'string'));
}
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
lat_lng: latLng,
google_maps_url: extractGoogleMapsLink(html),
phone: extractPhone(html),
email: extractEmail(html),
social_links: socialFromHtml,
has_structured_data: jsonLdItems.length > 0 && !!structuredAddress
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

let contact_confidence = 'low';
let source = 'contact_page';

if (parsed.lat_lng) {
contact_confidence = 'high';
source = 'structured_data';
} else if (extracted_address && extracted_city && extracted_country) {
contact_confidence = 'high';
source = 'structured_data';
} else if (extracted_city || extracted_country || extracted_address) {
contact_confidence = 'medium';
source = 'contact_page';
} else if (parsed.phone || parsed.email) {
contact_confidence = 'low';
source = 'contact_page';
}

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
const homepageUrl = hotel && (hotel.website || (hotel.domain ? `https://${hotel.domain}` : null));
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

const parsed = parseContactPage(html, candidateUrl);
const result = buildExtractionResult(parsed);

if (!best || rank(result) > rank(best)) best = result;
if (result.contact_confidence === 'high') break;
}

return best;
} catch (err) {
console.error('Contact page discovery failed', err.message);
return null;
}
}

export { discoverContactPage };
