import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from './app/config.mjs';
import {createApprovalService} from './app/services/approve-project.mjs';
import {createMediaIngestService} from './app/services/media-ingest.mjs';
import {createRenderExecutionService} from './app/services/execute-render.mjs';
import {createArtifactStore} from './storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';
import {createProjectStateStore} from './storage/project-state.mjs';
import {createJobRunner} from './worker/job-runner.mjs';

const config = loadConfig();
const db = openDatabase({filename: path.join(config.dataDir, 'app.sqlite')});
migrateDatabase(db);

const repositories = createRepositories(db);
const projectStateStore = createProjectStateStore(db);
const approvalService = createApprovalService({repositories, projectStateStore});
const artifactStore = createArtifactStore({dataDir: config.dataDir, repositories});
const mediaIngestService = createMediaIngestService({repositories, approvalService, artifactStore});
const renderService = createRenderExecutionService({
  repositories,
  projectStateStore,
  approvalService,
  mediaIngestService,
  artifactStore,
  dataDir: config.dataDir,
});
const jobStore = createJobStore(db);

let stopping = false;
const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}-${randomUUID()}`;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

const runner = createJobRunner({
  jobStore,
  workerId,
  handlers: {rendering: renderService.handleJob},
  leaseMs: 30_000,
  shouldStop: () => stopping,
});

console.log(JSON.stringify({event: 'worker.started', workerId}));
try {
  while (!stopping) {
    const result = await runner.runOnce();
    if (!result && !stopping) await delay(500);
  }
} finally {
  if (db.open) db.close();
  console.log(JSON.stringify({event: 'worker.stopped', workerId}));
}
