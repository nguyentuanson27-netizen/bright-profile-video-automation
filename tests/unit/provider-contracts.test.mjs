import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../domain/errors.mjs';
import {createResearchProvider} from '../../providers/research/index.mjs';
import {createGenerationProvider} from '../../providers/generation/index.mjs';
import {createFakeGenerationProvider, createFakeResearchProvider} from '../fakes/providers.mjs';

const source = {
  sourceId: 'source-1',
  url: 'https://example.com/creator',
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Creator public profile excerpt.',
  sourceType: 'page',
};

const generation = {
  researchSummary: 'Summary grounded in stored sources.',
  claims: [{id: 'claim-1', text: 'Supported claim.', sourceIds: ['source-1'], status: 'supported'}],
  script: 'A short profile script.',
  voiceover: {chunks: [{id: 'hero', start: 0, duration: 6, text: 'Opening.'}]},
  project: {
    duration: 6,
    creatorName: 'Creator',
    scenes: [{id: 'hero', type: 'hero', start: 0, duration: 6}],
  },
};

test('research provider contract returns source candidates without source IDs or factual claims', async () => {
  const provider = createResearchProvider({
    search: async () => ({
      candidates: [{
        url: 'https://www.youtube.com/watch?v=abc',
        platform: 'youtube',
        title: 'Creator interview',
        sourceType: 'search-result',
        discoveryStatus: 'discovered',
      }],
    }),
  });

  const result = await provider.search({topic: 'Creator profile'});
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://www.youtube.com/watch?v=abc');
  assert.equal('sourceId' in result.candidates[0], false);
  assert.equal('claims' in result, false);
});

test('research provider contract rejects malformed or privileged candidate fields', async () => {
  const provider = createResearchProvider({
    search: async () => ({
      candidates: [{
        url: 'file:///etc/passwd',
        platform: 'local',
        sourceType: 'search-result',
        discoveryStatus: 'discovered',
        sourceId: 'provider-invented',
      }],
    }),
  });

  await assert.rejects(
    () => provider.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_OUTPUT_INVALID',
  );
});

test('generation provider validates normalized source input and shared generation output', async () => {
  const provider = createGenerationProvider({generate: async () => generation});
  const result = await provider.generate({topic: 'Creator', sources: [source]});
  assert.deepEqual(result, generation);
});

test('generation provider rejects unknown source references from provider output', async () => {
  const invalid = structuredClone(generation);
  invalid.claims[0].sourceIds = ['provider-invented'];
  const provider = createGenerationProvider({generate: async () => invalid});

  await assert.rejects(
    () => provider.generate({topic: 'Creator', sources: [source]}),
    (error) => error instanceof AppError && error.code === 'UNKNOWN_SOURCE_REFERENCE',
  );
});

test('fake research provider deterministically simulates success and inaccessible discovery', async () => {
  const success = createFakeResearchProvider({mode: 'success'});
  const found = await success.search({topic: 'Creator'});
  assert.equal(found.candidates[0].discoveryStatus, 'discovered');

  const inaccessible = createFakeResearchProvider({mode: 'inaccessible'});
  const unavailable = await inaccessible.search({topic: 'Creator'});
  assert.equal(unavailable.candidates[0].discoveryStatus, 'unavailable');
});

test('fake providers deterministically classify timeout, rate-limit, retryable, and fatal failures', async () => {
  for (const [mode, code, retryable] of [
    ['timeout', 'PROVIDER_TIMEOUT', true],
    ['rate-limit', 'PROVIDER_RATE_LIMITED', true],
    ['retryable-error', 'PROVIDER_TEMPORARY_FAILURE', true],
    ['fatal-error', 'PROVIDER_FAILURE', false],
  ]) {
    const provider = createFakeResearchProvider({mode});
    await assert.rejects(
      () => provider.search({topic: 'Creator'}),
      (error) => error instanceof AppError && error.code === code && error.retryable === retryable,
    );
  }
});

test('fake generation provider can return malformed output for downstream rejection', async () => {
  const provider = createFakeGenerationProvider({mode: 'malformed'});
  await assert.rejects(
    () => provider.generate({topic: 'Creator', sources: [source]}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_OUTPUT_INVALID',
  );
});

test('fake generation provider produces deterministic valid output linked to supplied sources', async () => {
  const provider = createFakeGenerationProvider({mode: 'success'});
  const result = await provider.generate({topic: 'Creator', sources: [source]});
  assert.equal(result.claims[0].sourceIds[0], 'source-1');
  assert.equal(result.project.scenes[0].type, 'hero');
});
