import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanHotel } from './scanner.js';
import { aiReport } from './report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3030;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/scan', async (req, res) => {
  try {
    const { url } = req.body || {};
    const scan = await scanHotel(url);
    const report = await aiReport(scan);
    res.json({ ok: true, product: 'Polaris Hotel Monitor', version: '1.1.0', scan, report });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Scan failed' });
  }
});

app.post('/api/lead', async (req, res) => {
  try {
    const lead = cleanLead(req.body || {});
    if (!lead.email) return res.status(400).json({ ok: false, error: 'Email is required' });
    const payload = { ...lead, receivedAt: new Date().toISOString(), source: 'polaris-hotel-monitor-v1.1' };

    // Render filesystem is ephemeral, but this is useful for logs/debugging.
    console.log('NEW_LEAD', JSON.stringify(payload));
    try {
      const dir = path.join(__dirname, '..', 'leads');
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, 'leads.jsonl'), JSON.stringify(payload) + '\n');
    } catch {}

    if (process.env.LEAD_WEBHOOK_URL) {
      await fetch(process.env.LEAD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    res.json({ ok: true, message: 'Lead captured' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Lead capture failed' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, product: 'Polaris Hotel Monitor', version: '1.1.0', openai: !!process.env.OPENAI_API_KEY }));

function cleanLead(body) {
  const str = (v, max = 500) => String(v || '').trim().slice(0, max);
  return {
    name: str(body.name, 120),
    email: str(body.email, 180),
    company: str(body.company, 180),
    website: str(body.website, 260),
    message: str(body.message, 1200),
    score: Number.isFinite(Number(body.score)) ? Number(body.score) : null,
    grade: str(body.grade, 180),
    reportSummary: str(body.reportSummary, 1200)
  };
}

app.listen(port, () => {
  console.log(`Polaris Hotel Monitor v1.1 running on port ${port}`);
});
