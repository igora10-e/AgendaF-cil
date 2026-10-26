import { HttpError } from '../config/errors.js';
import { digest, now, stamp } from '../config/time.js';

export function cookie(req, name) {
  if (req.cookies && typeof req.cookies[name] === 'string') return req.cookies[name];
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return '';
  for (const entry of header.split(';')) {
    const equals = entry.indexOf('=');
    if (equals === -1 || entry.slice(0, equals).trim() !== name) continue;
    const value = entry.slice(equals + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

export function requireProfessional(db, req) {
  const token = cookie(req, 'agenda_session');
  const row = db
    .prepare(
      `
    SELECT p.* FROM professionals p JOIN sessions s ON s.professional_id=p.id
    WHERE s.token=? AND s.expires>?
  `,
    )
    .get(digest(token), stamp(now(req.clock)));
  if (!row) throw new HttpError(401, 'Entre na sua conta para continuar.');
  return row;
}

export function clientIdentity(db, req) {
  const token = cookie(req, 'agenda_client_session');
  if (!token) return null;
  const row = db
    .prepare(
      `
    SELECT a.* FROM client_accounts a JOIN client_sessions s ON s.account_id=a.id
    WHERE s.token=? AND s.expires>?
  `,
    )
    .get(digest(token), stamp(now(req.clock)));
  if (!row) throw new HttpError(401, 'Sua sessão de cliente expirou. Entre novamente.');
  return row;
}

export function requireClient(db, req) {
  const row = clientIdentity(db, req);
  if (!row) throw new HttpError(401, 'Entre como cliente para ver seus agendamentos.');
  return row;
}

export function safeClient(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
  };
}
