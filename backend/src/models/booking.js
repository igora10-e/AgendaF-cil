import { HttpError } from '../config/errors.js';
import { now, stamp, parse, dayKey, addDays, randomToken } from '../config/time.js';
import { bookingNotifications } from './notifications.js';

export const LABELS = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  absent: 'Ausente',
};

export const JOIN = `SELECT a.*,c.name AS client_name,c.email AS client_email,c.phone AS client_phone,c.history_token
  FROM appointments a JOIN clients c ON c.id=a.client_id`;

export function defaultSchedule() {
  return Array.from({ length: 7 }, (_, i) => ({
    enabled: i < 6,
    start: '09:00',
    end: i < 5 ? '18:00' : '14:00',
    has_break: i < 5,
    break_start: '12:00',
    break_end: '13:00',
  }));
}

export function professional(row) {
  const p = { ...row, schedule: JSON.parse(row.schedule), auto_approve: Boolean(row.auto_approve) };
  delete p.password;
  return p;
}

export function publicProfile(row) {
  const p = professional(row);
  return Object.fromEntries(
    [
      'id',
      'name',
      'business',
      'slug',
      'bio',
      'photo',
      'phone',
      'auto_approve',
      'category',
      'city',
    ].map((key) => [key, p[key]]),
  );
}

export function service(row) {
  return { ...row, price: row.price / 100, active: Boolean(row.active) };
}

export function appointment(row, privateView = false) {
  const a = { ...row, services: JSON.parse(row.services), total: row.total / 100 };
  if (!privateView) {
    delete a.token;
    delete a.history_token;
  }
  // A client account never receives the guest's history capability, even when
  // its booking reuses an existing contact record.
  if (a.account_id != null) delete a.history_token;
  delete a.account_id;
  return a;
}

export function bySlug(db, slug) {
  const p = db.prepare('SELECT * FROM professionals WHERE slug=?').get(slug);
  if (!p) throw new HttpError(404, 'Página profissional não encontrada.');
  return p;
}

export function casefold(value) {
  return value.toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
}

function selectedServices(db, pid, ids) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 10 ||
    ids.some((id) => !Number.isSafeInteger(id))
  ) {
    throw new HttpError(422, 'Selecione entre 1 e 10 serviços.');
  }
  if (new Set(ids).size !== ids.length)
    throw new HttpError(422, 'Selecione cada serviço apenas uma vez.');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM services WHERE professional_id=? AND active=1 AND id IN (${placeholders})`,
    )
    .all(pid, ...ids);
  if (rows.length !== ids.length) throw new HttpError(422, 'Um dos serviços não está disponível.');
  return rows;
}

const weekday = (value) => (parse(`${dayKey(value)}T12:00:00`).getUTCDay() + 6) % 7;

export function insideSchedule(schedule, start, end) {
  const key = dayKey(start);
  const day = schedule[weekday(start)];
  if (!day?.enabled || key !== dayKey(end)) return false;
  if (start < parse(`${key}T${day.start}`) || end > parse(`${key}T${day.end}`)) return false;
  if (
    day.has_break &&
    start < parse(`${key}T${day.break_end}`) &&
    end > parse(`${key}T${day.break_start}`)
  )
    return false;
  return true;
}

export function isFree(db, pid, start, end) {
  const args = [pid, stamp(end), stamp(start)];
  const busy = db
    .prepare(
      "SELECT 1 FROM appointments WHERE professional_id=? AND start < ? AND end > ? AND status != 'cancelled' LIMIT 1",
    )
    .get(...args);
  const block = db
    .prepare('SELECT 1 FROM blocks WHERE professional_id=? AND start < ? AND end > ? LIMIT 1')
    .get(...args);
  return !busy && !block;
}

export function slots(db, p, day, ids, clock) {
  const selected = selectedServices(db, p.id, ids);
  const duration = selected.reduce((sum, s) => sum + s.duration, 0) * 60_000;
  const schedule = JSON.parse(p.schedule);
  let base;
  try {
    base = parse(`${day}T00:00`);
  } catch {
    throw new HttpError(422, 'Data inválida.');
  }
  const currentTime = now(clock);
  const today = dayKey(currentTime);
  if (day < today || day > addDays(today, 90)) return [];
  const config = schedule[weekday(base)];
  if (!config.enabled) return [];
  let current = parse(`${day}T${config.start}`);
  const finish = parse(`${day}T${config.end}`);
  // Fetch occupancies once so query count does not grow with the slot count.
  const ranges = db
    .prepare(
      `SELECT start,end FROM appointments WHERE professional_id=? AND start < ? AND end > ? AND status != 'cancelled'
    UNION ALL SELECT start,end FROM blocks WHERE professional_id=? AND start < ? AND end > ?`,
    )
    .all(p.id, stamp(finish), stamp(base), p.id, stamp(finish), stamp(base))
    .map((row) => [parse(row.start), parse(row.end)]);
  const cutoff = new Date(currentTime.getTime() + 2 * 3_600_000);
  const available = [];
  while (current.getTime() + duration <= finish.getTime()) {
    const end = new Date(current.getTime() + duration);
    if (
      current >= cutoff &&
      insideSchedule(schedule, current, end) &&
      !ranges.some(([a, b]) => current < b && end > a)
    ) {
      available.push(stamp(current));
    }
    current = new Date(current.getTime() + 15 * 60_000);
  }
  return available;
}

// The caller holds BEGIN IMMEDIATE across the full operation.
export function createBooking(db, professionalRow, data, { clock, accountId = null } = {}) {
  const p = db.prepare('SELECT * FROM professionals WHERE id=?').get(professionalRow.id);
  if (!p) throw new HttpError(404, 'Página profissional não encontrada.');
  const selected = selectedServices(db, p.id, data.service_ids);
  const start = parse(data.start);
  const local = stamp(start);
  const fraction = String(data.start).match(/\.(\d+)/)?.[1];
  if (
    Number(local.slice(17, 19)) ||
    start.getMilliseconds() ||
    (fraction && /[1-9]/.test(fraction)) ||
    Number(local.slice(14, 16)) % 15
  ) {
    throw new HttpError(422, 'O horário deve estar alinhado a intervalos de 15 minutos.');
  }
  const currentTime = now(clock);
  if (start.getTime() < currentTime.getTime() + 2 * 3_600_000) {
    throw new HttpError(422, 'Agende com pelo menos 2 horas de antecedência.');
  }
  if (dayKey(start) > addDays(dayKey(currentTime), 90))
    throw new HttpError(422, 'Agende para os próximos 90 dias.');
  const end = new Date(start.getTime() + selected.reduce((sum, s) => sum + s.duration, 0) * 60_000);
  if (!insideSchedule(JSON.parse(p.schedule), start, end)) {
    throw new HttpError(409, 'O atendimento não cabe no expediente ou coincide com um intervalo.');
  }
  if (!isFree(db, p.id, start, end)) {
    throw new HttpError(409, 'Este horário acabou de ser reservado ou bloqueado. Escolha outro.');
  }
  const matches = db
    .prepare('SELECT * FROM clients WHERE professional_id=? AND (email=? OR phone=?)')
    .all(p.id, data.email, data.phone);
  if (
    matches.length &&
    (matches.length > 1 ||
      matches[0].email !== data.email ||
      matches[0].phone !== data.phone ||
      casefold(matches[0].name) !== casefold(data.name))
  ) {
    throw new HttpError(
      409,
      'Já existe um cadastro com estes contatos. Use o mesmo nome, e-mail e telefone do primeiro agendamento ou contate o profissional.',
    );
  }
  const cid = matches.length
    ? matches[0].id
    : Number(
        db
          .prepare(
            'INSERT INTO clients(professional_id,name,email,phone,history_token) VALUES(?,?,?,?,?)',
          )
          .run(p.id, data.name, data.email, data.phone, randomToken()).lastInsertRowid,
      );
  const snapshot = selected.map((s) => ({
    id: s.id,
    name: s.name,
    duration: s.duration,
    price: s.price / 100,
    color: s.color,
  }));
  const status = p.auto_approve ? 'confirmed' : 'pending';
  const aid = Number(
    db
      .prepare(
        'INSERT INTO appointments(professional_id,client_id,start,end,services,total,status,token,notes,created,account_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        p.id,
        cid,
        stamp(start),
        stamp(end),
        JSON.stringify(snapshot),
        selected.reduce((sum, s) => sum + s.price, 0),
        status,
        randomToken(),
        data.notes ?? '',
        stamp(currentTime),
        accountId,
      ).lastInsertRowid,
  );
  const a = db.prepare(`${JOIN} WHERE a.id=?`).get(aid);
  bookingNotifications(db, a, p, LABELS[status], { clock });
  return appointment(a, true);
}
