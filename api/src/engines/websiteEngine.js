import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function scanWebsite(url) {
  const started = Date.now();
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'PolarisRevenueIntelligence/3.0' } });
  const html = await response.text();
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 30000);
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1 = $('h1').map((_, el) => $(el).text().trim()).get();
  const images = $('img').length;
  const imagesWithoutAlt = $('img').filter((_, el) => !($(el).attr('alt') || '').trim()).length;
  const links = $('a[href]').map((_, el) => $(el).attr('href')).get();
  const bookingLinks = links.filter(h => /book|booking|reserve|reservation|reserv|ibe|synxis|verticalbooking|cubilis|availpro/i.test(h || ''));
  const otaLinks = links.filter(h => /booking\.com|expedia|hotels\.com|agoda|tripadvisor|trivago/i.test(h || ''));
  const headers = Object.fromEntries(response.headers.entries());
  const missingSecurityHeaders = ['strict-transport-security', 'content-security-policy', 'x-content-type-options'].filter(h => !headers[h]);
  const schemaHotel = /Hotel|LodgingBusiness|LocalBusiness/.test(html);
  const tracking = /G-|gtag\(|googletagmanager|GTM-|google-analytics/i.test(html);
  const cookieSignals = /cookie|consent|cookieyes|complianz|onetrust|cookiebot/i.test(html);

  return {
    url,
    status: response.status,
    loadMs: Date.now() - started,
    title,
    metaDescription,
    h1,
    images,
    imagesWithoutAlt,
    bookingLinks: bookingLinks.slice(0, 8),
    otaLinks: otaLinks.slice(0, 8),
    missingSecurityHeaders,
    schemaHotel,
    tracking,
    cookieSignals,
    textSample: text.slice(0, 3000)
  };
}
