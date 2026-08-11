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

const fakeClient = (implementation) => ({interactions: {create: implementation}});

const completedSearch = (urls) => ({
  id: 'interaction-1',
  status: 'completed',
  steps: [{
    type: 'model_output',
    content: [{
      type: 'text',
      text: 'Grounded source list',
      annotations: urls.map(({url, title}, index) => ({
        type: 'url_citation',
        url,
        title,
        start_index: index,
        end_index: index + 1,
      })),
    }],
  }],
});

test('Gemini research uses Interactions Google Search and returns deduplicated citation URLs', async () => {
  let request;
  let options;
  const provider = createGeminiResearchProvider({
    client: fakeClient(async (body, requestOptions) => {
      request = body;
      options = requestOptions;
      return completedSearch([
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
  assert.deepEqual(request.tools, [{type: 'google_search'}]);
  assert.equal(request.store, false);
  assert.match(request.input, /Creator profile/);
  assert.match(request.input, /https:\/\/youtube\.com\/@creator/);
  assert.equal(options.timeout_ms, 30_000);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/profile',
    platform: 'example.com',
    title: 'Creator profile',
    sourceType: 'search-result',
    discoveryStatus: 'discovered',
    citation: {title: 'Creator profile', startIndex: 0, endIndex: 1},
  });
  assert.equal('sourceId' in result.candidates[0], false);
});

test('Gemini research maps incomplete/no-results/provider failures to stable non-leaking errors', async () => {
  const incomplete = createGeminiResearchProvider({
    client: fakeClient(async () => ({id: 'i', status: 'in_progress', steps: []})),
    config,
  });
  await assert.rejects(
    () => incomplete.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_INCOMPLETE' && error.retryable === true,
  );

  const empty = createGeminiResearchProvider({
    client: fakeClient(async () => ({id: 'i', status: 'completed', steps: []})),
    config,
  });
  await assert.rejects(
    () => empty.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_NO_RESULTS',
  );

  for (const [providerError, code, retryable] of [
    [Object.assign(new Error('sensitive timeout'), {name: 'RequestTimeoutError'}), 'PROVIDER_TIMEOUT', true],
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
  }), config);

  assert.throws(
    () => loadGeminiResearchConfig({GEMINI_MODEL: 'gemini-3.5-flash-lite'}),
    (error) => error instanceof AppError
      && error.code === 'GEMINI_CONFIG_INVALID'
      && !error.message.includes('secret-key'),
  );
});
