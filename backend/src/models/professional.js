import { transaction } from '../config/database.js';
import { HttpError } from '../config/errors.js';
import { now, stamp, parse, addDays, DAY } from '../config/time.js';
import {
  professional,
  service,
  appointment,
  JOIN,
  LABELS,
  insideSchedule,
  isFree,
} from './booking.js';
import { bookingNotifications } from './notifications.js';

function conflict(error, message) {
  if (error.message?.includes('UNIQUE constraint failed')) throw new HttpError(409, message);
  throw error;
}

export function updateProfile(db, p, data) {
  return transaction(db, () => {
    try {
      db.prepare(
        'UPDATE professionals SET name=?,email=?,phone=?,business=?,slug=?,bio=?,photo=?,auto_approve=?,category=?,city=? WHERE id=?',
      ).run(
        data.name,
        data.email,
        data.phone,
        data.business,
        data.slug,
        data.bio,
        data.photo,
        Number(data.auto_approve),
        data.category,
        data.city,
        p.id,
      );
    } catch (error) {
      conflict(error, 'E-mail ou link personalizado já utilizado.');
    }
    return professional(db.prepare('SELECT * FROM professionals WHERE id=?').get(p.id));
  });
}

export function listServices(db, p) {
  return db
    .prepare('SELECT * FROM services WHERE professional_id=? ORDER BY id')
    .all(p.id)
    .map(service);
}
export function addService(db, p, data) {
  return transaction(db, () => {
    const id = Number(
      db
        .prepare(
          'INSERT INTO services(professional_id,name,description,duration,price,active,color) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          p.id,
          data.name,
          data.description,
          data.duration,
          Math.round(data.price * 100),
          Number(data.active),
          data.color,
        ).lastInsertRowid,
    );
    return service(db.prepare('SELECT * FROM services WHERE id=?').get(id));
  });
}
export function editService(db, p, id, data) {
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM services WHERE id=? AND professional_id=?').get(id, p.id))
      throw new HttpError(404, 'Serviço não encontrado.');
    db.prepare(
      'UPDATE services SET name=?,description=?,duration=?,price=?,active=?,color=? WHERE id=?',
    ).run(
      data.name,
      data.description,
      data.duration,
      Math.round(data.price * 100),
      Number(data.active),
      data.color,
      id,
    );
    return service(db.prepare('SELECT * FROM services WHERE id=?').get(id));
  });
}
export function deleteService(db, p, id) {
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM services WHERE id=? AND professional_id=?').get(id, p.id))
      throw new HttpError(404, 'Serviço não encontrado.');
    const rows = db.prepare('SELECT services FROM appointments WHERE professional_id=?').all(p.id);
    if (rows.some((row) => JSON.parse(row.services).some((item) => item.id === id)))
      throw new HttpError(
        409,
        'Este serviço possui histórico. Inative-o para preservar os atendimentos.',
      );
    db.prepare('DELETE FROM services WHERE id=? AND professional_id=?').run(id, p.id);
    return { ok: true };
  });
}
export function saveSchedule(db, p, days, clock) {
  return transaction(db, () => {
    const upcoming = db
      .prepare(
        "SELECT start,end FROM appointments WHERE professional_id=? AND status IN ('pending','confirmed') AND end>?",
      )
      .all(p.id, stamp(now(clock)));
    if (upcoming.some((row) => !insideSchedule(days, parse(row.start), parse(row.end))))
      throw new HttpError(
        409,
        'A nova jornada conflita com reservas existentes. Ajuste ou cancele essas reservas primeiro.',
      );
    db.prepare('UPDATE professionals SET schedule=? WHERE id=?').run(JSON.stringify(days), p.id);
    return { schedule: days };
  });
}
export function listBlocks(db, p, clock) {
  return db
    .prepare('SELECT * FROM blocks WHERE professional_id=? AND end>? ORDER BY start')
    .all(p.id, stamp(now(clock)));
}
export function addBlock(db, p, data, clock) {
  const start = parse(data.start),
    end = parse(data.end);
  if (start >= end || end <= now(clock))
    throw new HttpError(422, 'Informe um período futuro válido.');
  return transaction(db, () => {
    if (!isFree(db, p.id, start, end))
      throw new HttpError(409, 'O bloqueio conflita com um agendamento ou bloqueio existente.');
    const id = Number(
      db
        .prepare('INSERT INTO blocks(professional_id,start,end,reason) VALUES(?,?,?,?)')
        .run(p.id, stamp(start), stamp(end), data.reason).lastInsertRowid,
    );
    return { id };
  });
}
export function removeBlock(db, p, id) {
  return transaction(db, () => {
    if (!db.prepare('DELETE FROM blocks WHERE id=? AND professional_id=?').run(id, p.id).changes)
      throw new HttpError(404, 'Bloqueio não encontrado.');
    return { ok: true };
  });
}
export function listAppointments(db, p, start, end) {
  let sql = JOIN + ' WHERE a.professional_id=?';
  const args = [p.id];
  if (start) {
    sql += ' AND a.start>=?';
    args.push(`${start}T00:00:00-03:00`);
  }
  if (end) {
    sql += ' AND a.start<?';
    args.push(`${addDays(end, 1)}T00:00:00-03:00`);
  }
  return db
    .prepare(sql + ' ORDER BY a.start')
    .all(...args)
    .map((row) => appointment(row));
}
export function changeStatus(db, p, id, status, clock) {
  return transaction(db, () => {
    const row = db.prepare(JOIN + ' WHERE a.id=? AND a.professional_id=?').get(id, p.id);
    if (!row) throw new HttpError(404, 'Reserva não encontrada.');
    const transitions = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['completed', 'cancelled', 'absent'],
    };
    if (!transitions[row.status]?.includes(status))
      throw new HttpError(409, 'Esta transição de status não é permitida.');
    if (status === 'completed' && parse(row.end) > now(clock))
      throw new HttpError(422, 'Conclua o atendimento apenas após o horário de término.');
    if (status === 'absent' && parse(row.start) > now(clock))
      throw new HttpError(422, 'Registre ausência apenas após o horário marcado.');
    db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, id);
    const updated = db.prepare(JOIN + ' WHERE a.id=?').get(id);
    bookingNotifications(db, updated, p, LABELS[status], { clock });
    return appointment(updated);
  });
}
export function listClients(db, p) {
  return db
    .prepare(
      "SELECT c.id,c.name,c.email,c.phone,COUNT(a.id) AS bookings,SUM(CASE WHEN a.status='completed' THEN a.total ELSE 0 END) AS spent,MAX(a.start) AS last_visit FROM clients c LEFT JOIN appointments a ON a.client_id=c.id WHERE c.professional_id=? GROUP BY c.id ORDER BY c.name",
    )
    .all(p.id)
    .map((row) => ({ ...row, spent: (row.spent || 0) / 100 }));
}
export function clientHistory(db, p, id) {
  return db
    .prepare(JOIN + ' WHERE a.client_id=? AND a.professional_id=? ORDER BY a.start DESC')
    .all(id, p.id)
    .map((row) => appointment(row));
}
export function reports(db, p, start, end) {
  const span = (parse(end) - parse(start)) / DAY;
  if (span < 0 || span > 366) throw new HttpError(422, 'Selecione um período de até um ano.');
  const rows = db
    .prepare(
      'SELECT start,status,total FROM appointments WHERE professional_id=? AND start>=? AND start<?',
    )
    .all(p.id, `${start}T00:00:00-03:00`, `${addDays(end, 1)}T00:00:00-03:00`);
  const daily = Array.from({ length: span + 1 }, (_, i) => ({
    date: addDays(start, i),
    revenue: 0,
    completed: 0,
  }));
  const dates = new Map(daily.map((day) => [day.date, day]));
  const counts = Object.fromEntries(Object.keys(LABELS).map((status) => [status, 0]));
  let cents = 0;
  for (const row of rows) {
    counts[row.status]++;
    if (row.status === 'completed') {
      const day = dates.get(row.start.slice(0, 10));
      day.revenue += row.total;
      day.completed++;
      cents += row.total;
    }
  }
  daily.forEach((day) => {
    day.revenue /= 100;
  });
  const revenue = cents / 100;
  return {
    revenue,
    completed: counts.completed,
    counts,
    daily,
    average: counts.completed ? revenue / counts.completed : 0,
  };
}
export function notifications(db, p) {
  return db
    .prepare('SELECT * FROM notifications WHERE professional_id=? ORDER BY id DESC LIMIT 100')
    .all(p.id);
}
