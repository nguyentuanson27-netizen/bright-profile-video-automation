import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadConfig} from './app/config.mjs';
import {createGenerationService, createGenerationStageHandler} from './app/services/generate-project.mjs';
import {createMediaIngestService, createMediaIngestStageHandler} from './app/services/ingest-media.mjs';
import {createRenderStageHandler, createTtsStageHandler} from './app/services/execute-render.mjs';
import {createResearchService, createResearchStageHandler} from './app/services/research-project.mjs';
import {createOpenAIGenerationProvider} from './providers/generation/openai.mjs';
import {createOpenAIResearchProvider} from './providers/research/openai.mjs';
import {createSafeFetcher} from './security/safe-fetch.mjs';
import {createArtifactStore} from './storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';
import {createJobRunner} from './worker/job-runner.mjs';

const createDeferredProvider = (factory, method) => {
  let provider;
  return Object.freeze({
    async [method](...args) {
      // Imported ChatGPT drafts bypass research/generation and still need this worker for rendering.
      provider ??= factory();
      return provider[method](...args);
    },
  });
};

export const createDefaultWorkerHandlers = ({
  config,
  db,
  repos,
  provider,
  researchProvider,
  generationProvider,
  mediaFetcher,
  ttsGenerator,
  renderer,
  renderProbe,
} = {}) => {
  const resolvedResearchProvider = researchProvider ?? provider ?? createDeferredProvider(
    () => createOpenAIResearchProvider({
      apiKey: config.openai.apiKey,
      model: config.openai.researchModel,
      timeoutMs: config.openai.timeoutMs,
      maxRetries: config.openai.maxRetries,
    }),
    'research',
  );
  const resolvedGenerationProvider = generationProvider ?? createDeferredProvider(
    () => createOpenAIGenerationProvider({
      apiKey: config.openai.apiKey,
      model: config.openai.generationModel,
      timeoutMs: config.openai.timeoutMs,
      maxRetries: config.openai.maxRetries,
    }),
    'generate',
  );
  const researchService = createResearchService({
    provider: resolvedResearchProvider,
    fetchOptions: config.fetch,
  });
  const generationService = createGenerationService({provider: resolvedGenerationProvider});
  const artifactStore = createArtifactStore(db);
  const mediaService = createMediaIngestService({
    fetcher: mediaFetcher ?? createSafeFetcher(),
    dataDir: config.dataDir,
    fetchOptions: config.fetch,
  });
  const nextMaxAttempts = config.worker.maxRetries + 1;
  return Object.freeze({
    research: createResearchStageHandler({repos, researchService}),
    generation: createGenerationStageHandler({repos, generationService}),
    media_ingest: createMediaIngestStageHandler({repos, artifactStore, service: mediaService, nextMaxAttempts}),
    tts: createTtsStageHandler({
      repos,
      artifactStore,
      dataDir: config.dataDir,
      ...(ttsGenerator ? {generateTts: ttsGenerator} : {}),
      nextMaxAttempts,
    }),
    render: createRenderStageHandler({
      repos,
      artifactStore,
      dataDir: config.dataDir,
      ...(renderer ? {renderer} : {}),
      ...(renderProbe ? {probe: renderProbe} : {}),
    }),
  });
};

export const runWorker = async ({
  handlers,
  provider,
  researchProvider,
  generationProvider,
  mediaFetcher,
  ttsGenerator,
  renderer,
  renderProbe,
  env = process.env,
} = {}) => {
  const config = loadConfig(env);
  const db = openDatabase(config.databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {
    leaseMs: config.worker.leaseMs,
    defaultMaxAttempts: config.worker.maxRetries + 1,
  });

  let resolvedHandlers = handlers;
  if (resolvedHandlers === undefined) {
    resolvedHandlers = createDefaultWorkerHandlers({
      config,
      db,
      repos,
      provider,
      researchProvider,
      generationProvider,
      mediaFetcher,
      ttsGenerator,
      renderer,
      renderProbe,
    });
  }

  const runner = createJobRunner({
    jobs,
    workerId: `worker-${randomUUID()}`,
    handlers: resolvedHandlers,
    leaseMs: config.worker.leaseMs,
  });
  const controller = new AbortController();
  const stop = () => {
    runner.stop();
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runner.run({signal: controller.signal});
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    db.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch((error) => {
    console.error(error?.message ?? 'worker failed');
    process.exitCode = 1;
  });
}
