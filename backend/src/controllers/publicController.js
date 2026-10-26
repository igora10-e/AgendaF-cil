import * as model from '../models/public.js';
import { clientIdentity, requireClient } from '../models/auth.js';
import { createBooking, bySlug, slots, casefold } from '../models/booking.js';
import { transaction } from '../config/database.js';
import { HttpError } from '../config/errors.js';
import { validDay } from '../config/time.js';
import { validateBooking } from '../config/validation.js';

function query(value, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(422, 'Filtro inválido.');
  return value;
}
export function createPublicController({ db, clock }) {
  return {
    explore: (req, res) =>
      res.json(
        model.explore(db, {
          q: query(req.query.q, 200),
          category: query(req.query.category, 80),
          city: query(req.query.city, 100),
        }),
      ),
    profile: (req, res) => res.json(model.profile(db, req.params.slug)),
    slots: (req, res) => {
      const day = validDay(req.query.day),
        raw = query(req.query.service_ids, 200);
      if (!/^\d+(?:,\d+){0,9}$/.test(raw))
        throw new HttpError(422, 'Selecione entre 1 e 10 serviços.');
      const ids = raw.split(',').map(Number);
      if (ids.some((id) => !Number.isSafeInteger(id)))
        throw new HttpError(422, 'Serviços inválidos.');
      res.json({ slots: slots(db, bySlug(db, req.params.slug), day, ids, clock) });
    },
    book: (req, res) => {
      let data = validateBooking(req.body);
      const result = transaction(db, () => {
        const account = clientIdentity(db, req);
        if (account) {
          if (
            casefold(data.name) !== casefold(account.name) ||
            data.email !== account.email ||
            data.phone !== account.phone
          )
            throw new HttpError(
              409,
              'Use o nome, e-mail e telefone da sua conta de cliente para agendar.',
            );
          data = { ...data, name: account.name, email: account.email, phone: account.phone };
        }
        return createBooking(db, bySlug(db, req.params.slug), data, {
          clock,
          accountId: account?.id ?? null,
        });
      });
      res.status(201).json(result);
    },
    clientBookings: (req, res) => res.json(model.clientBookings(db, requireClient(db, req), clock)),
    reservation: (req, res) => res.json(model.reservation(db, req.params.token, clock)),
    cancel: (req, res) => res.json(model.cancel(db, req.params.token, clock)),
    history: (req, res) => res.json(model.history(db, req.params.token)),
  };
}
