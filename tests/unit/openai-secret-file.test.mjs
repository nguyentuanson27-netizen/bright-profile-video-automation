import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {loadOpenAiResearchConfig} from '../../providers/research/openai.mjs';
import {loadOpenAiGenerationConfig} from '../../providers/generation/openai.mjs';

const datedModel = 'gpt-5-2026-08-07';

const withSecretFile = (body) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-openai-secret-'));
  const file = path.join(directory, 'openai-api-key');
  writeFileSync(file, 'file-secret-key\n', {mode: 0o600});
  try {
    return body({directory, file});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
};

test('OpenAI research and generation configs prefer an absolute mounted secret file when configured', () => withSecretFile(({file}) => {
  const research = loadOpenAiResearchConfig({
    OPENAI_API_KEY: 'env-key-must-not-win',
    OPENAI_API_KEY_FILE: file,
    OPENAI_RESEARCH_MODEL: datedModel,
  });
  const generation = loadOpenAiGenerationConfig({
    OPENAI_API_KEY: 'env-key-must-not-win',
    OPENAI_API_KEY_FILE: file,
    OPENAI_GENERATION_MODEL: datedModel,
  });

  assert.equal(research.apiKey, 'file-secret-key');
  assert.equal(generation.apiKey, 'file-secret-key');
}));

test('OpenAI secret-file configuration rejects relative, missing, empty, and oversized files without leaking file contents', () => withSecretFile(({directory}) => {
  const empty = path.join(directory, 'empty');
  writeFileSync(empty, '');
  const oversized = path.join(directory, 'oversized');
  writeFileSync(oversized, 'sensitive-secret-body'.repeat(5000));

  for (const file of ['relative-secret', path.join(directory, 'missing'), empty, oversized]) {
    assert.throws(
      () => loadOpenAiResearchConfig({OPENAI_API_KEY_FILE: file, OPENAI_RESEARCH_MODEL: datedModel}),
      (error) => error instanceof AppError
        && error.code === 'OPENAI_CONFIG_INVALID'
        && !error.message.includes('sensitive-secret-body'),
    );
  }
}));

test('OpenAI environment secret remains supported when no secret file is configured', () => {
  assert.equal(loadOpenAiResearchConfig({
    OPENAI_API_KEY: 'local-env-key',
    OPENAI_RESEARCH_MODEL: datedModel,
  }).apiKey, 'local-env-key');
  assert.equal(loadOpenAiGenerationConfig({
    OPENAI_API_KEY: 'local-env-key',
    OPENAI_GENERATION_MODEL: datedModel,
  }).apiKey, 'local-env-key');
});
