import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  fixture,
  booking,
  clientRegistration,
  professionalRegistration,
  expectStatus,
} from './helpers.js';

test('client authentication has independent secure sessions and a safe normalized projection', async (t) => {
  const { client, app } = await fixture(t);
  const response = await client.post(
    '/api/client/auth/register',
    clientRegistration({ email: 'ANA@example.com', phone: '+55 (11) 99999-8888' }),
  );
  const account = expectStatus(response, 201);
  assert.deepEqual(account, {
    id: account.id,
    name: 'Ana Carolina',
    email: 'ana@example.com',
    phone: '11999998888',
  });
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.ok(client.cookies.get('agenda_session'));
  assert.ok(client.cookies.get('agenda_client_session'));
  assert.match(
    app.locals.db.prepare('SELECT password FROM client_accounts').get().password,
    /^\$2[ab]\$/,
  );
  assert.equal(
    app.locals.db.prepare('SELECT token FROM client_sessions').get().token,
    createHash('sha256').update(client.cookies.get('agenda_client_session')).digest('hex'),
  );
  assert.deepEqual(expectStatus(await client.get('/api/client/auth/me'), 200), account);
  expectStatus(await client.post('/api/client/auth/register', clientRegistration()), 409);
  expectStatus(
    await client.post('/api/client/auth/login', { email: account.email, password: 'wrong' }),
    401,
  );
  expectStatus(await client.post('/api/client/auth/logout'), 200);
  expectStatus(await client.get('/api/client/auth/me'), 401);
  expectStatus(await client.get('/api/services'), 200);
  expectStatus(
    await client.post('/api/client/auth/login', {
      email: 'ANA@example.com',
      password: 'Cliente@123',
    }),
    200,
  );
  expectStatus(await client.post('/api/auth/logout'), 200);
  expectStatus(await client.get('/api/auth/me'), 401);
  expectStatus(await client.get('/api/client/auth/me'), 200);
});

test('discovery combines accent-insensitive searches and category/city filters using active services', async (t) => {
  const { client, professional } = await fixture(t);
  expectStatus(
    await client.put('/api/profile', {
      ...professional,
      category: 'Estética',
      city: 'São Paulo',
      bio: 'Cuidado facial em Pinheiros.',
    }),
    200,
  );
  expectStatus(
    await client.post('/api/services', {
      name: 'Serviço oculto',
      description: 'Não aparece',
      duration: 30,
      price: 1,
      active: false,
    }),
    201,
  );
  const second = expectStatus(
    await client.post(
      '/api/auth/register',
      professionalRegistration({
        name: 'Caio Moreira',
        email: 'caio@example.com',
        phone: '11987770000',
        business: 'Caio Barbearia',
        slug: 'caio-barbearia',
      }),
    ),
    201,
  );
  expectStatus(
    await client.put('/api/profile', { ...second, category: 'Barbearia', city: 'Campinas' }),
    200,
  );
  expectStatus(
    await client.post('/api/services', {
      name: 'Corte masculino',
      description: 'Consulta de estilo e corte',
      duration: 45,
      price: 75,
    }),
    201,
  );
  expectStatus(
    await client.post(
      '/api/auth/register',
      professionalRegistration({
        name: 'Sem Serviços',
        email: 'empty@example.com',
        phone: '11987770001',
        business: 'Sem Serviços',
        slug: 'sem-servicos',
      }),
    ),
    201,
  );
  const result = expectStatus(await client.get('/api/explore'), 200);
  assert.equal(result.professionals.length, 2);
  assert.deepEqual(result.categories, ['Barbearia', 'Estética']);
  assert.deepEqual(result.cities, ['Campinas', 'São Paulo']);
  const first = result.professionals.find((row) => row.slug === 'studio-marina');
  assert.equal(first.min_price, 100);
  assert.equal(first.service_count, 1);
  assert.equal(first.services.length, 1);
  for (const key of ['email', 'password', 'schedule', 'created']) assert.equal(key in first, false);
  assert.equal(
    expectStatus(await client.get('/api/explore?q=ESTETICA%20SAO%20PAULO'), 200).professionals[0]
      .id,
    professional.id,
  );
  assert.equal(
    expectStatus(
      await client.get('/api/explore?q=facial%20Pinheiros&category=estetica&city=sao%20paulo'),
      200,
    ).professionals[0].id,
    professional.id,
  );
  assert.equal(
    expectStatus(await client.get('/api/explore?q=consulta%20estilo&category=Barbearia'), 200)
      .professionals[0].slug,
    'caio-barbearia',
  );
  assert.deepEqual(
    expectStatus(await client.get('/api/explore?category=Est%C3%A9tica&city=Campinas'), 200)
      .professionals,
    [],
  );
  assert.deepEqual(
    expectStatus(await client.get('/api/explore?q=servi%C3%A7o%20oculto'), 200).professionals,
    [],
  );
  assert.equal(
    expectStatus(await client.get('/api/public/studio-marina'), 200).profile.city,
    'São Paulo',
  );
});

test('client accounts own only reservations made while signed in and never claim guest history', async (t) => {
  const { client, service, app, professional } = await fixture(t);
  const guest = expectStatus(
    await client.post('/api/public/studio-marina/bookings', booking(service)),
    201,
  );
  const account = expectStatus(
    await client.post('/api/client/auth/register', clientRegistration()),
    201,
  );
  assert.deepEqual(expectStatus(await client.get('/api/client/bookings'), 200), []);
  const own = expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00' }),
    ),
    201,
  );
  assert.equal('history_token' in own, false);
  assert.equal('account_id' in own, false);
  const results = expectStatus(await client.get('/api/client/bookings'), 200);
  assert.equal(results.length, 1);
  const row = results[0];
  assert.equal(row.id, own.id);
  assert.equal(row.token, own.token);
  assert.equal(row.can_cancel, true);
  assert.equal(row.business, 'Studio Marina');
  assert.equal(row.professional_name, 'Marina Almeida');
  assert.equal(row.slug, 'studio-marina');
  assert.equal('history_token' in row, false);
  const history = expectStatus(
    await client.get(`/api/history/${guest.history_token}`),
    200,
  ).appointments;
  assert.deepEqual(
    history.map((item) => item.id),
    [guest.id],
  );
  assert.equal(
    'history_token' in
      expectStatus(await client.get(`/api/reservations/${own.token}`), 200).appointment,
    false,
  );
  const db = app.locals.db;
  assert.equal(
    db.prepare('SELECT account_id FROM appointments WHERE id=?').get(guest.id).account_id,
    null,
  );
  assert.equal(
    db.prepare('SELECT account_id FROM appointments WHERE id=?').get(own.id).account_id,
    account.id,
  );
  const customer = db
    .prepare('SELECT body FROM notifications WHERE body LIKE ? ORDER BY id DESC')
    .get(`%/reserva/${own.token}%`).body;
  assert.equal(customer.includes('/historico/'), false);
  assert.ok(customer.includes('/cliente'));
  const panel = db
    .prepare('SELECT body FROM notifications WHERE recipient=? ORDER BY id DESC')
    .get(professional.email).body;
  assert.match(panel, /Painel: .+\/profissional/);
  expectStatus(await client.post(`/api/reservations/${own.token}/cancel`), 200);
  assert.equal(expectStatus(await client.get('/api/client/bookings'), 200)[0].can_cancel, false);
  expectStatus(await client.post('/api/client/auth/logout'), 200);
  expectStatus(await client.get('/api/client/bookings'), 401);
  expectStatus(
    await client.post(
      '/api/client/auth/register',
      clientRegistration({ name: 'Beatriz Souza', email: 'bia@example.com', phone: '11999997777' }),
    ),
    201,
  );
  assert.deepEqual(expectStatus(await client.get('/api/client/bookings'), 200), []);
});

test('signed-in booking identity matches the account and expired cookies cannot create guest bookings', async (t) => {
  const { client, service, app } = await fixture(t);
  expectStatus(await client.post('/api/client/auth/register', clientRegistration()), 201);
  for (const changes of [
    { email: 'other@example.com' },
    { phone: '11999887766' },
    { name: 'Outra Pessoa' },
  ]) {
    expectStatus(
      await client.post('/api/public/studio-marina/bookings', booking(service, changes)),
      409,
    );
  }
  assert.deepEqual(expectStatus(await client.get('/api/appointments'), 200), []);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { name: 'ANA CAROLINA', phone: '+55 (11) 99999-8888' }),
    ),
    201,
  );
  assert.equal(
    expectStatus(await client.get('/api/client/bookings'), 200)[0].client_name,
    'Ana Carolina',
  );
  app.locals.db.prepare('UPDATE client_sessions SET expires=?').run('2026-10-05T07:59:59-03:00');
  expectStatus(await client.get('/api/client/auth/me'), 401);
  expectStatus(
    await client.post(
      '/api/public/studio-marina/bookings',
      booking(service, { start: '2026-10-05T14:00:00-03:00' }),
    ),
    401,
  );
});
