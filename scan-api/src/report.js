import OpenAI from 'openai';

export function deterministicReport(scan) {
  const critical = scan.warnings.filter(w => w.severity === 'critical');
  const high = scan.warnings.filter(w => w.severity === 'high');
  const medium = scan.warnings.filter(w => w.severity === 'medium');
  const grade = scan.score >= 88 ? 'Excellent trust foundation' : scan.score >= 75 ? 'Good, but leaking revenue/trust' : scan.score >= 55 ? 'Needs a revenue leak fix' : 'High commercial risk';
  const findings = scan.warnings.slice(0, 8).map(w => ({
    severity: w.severity || 'medium',
    area: w.area || 'Website',
    finding: w.message,
    revenueImpact: impactFor(w),
    technicalFix: technicalFixFor(w)
  }));
  return {
    title: 'Hotel Revenue & Trust Scan',
    grade,
    executiveSummary: `This hotel website scores ${scan.score}/100. The most visible risks are ${[...critical, ...high, ...medium].slice(0,3).map(x => x.message).join(' ') || 'limited in this first public scan.'}`,
    topFindings: findings,
    quickWins: buildQuickWins(scan),
    revenueRisks: buildRevenueRisks(scan),
    commercialAngle: 'Direct bookings depend on trust, speed, measurement and a clear booking path. Fixing the highest-impact issues helps reduce booking friction and makes supplier performance easier to verify.',
    suggestedOffer: scan.score < 70 ? 'Propose a paid Hotel Revenue Leak Fix Sprint followed by monthly monitoring.' : 'Propose monthly monitoring plus small technical optimisations and tracking checks.',
    emailSubject: `Website revenue leak scan for ${host(scan.finalUrl)}`,
    emailPitch: `We ran a first public scan of ${host(scan.finalUrl)} and found several points that may affect direct bookings, trust or measurement. The website scores ${scan.score}/100. A short review could turn this into a clear fix plan.`,
    disclaimer: 'Automated public website scan. Verify privacy, legal, tracking and revenue findings manually before making legal claims.'
  };
}

function host(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return 'your hotel website'; } }
function impactFor(w){
  const area = String(w.area || '').toLowerCase();
  if (area.includes('revenue')) return 'Potential friction in the direct-booking path.';
  if (area.includes('privacy')) return 'Possible trust/compliance concern and unreliable tracking data.';
  if (area.includes('seo') || area.includes('ai')) return 'Weaker visibility in Google and AI search experiences.';
  if (area.includes('trust')) return 'Lower technical trust signal for visitors, browsers and partners.';
  return 'Can reduce confidence or performance if left unresolved.';
}
function technicalFixFor(w){
  const msg = String(w.message || '').toLowerCase();
  if (msg.includes('security headers')) return 'Configure missing headers in hosting, CDN, Nginx/Apache or application middleware.';
  if (msg.includes('booking')) return 'Make the booking CTA prominent on desktop and mobile and verify the booking-engine URL.';
  if (msg.includes('structured data')) return 'Add Hotel/LodgingBusiness JSON-LD with name, address, contact, amenities and booking URL.';
  if (msg.includes('consent') || msg.includes('cookie')) return 'Review CMP setup and block marketing/analytics scripts until consent where required.';
  if (msg.includes('seo')) return 'Improve title, meta description, canonical, H1 and language signals.';
  if (msg.includes('accessibility')) return 'Add alt texts and accessible labels for images/buttons.';
  return 'Review manually and add to the technical fix backlog.';
}
function buildQuickWins(scan) {
  const wins = [];
  if (!scan.booking.found) wins.push('Make the Book Now button visible above the fold on desktop and mobile.');
  if (scan.security.missing.length) wins.push('Add missing security headers through hosting, CDN or application config.');
  if (!scan.schema.hotelSchema) wins.push('Add Hotel/LodgingBusiness JSON-LD with name, address, phone, amenities and booking URL.');
  if (scan.accessibility.missingAlt > 0) wins.push(`Add alt text to ${scan.accessibility.missingAlt} images detected in the initial scan.`);
  if (!scan.cookies.signalsFound) wins.push('Add or verify a consent banner and privacy/cookie links.');
  if (scan.tracking.trackingBeforeConsentRisk) wins.push('Block analytics/marketing scripts until consent is given, where applicable.');
  if (!wins.length) wins.push('Keep monitoring monthly and add competitor/OTA parity checks in the next version.');
  return wins;
}
function buildRevenueRisks(scan) {
  const risks = [];
  if (!scan.booking.found) risks.push('Visitors may not find the direct booking path quickly enough.');
  if (!scan.tracking.found) risks.push('Marketing performance may be undermeasured because no common analytics signal was detected.');
  if (scan.tracking.trackingBeforeConsentRisk) risks.push('Analytics data may be unreliable if consent mode/CMP is not configured correctly.');
  if (scan.performance.score < 0.6) risks.push('Slow mobile loading may reduce conversion and increase abandonment.');
  if (!scan.schema.hotelSchema) risks.push('AI and search engines may have less structured information about the hotel.');
  return risks.length ? risks : ['No major public revenue leak was detected in this first scan. Continue monthly monitoring.'];
}

export async function aiReport(scan) {
  if (!process.env.OPENAI_API_KEY) return deterministicReport(scan);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  try {
    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: 'You are a senior hotel direct-booking, website trust, SEO, privacy and revenue-leak auditor. Return concise JSON only. Do not invent facts. Make findings commercial, practical and non-alarmist.' },
        { role: 'user', content: `Create a practical sales-ready audit report from this public scan JSON. Include revenue impact, technical fix labels, quick wins, and a short pitch. JSON scan: ${JSON.stringify(scan).slice(0, 24000)}` }
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
              topFindings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                severity: { type: 'string' }, area: { type: 'string' }, finding: { type: 'string' }, revenueImpact: { type: 'string' }, technicalFix: { type: 'string' }
              }, required: ['severity','area','finding','revenueImpact','technicalFix'] } },
              quickWins: { type: 'array', items: { type: 'string' } },
              revenueRisks: { type: 'array', items: { type: 'string' } },
              commercialAngle: { type: 'string' },
              suggestedOffer: { type: 'string' },
              emailSubject: { type: 'string' },
              emailPitch: { type: 'string' },
              disclaimer: { type: 'string' }
            },
            required: ['title','grade','executiveSummary','topFindings','quickWins','revenueRisks','commercialAngle','suggestedOffer','emailSubject','emailPitch','disclaimer']
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
