import { Router } from 'express';
import { hotels } from '../data/store.js';
export const router = Router();

router.get('/', (req, res) => res.json({ hotels }));
router.get('/:id', (req, res) => {
  const hotel = hotels.find(h => h.id === req.params.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  res.json({ hotel });
});
