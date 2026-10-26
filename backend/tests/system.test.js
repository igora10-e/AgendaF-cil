import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  application,
  fixture,
  booking,
  professionalRegistration,
  expectStatus,
  FIXED,
} from './helpers.js';

test('professional authentication hashes passwords, revokes logout, and isolates tenant data', async (t) => {
  const { client, app, service, professional } = await fixture(t);
  assert.equal('password' in professional, false);
  assert.ok(client.cookies.get('agenda_session'));
  const password = app.locals.db.prepare('SELECT password FROM professionals').get().password;
  assert.match(password, /^\$2[ab]\$/);
  assert.notEqual(password, 'Agenda@123');
  const rawSession = client.cookies.get('agenda_session');
  const stored = app.locals.db.prepare('SELECT token FROM sessions').get().token;
  assert.equal(stored, createHash('sha256').update(rawSession).digest('hex'));
  expectStatus(await client.post('/api/auth/logout'), 200);
  expectStatus(await client.get('/api/services'), 401);
  expectStatus(
    await client.post('/api/auth/login', { email: professional.email, password: 'wrong' }),
    401,
  );
  expectStatus(
    await client.post('/api/auth/login', {
      email: professional.email.toUpperCase(),
      password: 'Agenda@123',
    }),
    200,
  );
  expectStatus(await client.post('/api/appointments', booking(service)), 201);
  expectStatus(
    await client.post(
      '/api/auth/register',
      professionalRegistration({
        name: 'Outra Conta',
        email: 'outra@example.com',
        phone: '11987776666',
        business: 'Outro Studio',
        slug: 'outro-studio',
      }),
    ),
    201,
  );
  assert.deepEqual(expectStatus(await client.get('/api/appointments'), 200), []);
  expectStatus(
    await client.put(`/api/services/${service.id}`, { ...service, name: 'Alterado', price: 1 }),
    404,
  );
  expectStatus(await client.delete(`/api/services/${service.id}`), 404);
});

test('bookings enforce two-hour notice, quarter-hour grid, and a ninety-day horizon', async (t) => {
  const { client, service } = await fixture(t);
  for (const start of [
    '2026-10-05T09:45:00-03:00',
    '2026-10-05T10:01:00-03:00',
    '2026-10-05T10:00:01-03:00',
    '2026-10-05T10:00:00.001-03:00',
    '2026-10-05T10:00:00.000001-03:00',
    '2027-01-04T10:00:00-03:00',
    'invalid-date',
  ])
    expectStatus(
      await client.post('/api/public/studio-marina/bookings', booking(service, { start })),
      422,
    );
  expectStatus(await client.post('/api/public/studio-marina/bookings', booking(service)), 201);
  const available = expectStatus(
    await client.get(`/api/public/studio-marina/slots?day=2026-10-05&service_ids=${service.id}`),
    200,
  ).slots;
  assert.ok(
    available.every((value) => new Date(value) >= new Date(FIXED).getTime() + 2 * 60 * 60 * 1000),
  );
  assert.equal(available.includes('2026-10-05T10:00:00-03:00'), false);
  assert.ok(available.includes('2026-10-05T11:00:00-03:00'));
  assert.deepEqual(
    expectStatus(
      await client.get(`/api/public/studio-marina/slots?day=2027-01-04&service_ids=${service.id}`),
      200,
    ).slots,
    [],
  );
});

test('UTC booking timestamps use the same São Paulo working hours and slot occupancy', async (t) => {
  const { client, service } = await fixture(t);
  const appointment = expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T13:00:00Z' }),
    ),
    201,
  );
  assert.equal(appointment.start, '2026-10-05T10:00:00-03:00');
  assert.equal(appointment.end, '2026-10-05T11:00:00-03:00');
  const slots = expectStatus(
    await client.get(`/api/public/studio-marina/slots?day=2026-10-05&service_ids=${service.id}`),
    200,
  ).slots;
  assert.equal(slots.includes(appointment.start), false);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-11T10:00:00-03:00' }),
    ),
    409,
  );
});

test('multiple services combine duration and prices without crossing lunch or repeating services', async (t) => {
  const { client, service, app } = await fixture(t);
  expectStatus(
    await client.post('/api/services', {
      name: 'Inválido',
      description: 'Duração inválida',
      duration: 20,
      price: 10,
    }),
    422,
  );
  const second = expectStatus(
    await client.post('/api/services', {
      name: 'Massagem',
      description: 'Relaxante',
      duration: 30,
      price: 50,
    }),
    201,
  );
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, {
        service_ids: [service.id, second.id],
        start: '2026-10-05T11:00:00-03:00',
      }),
    ),
    409,
  );
  const appointment = expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { service_ids: [service.id, second.id] }),
    ),
    201,
  );
  assert.equal(appointment.total, 150);
  assert.equal(new Date(appointment.end) - new Date(appointment.start), 90 * 60 * 1000);
  assert.equal(appointment.services.length, 2);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, {
        service_ids: [service.id, service.id],
        start: '2026-10-05T14:00:00-03:00',
      }),
    ),
    422,
  );
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM appointments').get().count, 1);
});

test('simultaneous overlapping requests produce one reservation atomically', async (t) => {
  const { client, service, app } = await fixture(t);
  const results = await Promise.all(
    [1, 2].map((index) =>
      client.post(
        '/api/public/studio-marina/bookings',
        booking(service, {
          name: `Cliente ${index}`,
          email: `cliente${index}@example.com`,
          phone: `1198888000${index}`,
        }),
      ),
    ),
  );
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal(expectStatus(await client.get('/api/appointments'), 200).length, 1);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM clients').get().count, 1);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 2);
});

test('private links preserve guest history and cancellation includes the exact three-hour boundary', async (t) => {
  const { client, service } = await fixture(t);
  const first = expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T11:00:00-03:00' }),
    ),
    201,
  );
  assert.equal(
    expectStatus(await client.get(`/api/history/${first.history_token}`), 200).name,
    'Ana Carolina',
  );
  expectStatus(await client.get('/api/reservations/not-a-valid-token'), 404);
  expectStatus(await client.get('/api/history/not-a-valid-token'), 404);
  assert.equal(
    expectStatus(await client.get(`/api/reservations/${first.token}`), 200).can_cancel,
    true,
  );
  expectStatus(await client.post(`/api/reservations/${first.token}/cancel`), 200);
  expectStatus(await client.post(`/api/reservations/${first.token}/cancel`), 409);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: first.start }),
    ),
    201,
  );
  const second = expectStatus(
    await client.post('/api/public/studio-marina/bookings', booking(service)),
    201,
  );
  assert.equal(
    expectStatus(await client.get(`/api/reservations/${second.token}`), 200).can_cancel,
    false,
  );
  expectStatus(await client.post(`/api/reservations/${second.token}/cancel`), 422);
  expectStatus(
    await client.patch(`/api/appointments/${second.id}/status`, { status: 'cancelled' }),
    200,
  );
});

test('Brazilian phone normalization reuses a client and rejects contradictory contact identities', async (t) => {
  const { client, service } = await fixture(t);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { phone: '+55 (11) 99999-8888' }),
    ),
    201,
  );
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00', email: 'different@example.com' }),
    ),
    409,
  );
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00', phone: '123' }),
    ),
    422,
  );
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00', name: 'ANA CAROLINA' }),
    ),
    201,
  );
  assert.equal(expectStatus(await client.get('/api/clients'), 200).length, 1);
});

test('blocks and schedule changes protect existing bookings and inactive services preserve history', async (t) => {
  const { client, service, professional } = await fixture(t);
  expectStatus(
    await client.post('/api/blocks', {
      start: '2026-10-05T10:00',
      end: '2026-10-05T11:00',
      reason: 'Descanso',
    }),
    201,
  );
  expectStatus(await client.post('/api/public/studio-marina/bookings', booking(service)), 409);
  const block = expectStatus(await client.get('/api/blocks'), 200)[0];
  expectStatus(await client.delete(`/api/blocks/${block.id}`), 200);
  expectStatus(await client.post('/api/public/studio-marina/bookings', booking(service)), 201);
  expectStatus(
    await client.post('/api/blocks', {
      start: '2026-10-05T10:30',
      end: '2026-10-05T11:30',
      reason: 'Conflito',
    }),
    409,
  );
  const days = structuredClone(professional.schedule);
  days[0].enabled = false;
  expectStatus(await client.put('/api/schedule', { days }), 409);
  assert.deepEqual(
    expectStatus(await client.get('/api/auth/me'), 200).schedule,
    professional.schedule,
  );
  expectStatus(await client.put(`/api/services/${service.id}`, { ...service, active: false }), 200);
  assert.deepEqual(expectStatus(await client.get('/api/public/studio-marina'), 200).services, []);
  expectStatus(await client.delete(`/api/services/${service.id}`), 409);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00' }),
    ),
    422,
  );
});

test('status transitions, immutable service snapshots, and revenue reports match completed work', async (t) => {
  const { client, service, professional, setClock } = await fixture(t);
  expectStatus(await client.put('/api/profile', { ...professional, auto_approve: false }), 200);
  const appointment = expectStatus(
    await client.post('/api/public/studio-marina/bookings', booking(service)),
    201,
  );
  assert.equal(appointment.status, 'pending');
  expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'completed' }),
    409,
  );
  expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'confirmed' }),
    200,
  );
  expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'completed' }),
    422,
  );
  expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'absent' }),
    422,
  );
  setClock('2026-10-05T12:00:00-03:00');
  expectStatus(
    await client.put(`/api/services/${service.id}`, { ...service, name: 'Novo nome', price: 999 }),
    200,
  );
  const completed = expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'completed' }),
    200,
  );
  assert.equal(completed.services[0].price, 100);
  assert.equal(completed.services[0].name, 'Consulta');
  const report = expectStatus(
    await client.get('/api/reports?start=2026-10-05&end=2026-10-05'),
    200,
  );
  assert.equal(report.revenue, 100);
  assert.equal(report.completed, 1);
  assert.equal(report.average, 100);
  assert.deepEqual(report.daily, [{ date: '2026-10-05', revenue: 100, completed: 1 }]);
  expectStatus(
    await client.patch(`/api/appointments/${appointment.id}/status`, { status: 'cancelled' }),
    409,
  );
  assert.ok(expectStatus(await client.get('/api/notifications'), 200).length >= 6);
  expectStatus(await client.get('/api/reports?start=2026-10-06&end=2026-10-05'), 422);
  expectStatus(await client.get('/api/reports?start=2025-01-01&end=2026-10-05'), 422);
});

test('password recovery avoids enumeration, expires, is single use, and revokes sessions', async (t) => {
  const { client, professional, app, setClock } = await fixture(t);
  const missing = expectStatus(
    await client.post('/api/auth/recover', { email: 'missing@example.com' }),
    200,
  );
  assert.deepEqual(
    expectStatus(await client.post('/api/auth/recover', { email: professional.email }), 200),
    missing,
  );
  const resetToken = () =>
    app.locals.db
      .prepare("SELECT body FROM notifications WHERE subject LIKE 'Recuperar%' ORDER BY id DESC")
      .get()
      .body.match(/\/redefinir\/([^\s]+)/)[1];
  const expired = resetToken();
  setClock('2026-10-05T08:30:01-03:00');
  expectStatus(
    await client.post('/api/auth/reset', { token: expired, password: 'NovaSenha@123' }),
    400,
  );
  expectStatus(await client.post('/api/auth/recover', { email: professional.email }), 200);
  const token = resetToken();
  expectStatus(await client.post('/api/auth/reset', { token, password: 'NovaSenha@123' }), 200);
  expectStatus(await client.get('/api/auth/me'), 401);
  expectStatus(await client.post('/api/auth/reset', { token, password: 'OutraSenha@123' }), 400);
  expectStatus(
    await client.post('/api/auth/login', { email: professional.email, password: 'Agenda@123' }),
    401,
  );
  expectStatus(
    await client.post('/api/auth/login', { email: professional.email, password: 'NovaSenha@123' }),
    200,
  );
});

test('professional sessions expire without accepting a still-present cookie', async (t) => {
  const { client, app } = await fixture(t);
  app.locals.db.prepare('UPDATE sessions SET expires=?').run('2026-10-05T07:59:59-03:00');
  expectStatus(await client.get('/api/auth/me'), 401);
  expectStatus(await client.get('/api/appointments'), 401);
});

test('password limits count UTF-8 bytes and excessive login attempts are throttled', async (t) => {
  const { client, professional } = await fixture(t);
  const tooLong = 'é'.repeat(40);
  expectStatus(
    await client.post(
      '/api/auth/register',
      professionalRegistration({
        email: 'long@example.com',
        slug: 'long-studio',
        password: tooLong,
      }),
    ),
    422,
  );
  expectStatus(await client.post('/api/auth/reset', { token: 'unused', password: tooLong }), 422);
  expectStatus(
    await client.post('/api/auth/login', { email: professional.email, password: tooLong }),
    401,
  );
  for (let attempt = 1; attempt < 20; attempt++) {
    expectStatus(
      await client.post('/api/auth/login', { email: 'unknown@example.com', password: 'wrong' }),
      401,
    );
  }
  expectStatus(
    await client.post('/api/auth/login', { email: 'unknown@example.com', password: 'wrong' }),
    429,
  );
});

test('mutating requests reject foreign origins and public responses omit private profile fields', async (t) => {
  const { client } = await fixture(t);
  expectStatus(
    await client.post('/api/auth/logout', undefined, { origin: 'https://untrusted.example' }),
    403,
  );
  expectStatus(await client.get('/api/auth/me'), 200);
  const response = await client.get('/api/public/studio-marina');
  const profile = expectStatus(response, 200).profile;
  for (const key of ['email', 'password', 'schedule']) assert.equal(key in profile, false);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('API validation rejects malformed payloads without writing services or appointments', async (t) => {
  const { client, app, service, professional } = await fixture(t);
  for (const changes of [
    { price: -1 },
    { price: 1.001 },
    { duration: 0 },
    { duration: 481 },
    { color: 'unknown' },
  ]) {
    expectStatus(await client.post('/api/services', { ...service, ...changes }), 422);
  }
  for (const changes of [
    { email: 'not-email' },
    { name: ' ' },
    { service_ids: [] },
    { service_ids: [999999] },
    { notes: 'x'.repeat(501) },
  ]) {
    expectStatus(
      await client.post('/api/public/studio-marina/bookings', booking(service, changes)),
      422,
    );
  }
  expectStatus(
    await client.put('/api/profile', { ...professional, photo: 'javascript:alert(1)' }),
    422,
  );
  expectStatus(await client.put('/api/schedule', { days: professional.schedule.slice(0, 6) }), 422);
  expectStatus(
    await client.get('/api/public/studio-marina/slots?day=2026-10-05&service_ids=1,invalid'),
    422,
  );
  expectStatus(await client.get('/api/public/studio-marina/slots?day=bad-date&service_ids=1'), 422);
  expectStatus(
    await client.post('/api/blocks', {
      start: '2026-10-05T11:00',
      end: '2026-10-05T10:00',
      reason: 'Inválido',
    }),
    422,
  );
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM services').get().count, 1);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM appointments').get().count, 0);
});

test('SPA routes and assets are served while unknown API paths return JSON 404', async (t) => {
  const { client } = await application(t);
  assert.deepEqual(expectStatus(await client.get('/api/health'), 200), { status: 'ok' });
  const missing = await client.get('/api/does-not-exist');
  expectStatus(missing, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal(typeof missing.data.detail, 'string');
  const spa = await client.get('/profissional/agenda');
  expectStatus(spa, 200);
  assert.match(spa.headers.get('content-type'), /text\/html/);
  assert.match(spa.text, /<div id="root"><\/div>/);
  const assetDirectory = fileURLToPath(new URL('../../frontend/dist/assets/', import.meta.url));
  const asset = (await readdir(assetDirectory)).find((name) => name.endsWith('.js'));
  assert.ok(asset);
  const javascript = await client.get(`/assets/${asset}`);
  expectStatus(javascript, 200);
  assert.match(javascript.headers.get('content-type'), /javascript/);
  expectStatus(await client.get('/assets/missing-file.js'), 404);
});
