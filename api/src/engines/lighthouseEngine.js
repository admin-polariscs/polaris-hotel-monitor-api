import fetch from 'node-fetch';

function auditRef(audit, fallback = null) {
  if (!audit) return fallback;
  return {
    id: audit.id,
    title: audit.title,
    score: typeof audit.score === 'number' ? Math.round(audit.score * 100) : null,
    displayValue: audit.displayValue || null,
    numericValue: typeof audit.numericValue === 'number' ? audit.numericValue : null,
    description: audit.description || ''
  };
}

function categoryScore(cat) {
  return cat && typeof cat.score === 'number' ? Math.round(cat.score * 100) : null;
}

export async function runLighthouse(url, strategy = 'mobile') {
  const apiKey = process.env.PAGESPEED_API_KEY || process.env.PSI_API_KEY || '';
  const params = new URLSearchParams({
    url,
    strategy,
    category: 'performance',
  });
  if (apiKey) params.set('key', apiKey);

  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;
  const started = Date.now();

  try {
    const res = await fetch(endpoint, { headers: { 'user-agent': 'PolarisRevenueIntelligence/3.2' } });
    const json = await res.json();
    if (!res.ok) {
      return {
        available: false,
        strategy,
        source: 'PageSpeed Insights API',
        error: json?.error?.message || `PageSpeed API returned ${res.status}`,
        durationMs: Date.now() - started
      };
    }

    const lhr = json.lighthouseResult || {};
    const audits = lhr.audits || {};
    const opportunities = Object.values(audits)
      .filter(a => a && a.details && a.details.type === 'opportunity' && typeof a.numericValue === 'number' && a.numericValue > 100)
      .sort((a, b) => (b.numericValue || 0) - (a.numericValue || 0))
      .slice(0, 8)
      .map(auditRef);

    return {
      available: true,
      strategy,
      source: 'PageSpeed Insights API / Lighthouse',
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || url,
      performanceScore: categoryScore(lhr.categories?.performance),
      metrics: {
        fcp: auditRef(audits['first-contentful-paint']),
        lcp: auditRef(audits['largest-contentful-paint']),
        cls: auditRef(audits['cumulative-layout-shift']),
        tbt: auditRef(audits['total-blocking-time']),
        speedIndex: auditRef(audits['speed-index']),
        serverResponse: auditRef(audits['server-response-time'])
      },
      opportunities,
      diagnostics: {
        renderBlocking: auditRef(audits['render-blocking-resources']),
        unusedJavascript: auditRef(audits['unused-javascript']),
        unusedCss: auditRef(audits['unused-css-rules']),
        modernImages: auditRef(audits['modern-image-formats']),
        properlySizedImages: auditRef(audits['uses-responsive-images']),
        imageElements: auditRef(audits['image-size-responsive'])
      }
    };
  } catch (error) {
    return {
      available: false,
      strategy,
      source: 'PageSpeed Insights API',
      error: error.message,
      durationMs: Date.now() - started
    };
  }
}
