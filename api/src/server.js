import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { router as healthRouter } from './routes/health.js';
import { router as hotelsRouter } from './routes/hotels.js';
import { router as scansRouter } from './routes/scans.js';

const app = express();
const port = process.env.PORT || 10000;
const allowed = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: allowed === '*' ? true : allowed }));
app.use(express.json({ limit: '2mb' }));

app.use('/health', healthRouter);
app.use('/api/hotels', hotelsRouter);
app.use('/api/scans', scansRouter);

app.get('/', (req, res) => {
  res.json({ product: 'Polaris Revenue Intelligence', version: '3.0.0', status: 'live' });
});

app.listen(port, () => console.log(`Polaris Revenue Intelligence API v3 running on port ${port}`));
