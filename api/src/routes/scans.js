import { Router } from 'express';
import { runRevenueScan } from '../services/revenueScan.js';
import { scans } from '../data/store.js';
export const router = Router();

router.post('/', async (req, res) => {
  try {
    const { url, hotelName, otaUrls = [], competitors = [] } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const scan = await runRevenueScan({ url, hotelName, otaUrls, competitors });
    scans.unshift(scan);
    res.json(scan);
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

router.get('/history', (req, res) => res.json({ scans: scans.slice(0, 20) }));
