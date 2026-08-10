import http from 'node:http';
import path from 'node:path';
import {loadConfig} from './app/config.mjs';
import {createHttpHandler} from './app/http/router.mjs';
import {createObservability} from './app/observability.mjs';
import {createHealthService} from './app/operations.mjs';
import {createApprovalService} from './app/services/approve-project.mjs';
import {createGenerationProjectService} from './app/services/generate-project.mjs';
import {createMediaIngestService} from './app/services/media-ingest.mjs';
import {createRenderExecutionService} from './app/services/execute-render.mjs';
import {createResearchProjectService} from './app/services/research-project.mjs';
import {probeVideoDuration} from './lib/media-probe.mjs';
import {createOpenAiGenerationProvider} from './providers/generation/openai.mjs';
import {createOpenAiResearchProvider} from './providers/research/openai.mjs';
import {createArtifactStore} from './storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';
import {createDiskGuard} from './storage/lifecycle.mjs';
import {createProjectStateStore} from './storage/project-state.mjs';

const GIB = 1024 ** 3;
const config = loadConfig();
const databasePath = path.join(config.dataDir, 'app.sqlite');
const db = openDatabase({filename: databasePath});
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
const researchProvider = createOpenAiResearchProvider();
const generationProvider = createOpenAiGenerationProvider();
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
  diskGuard,
});

const server = http.createServer(createHttpHandler({
  repositories,
  researchService,
  generationService,
  approvalService,
  renderService,
  artifactStore,
  videoProbe: probeVideoDuration,
  healthService,
  observability,
  maxBodyBytes: config.maxBodyBytes,
}));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => {
    try {
      if (db.open) db.close();
    } finally {
      if (error) {
        observability.log('app.shutdown_failed');
        process.exitCode = 1;
      }
    }
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(config.port, '0.0.0.0', () => {
  observability.log('app.started', {status: 'ready'});
});
