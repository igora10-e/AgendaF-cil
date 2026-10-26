import cors from 'cors';
import { HttpError } from './errors.js';

export function security({ publicUrl, environment }) {
  const origins = new Set(
    environment === 'production'
      ? [publicUrl]
      : [
          publicUrl,
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:8000',
          'http://127.0.0.1:8000',
        ],
  );
  const attempts = new Map();
  const corsHandler = cors({
    credentials: true,
    origin: (origin, done) => {
      if (!origin) done(null, false);
      else if (origins.has(origin)) done(null, true);
      else done(new HttpError(403, 'Origem não autorizada.'));
    },
  });
  return (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (req.path.startsWith('/api/auth') ||
        req.path.startsWith('/api/client/auth') ||
        req.path.endsWith('/bookings'))
    ) {
      const key = `${req.ip}:${req.path}`,
        current = Date.now(),
        recent = (attempts.get(key) || []).filter((time) => time > current - 60_000);
      if (recent.length >= 20)
        return next(new HttpError(429, 'Muitas tentativas. Aguarde um minuto.'));
      recent.push(current);
      attempts.set(key, recent);
      if (attempts.size > 10_000)
        for (const [name, values] of attempts)
          if (values.at(-1) < current - 60_000) attempts.delete(name);
    }
    return corsHandler(req, res, next);
  };
}
