import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';

export default function authRoutes({ db, clock, publicUrl }) {
  const router = Router();
  const controller = createAuthController({ db, clock, publicUrl });
  router.use((req, _res, next) => {
    req.clock = clock;
    next();
  });
  router.post('/auth/register', controller.register);
  router.post('/auth/login', controller.login);
  router.get('/auth/me', controller.me);
  router.post('/auth/logout', controller.logout);
  router.post('/auth/recover', controller.recover);
  router.post('/auth/reset', controller.reset);
  router.post('/client/auth/register', controller.registerClient);
  router.post('/client/auth/login', controller.loginClient);
  router.get('/client/auth/me', controller.meClient);
  router.post('/client/auth/logout', controller.logoutClient);
  return router;
}
