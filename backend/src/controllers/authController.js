import bcrypt from 'bcryptjs';
import { transaction } from '../config/database.js';
import { HttpError } from '../config/errors.js';
import { digest, now, randomToken, stamp } from '../config/time.js';
import {
  validateClientRegister,
  validateLogin,
  validateRecovery,
  validateRegister,
  validateReset,
} from '../config/validation.js';
import { cookie, requireClient, requireProfessional, safeClient } from '../models/auth.js';
import { defaultSchedule, professional } from '../models/booking.js';

const lifetime = 7 * 24 * 60 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.ENVIRONMENT === 'production',
    sameSite: 'strict',
    path: '/',
  };
}

function uniqueConstraint(error) {
  return (
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error?.errcode === 2067 ||
    /UNIQUE constraint failed/.test(error?.message || '')
  );
}

function createSession(db, table, id, clock) {
  const token = randomToken();
  const current = now(clock);
  // The table is selected internally, never from a request parameter.
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(
    digest(token),
    id,
    stamp(new Date(current.getTime() + lifetime)),
  );
  db.prepare(`DELETE FROM ${table} WHERE expires<?`).run(stamp(current));
  return token;
}

function respondWithSession(res, name, token, payload, status = 200) {
  res.cookie(name, token, { ...cookieOptions(), maxAge: lifetime });
  return res.status(status).json(payload);
}

async function validPassword(password, hash) {
  if (Buffer.byteLength(password, 'utf8') > 72) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export function createAuthController({
  db,
  clock,
  publicUrl = process.env.PUBLIC_URL || 'http://127.0.0.1:8000',
}) {
  return {
    async register(req, res) {
      const data = validateRegister(req.body);
      const hash = await bcrypt.hash(data.password, 12);
      const result = transaction(db, () => {
        let id;
        try {
          id = Number(
            db
              .prepare(
                'INSERT INTO professionals(name,email,password,phone,slug,business,schedule) VALUES(?,?,?,?,?,?,?)',
              )
              .run(
                data.name,
                data.email,
                hash,
                data.phone,
                data.slug,
                data.business,
                JSON.stringify(defaultSchedule()),
              ).lastInsertRowid,
          );
        } catch (error) {
          if (uniqueConstraint(error))
            throw new HttpError(409, 'E-mail ou link personalizado já cadastrado.');
          throw error;
        }
        const token = createSession(db, 'sessions', id, clock);
        const payload = professional(db.prepare('SELECT * FROM professionals WHERE id=?').get(id));
        return { token, payload };
      });
      return respondWithSession(res, 'agenda_session', result.token, result.payload, 201);
    },

    async login(req, res) {
      const data = validateLogin(req.body);
      const row = db.prepare('SELECT * FROM professionals WHERE email=?').get(data.email);
      if (!row || !(await validPassword(data.password, row.password)))
        throw new HttpError(401, 'E-mail ou senha incorretos.');
      const result = transaction(db, () => {
        const current = db.prepare('SELECT * FROM professionals WHERE id=?').get(row.id);
        if (!current || current.password !== row.password)
          throw new HttpError(401, 'E-mail ou senha incorretos.');
        return {
          token: createSession(db, 'sessions', current.id, clock),
          payload: professional(current),
        };
      });
      return respondWithSession(res, 'agenda_session', result.token, result.payload);
    },

    me(req, res) {
      return res.json(professional(requireProfessional(db, req)));
    },

    logout(req, res) {
      transaction(db, () =>
        db.prepare('DELETE FROM sessions WHERE token=?').run(digest(cookie(req, 'agenda_session'))),
      );
      res.clearCookie('agenda_session', cookieOptions());
      return res.json({ ok: true });
    },

    async registerClient(req, res) {
      const data = validateClientRegister(req.body);
      const hash = await bcrypt.hash(data.password, 12);
      const result = transaction(db, () => {
        let id;
        try {
          id = Number(
            db
              .prepare('INSERT INTO client_accounts(name,email,phone,password) VALUES(?,?,?,?)')
              .run(data.name, data.email, data.phone, hash).lastInsertRowid,
          );
        } catch (error) {
          if (uniqueConstraint(error))
            throw new HttpError(409, 'E-mail ou telefone já cadastrado como cliente.');
          throw error;
        }
        return {
          token: createSession(db, 'client_sessions', id, clock),
          payload: safeClient(db.prepare('SELECT * FROM client_accounts WHERE id=?').get(id)),
        };
      });
      return respondWithSession(res, 'agenda_client_session', result.token, result.payload, 201);
    },

    async loginClient(req, res) {
      const data = validateLogin(req.body);
      const row = db.prepare('SELECT * FROM client_accounts WHERE email=?').get(data.email);
      if (!row || !(await validPassword(data.password, row.password)))
        throw new HttpError(401, 'E-mail ou senha incorretos.');
      const result = transaction(db, () => {
        const current = db.prepare('SELECT * FROM client_accounts WHERE id=?').get(row.id);
        if (!current || current.password !== row.password)
          throw new HttpError(401, 'E-mail ou senha incorretos.');
        return {
          token: createSession(db, 'client_sessions', current.id, clock),
          payload: safeClient(current),
        };
      });
      return respondWithSession(res, 'agenda_client_session', result.token, result.payload);
    },

    meClient(req, res) {
      return res.json(safeClient(requireClient(db, req)));
    },

    logoutClient(req, res) {
      transaction(db, () =>
        db
          .prepare('DELETE FROM client_sessions WHERE token=?')
          .run(digest(cookie(req, 'agenda_client_session'))),
      );
      res.clearCookie('agenda_client_session', cookieOptions());
      return res.json({ ok: true });
    },

    recover(req, res) {
      const data = validateRecovery(req.body);
      transaction(db, () => {
        const row = db.prepare('SELECT * FROM professionals WHERE email=?').get(data.email);
        if (!row) return;
        const token = randomToken();
        const current = now(clock);
        db.prepare('DELETE FROM resets WHERE professional_id=?').run(row.id);
        db.prepare('INSERT INTO resets VALUES(?,?,?)').run(
          digest(token),
          row.id,
          stamp(new Date(current.getTime() + 30 * 60 * 1000)),
        );
        const url = `${publicUrl.replace(/\/$/, '')}/redefinir/${token}`;
        db.prepare(
          'INSERT INTO notifications(professional_id,recipient,subject,body,created) VALUES(?,?,?,?,?)',
        ).run(
          row.id,
          row.email,
          'Recuperar acesso • Agenda Fácil',
          `Redefina sua senha em até 30 minutos:\n${url}\nSe não foi você, ignore esta mensagem.`,
          stamp(current),
        );
      });
      return res.json({
        message: 'Se este e-mail estiver cadastrado, enviaremos um link de recuperação.',
      });
    },

    async reset(req, res) {
      const data = validateReset(req.body);
      const tokenHash = digest(data.token);
      const lookup = () =>
        db
          .prepare('SELECT * FROM resets WHERE token=? AND expires>?')
          .get(tokenHash, stamp(now(clock)));
      if (!lookup()) throw new HttpError(400, 'Link inválido ou expirado. Solicite outro.');
      const hash = await bcrypt.hash(data.password, 12);
      transaction(db, () => {
        const row = lookup();
        if (!row) throw new HttpError(400, 'Link inválido ou expirado. Solicite outro.');
        db.prepare('UPDATE professionals SET password=? WHERE id=?').run(hash, row.professional_id);
        db.prepare('DELETE FROM sessions WHERE professional_id=?').run(row.professional_id);
        db.prepare('DELETE FROM resets WHERE professional_id=?').run(row.professional_id);
      });
      return res.json({ ok: true });
    },
  };
}
