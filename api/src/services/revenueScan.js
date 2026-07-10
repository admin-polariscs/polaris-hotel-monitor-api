import crypto from 'crypto';
import { scanWebsite } from '../engines/websiteEngine.js';
import { scanOtaUrls } from '../engines/otaEngine.js';

export async function runRevenueScan({ url, hotelName = '', otaUrls = [], competitors = [] }) {
  const website = await scanWebsite(url);
  const ota = await scanOtaUrls(otaUrls);
  const scores = calculateScores(website, ota);
  const opportunities = buildOpportunities(website, ota, scores);

  return {
    id: crypto.randomUUID(),
    version: '3.0.0',
    createdAt: new Date().toISOString(),
    hotel: { name: hotelName || inferHotelName(website), url, competitors },
    scores,
    modules: {
      website,
      ota,
      bookingJourney: buildBookingJourney(website),
      aiVisibility: buildAiVisibilityPlaceholder(website),
      reviews: buildReviewPlaceholder(ota),
      competitors: buildCompetitorPlaceholder(competitors)
    },
    opportunities,
    consultantView: buildConsultantView(opportunities)
  };
}

function calculateScores(website, ota) {
  const websiteHealth = avg([
    website.status >= 200 && website.status < 400 ? 100 : 30,
    website.missingSecurityHeaders.length === 0 ? 100 : 60,
    website.title && website.metaDescription && website.h1.length ? 90 : 55,
    website.imagesWithoutAlt === 0 ? 90 : Math.max(40, 90 - website.imagesWithoutAlt * 3),
    website.schemaHotel ? 100 : 55,
    website.loadMs < 1500 ? 90 : website.loadMs < 3000 ? 70 : 45
  ]);
  const bookingJourney = website.bookingLinks.length ? 82 : 35;
  const otaHealth = ota.length ? avg(ota.map(o => o.error ? 35 : (o.images > 10 ? 80 : 55))) : 45;
  const aiVisibility = website.schemaHotel && website.metaDescription ? 70 : 45;
  const reviewReputation = ota.some(o => o.hasReviews) ? 70 : 50;
  const competitorIndex = 50;
  const revenueScore = Math.round(avg([websiteHealth, bookingJourney, otaHealth, aiVisibility, reviewReputation]));
  return { revenueScore, websiteHealth: Math.round(websiteHealth), bookingJourney, otaHealth: Math.round(otaHealth), aiVisibility, reviewReputation, competitorIndex };
}

function buildOpportunities(website, ota, scores) {
  const list = [];
  if (!website.bookingLinks.length) list.push(opp('high', 'Booking CTA missing or hard to detect', 'Guests may not find the direct booking path quickly.', 'Place a visible Book Direct CTA in header, mobile navigation and key pages.', 'Booking Journey'));
  if (website.missingSecurityHeaders.length) list.push(opp('medium', 'Trust headers missing', `Missing ${website.missingSecurityHeaders.join(', ')}.`, 'Add security headers through hosting/CDN/server config.', 'Website Trust'));
  if (!website.schemaHotel) list.push(opp('medium', 'Hotel structured data missing', 'AI search and Google may understand the hotel less clearly.', 'Add Hotel/LodgingBusiness schema with name, address, amenities and booking URL.', 'AI Visibility'));
  if (!website.metaDescription || !website.h1.length) list.push(opp('medium', 'SEO basics incomplete', 'Guests and search engines may not immediately understand the positioning.', 'Improve title, meta description and H1 structure.', 'Website'));
  if (website.imagesWithoutAlt > 3) list.push(opp('low', 'Image accessibility and SEO gap', `${website.imagesWithoutAlt} images without alt text.`, 'Add descriptive alt text to key hotel, room and restaurant images.', 'Website'));
  if (website.loadMs > 2500) list.push(opp('medium', 'Slow first response or page load', 'Guests may drop off before reaching the booking path.', 'Optimize images, caching, scripts and server response.', 'Performance'));
  if (!ota.length) list.push(opp('high', 'OTA visibility unknown', 'No OTA URLs were provided, so revenue leakage on Booking.com/Expedia/Google Hotels is not monitored yet.', 'Add public OTA profile URLs and rerun the scan.', 'OTA Intelligence'));
  for (const o of ota) {
    if (!o.error && website.images > 0 && o.images > 0 && website.images - o.images > 15) {
      list.push(opp('high', `${o.platform} may show fewer photos than the website`, `Website has ${website.images} detected images, ${o.platform} has ${o.images}.`, 'Review OTA image gallery and upload missing high-quality room, restaurant and lifestyle photos.', 'OTA Intelligence'));
    }
  }
  return list;
}

function opp(priority, title, impact, fix, module) { return { priority, title, impact, recommendedFix: fix, module }; }
function avg(arr) { return arr.reduce((a,b)=>a+b,0) / arr.length; }
function inferHotelName(website) { return (website.title || 'Hotel').split('|')[0].split('-')[0].trim(); }
function buildBookingJourney(w) { return { directBookingLinksFound: w.bookingLinks.length, examples: w.bookingLinks, status: w.bookingLinks.length ? 'Detected' : 'Needs review' }; }
function buildAiVisibilityPlaceholder(w) { return { readiness: w.schemaHotel ? 'medium' : 'low', checks: ['Hotel schema', 'Clear entity signals', 'Descriptive pages', 'FAQ / local context'] }; }
function buildReviewPlaceholder(ota) { return { sourcesDetected: ota.filter(o => o.hasReviews).map(o => o.platform), status: ota.some(o => o.hasReviews) ? 'Review signals detected' : 'No review signals detected in public scan' }; }
function buildCompetitorPlaceholder(competitors) { return { competitors, status: competitors.length ? 'Ready for competitor monitoring' : 'No competitors configured' }; }
function buildConsultantView(opportunities) {
  return {
    ifIHAd1000Euro: opportunities.slice(0, 5).map((o, i) => `${i + 1}. ${o.title}: ${o.recommendedFix}`),
    summary: 'Prioritize direct booking visibility, OTA content consistency, trust signals and AI-readable hotel information.'
  };
}
