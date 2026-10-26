import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';

export const TZ = 'America/Sao_Paulo';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const pad = (value) => String(value).padStart(2, '0');

export function now(clock) {
  return new Date(clock ? clock() : Date.now());
}
export function randomToken() {
  return randomBytes(32).toString('base64url');
}
export function digest(value = '') {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function stamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(422, 'Data ou horário inválido.');
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const apparent = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = Math.round((apparent - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${zone}`;
}

export function dayKey(value = new Date()) {
  return stamp(value).slice(0, 10);
}
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new HttpError(422, 'Data inválida.');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new HttpError(422, 'Data inválida.');
  return value;
}

export function parse(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value);
  if (typeof value !== 'string') throw new HttpError(422, 'Data ou horário inválido.');
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (!match) throw new HttpError(422, 'Data ou horário inválido.');
  validDay(match[1]);
  if (Number(match[2] || 0) > 23 || Number(match[3] || 0) > 59 || Number(match[4] || 0) > 59)
    throw new HttpError(422, 'Data ou horário inválido.');
  const parsed = new Date(
    `${match[1]}T${match[2] || '00'}:${match[3] || '00'}:${match[4] || '00'}${match[5] || ''}${match[6] || '-03:00'}`,
  );
  if (Number.isNaN(parsed.getTime())) throw new HttpError(422, 'Data ou horário inválido.');
  return parsed;
}

export function addDays(day, count) {
  return dayKey(new Date(parse(`${validDay(day)}T12:00:00`).getTime() + count * DAY));
}
