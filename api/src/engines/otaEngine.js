import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function scanOtaUrls(otaUrls = []) {
  const results = [];
  for (const item of otaUrls.filter(Boolean).slice(0, 5)) {
    const url = typeof item === 'string' ? item : item.url;
    try {
      const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 PolarisRevenueIntelligence/3.0' } });
      const html = await response.text();
      const $ = cheerio.load(html);
      const title = $('title').first().text().trim();
      const body = $('body').text().replace(/\s+/g, ' ').trim();
      const images = $('img').length;
      const platform = detectPlatform(url);
      results.push({
        url,
        platform,
        status: response.status,
        title,
        images,
        hasReviews: /review|reviews|beoordeling|avis|gastbeoordeling/i.test(body),
        hasAmenities: /amenit|facilit|voorzieningen|services|equipment|wifi|parking|breakfast/i.test(body),
        hasPolicies: /cancel|annul|policy|children|check-in|checkout|check-out/i.test(body),
        textSample: body.slice(0, 2000)
      });
    } catch (e) {
      results.push({ url, platform: detectPlatform(url), error: e.message });
    }
  }
  return results;
}

function detectPlatform(url) {
  if (/booking\.com/i.test(url)) return 'Booking.com';
  if (/expedia/i.test(url)) return 'Expedia';
  if (/hotels\.com/i.test(url)) return 'Hotels.com';
  if (/agoda/i.test(url)) return 'Agoda';
  if (/tripadvisor/i.test(url)) return 'Tripadvisor';
  if (/google/i.test(url)) return 'Google Hotels';
  return 'OTA / public profile';
}
