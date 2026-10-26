import { Router } from 'express';
import { createPublicController } from '../controllers/publicController.js';
export default function publicRoutes(context) {
  const router = Router(),
    c = createPublicController(context);
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.get('/explore', c.explore);
  router.get('/client/bookings', c.clientBookings);
  router.get('/public/:slug', c.profile);
  router.get('/public/:slug/slots', c.slots);
  router.post('/public/:slug/bookings', c.book);
  router.get('/reservations/:token', c.reservation);
  router.post('/reservations/:token/cancel', c.cancel);
  router.get('/history/:token', c.history);
  return router;
}
