import nodemailer from 'nodemailer';
import { transaction } from '../config/database.js';
import { PUBLIC_URL } from '../config/env.js';
import { now, stamp, parse } from '../config/time.js';
import { JOIN } from './booking.js';

export function queueEmail(db, pid, recipient, subject, body, { clock } = {}) {
  db.prepare(
    'INSERT INTO notifications(professional_id,recipient,subject,body,created) VALUES(?,?,?,?,?)',
  ).run(pid, recipient, subject, body, stamp(now(clock)));
}

export function bookingNotifications(db, a, p, label, { clock } = {}) {
  const local = stamp(parse(a.start));
  const when = `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} às ${local.slice(11, 16)}`;
  const historyUrl =
    a.account_id != null ? `${PUBLIC_URL}/cliente` : `${PUBLIC_URL}/historico/${a.history_token}`;
  const body = `Olá, ${a.client_name}!\n\nSeu atendimento com ${p.business} está ${label.toLowerCase()}.\nData: ${when}\nServiços: ${JSON.parse(
    a.services,
  )
    .map((s) => s.name)
    .join(
      ', ',
    )}\nValor: R$ ${(a.total / 100).toFixed(2)}\n\nConsulte ou cancele: ${PUBLIC_URL}/reserva/${a.token}\nSeu histórico: ${historyUrl}\n\nCancelamentos permitidos até 3 horas antes.\nAgenda Fácil`;
  queueEmail(db, p.id, a.client_email, `Agenda Fácil • ${label} • ${when}`, body, { clock });
  queueEmail(
    db,
    p.id,
    p.email,
    `${label}: ${a.client_name} • ${when}`,
    `Cliente: ${a.client_name}\nTelefone: ${a.client_phone}\n${when}\nStatus: ${label}\nPainel: ${PUBLIC_URL}/profissional`,
    { clock },
  );
}

function smtpTransport() {
  const port = Number(process.env.SMTP_PORT || '587');
  if (
    !process.env.SMTP_FROM ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (process.env.SMTP_USER && !process.env.SMTP_PASSWORD)
  ) {
    throw new Error('SMTPConfigurationError');
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: false,
    requireTLS: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
      : {}),
  });
}

export async function processNotifications(db, { clock } = {}) {
  // Queue reminders and mark them in one lock, so retries never duplicate mail.
  transaction(db, () => {
    const currentTime = now(clock);
    const rows = db
      .prepare(`${JOIN} WHERE a.status='confirmed' AND a.reminded=0 AND a.start>? AND a.start<=?`)
      .all(stamp(currentTime), stamp(new Date(currentTime.getTime() + 24 * 3_600_000)));
    for (const a of rows) {
      const p = db.prepare('SELECT * FROM professionals WHERE id=?').get(a.professional_id);
      bookingNotifications(db, a, p, 'Lembrete de atendimento', { clock });
      db.prepare('UPDATE appointments SET reminded=1 WHERE id=?').run(a.id);
    }
  });
  const pending = db
    .prepare(
      "SELECT * FROM notifications WHERE status IN ('queued','failed') AND attempts < 5 ORDER BY id LIMIT 30",
    )
    .all();
  let transport;
  for (const item of pending) {
    let state = 'local';
    let error = '';
    try {
      if (process.env.SMTP_HOST) {
        transport ??= smtpTransport();
        await transport.sendMail({
          from: process.env.SMTP_FROM,
          to: item.recipient,
          subject: item.subject,
          text: item.body,
        });
        state = 'sent';
      }
    } catch (exc) {
      state = 'failed';
      error =
        exc?.message === 'SMTPConfigurationError' ? 'SMTPConfigurationError' : exc?.name || 'Error';
    }
    transaction(db, () => {
      db.prepare('UPDATE notifications SET status=?,error=?,attempts=attempts+1 WHERE id=?').run(
        state,
        error,
        item.id,
      );
    });
  }
  transport?.close();
}

export function startNotificationWorker(db, { clock } = {}) {
  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return;
    running = processNotifications(db, { clock })
      .catch((error) =>
        console.error('Falha no processamento de notificações:', error?.name || 'Error'),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    return running ?? Promise.resolve();
  };
}
