import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../domain/errors.mjs';
import {
  createGeminiResearchProvider,
  loadGeminiResearchConfig,
} from '../../providers/research/gemini.mjs';

const config = {
  apiKey: 'test-key',
  model: 'gemini-3.5-flash-lite',
  timeoutMs: 30_000,
};

const fakeClient = (implementation) => ({models: {generateContent: implementation}});

const groundedResponse = (sources) => ({
  text: 'Grounded source list',
  candidates: [{
    groundingMetadata: {
      groundingChunks: sources.map(({url, title}) => ({web: {uri: url, title}})),
    },
  }],
});

test('Gemini research uses generateContent Google Search and returns deduplicated grounding URLs', async () => {
  let request;
  const provider = createGeminiResearchProvider({
    client: fakeClient(async (body) => {
      request = body;
      return groundedResponse([
        {url: 'https://example.com/profile', title: 'Creator profile'},
        {url: 'https://youtube.com/watch?v=abc', title: 'Video'},
        {url: 'https://example.com/profile', title: 'Creator profile'},
      ]);
    }),
    config,
  });

  const result = await provider.search({
    topic: 'Creator profile',
    sourceUrls: ['https://youtube.com/@creator'],
  });

  assert.equal(request.model, 'gemini-3.5-flash-lite');
  assert.match(request.contents, /Creator profile/);
  assert.match(request.contents, /https:\/\/youtube\.com\/@creator/);
  assert.deepEqual(request.config.tools, [{googleSearch: {}}]);
  assert.deepEqual(request.config.httpOptions, {timeout: 30_000});
  assert.equal(request.config.temperature, undefined);
  assert.equal(request.config.topP, undefined);
  assert.equal(request.config.topK, undefined);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/profile',
    platform: 'example.com',
    title: 'Creator profile',
    sourceType: 'search-result',
    discoveryStatus: 'discovered',
  });
  assert.equal('sourceId' in result.candidates[0], false);
});

test('Gemini research rejects blocked and empty grounded responses', async () => {
  const blocked = createGeminiResearchProvider({
    client: fakeClient(async () => ({
      text: '',
      promptFeedback: {blockReason: 'SAFETY'},
      candidates: [],
    })),
    config,
  });
  await assert.rejects(
    () => blocked.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_REFUSAL' && error.retryable === false,
  );

  const empty = createGeminiResearchProvider({
    client: fakeClient(async () => ({text: 'No grounded sources', candidates: [{}]})),
    config,
  });
  await assert.rejects(
    () => empty.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_NO_RESULTS',
  );
});

test('Gemini research maps timeout, connection, rate-limit and provider failures without leaking details', async () => {
  for (const [providerError, code, retryable] of [
    [Object.assign(new Error('sensitive timeout'), {name: 'RequestTimeoutError'}), 'PROVIDER_TIMEOUT', true],
    [Object.assign(new Error('sensitive connection'), {name: 'ConnectionError'}), 'PROVIDER_TEMPORARY_FAILURE', true],
    [Object.assign(new Error('sensitive rate'), {status: 429}), 'PROVIDER_RATE_LIMITED', true],
    [Object.assign(new Error('sensitive server'), {status: 503}), 'PROVIDER_TEMPORARY_FAILURE', true],
    [Object.assign(new Error('sensitive auth'), {status: 401}), 'PROVIDER_FAILURE', false],
  ]) {
    const provider = createGeminiResearchProvider({
      client: fakeClient(async () => { throw providerError; }),
      config,
    });
    await assert.rejects(
      () => provider.search({topic: 'Creator'}),
      (error) => error instanceof AppError
        && error.code === code
        && error.retryable === retryable
        && !error.message.includes('sensitive'),
    );
  }
});

test('Gemini research config uses file/env secret and stable Gemini model without leaking secret', () => {
  assert.deepEqual(loadGeminiResearchConfig({
    GEMINI_API_KEY: 'secret-key',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_TIMEOUT_MS: '30000',
  }), {...config, apiKey: 'secret-key'});

  assert.throws(
    () => loadGeminiResearchConfig({GEMINI_MODEL: 'gemini-3.5-flash-lite'}),
    (error) => error instanceof AppError
      && error.code === 'GEMINI_CONFIG_INVALID'
      && !error.message.includes('secret-key'),
  );
});
