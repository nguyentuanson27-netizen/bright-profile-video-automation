import path from 'node:path';

export class ConfigError extends Error {
  constructor(key, expectation) {
    super(`${key} ${expectation}`);
    this.name = 'ConfigError';
    this.key = key;
  }
}

const integer = (env, key, fallback, {min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER} = {}) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(key, `must be an integer between ${min} and ${max}`);
  }
  return value;
};

const boolean = (env, key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(key, 'must be either true or false');
};

const absolutePath = (env, key, fallback) => {
  const value = env[key] || fallback;
  if (!path.isAbsolute(value)) throw new ConfigError(key, 'must be an absolute path');
  return path.normalize(value);
};

export function loadConfig(env = process.env) {
  const diskWarningFreePercent = integer(env, 'DISK_WARNING_FREE_PERCENT', 25, {min: 1, max: 100});
  const diskHardFreePercent = integer(env, 'DISK_HARD_FREE_PERCENT', 15, {min: 1, max: 100});
  if (diskHardFreePercent > diskWarningFreePercent) {
    throw new ConfigError('DISK_HARD_FREE_PERCENT', 'must be less than or equal to DISK_WARNING_FREE_PERCENT');
  }

  return Object.freeze({
    port: integer(env, 'PORT', 4180, {min: 1, max: 65535}),
    workerOpsPort: integer(env, 'WORKER_OPS_PORT', 4181, {min: 1, max: 65535}),
    dataDir: absolutePath(env, 'DATA_DIR', '/app/data'),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 10 * 1024 * 1024, {min: 1, max: 100 * 1024 * 1024}),
    allowPrivateMediaUrls: boolean(env, 'ALLOW_PRIVATE_MEDIA_URLS', false),
    completedArtifactRetentionDays: integer(env, 'COMPLETED_ARTIFACT_RETENTION_DAYS', 30, {min: 1, max: 3650}),
    transientArtifactRetentionDays: integer(env, 'TRANSIENT_ARTIFACT_RETENTION_DAYS', 7, {min: 1, max: 3650}),
    diskWarningFreePercent,
    diskHardFreePercent,
    diskHardFreeGiB: integer(env, 'DISK_HARD_FREE_GIB', 20, {min: 1, max: 1024 * 1024}),
  });
}
