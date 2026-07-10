import { Router } from 'express';
export const router = Router();
router.get('/', (req, res) => {
  res.json({ ok: true, product: 'Polaris Revenue Intelligence', version: '3.0.0', openai: Boolean(process.env.OPENAI_API_KEY) });
});
