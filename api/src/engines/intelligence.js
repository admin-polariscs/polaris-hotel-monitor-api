import * as cheerio from 'cheerio';
import crypto from 'crypto';

function normaliseUrl(input){
  const value = String(input||'').trim();
  const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProto).toString();
}
async function fetchHtml(url){
  const started = Date.now();
  const r = await fetch(url,{headers:{'user-agent':'Mozilla/5.0 PolarisRevenueIntelligence/3.3'}});
  const html = await r.text();
  return {status:r.status,html,responseMs:Date.now()-started,finalUrl:r.url,headers:Object.fromEntries(r.headers)};
}
function text($,sel){return ($(sel).first().text()||'').trim().replace(/\s+/g,' ')}
function attr($,sel,a){return ($(sel).first().attr(a)||'').trim()}
function parseJsonLd($){
  const items=[];$('script[type="application/ld+json"]').each((_,el)=>{try{let raw=$(el).contents().text();let json=JSON.parse(raw);items.push(...(Array.isArray(json)?json:[json]));}catch{}});return items;
}
function hotelEntity(url,$){
  const jsonld=parseJsonLd($); const flat=JSON.stringify(jsonld).slice(0,6000);
  const hotelLike=jsonld.find(x=>/Hotel|LodgingBusiness|LocalBusiness/.test(JSON.stringify(x?.['@type']||'')))||{};
  const name = hotelLike.name || attr($,'meta[property="og:site_name"]','content') || attr($,'meta[property="og:title"]','content') || text($,'title');
  const desc = hotelLike.description || attr($,'meta[name="description"]','content') || attr($,'meta[property="og:description"]','content');
  let address = '';
  if(typeof hotelLike.address==='string') address=hotelLike.address;
  else if(hotelLike.address) address=[hotelLike.address.streetAddress,hotelLike.address.postalCode,hotelLike.address.addressLocality,hotelLike.address.addressCountry].filter(Boolean).join(', ');
  const tel = hotelLike.telephone || attr($,'a[href^="tel:"]','href').replace(/^tel:/,'');
  const body=$('body').text().replace(/\s+/g,' ').slice(0,12000);
  const city = (address.match(/,\s*([^,]+)\s*,?\s*(Belgium|Belgique|België|BE)?$/i)||[])[1] || (body.match(/Brussels|Bruxelles|Antwerp|Ghent|Gent|Bruges|Liège|Namur/i)||[])[0] || '';
  return {name:name?.replace(/[-|].*$/,'').trim()||new URL(url).hostname,address,city,telephone:tel,description:desc,confidence: name?82:45,rawSignals:{jsonLdTypes:jsonld.map(x=>x['@type']).filter(Boolean).slice(0,8),jsonLdFound:jsonld.length,flatPreview:flat.slice(0,300)}};
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
function discoverOtas(entity){
  const q=[entity.name, entity.city||'', entity.address||''].filter(Boolean).join(' ');
  const enc=encodeURIComponent(q);
  const platforms=[['Booking.com','booking.com'],['Expedia','expedia.com'],['Hotels.com','hotels.com'],['Tripadvisor','tripadvisor.com'],['Agoda','agoda.com'],['Google Hotels','google.com/travel/hotels']];
  return platforms.map(([name,domain])=>({name,domain,status:'discovery-ready',confidence: entity.name?70:35,searchUrl:`https://www.google.com/search?q=${enc}+site:${encodeURIComponent(domain)}`,note:'Automatic public discovery prepared. Add SERP/Places API later for verified URLs.'}));
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
  const url=normaliseUrl(inputUrl); const meta=await fetchHtml(url); const $=cheerio.load(meta.html); const entity=hotelEntity(meta.finalUrl,$); const ws=websiteSignals($,meta.html,meta); const ps=await pagespeed(meta.finalUrl); const scores=score(ws,ps); const revenueLeaks=leaks(ws,ps,entity); const otas=discoverOtas(entity); const competitors=discoverCompetitors(entity);
  return {scanId:crypto.randomUUID(),generatedAt:new Date().toISOString(),inputUrl:url,finalUrl:meta.finalUrl,entity,scores,website:ws,performance:ps,ota:{status:'automatic-discovery-v1',items:otas},reviews:{status:'prepared',note:'Google/Booking/Tripadvisor review engines are ready for API-based integration. No manual review fields are used.'},competitors,aiVisibility:{status:'prepared',queries:[`best hotels ${entity.city||''}`,`business hotel ${entity.city||''}`,`${entity.name} hotel review`,`direct booking ${entity.name}`]},revenueLeaks,consultant:aiConsultant(entity,ws,scores,revenueLeaks)};
}
