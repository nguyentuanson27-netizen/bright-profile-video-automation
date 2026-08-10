import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {hostname} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from './app/config.mjs';
import {createObservability} from './app/observability.mjs';
import {createHealthService, createOperationsHandler} from './app/operations.mjs';
import {createApprovalService} from './app/services/approve-project.mjs';
import {createGenerationProjectService} from './app/services/generate-project.mjs';
import {createMediaIngestService} from './app/services/media-ingest.mjs';
import {createRenderExecutionService} from './app/services/execute-render.mjs';
import {createResearchProjectService} from './app/services/research-project.mjs';
import {createOpenAiGenerationProvider} from './providers/generation/openai.mjs';
import {createOpenAiResearchProvider} from './providers/research/openai.mjs';
import {createArtifactStore} from './storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';
import {createDiskGuard} from './storage/lifecycle.mjs';
import {createProjectStateStore} from './storage/project-state.mjs';
import {createWorkerHandlers} from './worker/handlers.mjs';
import {createJobRunner} from './worker/job-runner.mjs';

const GIB = 1024 ** 3;
const listen = (server, port) => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    server.off('error', onError);
    resolve();
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '0.0.0.0');
});

const close = (server) => new Promise((resolve, reject) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close((error) => error ? reject(error) : resolve());
});

const config = loadConfig();
const db = openDatabase({filename: path.join(config.dataDir, 'app.sqlite')});
migrateDatabase(db);

const repositories = createRepositories(db);
const jobStore = createJobStore(db);
const diskGuard = createDiskGuard({
  dataDir: config.dataDir,
  warningFreePercent: config.diskWarningFreePercent,
  hardFreePercent: config.diskHardFreePercent,
  hardFreeBytes: config.diskHardFreeGiB * GIB,
});
const observability = createObservability({
  queueStats: () => jobStore.stats(),
  diskStatus: () => diskGuard.inspect(),
});
const healthService = createHealthService({db, dataDir: config.dataDir});
const projectStateStore = createProjectStateStore(db);
const rawResearchProvider = createOpenAiResearchProvider();
const rawGenerationProvider = createOpenAiGenerationProvider();
const researchProvider = Object.freeze({
  search: (input) => observability.observeProvider({
    provider: 'openai',
    operation: 'research',
    run: () => rawResearchProvider.search(input),
  }),
});
const generationProvider = Object.freeze({
  generate: (input) => observability.observeProvider({
    provider: 'openai',
    operation: 'generation',
    run: () => rawGenerationProvider.generate(input),
  }),
});
const researchService = createResearchProjectService({repositories, projectStateStore, researchProvider});
const generationService = createGenerationProjectService({repositories, projectStateStore, generationProvider});
const approvalService = createApprovalService({repositories, projectStateStore});
const artifactStore = createArtifactStore({dataDir: config.dataDir, repositories});
const mediaIngestService = createMediaIngestService({repositories, approvalService, artifactStore, diskGuard});
const renderService = createRenderExecutionService({
  repositories,
  projectStateStore,
  approvalService,
  mediaIngestService,
  artifactStore,
  dataDir: config.dataDir,
  observability,
  diskGuard,
});
const handlers = createWorkerHandlers({researchService, generationService, renderService});

let stopping = false;
const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}-${randomUUID()}`;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

const runner = createJobRunner({
  jobStore,
  workerId,
  handlers,
  leaseMs: 30_000,
  shouldStop: () => stopping,
  observability,
});
const opsServer = http.createServer(createOperationsHandler({healthService, observability}));

try {
  await listen(opsServer, config.workerOpsPort);
  observability.log('worker.started', {workerId, status: 'ready'});
  while (!stopping) {
    const result = await runner.runOnce();
    if (!result && !stopping) await delay(500);
  }
} catch (error) {
  observability.log('worker.failed', {
    workerId,
    errorCode: typeof error?.code === 'string' ? error.code : 'WORKER_RUNTIME_FAILED',
  });
  process.exitCode = 1;
} finally {
  try {
    await close(opsServer);
  } catch (error) {
    observability.log('worker.ops_shutdown_failed', {
      workerId,
      errorCode: typeof error?.code === 'string' ? error.code : 'WORKER_OPS_SHUTDOWN_FAILED',
    });
    process.exitCode = 1;
  }
  if (db.open) db.close();
  observability.log('worker.stopped', {workerId});
}
