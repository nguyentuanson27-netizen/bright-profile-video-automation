import {join, resolve} from 'node:path';

const DEFAULTS = Object.freeze({
  dataDir: './data',
  workerLeaseMs: 30000,
  workerMaxRetries: 3,
  fetchTimeoutMs: 15000,
  fetchMaxBytes: 25 * 1024 * 1024,
  fetchMaxRedirects: 5,
  openaiResearchModel: 'gpt-5',
  openaiGenerationModel: 'gpt-5',
  openaiTimeoutMs: 60000,
  openaiMaxRetries: 2,
});

const readInteger = (env, name, fallback, {min = 0} = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
};

const readRequiredText = (env, name, fallback) => {
  const value = env[name] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
};

export const loadConfig = (env = process.env, {cwd = process.cwd()} = {}) => {
  const dataDir = resolve(cwd, readRequiredText(env, 'BRIGHT_DATA_DIR', DEFAULTS.dataDir));
  const databasePath = resolve(
    cwd,
    env.BRIGHT_DATABASE_PATH?.trim() || join(dataDir, 'bright-profile.sqlite'),
  );

  return Object.freeze({
    dataDir,
    databasePath,
    worker: Object.freeze({
      leaseMs: readInteger(env, 'WORKER_LEASE_MS', DEFAULTS.workerLeaseMs, {min: 1}),
      maxRetries: readInteger(env, 'WORKER_MAX_RETRIES', DEFAULTS.workerMaxRetries, {min: 0}),
    }),
    fetch: Object.freeze({
      timeoutMs: readInteger(env, 'FETCH_TIMEOUT_MS', DEFAULTS.fetchTimeoutMs, {min: 1}),
      maxBytes: readInteger(env, 'FETCH_MAX_BYTES', DEFAULTS.fetchMaxBytes, {min: 1}),
      maxRedirects: readInteger(env, 'FETCH_MAX_REDIRECTS', DEFAULTS.fetchMaxRedirects, {min: 0}),
    }),
    openai: Object.freeze({
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      researchModel: readRequiredText(env, 'OPENAI_RESEARCH_MODEL', DEFAULTS.openaiResearchModel),
      generationModel: readRequiredText(env, 'OPENAI_GENERATION_MODEL', DEFAULTS.openaiGenerationModel),
      timeoutMs: readInteger(env, 'OPENAI_API_TIMEOUT_MS', DEFAULTS.openaiTimeoutMs, {min: 1}),
      maxRetries: readInteger(env, 'OPENAI_API_MAX_RETRIES', DEFAULTS.openaiMaxRetries, {min: 0}),
    }),
  });
};
