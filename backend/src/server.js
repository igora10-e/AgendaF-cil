import { createApp } from './app.js';
import { config } from './config/env.js';

const app = createApp({ startWorker: true });
const server = app.listen(config.port, config.host, () =>
  console.log(`Agenda Fácil (Node.js + Express): http://${config.host}:${config.port}`),
);
server.on('error', async (error) => {
  console.error(`Não foi possível iniciar o servidor: ${error.code || error.message}`);
  await app.locals.close();
  process.exitCode = 1;
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await app.locals.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
