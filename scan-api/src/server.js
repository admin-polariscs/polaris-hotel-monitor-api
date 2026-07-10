import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanHotel } from './scanner.js';
import { aiReport } from './report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3030;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

// CORS for the simple /monitor/ frontend hosted on your own site.
// Set ALLOWED_ORIGIN=https://www.yourdomain.com in production.
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/scan', async (req, res) => {
  try {
    const { url } = req.body || {};
    const scan = await scanHotel(url);
    const report = await aiReport(scan);
    res.json({ ok: true, scan, report });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Scan failed' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, product: 'Polaris Hotel Monitor v1' }));

app.listen(port, () => {
  console.log(`Polaris Hotel Monitor v1 running on http://localhost:${port}`);
});
