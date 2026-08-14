import {mkdirSync} from 'node:fs';

import {loadConfig} from './app/config.mjs';
import {createAppServer} from './app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';

const readPort = (value) => {
  const port = value === undefined || value === '' ? 4180 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
};

const config = loadConfig(process.env);
mkdirSync(config.dataDir, {recursive: true});
const db = openDatabase(config.databasePath);
migrateDatabase(db);
const repos = createRepositories(db);
const jobs = createJobStore(db, {
  leaseMs: config.worker.leaseMs,
  defaultMaxAttempts: config.worker.maxRetries + 1,
});
const server = createAppServer({
  db,
  repos,
  jobs,
  dataDir: config.dataDir,
  researchMaxAttempts: config.worker.maxRetries + 1,
  mediaIngestMaxAttempts: config.worker.maxRetries + 1,
});
const port = readPort(process.env.PORT);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    db.close();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.once('close', () => {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
});
server.once('error', (error) => {
  console.error(error?.message ?? 'standalone server failed');
  if (db.open) db.close();
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`bright-profile-api listening on 127.0.0.1:${port}`);
});
