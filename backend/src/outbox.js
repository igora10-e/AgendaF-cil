/** Read local notification and recovery messages from the trusted server. */
import { openDatabase } from './config/database.js';
import { config } from './config/env.js';

const db = openDatabase(config.databasePath);
try {
  for (const n of db
    .prepare('SELECT recipient,subject,body,status FROM notifications ORDER BY id DESC LIMIT 20')
    .all()) {
    console.log(
      `\nPara: ${n.recipient}\nAssunto: ${n.subject}\nEstado: ${n.status}\n\n${n.body}\n`,
    );
  }
} finally {
  db.close();
}
