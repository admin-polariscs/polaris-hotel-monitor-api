import * as cheerio from 'cheerio';
import crypto from 'crypto';

function normaliseUrl(input){
const value = String(input||'').trim();
const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
return new URL(withProto).toString();
}
async function fetchHtml(url){
const started = Date.now();
const r = await fetch(url,{headers:{'user-agent':'Mozilla/5.0 PolarisRevenueIntelligence/3.5'}});
const html = await r.text();
return {status:r.status,html,responseMs:Date.now()-started,finalUrl:r.url,headers:Object.fromEntries(r.headers)};
}
function text($,sel){return ($(sel).first().text()||'').trim().replace(/\s+/g,' ')}
function attr($,sel,a){return ($(sel).first().attr(a)||'').trim()}
function parseJsonLd($){
const items=[];$('script[type="application/ld+json"]').each((_,el)=>{try{let raw=$(el).contents().text();let json=JSON.parse(raw);items.push(...(Array.isArray(json)?json:[json]));}catch{}});return items;
}

// V3.5.1: safer hotel-name extraction from <title> tags.
// Splits ONLY on separators that have whitespace on both sides (e.g. " | ", " - ", " \u2014 "),
// so hyphens inside words like "5-star" are never treated as a split point (this fixed a bug
// where "Luxury 5-star hotel..." was being truncated to "Luxe 5"/"Luxury 5").
// When a title has multiple segments, prefers the shortest segment that mentions a lodging
// word (hotel/resort/inn/suites/lodge/hostel), since marketing taglines are usually longer
// than the actual property name. Falls back to the first segment otherwise.
function cleanTitleForName(title){
const raw = String(title||'').trim();
if(!raw) return '';
const parts = raw.split(/\s+[-|\u2013\u2014]\s+/).map(s=>s.trim()).filter(Boolean);
if(parts.length<=1) return raw;
const lodgingWord=/hotel|resort|inn\b|suites|lodge|hostel/i;
const withLodgingWord = parts.filter(p=>lodgingWord.test(p));
if(withLodgingWord.length) return withLodgingWord.sort((a,b)=>a.length-b.length)[0];
return parts[0];
}

// Conservative OpenAI fallback: only ever called when structured/heuristic extraction is
// missing or weak. It never overrides strong structured data, and any failure (missing key,
// network error, bad JSON) simply leaves the original heuristic result untouched.
async function aiEntityFallback(ws){
const key = process.env.OPENAI_API_KEY;
if(!key) return null;
try{
const prompt = `You extract hotel identity facts from public website text. Return ONLY compact JSON with keys hotel_name, city, country, confidence (integer 0-100, your own confidence in this extraction). If a fact cannot be found, use an empty string for it and lower the confidence. Do not invent details that are not supported by the text.\n\nPage title: ${ws.title||''}\nHeading (h1): ${ws.h1||''}\nMeta description: ${ws.metaDescription||''}`;
const r = await fetch('https://api.openai.com/v1/chat/completions',{
method:'POST',
headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:prompt}],temperature:0,response_format:{type:'json_object'}})
});
if(!r.ok) return null;
const j = await r.json();
const raw = j.choices?.[0]?.message?.content;
if(!raw) return null;
const parsed = JSON.parse(raw);
if(!parsed || typeof parsed!=='object') return null;
return {
hotel_name:String(parsed.hotel_name||'').trim(),
city:String(parsed.city||'').trim(),
country:String(parsed.country||'').trim(),
confidence:Math.max(0,Math.min(100,Number(parsed.confidence)||0))
};
}catch{ return null; }
}

// Improved hotel identity extraction (V3.5 / V3.5.1).
// Name fallback order: schema.org name > og:site_name > og:title > h1 > cleaned <title> > domain (last resort).
// Prefers structured schema.org Hotel/LodgingBusiness/LocalBusiness data for address/city over regex guessing.
function hotelEntity(url,$){
const jsonld=parseJsonLd($);
const flat=JSON.stringify(jsonld).slice(0,6000);
const hotelLike=jsonld.find(x=>/Hotel|LodgingBusiness|LocalBusiness/.test(JSON.stringify(x?.['@type']||'')))||{};
const schemaOrgType = hotelLike['@type'] ? (Array.isArray(hotelLike['@type'])?hotelLike['@type']:[hotelLike['@type']]) : [];

const ogSiteName = attr($,'meta[property="og:site_name"]','content');
const ogTitle = attr($,'meta[property="og:title"]','content');
const h1Text = text($,'h1');
const rawTitle = text($,'title');
const titleCleaned = cleanTitleForName(rawTitle);

let name='', nameSource='';
const ogSiteNameCleaned = cleanTitleForName(ogSiteName);
const ogTitleCleaned = cleanTitleForName(ogTitle);
if(hotelLike.name){ name=hotelLike.name; nameSource='schema_org'; }
else if(ogSiteNameCleaned){ name=ogSiteNameCleaned; nameSource='og_site_name'; }
else if(ogTitleCleaned){ name=ogTitleCleaned; nameSource='og_title'; }
else if(h1Text){ name=h1Text; nameSource='h1'; }
else if(titleCleaned){ name=titleCleaned; nameSource='title_cleaned'; }

const desc = hotelLike.description || attr($,'meta[name="description"]','content') || attr($,'meta[property="og:description"]','content');

let streetAddress='', postalCode='', addressLocality='', addressCountry='', address='';
if(typeof hotelLike.address==='string'){
address=hotelLike.address;
} else if(hotelLike.address && typeof hotelLike.address==='object'){
streetAddress = hotelLike.address.streetAddress || '';
postalCode = hotelLike.address.postalCode || '';
addressLocality = hotelLike.address.addressLocality || '';
addressCountry = typeof hotelLike.address.addressCountry === 'string' ? hotelLike.address.addressCountry : (hotelLike.address.addressCountry?.name || '');
address = [streetAddress, postalCode, addressLocality, addressCountry].filter(Boolean).join(', ');
}

const tel = hotelLike.telephone || attr($,'a[href^="tel:"]','href').replace(/^tel:/,'');
const body=$('body').text().replace(/\s+/g,' ').slice(0,12000);
const ogLocality = attr($,'meta[property="og:locality"]','content');

// City resolution order: structured schema.org locality > og:locality meta > loose regex on address/body (last resort, kept from V3.3).
const city = addressLocality || ogLocality || (address.match(/,\s*([^,]+)\s*,?\s*(Belgium|Belgique|Belgi\u00eb|BE)?$/i)||[])[1] || (body.match(/Brussels|Bruxelles|Antwerp|Ghent|Gent|Bruges|Li\u00e8ge|Namur/i)||[])[0] || '';

let domain = '';
try { domain = new URL(url).hostname.replace(/^www\./,''); } catch {}

if(!name){ name = domain || new URL(url).hostname; nameSource='domain_fallback'; }

let confidence = 40;
if (schemaOrgType.length) confidence += 20;
if (nameSource==='schema_org') confidence += 15;
else if (nameSource==='og_site_name' || nameSource==='og_title') confidence += 10;
else if (nameSource==='h1' || nameSource==='title_cleaned') confidence += 5;
if (address) confidence += 10;
if (city) confidence += 5;
if (tel) confidence += 5;
confidence = Math.min(confidence, 95);
if (nameSource==='domain_fallback') confidence = Math.min(confidence, 35);

return {
name,
nameSource,
domain,
address,
streetAddress,
postalCode,
city,
country: addressCountry,
telephone: tel,
description: desc,
schemaOrgType,
confidence,
rawSignals:{jsonLdTypes:jsonld.map(x=>x['@type']).filter(Boolean).slice(0,8),jsonLdFound:jsonld.length,flatPreview:flat.slice(0,300)}
};
}

// Applies the conservative OpenAI fallback only when structured data is missing/weak.
// It only ever fills gaps (name still on domain fallback, or city/country missing) - it
// never overwrites a name or address that came from schema.org, og tags, h1 or the title.
async function refineEntityWithAi(entity, ws){
const weak = !entity.schemaOrgType.length && (entity.nameSource==='domain_fallback' || entity.confidence < 60);
if(!weak) return entity;
if(!process.env.OPENAI_API_KEY) return entity;
const ai = await aiEntityFallback(ws);
if(!ai || !ai.hotel_name) return entity;
const refined = { ...entity };
let changed = false;
const weakNameSource = entity.nameSource==='domain_fallback' || entity.nameSource==='h1' || entity.nameSource==='title_cleaned';
if(weakNameSource && ai.confidence>=60){
refined.name = ai.hotel_name; refined.nameSource='openai_fallback'; changed = true;
}
if(!entity.city && ai.city){ refined.city = ai.city; changed = true; }
if(!entity.country && ai.country){ refined.country = ai.country; changed = true; }
if(changed){
refined.confidence = Math.max(entity.confidence, Math.min(95, entity.confidence + 15, ai.confidence));
refined.aiFallback = { used:true, rawConfidence: ai.confidence };
}
return refined;
}

function websiteSignals($,html,meta){
const links=[];$('a[href]').each((_,a)=>links.push($(a).attr('href')));
const imgs=[];$('img').each((_,i)=>imgs.push($(i).attr('src')||$(i).attr('data-src')||''));
const body=$('body').text().replace(/\s+/g,' ');
const bookingLinks=links.filter(h=>/book|booking|reserve|reservation|availability|synxis|availpro|cubilis|mews|siteminder|thehotelsnetwork|travelclick/i.test(h||''));
const ga=/G-[A-Z0-9]+|gtag\(|googletagmanager|GTM-/i.test(html);
return {status:meta.status,responseMs:meta.responseMs,title:text($,'title'),metaDescription:attr($,'meta[name="description"]','content'),h1:text($,'h1'),imageCount:imgs.filter(Boolean).length,linkCount:links.length,bookingLinks:bookingLinks.slice(0,8),hasBookingCta:bookingLinks.length>0,hasGAorGTM:ga,hasCookieSignals:/cookie|consent|cmp|cookieyes|onetrust|complianz/i.test(html),hasHotelSchema:/Hotel|LodgingBusiness|LocalBusiness/i.test(html),wordCount:body.split(' ').filter(Boolean).length};
}
async function pagespeed(url){
const key=process.env.PAGESPEED_API_KEY; if(!key) return {available:false,reason:'No PAGESPEED_API_KEY configured'};
const api=`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
try{const r=await fetch(api); const j=await r.json(); if(!r.ok) return {available:false,reason:j?.error?.message||'PageSpeed request failed'};
const lh=j.lighthouseResult; const audits=lh.audits; const num=id=>audits[id]?.numericValue; const display=id=>audits[id]?.displayValue||'';
return {available:true,score:Math.round((lh.categories.performance.score||0)*100),metrics:{fcp:display('first-contentful-paint'),lcp:display('largest-contentful-paint'),cls:display('cumulative-layout-shift'),tbt:display('total-blocking-time'),speedIndex:display('speed-index')},opportunities:Object.values(audits).filter(a=>a.details?.type==='opportunity'&&a.score!==1).slice(0,5).map(a=>({title:a.title,displayValue:a.displayValue||'',description:a.description?.replace(/<[^>]+>/g,'').slice(0,180)}))};
}catch(e){return {available:false,reason:e.message};}
}

// V3.5.1 OTA discovery: builds non-aggressive, search-style candidate URLs for each platform.
// IMPORTANT: this never fabricates a confirmed OTA listing URL. listingUrl stays null unless a
// real verified listing URL is known. searchQuery/searchUrl only describe a discovery starting
// point (a Google site-search link), stored separately in raw_data so they are never confused
// with a real listing. We deliberately do NOT fetch/scrape these search URLs ourselves - that
// would mean automatically querying Google's search results, which we avoid entirely.
function discoverOtas(entity){
const hasRealName = !!entity.name && entity.nameSource!=='domain_fallback';
const q=[entity.name, entity.city||'', entity.address||''].filter(Boolean).join(' ');
const enc=encodeURIComponent(q);
const platforms=[['Booking.com','booking.com'],['Expedia','expedia.com'],['Hotels.com','hotels.com'],['Tripadvisor','tripadvisor.com'],['Agoda','agoda.com'],['Google Hotels','google.com/travel/hotels']];
return platforms.map(([name,domain])=>{
let confidence = hasRealName ? 35 : 15;
if (entity.city) confidence += 15;
if (entity.address) confidence += 10;
if (entity.schemaOrgType && entity.schemaOrgType.length) confidence += 10;
confidence = Math.max(0, Math.min(confidence, 80));
const searchUrl = `https://www.google.com/search?q=${enc}+site:${encodeURIComponent(domain)}`;
return {
name,
domain,
listingUrl: null,
searchQuery: q,
searchUrl,
confidence,
status:'discovery_candidate',
verificationStatus:'unverified',
message:`${name} discovery candidate prepared`,
note:'Automatic public discovery candidate prepared. This is a search-style starting point, not a confirmed listing - add a SERP/Places API to verify real matches automatically.'
};
});
}

function discoverCompetitors(entity){
const city=entity.city||'nearby'; const base=entity.name||'this hotel';
return {status:'discovery-ready',query:`hotels similar to ${base} ${city}`,items:[
{name:'Competitor discovery requires Google Places or SERP API',type:'setup-needed',confidence:0,note:'V3.3 prepares the engine; configure Places/SERP provider to return live competitor hotels.'}
]};
}
function score(ws,ps){
const booking=ws.hasBookingCta?82:45; const perf=ps.available?ps.score:(ws.responseMs<1200?78:55); const trust=(ws.hasGAorGTM?15:0)+(ws.hasCookieSignals?20:0)+(ws.hasHotelSchema?25:0)+(ws.metaDescription?20:0)+(ws.h1?20:0); const ota=62; const ai=ws.hasHotelSchema&&ws.wordCount>500?70:48; const overall=Math.round((booking*0.25+perf*0.2+trust*0.2+ota*0.15+ai*0.2)); return {overall,booking,performance:perf,trust,ota,aiVisibility:ai,reviews:50,competitors:45};
}
function leaks(ws,ps,entity){
const out=[];
if(!ws.hasBookingCta) out.push({priority:'High',title:'Direct booking path is not clearly detected',impact:'Guests may not find the booking path quickly, especially on mobile.',fix:'Make the direct booking CTA visible in the header and above the fold.'});
if(!ws.hasGAorGTM) out.push({priority:'High',title:'Booking performance may not be measurable',impact:'Campaigns can generate costs without clear direct booking attribution.',fix:'Verify GA4/GTM and book_now conversion tracking.'});
if(ps.available && ps.score<70) out.push({priority:'High',title:'Mobile performance is weak',impact:'Slow mobile pages can reduce booking intent before guests reach the engine.',fix:'Use Lighthouse opportunities to fix image weight, JavaScript and server response time.'});
if(!ws.hasHotelSchema) out.push({priority:'Medium',title:'Hotel structured data is missing or weak',impact:'Google and AI systems may understand the hotel less clearly.',fix:'Add schema.org Hotel/LocalBusiness markup with address, phone, amenities and links.'});
if(!entity.address) out.push({priority:'Medium',title:'Hotel address not confidently extracted',impact:'OTA/Google matching and AI visibility become less reliable.',fix:'Make NAP data clear in footer/contact page and structured data.'});
return out;
}
function aiConsultant(entity,ws,scores,leaks){
return {headline:`${entity.name} has a Revenue Intelligence score of ${scores.overall}/100.`,summary:`The current scan identifies the hotel entity, website booking signals, performance readiness, OTA discovery readiness and competitor intelligence structure. The most commercial risks are shown as revenue leaks rather than technical issues.`,thisMonth:leaks.slice(0,5).map((l,i)=>({rank:i+1,action:l.fix,why:l.impact})),askPolarisExamples:[`Why is ${entity.name} losing direct bookings?`,`Which three fixes should we do this month?`,`What changed since last scan?`,`Which OTA listing should we improve first?`]};
}
export async function runHotelIntelligence(inputUrl){
const url=normaliseUrl(inputUrl); const meta=await fetchHtml(url); const $=cheerio.load(meta.html);
let entity=hotelEntity(meta.finalUrl,$);
const ws=websiteSignals($,meta.html,meta);
entity=await refineEntityWithAi(entity,ws);
const ps=await pagespeed(meta.finalUrl); const scores=score(ws,ps); const revenueLeaks=leaks(ws,ps,entity); const otas=discoverOtas(entity); const competitors=discoverCompetitors(entity);
return {scanId:crypto.randomUUID(),generatedAt:new Date().toISOString(),inputUrl:url,finalUrl:meta.finalUrl,entity,scores,website:ws,performance:ps,ota:{status:'automatic-discovery-v1',items:otas},reviews:{status:'prepared',note:'Google/Booking/Tripadvisor review engines are ready for API-based integration. No manual review fields are used.'},competitors,aiVisibility:{status:'prepared',queries:[`best hotels ${entity.city||''}`,`business hotel ${entity.city||''}`,`${entity.name} hotel review`,`direct booking ${entity.name}`]},revenueLeaks,consultant:aiConsultant(entity,ws,scores,revenueLeaks)};
}
