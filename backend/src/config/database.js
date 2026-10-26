import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../../data/agenda.sqlite3', import.meta.url));

// Keep the SQLite schema compatible with existing Python installations.
const schema = `
  CREATE TABLE IF NOT EXISTS professionals (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, phone TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    business TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '',
    auto_approve INTEGER NOT NULL DEFAULT 1, schedule TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Beleza e cuidados', city TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, professional_id INTEGER REFERENCES professionals(id), expires TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resets (
    token TEXT PRIMARY KEY, professional_id INTEGER REFERENCES professionals(id), expires TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT UNIQUE NOT NULL, password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_sessions (
    token TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES client_accounts(id), expires TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id),
    name TEXT NOT NULL, description TEXT NOT NULL, duration INTEGER NOT NULL,
    price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, color TEXT NOT NULL DEFAULT 'sage'
  );
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id),
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, history_token TEXT NOT NULL UNIQUE,
    UNIQUE(professional_id,email), UNIQUE(professional_id,phone)
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id),
    client_id INTEGER NOT NULL REFERENCES clients(id), start TEXT NOT NULL, end TEXT NOT NULL,
    services TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE, notes TEXT NOT NULL DEFAULT '', created TEXT NOT NULL,
    reminded INTEGER NOT NULL DEFAULT 0, account_id INTEGER REFERENCES client_accounts(id)
  );
  CREATE INDEX IF NOT EXISTS appointments_range ON appointments(professional_id,start,end,status);
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id),
    start TEXT NOT NULL, end TEXT NOT NULL, reason TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id),
    recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', created TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
  );
`;

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new TypeError('SQLite transaction callbacks must be synchronous.');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original failure if SQLite already rolled back.
    }
    throw error;
  }
}

export function openDatabase(filename = process.env.DATABASE_PATH || defaultPath) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    transaction(db, () => {
      db.exec(schema);
      const professionalColumns = new Set(
        db
          .prepare('PRAGMA table_info(professionals)')
          .all()
          .map((row) => row.name),
      );
      if (!professionalColumns.has('category')) {
        db.exec(
          "ALTER TABLE professionals ADD COLUMN category TEXT NOT NULL DEFAULT 'Beleza e cuidados'",
        );
      }
      if (!professionalColumns.has('city')) {
        db.exec("ALTER TABLE professionals ADD COLUMN city TEXT NOT NULL DEFAULT ''");
      }
      const appointmentColumns = new Set(
        db
          .prepare('PRAGMA table_info(appointments)')
          .all()
          .map((row) => row.name),
      );
      if (!appointmentColumns.has('account_id')) {
        db.exec(
          'ALTER TABLE appointments ADD COLUMN account_id INTEGER REFERENCES client_accounts(id)',
        );
      }
      db.exec('CREATE INDEX IF NOT EXISTS appointments_account ON appointments(account_id,start)');
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
