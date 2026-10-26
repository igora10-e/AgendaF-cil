import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../src/config/database.js';
import { defaultSchedule } from '../src/models/booking.js';
import { seed } from '../src/models/seed.js';
import { processNotifications } from '../src/models/notifications.js';
import { application, fixture, booking, expectStatus, FIXED } from './helpers.js';

const clock = () => new Date(FIXED);

test('legacy SQLite migration preserves profiles, guest reservations, and Python bcrypt logins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenda-legacy-'));
  const databasePath = join(directory, 'legacy.sqlite3');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE professionals (id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,phone TEXT NOT NULL,slug TEXT UNIQUE NOT NULL,business TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',photo TEXT NOT NULL DEFAULT '',auto_approve INTEGER NOT NULL DEFAULT 1,schedule TEXT NOT NULL);
    CREATE TABLE clients (id INTEGER PRIMARY KEY,professional_id INTEGER NOT NULL REFERENCES professionals(id),name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,history_token TEXT NOT NULL UNIQUE,UNIQUE(professional_id,email),UNIQUE(professional_id,phone));
    CREATE TABLE appointments (id INTEGER PRIMARY KEY,professional_id INTEGER NOT NULL REFERENCES professionals(id),client_id INTEGER NOT NULL REFERENCES clients(id),start TEXT NOT NULL,end TEXT NOT NULL,services TEXT NOT NULL,total INTEGER NOT NULL,status TEXT NOT NULL,token TEXT NOT NULL UNIQUE,notes TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,reminded INTEGER NOT NULL DEFAULT 0);
  `);
  // Produced by Python bcrypt in the pre-migration regression fixture for Agenda@123.
  const pythonPassword = '$2b$12$QVCegAWlHWDGxYe/aNvHhO0gmukklYtEi8hXsvW/qr7OjKkRxJOF.';
  legacy
    .prepare(
      'INSERT INTO professionals(name,email,password,phone,slug,business,schedule) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'Existing',
      'existing@example.com',
      pythonPassword,
      '11988880000',
      'existing-studio',
      'Existing Studio',
      JSON.stringify(defaultSchedule()),
    );
  legacy
    .prepare(
      'INSERT INTO clients(professional_id,name,email,phone,history_token) VALUES(1,?,?,?,?)',
    )
    .run('Guest', 'guest@example.com', '11988881111', 'history-legacy');
  legacy
    .prepare(
      'INSERT INTO appointments(professional_id,client_id,start,end,services,total,status,token,created) VALUES(1,1,?,?,?,?,?,?,?)',
    )
    .run(
      '2026-10-05T10:00:00-03:00',
      '2026-10-05T11:00:00-03:00',
      '[]',
      10000,
      'confirmed',
      'legacy-token',
      '2026-10-01T08:00:00-03:00',
    );
  legacy.close();
  // Initialization may run on every process start; exercising it twice checks idempotence.
  openDatabase(databasePath).close();
  const { app, client } = await application(t, { databasePath });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const professional = app.locals.db.prepare('SELECT * FROM professionals').get();
  assert.equal(professional.name, 'Existing');
  assert.equal(professional.password, pythonPassword);
  assert.equal(professional.category, 'Beleza e cuidados');
  assert.equal(professional.city, '');
  const appointment = app.locals.db.prepare('SELECT * FROM appointments').get();
  assert.equal(appointment.token, 'legacy-token');
  assert.equal(appointment.account_id, null);
  expectStatus(
    await client.post('/api/auth/login', { email: 'existing@example.com', password: 'Agenda@123' }),
    200,
  );
  assert.equal(expectStatus(await client.get('/api/appointments'), 200)[0].id, appointment.id);
  assert.equal(
    expectStatus(await client.get('/api/history/history-legacy'), 200).appointments[0].token,
    'legacy-token',
  );
});

test('demo seeding is idempotent, preserves edits, and creates independently owned client reservations', async (t) => {
  const { app, client } = await application(t);
  const db = app.locals.db;
  seed(db, { clock });
  db.prepare(
    "UPDATE professionals SET business='My edited studio' WHERE email='demo@agendafacil.com'",
  ).run();
  const tables = ['professionals', 'services', 'clients', 'appointments', 'client_accounts'];
  const counts = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      ]),
    );
  const first = counts();
  seed(db, { clock });
  assert.deepEqual(counts(), first);
  assert.equal(
    db.prepare("SELECT business FROM professionals WHERE email='demo@agendafacil.com'").get()
      .business,
    'My edited studio',
  );
  assert.equal(expectStatus(await client.get('/api/explore'), 200).professionals.length, 6);
  expectStatus(
    await client.post('/api/client/auth/login', {
      email: 'cliente@agendafacil.com',
      password: 'Cliente@123',
    }),
    200,
  );
  const bookings = expectStatus(await client.get('/api/client/bookings'), 200);
  assert.equal(bookings.length, 3);
  assert.deepEqual(
    new Set(bookings.map((row) => row.status)),
    new Set(['confirmed', 'pending', 'completed']),
  );
  assert.ok(bookings.every((row) => row.client_email === 'cliente@agendafacil.com'));
});

test('demo seeding never overwrites or adds demo appointments to a user-owned professional slug', async (t) => {
  const { app, client, professional, service } = await fixture(t);
  seed(app.locals.db, { clock });
  assert.deepEqual(expectStatus(await client.get('/api/auth/me'), 200), professional);
  assert.deepEqual(expectStatus(await client.get('/api/services'), 200), [service]);
  assert.deepEqual(expectStatus(await client.get('/api/appointments'), 200), []);
  assert.equal(expectStatus(await client.get('/api/explore'), 200).professionals.length, 6);
  expectStatus(
    await client.post('/api/client/auth/login', {
      email: 'cliente@agendafacil.com',
      password: 'Cliente@123',
    }),
    200,
  );
  assert.deepEqual(
    new Set(expectStatus(await client.get('/api/client/bookings'), 200).map((row) => row.slug)),
    new Set(['casa-aurora', 'caio-barbearia']),
  );
});

test('notification processing queues reminders once and records local delivery without SMTP', async (t) => {
  const { app, client, service } = await fixture(t);
  expectStatus(await client.post('/api/public/studio-marina/bookings', booking(service)), 201);
  const smtpHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  try {
    await processNotifications(app.locals.db, { clock });
    const first = expectStatus(await client.get('/api/notifications'), 200);
    assert.equal(first.length, 4);
    assert.ok(first.every((row) => row.status === 'local' && row.attempts === 1));
    await processNotifications(app.locals.db, { clock });
    assert.deepEqual(expectStatus(await client.get('/api/notifications'), 200), first);
    assert.equal(app.locals.db.prepare('SELECT reminded FROM appointments').get().reminded, 1);
  } finally {
    if (smtpHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = smtpHost;
  }
});

test('transactions roll back errors and reject asynchronous callbacks without committing partial writes', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('INSERT INTO client_accounts(name,email,phone,password) VALUES(?,?,?,?)').run(
            'Test',
            'test@example.com',
            '11999998888',
            'hash',
          );
          throw new Error('abort');
        }),
      /abort/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM client_accounts').get().count, 0);
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('INSERT INTO client_accounts(name,email,phone,password) VALUES(?,?,?,?)').run(
            'Test',
            'test@example.com',
            '11999998888',
            'hash',
          );
          return Promise.resolve();
        }),
      /synchronous/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM client_accounts').get().count, 0);
  } finally {
    db.close();
  }
});
