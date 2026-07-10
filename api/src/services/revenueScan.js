import crypto from 'crypto';
import { scanWebsite } from '../engines/websiteEngine.js';
import { scanOtaUrls } from '../engines/otaEngine.js';
import { runLighthouse } from '../engines/lighthouseEngine.js';

export async function runRevenueScan({ url, hotelName = '', otaUrls = [], competitors = [] }) {
  const website = await scanWebsite(url);
  const ota = await scanOtaUrls(otaUrls);
  const lighthouse = await runLighthouse(url, 'mobile');
  const bookingJourney = buildBookingJourney(website);
  const aiVisibility = buildAiVisibility(website);
  const reviews = buildReviewIntel(website, ota);
  const competitorIntel = buildCompetitorIntel(competitors);
  const scores = calculateScores(website, ota, bookingJourney, aiVisibility, reviews, lighthouse);
  const leaks = buildLeaks(website, ota, bookingJourney, scores);

  return {
    id: crypto.randomUUID(),
    version: '3.2.0',
    createdAt: new Date().toISOString(),
    hotel: { name: hotelName || inferHotelName(website), url, competitors },
    scores,
    modules: { website, ota, bookingJourney, aiVisibility, reviews, competitors: competitorIntel, performance: buildPerformance(website, lighthouse), lighthouse, trust: buildTrust(website) },
    leaks,
    opportunities: leaks,
    consultantView: buildConsultantView(leaks, scores),
    report: buildReport(leaks, scores, website, ota)
  };
}

function calculateScores(w, ota, booking, ai, reviews, lighthouse) {
  const websiteHealth = avg([
    w.status >= 200 && w.status < 400 ? 100 : 25,
    w.missingSecurityHeaders.length === 0 ? 100 : Math.max(40, 100 - w.missingSecurityHeaders.length * 14),
    w.title && w.metaDescription && w.h1.length ? 90 : 50,
    w.imagesWithoutAlt === 0 ? 90 : Math.max(35, 90 - w.imagesWithoutAlt * 4),
    w.schemaHotel ? 100 : 50,
    lighthouse?.available && typeof lighthouse.performanceScore === 'number' ? lighthouse.performanceScore : performanceScore(w.loadMs)
  ]);
  const otaHealth = ota.length ? avg(ota.map(o => o.error ? 25 : otaScore(o, w))) : 35;
  const reviewReputation = reviews.sourcesDetected.length ? 68 : 35;
  const revenueScore = Math.round(avg([websiteHealth, booking.score, otaHealth, ai.score, reviewReputation]));
  const perf = lighthouse?.available && typeof lighthouse.performanceScore === 'number' ? lighthouse.performanceScore : performanceScore(w.loadMs);
  return { revenueScore, websiteHealth: Math.round(websiteHealth), bookingJourney: booking.score, otaHealth: Math.round(otaHealth), aiVisibility: ai.score, reviewReputation, competitorIndex: 50, performance: perf, trust: trustScore(w) };
}
function performanceScore(ms){ return ms < 900 ? 95 : ms < 1500 ? 85 : ms < 2500 ? 70 : ms < 4000 ? 50 : 30; }
function trustScore(w){ return Math.round(avg([w.missingSecurityHeaders.length ? 55 : 95, w.tracking && !w.cookieSignals ? 55 : 85, w.schemaHotel ? 85 : 55])); }
function otaScore(o, w){ let s = 65; if(o.images && w.images && w.images - o.images > 15) s -= 20; if(o.hasAmenities) s += 10; if(o.hasPolicies) s += 8; if(o.hasReviews) s += 8; return Math.max(25, Math.min(95, s)); }
function avg(arr){ return arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length); }
function inferHotelName(w){ return (w.title || 'Hotel').split('|')[0].split('-')[0].trim(); }

function buildBookingJourney(w){
  const directBookingLinksFound = w.bookingLinks.length;
  const steps = [
    { step:'Homepage loads', status: w.status < 400 ? 'ok':'risk', detail:`HTTP ${w.status}` },
    { step:'Book direct CTA detected', status: directBookingLinksFound ? 'ok':'risk', detail: directBookingLinksFound ? `${directBookingLinksFound} booking signal(s)` : 'No clear booking CTA found' },
    { step:'Tracking present', status: w.tracking ? 'ok':'warning', detail: w.tracking ? 'GA/GTM signal detected' : 'No GA/GTM signal detected' },
    { step:'Consent signal', status: w.cookieSignals ? 'ok':'warning', detail: w.cookieSignals ? 'Cookie/CMP signal detected' : 'No CMP signal detected' },
    { step:'Mobile speed proxy', status: w.loadMs < 2500 ? 'ok':'warning', detail:`Initial response ${w.loadMs}ms` }
  ];
  const score = Math.round(avg(steps.map(s => s.status==='ok'?90:s.status==='warning'?60:30)));
  return { directBookingLinksFound, examples: w.bookingLinks, status: score > 75 ? 'Strong' : score > 55 ? 'Needs optimization' : 'High leakage risk', score, steps };
}
function buildAiVisibility(w){
  const checks = [
    {label:'Hotel schema', ok:w.schemaHotel}, {label:'Meta description', ok:!!w.metaDescription}, {label:'Clear H1', ok:w.h1.length>0}, {label:'Images with alt text', ok:w.imagesWithoutAlt < 4}, {label:'Tracking/structured signals', ok:w.tracking || w.schemaHotel}
  ];
  const score = Math.round(avg(checks.map(c=>c.ok?90:40)));
  return { readiness: score > 75 ? 'high' : score > 55 ? 'medium' : 'low', score, checks };
}
function buildReviewIntel(w, ota){
  const sources = [];
  if (/google|reviews|tripadvisor|beoordeling|avis|rating/i.test(w.textSample || '')) sources.push('Website review signals');
  sources.push(...ota.filter(o=>o.hasReviews).map(o=>o.platform));
  return { sourcesDetected:[...new Set(sources)], status:sources.length?'Review signals detected':'No review signals detected in public scan', nextSteps:['Connect Google Business Profile later','Add Tripadvisor/Booking public URLs','Track guest sentiment themes monthly'] };
}
function buildCompetitorIntel(competitors){ return { competitors, status:competitors.length?'Ready for competitor monitoring':'No competitors configured', nextSteps:['Add 3-5 comparable hotels','Track speed, offers, OTA photos and AI visibility','Create monthly benchmark report'] }; }
function buildPerformance(w, lighthouse){
  if(lighthouse?.available){
    const s = lighthouse.performanceScore;
    return { loadMs:w.loadMs, score:s, source:lighthouse.source, status: s >= 90 ? 'Fast / strong Lighthouse result' : s >= 70 ? 'Acceptable / optimization possible' : s >= 50 ? 'Slow / revenue risk' : 'Critical speed risk', checks:['Lighthouse mobile performance','LCP/FCP/CLS/TBT metrics','Image, JavaScript and CSS opportunities'], lighthouse };
  }
  return { loadMs:w.loadMs, score:performanceScore(w.loadMs), source:'Fetch timing fallback', status: w.loadMs < 1500 ? 'Fast' : w.loadMs < 3000 ? 'Acceptable' : 'Slow / revenue risk', checks:['Initial response time','Image optimization proxy','Script/caching review recommended'], lighthouse };
}
function buildTrust(w){ return { score:trustScore(w), missingSecurityHeaders:w.missingSecurityHeaders, tracking:w.tracking, cookieSignals:w.cookieSignals, status:w.missingSecurityHeaders.length?'Trust improvements needed':'Strong trust basics' }; }

function leak(priority,title,module,impact,fix,evidence){ return { priority,title,module,impact,recommendedFix:fix,evidence }; }
function buildLeaks(w, ota, booking, scores){
 const list=[];
 if(!w.bookingLinks.length) list.push(leak('high','Direct booking CTA may be too hard to find','Booking Journey','Guests can fall back to OTAs if the direct booking path is not obvious.','Add persistent Book Direct CTA in header, mobile menu and room pages.','No clear booking link detected in public HTML.'));
 if(scores.performance<70) list.push(leak('high','Mobile performance can reduce booking intent','Performance',`Performance score is ${scores.performance}/100. Slow mobile pages increase drop-off before guests reach booking.`, 'Use Lighthouse opportunities: optimize hero images, reduce blocking JavaScript/CSS, improve caching and server response time.', `Performance score ${scores.performance}/100.`));
 if(w.missingSecurityHeaders.length) list.push(leak('medium','Missing trust/security headers','Trust', 'Missing security headers may reduce browser trust signals and technical quality.', 'Add HSTS, CSP, X-Content-Type-Options, Referrer-Policy and Permissions-Policy where appropriate.', w.missingSecurityHeaders.join(', ')));
 if(!w.metaDescription || !w.h1.length) list.push(leak('medium','SEO positioning is incomplete','Website Intelligence','Organic traffic and AI crawlers may understand the hotel less clearly.', 'Improve page title, meta description and one strong H1.', `Title: ${w.title || 'missing'}`));
 if(!w.schemaHotel) list.push(leak('medium','Hotel schema missing','AI Visibility','AI/search systems may not confidently identify the property, address, amenities and booking intent.', 'Add Hotel/LodgingBusiness schema with name, address, amenities, images and booking URL.', 'No Hotel/LodgingBusiness schema detected.'));
 if(w.imagesWithoutAlt>3) list.push(leak('low','Image SEO/accessibility gap','Website Intelligence', 'Important room/restaurant images may not contribute to search or accessibility.', 'Add descriptive alt text to key hotel images.', `${w.imagesWithoutAlt} images without alt text.`));
 if(!ota.length) list.push(leak('high','OTA revenue leakage is not monitored yet','OTA Intelligence','The biggest direct-booking leaks often happen on Booking.com, Expedia and Google Hotels, but no OTA URLs were provided.', 'Add public OTA profile URLs and rerun scan.', '0 OTA URLs scanned.'));
 for(const o of ota){
  if(o.error) list.push(leak('medium',`${o.platform} could not be scanned`,'OTA Intelligence','A key public profile cannot be monitored automatically yet.', 'Check the public URL or add another OTA profile link.', o.error));
  else {
    if(w.images && o.images && w.images-o.images>10) list.push(leak('high',`${o.platform} may show fewer visuals than your website`,'OTA Intelligence',`Website has ${w.images} detected images, ${o.platform} has ${o.images}.`, 'Update OTA photo galleries with strongest room, lobby, breakfast and local experience images.', `Difference: ${w.images-o.images} images.`));
    if(!o.hasAmenities) list.push(leak('medium',`${o.platform} amenities may be incomplete`,'OTA Intelligence','Missing amenity signals can weaken conversion on OTA pages.', 'Review Wi-Fi, breakfast, parking, restaurant, meeting, family and accessibility amenities.', 'Amenity keywords not detected.'));
    if(!o.hasPolicies) list.push(leak('medium',`${o.platform} policy signals may be incomplete`,'OTA Intelligence','Unclear cancellation/check-in/children policies can create friction.', 'Review cancellation, check-in/out, children and pet policies.', 'Policy keywords not detected.'));
  }
 }
 return list;
}
function buildConsultantView(leaks,scores){ return { summary:`Revenue score ${scores.revenueScore}/100. Focus on direct-booking clarity, speed, OTA content parity and AI-readable hotel information.`, ifIHAd1000Euro: leaks.slice(0,5).map((o,i)=>`${i+1}. ${o.title}: ${o.recommendedFix}`) }; }
function buildReport(leaks,scores,w,ota){ return { executiveSummary:`This scan found ${leaks.length} potential direct-booking leakage points. The strongest commercial opportunities are speed, trust, OTA parity and AI visibility.`, topPriorities:leaks.slice(0,3), technicalDetails:{status:w.status, loadMs:w.loadMs, images:w.images, bookingLinks:w.bookingLinks.length, otaScanned:ota.length, missingSecurityHeaders:w.missingSecurityHeaders} }; }
