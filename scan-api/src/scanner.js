import cheerio from 'cheerio';
import validator from 'validator';
import { chromium } from 'playwright';

const TIMEOUT = 15000;
const BOOKING_PATTERNS = [
  /book(ing)?/i, /reserve/i, /reserv/i, /check availability/i, /availability/i,
  /rooms?/i, /stay/i, /arrival/i, /departure/i, /overnight/i,
  /siteminder/i, /synxis/i, /d-edge/i, /dedge/i, /bookassist/i, /mews/i,
  /thebookingbutton/i, /hoteliers\.com/i, /booking\.com/i, /expedia/i
];
const TRACKING_PATTERNS = [/G-[A-Z0-9]+/, /gtag\(/, /googletagmanager\.com/, /GTM-[A-Z0-9]+/, /google-analytics\.com/, /clarity\.ms/, /facebook\.net\/.*fbevents/];
const COOKIE_PATTERNS = [/cookie/i, /consent/i, /privacy/i, /gdpr/i, /cmp/i, /cookieyes/i, /onetrust/i, /didomi/i, /complianz/i, /iubenda/i];

function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!validator.isURL(url, { require_protocol: true, allow_underscores: true })) {
    throw new Error('Ongeldige URL');
  }
  return url;
}

function scoreFromChecks(checks) {
  const weights = {
    https: 10, statusOk: 8, securityHeaders: 14, bookingVisible: 16,
    tracking: 10, cookiePrivacy: 10, seo: 12, schema: 6, accessibility: 6, performance: 8
  };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (checks[k] || 0) * w;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function headerScore(headers) {
  const required = ['strict-transport-security','content-security-policy','x-content-type-options','referrer-policy','permissions-policy'];
  const found = required.filter(h => headers[h]);
  return { score: found.length / required.length, found, missing: required.filter(h => !headers[h]) };
}

function extractLinks($, baseUrl) {
  const base = new URL(baseUrl);
  const links = [];
  $('a[href]').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const href = $(el).attr('href');
    try {
      const absolute = new URL(href, baseUrl).href;
      links.push({ href: absolute, text, internal: new URL(absolute).hostname === base.hostname });
    } catch {}
  });
  return links;
}

function detectBooking(links, html) {
  const candidates = links.filter(l => BOOKING_PATTERNS.some(p => p.test(l.href) || p.test(l.text)));
  const formSignals = /check[-_\s]?in|check[-_\s]?out|arrival|departure|booking/i.test(html);
  return { found: candidates.length > 0 || formSignals, candidates: candidates.slice(0, 10), formSignals };
}

function seoChecks($) {
  const title = ($('title').first().text() || '').trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const lang = $('html').attr('lang') || '';
  const score = [title.length >= 20 && title.length <= 70, metaDescription.length >= 60 && metaDescription.length <= 170, !!canonical, h1s.length === 1, !!lang]
    .filter(Boolean).length / 5;
  return { score, title, metaDescription, canonical, h1s, lang };
}

function schemaChecks($) {
  const schemas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try { schemas.push(JSON.parse(raw)); } catch { schemas.push({ raw: raw.slice(0, 200), invalid: true }); }
  });
  const text = JSON.stringify(schemas).toLowerCase();
  const hotelSchema = /hotel|lodgingbusiness|localbusiness/.test(text);
  return { score: hotelSchema ? 1 : 0, count: schemas.length, hotelSchema, schemasPreview: schemas.slice(0, 3) };
}

function accessibilityChecks($) {
  const imgs = $('img').toArray();
  const missingAlt = imgs.filter(el => !($(el).attr('alt') || '').trim()).length;
  const buttonsWithoutText = $('button').toArray().filter(el => !$(el).text().trim() && !$(el).attr('aria-label')).length;
  const score = Math.max(0, 1 - ((missingAlt + buttonsWithoutText) / Math.max(1, imgs.length + $('button').length)));
  return { score, images: imgs.length, missingAlt, buttonsWithoutText };
}

function contentSignals($, html) {
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const signals = {
    address: /address|adres|adresse|street|straat|rue|avenue|laan|brussels|bruxelles|gent|antwerp|bruges/i.test(body),
    rooms: /room|rooms|kamer|kamers|chambre|chambres|suite/i.test(body),
    restaurant: /restaurant|bar|breakfast|ontbijt|petit-déjeuner|dinner|lunch/i.test(body),
    faq: /faq|frequently asked|veelgestelde|questions fréquentes/i.test(body),
    phoneEmail: /\+\d{2,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(body),
    hotelTerms: /hotel|stay|overnight|accommodation|guest|hospitality/i.test(body)
  };
  const score = Object.values(signals).filter(Boolean).length / Object.keys(signals).length;
  return { score, signals, sampleText: body.slice(0, 800) };
}

async function quickBrokenLinks(links) {
  const sample = links.filter(l => l.internal).slice(0, 12);
  const results = [];
  for (const l of sample) {
    try {
      const res = await fetch(l.href, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000) });
      results.push({ href: l.href, status: res.status, ok: res.ok });
    } catch (e) { results.push({ href: l.href, error: e.message, ok: false }); }
  }
  return results;
}

async function browserSignals(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: 'PolarisHotelMonitor/1.0' });
    const requests = [];
    page.on('request', req => requests.push(req.url()));
    const start = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1500);
    const timing = await page.evaluate(() => JSON.stringify(performance.getEntriesByType('navigation')[0] || {}));
    const viewportBooking = await page.locator('a,button,input[type="submit"]').evaluateAll((els) => els.slice(0, 120).map(el => ({ text: (el.innerText || el.value || el.ariaLabel || '').trim(), href: el.href || '' })));
    const screenshotBookingFound = viewportBooking.some(x => /book|reserve|availability|réserver|boeken/i.test((x.text || '') + ' ' + (x.href || '')));
    return { ok: true, loadMs: Date.now() - start, requests: requests.slice(0, 200), trackingBeforeConsent: requests.some(r => TRACKING_PATTERNS.some(p => p.test(r))), mobileBookingSignal: screenshotBookingFound, timing: JSON.parse(timing) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

export async function scanHotel(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const startedAt = new Date().toISOString();
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'PolarisHotelMonitor/1.0' } });
  const finalUrl = res.url;
  const html = await res.text();
  const headers = Object.fromEntries(res.headers.entries());
  const $ = cheerio.load(html);
  const links = extractLinks($, finalUrl);
  const security = headerScore(headers);
  const booking = detectBooking(links, html);
  const seo = seoChecks($);
  const schema = schemaChecks($);
  const accessibility = accessibilityChecks($);
  const geo = contentSignals($, html);
  const cookieSignals = COOKIE_PATTERNS.some(p => p.test(html));
  const trackingSignals = TRACKING_PATTERNS.some(p => p.test(html));
  const brokenLinks = await quickBrokenLinks(links);
  const browser = await browserSignals(finalUrl);
  const performanceScore = browser.ok ? Math.max(0, Math.min(1, 1 - ((browser.loadMs - 1500) / 6500))) : 0.4;
  const checks = {
    https: finalUrl.startsWith('https://') ? 1 : 0,
    statusOk: res.ok ? 1 : 0,
    securityHeaders: security.score,
    bookingVisible: booking.found || browser.mobileBookingSignal ? 1 : 0,
    tracking: trackingSignals ? 1 : 0.2,
    cookiePrivacy: cookieSignals ? (browser.trackingBeforeConsent ? 0.45 : 0.8) : 0.2,
    seo: seo.score,
    schema: schema.score,
    accessibility: accessibility.score,
    performance: performanceScore
  };
  const score = scoreFromChecks(checks);
  return {
    product: 'Polaris Hotel Revenue & Trust Monitor', version: '1.0.0', startedAt, scannedUrl: url, finalUrl,
    status: { code: res.status, ok: res.ok, redirected: finalUrl !== url },
    score, checks, security, booking, tracking: { found: trackingSignals, trackingBeforeConsentRisk: !!browser.trackingBeforeConsent },
    cookies: { signalsFound: cookieSignals }, seo, schema, accessibility, geo,
    performance: { browserOk: browser.ok, loadMs: browser.loadMs || null, score: performanceScore, error: browser.error || null },
    brokenLinks, warnings: buildWarnings({ score, security, booking, seo, schema, accessibility, geo, trackingSignals, cookieSignals, browser })
  };
}

function buildWarnings(ctx) {
  const w = [];
  if (!ctx.booking.found && !ctx.browser.mobileBookingSignal) w.push({ severity: 'critical', area: 'Revenue', message: 'No clear booking or reservation call-to-action detected.' });
  if (ctx.security.missing.length) w.push({ severity: 'high', area: 'Trust', message: `Missing security headers: ${ctx.security.missing.join(', ')}` });
  if (!ctx.cookieSignals) w.push({ severity: 'high', area: 'Privacy', message: 'No clear cookie/privacy consent signals detected.' });
  if (ctx.browser.trackingBeforeConsent) w.push({ severity: 'high', area: 'Privacy', message: 'Tracking requests appear before consent interaction. Verify CMP implementation.' });
  if (!ctx.schema.hotelSchema) w.push({ severity: 'medium', area: 'AI/SEO', message: 'No Hotel/LodgingBusiness structured data detected.' });
  if (ctx.seo.score < 0.8) w.push({ severity: 'medium', area: 'SEO', message: 'SEO basics need improvement.' });
  if (ctx.accessibility.score < 0.8) w.push({ severity: 'medium', area: 'Accessibility', message: 'Accessibility basics need review, especially image alt text and buttons.' });
  if (ctx.geo.score < 0.7) w.push({ severity: 'medium', area: 'AI visibility', message: 'Hotel content is missing some AI-search friendly signals such as address, rooms, restaurant, FAQ or contact details.' });
  return w;
}
