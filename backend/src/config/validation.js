import { domainToASCII } from 'node:url';
import { HttpError } from './errors.js';

function invalid(message) {
  throw new HttpError(422, message);
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Informe os dados em um objeto JSON.');
  return value;
}

function text(value, field, { min = 0, max = Infinity, fallback } = {}) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'string') invalid(`Informe ${field}.`);
  const length = Array.from(value).length;
  if (length < min || length > max) invalid(`${field} deve ter entre ${min} e ${max} caracteres.`);
  return value;
}

function email(value) {
  const raw = text(value, 'o e-mail').trim();
  const parts = raw.split('@');
  if (parts.length !== 2) invalid('Informe um e-mail válido.');
  const [local, domain] = parts;
  const asciiDomain = domainToASCII(domain).toLowerCase();
  if (
    !local ||
    Buffer.byteLength(local, 'utf8') > 64 ||
    /[\s<>()[\]\\,;:"\x00-\x1f\x7f]/u.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !asciiDomain.includes('.') ||
    asciiDomain.length > 253 ||
    asciiDomain
      .split('.')
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^\d+$/.test(asciiDomain.split('.').at(-1)) ||
    Buffer.byteLength(raw, 'utf8') > 254
  )
    invalid('Informe um e-mail válido.');
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

export function normalizePhone(value) {
  let digits = text(value, 'o telefone').replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55'))
    digits = digits.slice(2);
  if (digits.length !== 10 && digits.length !== 11)
    invalid('Informe um telefone brasileiro com DDD (10 ou 11 dígitos).');
  return digits;
}

function contact(value) {
  const data = object(value);
  const name = text(data.name, 'o nome', { min: 2, max: 100 }).trim();
  if (Array.from(name).length < 2) invalid('Informe seu nome.');
  return { name, email: email(data.email), phone: normalizePhone(data.phone) };
}

function password(value, min = 8, enforceBytes = true) {
  const result = text(value, 'a senha', { min, max: 72 });
  if (enforceBytes && Buffer.byteLength(result, 'utf8') > 72)
    invalid('A senha deve ter até 72 bytes.');
  return result;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 't'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', 'f'].includes(normalized)) return false;
  }
  invalid('Informe um valor booleano válido.');
}

function integer(
  value,
  field,
  { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
    invalid(`Informe ${field} como número inteiro.`);
  if (typeof value === 'string' && (!value.trim() || !/^[+-]?\d+(?:\.0+)?$/.test(value.trim())))
    invalid(`Informe ${field} como número inteiro.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    invalid(`Informe ${field} entre ${min} e ${max}.`);
  return number;
}

function slug(value) {
  const result = text(value, 'o link personalizado', { min: 3, max: 60 });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result))
    invalid('Use letras minúsculas, números e hífens no link personalizado.');
  return result;
}

export function validateClientRegister(value) {
  const data = object(value);
  return { ...contact(data), password: password(data.password) };
}

export function validateRegister(value) {
  const data = object(value);
  return {
    ...validateClientRegister(data),
    business: text(data.business, 'o negócio', { min: 2, max: 100 }),
    slug: slug(data.slug),
  };
}

export function validateLogin(value) {
  const data = object(value);
  return {
    email: email(data.email),
    password: password(data.password, 1, false),
  };
}

export function validateProfile(value) {
  const data = object(value);
  const photo = text(data.photo, 'a foto', { max: 500000, fallback: '' });
  if (photo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo))
    invalid('A foto deve ser PNG, JPEG ou WebP.');
  const category = text(data.category, 'a categoria', {
    min: 2,
    max: 80,
    fallback: 'Beleza e cuidados',
  }).trim();
  if (Array.from(category).length < 2)
    invalid('Informe uma categoria com pelo menos 2 caracteres.');
  return {
    ...contact(data),
    business: text(data.business, 'o negócio', { min: 2, max: 100 }),
    slug: slug(data.slug),
    bio: text(data.bio, 'a descrição', { max: 1000, fallback: '' }),
    photo,
    auto_approve: bool(data.auto_approve, true),
    category,
    city: text(data.city, 'a cidade', { max: 100, fallback: '' }).trim(),
  };
}

function price(value) {
  if (typeof value !== 'number' && typeof value !== 'string') invalid('Informe um preço válido.');
  const input = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!match || (!match[2] && !match[3])) invalid('Informe um preço válido.');
  const result = Number(input);
  if (!Number.isFinite(result) || result < 0 || result > 100000)
    invalid('Informe um preço entre 0 e 100000.');
  const significant = `${match[2]}${match[3] || ''}`.replace(/0+$/, '');
  const fractionalPlaces =
    (match[3] || '').length -
    Number(match[4] || 0) -
    (`${match[2]}${match[3] || ''}`.length - significant.length);
  if (significant && fractionalPlaces > 2) invalid('Use no máximo duas casas decimais no preço.');
  return result;
}

export function validateService(value) {
  const data = object(value);
  const duration = integer(data.duration, 'a duração', { min: 15, max: 480 });
  if (duration % 15) invalid('A duração deve ser múltipla de 15 minutos.');
  const color = text(data.color, 'a cor', { fallback: 'sage' });
  if (!['sage', 'peach', 'lavender', 'blue'].includes(color)) invalid('Informe uma cor válida.');
  return {
    name: text(data.name, 'o nome', { min: 2, max: 100 }),
    description: text(data.description, 'a descrição', { min: 2, max: 500 }),
    duration,
    price: price(data.price),
    active: bool(data.active, true),
    color,
  };
}

function time(value, fallback) {
  const result = text(value, 'o horário', { fallback });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) invalid('Informe um horário válido.');
  if (Number(result.slice(3)) % 15) invalid('Use horários em múltiplos de 15 minutos.');
  return result;
}

export function validateSchedule(value) {
  const data = object(value);
  if (!Array.isArray(data.days) || data.days.length !== 7)
    invalid('Informe os sete dias da semana.');
  const days = data.days.map((value) => {
    const day = object(value);
    const result = {
      enabled: bool(day.enabled, false),
      start: time(day.start, '09:00'),
      end: time(day.end, '18:00'),
      break_start: time(day.break_start, '12:00'),
      break_end: time(day.break_end, '13:00'),
      has_break: bool(day.has_break, true),
    };
    if (
      result.enabled &&
      (result.start >= result.end ||
        (result.has_break &&
          !(
            result.start <= result.break_start &&
            result.break_start < result.break_end &&
            result.break_end <= result.end
          )))
    ) {
      invalid('Intervalo inválido: confira início, fim e almoço.');
    }
    return result;
  });
  return { days };
}

export function validateBooking(value) {
  const data = object(value);
  if (
    !Array.isArray(data.service_ids) ||
    data.service_ids.length < 1 ||
    data.service_ids.length > 10
  )
    invalid('Selecione entre 1 e 10 serviços.');
  return {
    ...contact(data),
    service_ids: data.service_ids.map((id) => integer(id, 'o serviço')),
    start: text(data.start, 'a data e o horário'),
    notes: text(data.notes, 'as observações', { max: 500, fallback: '' }),
  };
}

export function validateBlock(value) {
  const data = object(value);
  return {
    start: text(data.start, 'o início'),
    end: text(data.end, 'o fim'),
    reason: text(data.reason, 'o motivo', { min: 2, max: 100 }),
  };
}

export function validateStatus(value) {
  const status = text(object(value).status, 'o status');
  if (!['confirmed', 'completed', 'cancelled', 'absent'].includes(status))
    invalid('Informe um status válido.');
  return { status };
}

export function validateRecovery(value) {
  return { email: email(object(value).email) };
}

export function validateReset(value) {
  const data = object(value);
  return {
    token: text(data.token, 'o token'),
    password: password(data.password),
  };
}
