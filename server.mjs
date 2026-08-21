import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

import {loadConfig} from './app/config.mjs';
import {createAppServer} from './app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from './storage/db.mjs';
import {createArtifactStore} from './storage/artifacts.mjs';
import {createJobStore} from './storage/jobs.mjs';

const readPort = (value) => {
  const port = value === undefined || value === '' ? 4180 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
};

const readBindHost = (value) => {
  const host = value?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) {
    throw new Error('BRIGHT_BIND_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
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
const artifactStore = createArtifactStore(db);
const server = createAppServer({
  db,
  repos,
  jobs,
  artifactStore,
  dataDir: config.dataDir,
  webDir: resolve(process.env.BRIGHT_WEB_DIR?.trim() || './dist'),
  integrationToken: config.integration.serviceToken,
  downloadSigningSecret: config.integration.downloadSigningSecret,
  allowedIntegrationHosts: config.integration.allowedHosts,
  researchMaxAttempts: config.worker.maxRetries + 1,
  generationMaxAttempts: config.worker.maxRetries + 1,
  mediaIngestMaxAttempts: config.worker.maxRetries + 1,
  maxActiveProjects: config.integration.chatgptMaxActiveProjects,
});
const port = readPort(process.env.PORT);
const bindHost = readBindHost(process.env.BRIGHT_BIND_HOST);

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

server.listen(port, bindHost, () => {
  console.log(`bright-profile-api listening on ${bindHost}:${port}`);
});
