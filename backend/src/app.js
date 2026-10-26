import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config/env.js';
import { openDatabase } from './config/database.js';
import { HttpError, errorHandler } from './config/errors.js';
import { security } from './config/middleware.js';
import { startNotificationWorker } from './models/notifications.js';
import authRoutes from './routes/authRoutes.js';
import professionalRoutes from './routes/professionalRoutes.js';
import publicRoutes from './routes/publicRoutes.js';

export function createApp({
  databasePath = config.databasePath,
  clock,
  startWorker = false,
  frontendDist = config.frontendDist,
  publicUrl = config.publicUrl,
  environment = config.environment,
} = {}) {
  const app = express(),
    db = openDatabase(databasePath);
  const context = { db, clock, publicUrl };
  app.disable('x-powered-by');
  app.use(security({ publicUrl, environment }));
  app.use(express.json({ limit: '700kb' }));
  app.use((req, _res, next) => {
    req.clock = clock;
    next();
  });
  app.use('/api', authRoutes(context), professionalRoutes(context), publicRoutes(context));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint não encontrado.')));
  if (existsSync(join(frontendDist, 'index.html'))) {
    app.use(
      '/assets',
      express.static(join(frontendDist, 'assets'), {
        immutable: true,
        maxAge: '1y',
        fallthrough: false,
      }),
    );
    app.use(
      '/images',
      express.static(join(frontendDist, 'images'), { maxAge: '1d', fallthrough: false }),
    );
    app.get('/{*path}', (_req, res) =>
      res.sendFile(join(frontendDist, 'index.html'), { headers: { 'Cache-Control': 'no-store' } }),
    );
  }
  app.use((_req, _res, next) => next(new HttpError(404, 'Página não encontrada.')));
  app.use(errorHandler);
  const stop = startWorker ? startNotificationWorker(db, { clock }) : null;
  let closed = false;
  app.locals.db = db;
  app.locals.close = async () => {
    if (closed) return;
    closed = true;
    if (stop) await stop();
    db.close();
  };
  return app;
}
