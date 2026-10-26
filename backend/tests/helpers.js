import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

export const FIXED = '2026-10-05T08:00:00-03:00';

export function professionalRegistration(changes = {}) {
  return {
    name: 'Marina Almeida',
    email: 'marina@example.com',
    phone: '11987654321',
    password: 'Agenda@123',
    business: 'Studio Marina',
    slug: 'studio-marina',
    ...changes,
  };
}

export function clientRegistration(changes = {}) {
  return {
    name: 'Ana Carolina',
    email: 'ana@example.com',
    phone: '11999998888',
    password: 'Cliente@123',
    ...changes,
  };
}

export function booking(service, changes = {}) {
  return {
    name: 'Ana Carolina',
    email: 'ana@example.com',
    phone: '11999998888',
    service_ids: [service.id],
    start: '2026-10-05T10:00:00-03:00',
    ...changes,
  };
}

export class ApiClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async request(method, path, data, headers = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, data: body, text, headers: response.headers };
  }

  get(path, headers) {
    return this.request('GET', path, undefined, headers);
  }
  post(path, data, headers) {
    return this.request('POST', path, data, headers);
  }
  put(path, data, headers) {
    return this.request('PUT', path, data, headers);
  }
  patch(path, data, headers) {
    return this.request('PATCH', path, data, headers);
  }
  delete(path, headers) {
    return this.request('DELETE', path, undefined, headers);
  }
}

export function expectStatus(response, status) {
  assert.equal(response.status, status, response.text);
  return response.data;
}

export async function application(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agenda-express-'));
  let current = new Date(FIXED);
  const databasePath = options.databasePath ?? join(directory, 'test.sqlite3');
  const app = createApp({ databasePath, clock: () => new Date(current), startWorker: false });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.locals.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    databasePath,
    client: new ApiClient(`http://127.0.0.1:${server.address().port}`),
    setClock: (value) => {
      current = new Date(value);
    },
  };
}

export async function fixture(t) {
  const system = await application(t);
  system.professional = expectStatus(
    await system.client.post('/api/auth/register', professionalRegistration()),
    201,
  );
  system.service = expectStatus(
    await system.client.post('/api/services', {
      name: 'Consulta',
      description: 'Atendimento inicial',
      duration: 60,
      price: 100,
      color: 'sage',
    }),
    201,
  );
  return system;
}
