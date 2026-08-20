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

const MAXIMUMS = Object.freeze({
  workerLeaseMs: 10 * 60 * 1000,
  workerMaxRetries: 10,
  fetchTimeoutMs: 2 * 60 * 1000,
  fetchMaxBytes: 256 * 1024 * 1024,
  fetchMaxRedirects: 10,
  openaiTimeoutMs: 10 * 60 * 1000,
  openaiMaxRetries: 5,
});

const readInteger = (env, name, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
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
      leaseMs: readInteger(env, 'WORKER_LEASE_MS', DEFAULTS.workerLeaseMs, {min: 2, max: MAXIMUMS.workerLeaseMs}),
      maxRetries: readInteger(env, 'WORKER_MAX_RETRIES', DEFAULTS.workerMaxRetries, {min: 0, max: MAXIMUMS.workerMaxRetries}),
    }),
    fetch: Object.freeze({
      timeoutMs: readInteger(env, 'FETCH_TIMEOUT_MS', DEFAULTS.fetchTimeoutMs, {min: 1, max: MAXIMUMS.fetchTimeoutMs}),
      maxBytes: readInteger(env, 'FETCH_MAX_BYTES', DEFAULTS.fetchMaxBytes, {min: 1, max: MAXIMUMS.fetchMaxBytes}),
      maxRedirects: readInteger(env, 'FETCH_MAX_REDIRECTS', DEFAULTS.fetchMaxRedirects, {min: 0, max: MAXIMUMS.fetchMaxRedirects}),
    }),
    openai: Object.freeze({
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      researchModel: readRequiredText(env, 'OPENAI_RESEARCH_MODEL', DEFAULTS.openaiResearchModel),
      generationModel: readRequiredText(env, 'OPENAI_GENERATION_MODEL', DEFAULTS.openaiGenerationModel),
      timeoutMs: readInteger(env, 'OPENAI_API_TIMEOUT_MS', DEFAULTS.openaiTimeoutMs, {min: 1, max: MAXIMUMS.openaiTimeoutMs}),
      maxRetries: readInteger(env, 'OPENAI_API_MAX_RETRIES', DEFAULTS.openaiMaxRetries, {min: 0, max: MAXIMUMS.openaiMaxRetries}),
    }),
    integration: Object.freeze({
      serviceToken: env.BRIGHT_INTEGRATION_TOKEN?.trim() || undefined,
      backendUrl: env.BRIGHT_BACKEND_URL?.trim() || 'http://127.0.0.1:4180',
      allowedHosts: env.BRIGHT_ALLOWED_INTEGRATION_HOSTS?.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) || ['127.0.0.1', 'localhost', 'app', '::1', '[::1]'],
    }),
  });
};
