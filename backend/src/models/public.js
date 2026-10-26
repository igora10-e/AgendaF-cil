import { HttpError } from '../config/errors.js';
import { transaction } from '../config/database.js';
import { now, parse, HOUR } from '../config/time.js';
import { bySlug, publicProfile, service, appointment, JOIN } from './booking.js';
import { bookingNotifications } from './notifications.js';

const fold = (value) =>
  String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim();
export function explore(db, { q = '', category = '', city = '' } = {}) {
  const offerings = new Map();
  for (const row of db.prepare('SELECT * FROM services WHERE active=1 ORDER BY id').all()) {
    const items = offerings.get(row.professional_id) || [];
    items.push(service(row));
    offerings.set(row.professional_id, items);
  }
  const profiles = db
    .prepare('SELECT * FROM professionals ORDER BY business COLLATE NOCASE,id')
    .all()
    .flatMap((row) => {
      const selected = offerings.get(row.id);
      if (!selected?.length) return [];
      return [
        {
          ...publicProfile(row),
          services: selected,
          min_price: Math.min(...selected.map((item) => item.price)),
          service_count: selected.length,
        },
      ];
    });
  const categories = [...new Set(profiles.map((p) => p.category))].sort();
  const cities = [...new Set(profiles.map((p) => p.city).filter(Boolean))].sort();
  const tokens = fold(q).split(/\s+/).filter(Boolean);
  return {
    professionals: profiles.filter((p) => {
      if (category && fold(p.category) !== fold(category)) return false;
      if (city && fold(p.city) !== fold(city)) return false;
      const searchable = fold(
        [
          p.name,
          p.business,
          p.bio,
          p.category,
          p.city,
          ...p.services.flatMap((s) => [s.name, s.description]),
        ].join(' '),
      );
      return tokens.every((token) => searchable.includes(token));
    }),
    categories,
    cities,
  };
}
export function profile(db, slug) {
  const p = bySlug(db, slug);
  return {
    profile: publicProfile(p),
    services: db
      .prepare('SELECT * FROM services WHERE professional_id=? AND active=1 ORDER BY id')
      .all(p.id)
      .map(service),
  };
}
export function clientBookings(db, account, clock) {
  const sql =
    JOIN.replace(
      'SELECT a.*',
      'SELECT a.*,p.business,p.name AS professional_name,p.slug,p.category,p.city',
    ) +
    ' JOIN professionals p ON p.id=a.professional_id WHERE a.account_id=? ORDER BY a.start DESC';
  return db
    .prepare(sql)
    .all(account.id)
    .map((row) => ({ ...appointment(row, true), can_cancel: canCancel(row, clock) }));
}
function canCancel(row, clock) {
  return (
    ['pending', 'confirmed'].includes(row.status) &&
    parse(row.start) >= new Date(now(clock).getTime() + 3 * HOUR)
  );
}
export function reservation(db, value, clock) {
  const row = db.prepare(JOIN + ' WHERE a.token=?').get(value);
  if (!row) throw new HttpError(404, 'Reserva não encontrada. Confira seu link privado.');
  const p = db.prepare('SELECT * FROM professionals WHERE id=?').get(row.professional_id);
  return {
    appointment: appointment(row, true),
    profile: publicProfile(p),
    can_cancel: canCancel(row, clock),
  };
}
export function cancel(db, value, clock) {
  return transaction(db, () => {
    const row = db.prepare(JOIN + ' WHERE a.token=?').get(value);
    if (!row) throw new HttpError(404, 'Reserva não encontrada.');
    if (!['pending', 'confirmed'].includes(row.status))
      throw new HttpError(409, 'Esta reserva não pode ser cancelada.');
    if (!canCancel(row, clock))
      throw new HttpError(
        422,
        'O prazo de cancelamento terminou. Entre em contato com o profissional.',
      );
    db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(row.id);
    const p = db.prepare('SELECT * FROM professionals WHERE id=?').get(row.professional_id);
    bookingNotifications(db, db.prepare(JOIN + ' WHERE a.id=?').get(row.id), p, 'Cancelado', {
      clock,
    });
    return { ok: true };
  });
}
export function history(db, value) {
  const client = db.prepare('SELECT * FROM clients WHERE history_token=?').get(value);
  if (!client) throw new HttpError(404, 'Histórico não encontrado. Utilize o link do comprovante.');
  return {
    name: client.name,
    appointments: db
      .prepare(JOIN + ' WHERE a.client_id=? AND a.account_id IS NULL ORDER BY a.start DESC')
      .all(client.id)
      .map((row) => appointment(row, true)),
  };
}
