import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {loadGeminiResearchConfig} from '../../providers/research/gemini.mjs';
import {loadGeminiGenerationConfig} from '../../providers/generation/gemini.mjs';

const withSecretFile = (body) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-gemini-secret-'));
  const file = path.join(directory, 'gemini-api-key');
  writeFileSync(file, 'file-secret-key\n', {mode: 0o600});
  try {
    return body({directory, file});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
};

test('Gemini research and generation configs prefer an absolute mounted secret file when configured', () => withSecretFile(({file}) => {
  const research = loadGeminiResearchConfig({
    GEMINI_API_KEY: 'env-key-must-not-win',
    GEMINI_API_KEY_FILE: file,
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
  });
  const generation = loadGeminiGenerationConfig({
    GEMINI_API_KEY: 'env-key-must-not-win',
    GEMINI_API_KEY_FILE: file,
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
  });

  assert.equal(research.apiKey, 'file-secret-key');
  assert.equal(generation.apiKey, 'file-secret-key');
}));

test('Gemini secret-file config rejects relative, missing, empty, and oversized files without leaking contents', () => withSecretFile(({directory}) => {
  const empty = path.join(directory, 'empty');
  writeFileSync(empty, '');
  const oversized = path.join(directory, 'oversized');
  writeFileSync(oversized, 'sensitive-secret-body'.repeat(5000));

  for (const file of ['relative-secret', path.join(directory, 'missing'), empty, oversized]) {
    assert.throws(
      () => loadGeminiResearchConfig({GEMINI_API_KEY_FILE: file, GEMINI_MODEL: 'gemini-3.5-flash-lite'}),
      (error) => error instanceof AppError
        && error.code === 'GEMINI_CONFIG_INVALID'
        && !error.message.includes('sensitive-secret-body'),
    );
  }
}));

test('Gemini environment secret remains supported for local development when no secret file is configured', () => {
  assert.equal(loadGeminiResearchConfig({
    GEMINI_API_KEY: 'local-env-key',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
  }).apiKey, 'local-env-key');
  assert.equal(loadGeminiGenerationConfig({
    GEMINI_API_KEY: 'local-env-key',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
  }).apiKey, 'local-env-key');
});
