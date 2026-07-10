import OpenAI from 'openai';

export function deterministicReport(scan) {
  const critical = scan.warnings.filter(w => w.severity === 'critical');
  const high = scan.warnings.filter(w => w.severity === 'high');
  const medium = scan.warnings.filter(w => w.severity === 'medium');
  const grade = scan.score >= 85 ? 'Strong' : scan.score >= 70 ? 'Good, but leaking revenue/trust' : scan.score >= 50 ? 'Needs attention' : 'High risk';
  return {
    title: 'Hotel Revenue & Trust Scan',
    grade,
    executiveSummary: `This hotel website scores ${scan.score}/100. The main commercial risks are ${[...critical, ...high, ...medium].slice(0,3).map(x => x.message).join(' ') || 'limited in v1 scan.'}`,
    topFindings: scan.warnings.slice(0, 7),
    quickWins: buildQuickWins(scan),
    commercialAngle: 'Direct bookings depend on trust, speed, tracking and a clear booking path. Fixing these issues can improve measurement, reduce friction and strengthen visibility in Google and AI search.',
    suggestedOffer: scan.score < 70 ? 'Recommend a paid Revenue Leak Fix Sprint.' : 'Recommend monthly monitoring plus small technical optimisations.',
    disclaimer: 'Automated scan. Verify privacy, legal and tracking findings manually before making legal claims.'
  };
}

function buildQuickWins(scan) {
  const wins = [];
  if (!scan.booking.found) wins.push('Make the Book Now button visible above the fold on desktop and mobile.');
  if (scan.security.missing.length) wins.push('Add missing security headers through hosting, CDN or application config.');
  if (!scan.schema.hotelSchema) wins.push('Add Hotel/LodgingBusiness JSON-LD with name, address, phone, amenities and booking URL.');
  if (scan.accessibility.missingAlt > 0) wins.push(`Add alt text to ${scan.accessibility.missingAlt} images detected in the initial scan.`);
  if (!scan.cookies.signalsFound) wins.push('Add or verify a consent banner and privacy/cookie links.');
  if (scan.tracking.trackingBeforeConsentRisk) wins.push('Block analytics/marketing scripts until consent is given.');
  if (!wins.length) wins.push('Keep monitoring monthly and add competitor/OTA parity checks in the next version.');
  return wins;
}

export async function aiReport(scan) {
  if (!process.env.OPENAI_API_KEY) return deterministicReport(scan);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  try {
    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: 'You are a hotel direct-booking, website trust, SEO, privacy and revenue-leak auditor. Return concise JSON only.' },
        { role: 'user', content: `Turn this scan JSON into a commercial hotel audit report. Be practical. Do not invent facts. JSON scan: ${JSON.stringify(scan).slice(0, 24000)}` }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'hotel_audit_report',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              grade: { type: 'string' },
              executiveSummary: { type: 'string' },
              topFindings: { type: 'array', items: { type: 'object', additionalProperties: true } },
              quickWins: { type: 'array', items: { type: 'string' } },
              commercialAngle: { type: 'string' },
              suggestedOffer: { type: 'string' },
              disclaimer: { type: 'string' }
            },
            required: ['title','grade','executiveSummary','topFindings','quickWins','commercialAngle','suggestedOffer','disclaimer']
          }
        }
      }
    });
    return JSON.parse(response.output_text);
  } catch (e) {
    const fallback = deterministicReport(scan);
    fallback.aiError = e.message;
    return fallback;
  }
}
