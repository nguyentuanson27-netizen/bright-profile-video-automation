import test from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {loadConfig} from '../../app/config.mjs';

const baseEnv = {
  BRIGHT_DATA_DIR: './var/bright',
  WORKER_LEASE_MS: '45000',
  WORKER_MAX_RETRIES: '4',
  FETCH_TIMEOUT_MS: '12000',
  FETCH_MAX_BYTES: '8388608',
  FETCH_MAX_REDIRECTS: '4',
  OPENAI_RESEARCH_MODEL: 'gpt-5',
  OPENAI_GENERATION_MODEL: 'gpt-5',
  OPENAI_API_TIMEOUT_MS: '60000',
  OPENAI_API_MAX_RETRIES: '2',
  OPENAI_API_KEY: 'sk-test-secret',
};

test('loadConfig normalizes standalone paths and numeric runtime bounds', () => {
  const config = loadConfig(baseEnv, {cwd: '/workspace'});
  assert.equal(config.dataDir, resolve('/workspace', './var/bright'));
  assert.equal(config.databasePath, join(config.dataDir, 'bright-profile.sqlite'));
  assert.deepEqual(config.worker, {leaseMs: 45000, maxRetries: 4});
  assert.deepEqual(config.fetch, {timeoutMs: 12000, maxBytes: 8388608, maxRedirects: 4});
  assert.deepEqual(config.openai, {
    apiKey: 'sk-test-secret',
    researchModel: 'gpt-5',
    generationModel: 'gpt-5',
    timeoutMs: 60000,
    maxRetries: 2,
  });
});

test('loadConfig accepts an explicit database path relative to cwd', () => {
  const config = loadConfig({...baseEnv, BRIGHT_DATABASE_PATH: './state/app.sqlite'}, {cwd: '/workspace'});
  assert.equal(config.databasePath, '/workspace/state/app.sqlite');
});

test('loadConfig rejects malformed or unsafe runtime bounds', () => {
  for (const [key, value] of [
    ['WORKER_LEASE_MS', '0'],
    ['WORKER_MAX_RETRIES', '-1'],
    ['FETCH_TIMEOUT_MS', 'NaN'],
    ['FETCH_MAX_BYTES', '0'],
    ['FETCH_MAX_REDIRECTS', '-1'],
    ['OPENAI_API_TIMEOUT_MS', '1.5'],
    ['OPENAI_API_MAX_RETRIES', '-1'],
  ]) {
    assert.throws(() => loadConfig({...baseEnv, [key]: value}), new RegExp(key));
  }
});

test('loadConfig rejects missing model names and does not log API secrets', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const seen = [];
  console.log = (...args) => seen.push(args.join(' '));
  console.error = (...args) => seen.push(args.join(' '));
  try {
    assert.throws(() => loadConfig({...baseEnv, OPENAI_RESEARCH_MODEL: '   '}), /OPENAI_RESEARCH_MODEL/);
    loadConfig(baseEnv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(seen.join('\n').includes('sk-test-secret'), false);
});
