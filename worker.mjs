import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadConfig} from './app/config.mjs';
import {createGenerationService, createGenerationStageHandler} from './app/services/generate-project.mjs';
import {createResearchService, createResearchStageHandler} from './app/services/research-project.mjs';
import {createOpenAIGenerationProvider} from './providers/generation/openai.mjs';
import {createOpenAIResearchProvider} from './providers/research/openai.mjs';
import {openDatabase, migrateDatabase, createRepositories} from './storage/db.mjs';
import {createJobStore} from './storage/jobs.mjs';
import {createJobRunner} from './worker/job-runner.mjs';

export const runWorker = async ({handlers, provider, researchProvider, generationProvider, env = process.env} = {}) => {
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
    const resolvedResearchProvider = researchProvider ?? provider ?? createOpenAIResearchProvider({
      apiKey: config.openai.apiKey,
      model: config.openai.researchModel,
      timeoutMs: config.openai.timeoutMs,
      maxRetries: config.openai.maxRetries,
    });
    const resolvedGenerationProvider = generationProvider ?? createOpenAIGenerationProvider({
      apiKey: config.openai.apiKey,
      model: config.openai.generationModel,
      timeoutMs: config.openai.timeoutMs,
      maxRetries: config.openai.maxRetries,
    });
    const researchService = createResearchService({
      provider: resolvedResearchProvider,
      fetchOptions: config.fetch,
    });
    const generationService = createGenerationService({provider: resolvedGenerationProvider});
    resolvedHandlers = {
      research: createResearchStageHandler({repos, researchService}),
      generation: createGenerationStageHandler({repos, generationService}),
    };
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
