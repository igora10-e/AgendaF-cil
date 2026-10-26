/** Explicit demo population; run only against a development database. */
import { openDatabase } from './config/database.js';
import { config } from './config/env.js';
import { seed } from './models/seed.js';

const db = openDatabase(config.databasePath);
try {
  console.log(seed(db));
} finally {
  db.close();
}
