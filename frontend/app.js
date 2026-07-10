const API = window.POLARIS_V3_CONFIG?.API_BASE_URL || '';
const $ = id => document.getElementById(id);
const scoreNames = {
  revenueScore: 'Revenue Score', websiteHealth: 'Website Health', bookingJourney: 'Booking Journey', otaHealth: 'OTA Health', aiVisibility: 'AI Visibility', reviewReputation: 'Reviews'
};

$('scanBtn').addEventListener('click', runScan);
$('demoBtn').addEventListener('click', () => {
  $('hotelName').value = 'Marivaux Hotel Brussels';
  $('hotelUrl').value = 'https://www.hotelmarivaux.be/';
  $('otaUrls').value = '';
  $('competitors').value = 'Hotel Indigo Brussels, Le Plaza Brussels, nh Collection Brussels Centre';
  runScan();
});

async function runScan(){
  $('status').textContent = 'Running V3 revenue intelligence scan...';
  const payload = {
    hotelName: $('hotelName').value,
    url: $('hotelUrl').value,
    otaUrls: $('otaUrls').value.split('\n').map(s=>s.trim()).filter(Boolean),
    competitors: $('competitors').value.split(',').map(s=>s.trim()).filter(Boolean)
  };
  try{
    const res = await fetch(`${API}/api/scans`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();
    render(data);
    $('status').textContent = 'Scan complete.';
  }catch(e){
    $('status').textContent = `Scan failed: ${e.message}`;
  }
}

function render(data){
  renderScores(data.scores);
  renderModules(data.modules);
  renderOpportunities(data.opportunities);
  renderConsultant(data.consultantView);
  $('rawJson').textContent = JSON.stringify(data,null,2);
}
function renderScores(scores){
  $('overview').innerHTML = Object.entries(scoreNames).map(([key,label]) => `
    <article class="card score"><small>${label}</small><b>${scores[key] ?? '-'}${typeof scores[key]==='number'?'/100':''}</b></article>
  `).join('');
}
function renderModules(m){
  $('modules').innerHTML = `
    ${moduleCard('Website Intelligence', [
      ['Status', m.website.status], ['Title', m.website.title || 'Missing'], ['Images', m.website.images], ['Images without alt', m.website.imagesWithoutAlt], ['Booking links', m.website.bookingLinks.length], ['Hotel schema', m.website.schemaHotel ? 'Detected' : 'Missing']
    ])}
    ${moduleCard('Booking Journey', [['Direct booking links found', m.bookingJourney.directBookingLinksFound], ['Status', m.bookingJourney.status]])}
    ${moduleCard('OTA Intelligence', [['OTA URLs scanned', m.ota.length], ['Platforms', m.ota.map(o=>o.platform).join(', ') || 'None yet'], ['Next step', 'Add public OTA URLs']])}
    ${moduleCard('AI Visibility', [['Readiness', m.aiVisibility.readiness], ['Checks', m.aiVisibility.checks.join(', ')]])}
    ${moduleCard('Review Intelligence', [['Sources detected', m.reviews.sourcesDetected.join(', ') || 'None'], ['Status', m.reviews.status]])}
    ${moduleCard('Competitor Intelligence', [['Competitors configured', m.competitors.competitors.length], ['Status', m.competitors.status]])}
  `;
}
function moduleCard(title, rows){
  return `<article class="card"><h2>${title}</h2>${rows.map(([a,b])=>`<div class="metric"><span>${a}</span><b>${b}</b></div>`).join('')}</article>`;
}
function renderOpportunities(items){
  $('opportunityList').innerHTML = items.map(o => `
    <div class="opp"><span class="pill ${o.priority}">${o.priority}</span><h3>${o.title}</h3><p><b>Module:</b> ${o.module}</p><p><b>Revenue impact:</b> ${o.impact}</p><p><b>Recommended fix:</b> ${o.recommendedFix}</p></div>
  `).join('');
}
function renderConsultant(c){
  $('consultantView').innerHTML = `<p>${c.summary}</p><ol>${c.ifIHAd1000Euro.map(x=>`<li>${x.replace(/^\d+\.\s*/, '')}</li>`).join('')}</ol>`;
}
