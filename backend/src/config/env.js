import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8000),
  publicUrl: (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 8000}`).replace(
    /\/$/,
    '',
  ),
  environment: process.env.ENVIRONMENT || 'development',
  databasePath: resolve(backendRoot, process.env.DATABASE_PATH || 'data/agenda.sqlite3'),
  frontendDist: resolve(backendRoot, '../frontend/dist'),
};
export const PUBLIC_URL = config.publicUrl;
