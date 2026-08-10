import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../domain/errors.mjs';
import {
  createOpenAiResearchProvider,
  loadOpenAiResearchConfig,
} from '../../providers/research/openai.mjs';

const config = {
  apiKey: 'test-key',
  model: 'gpt-5-2026-08-07',
  timeoutMs: 30_000,
  maxRetries: 2,
};

const fakeClient = (implementation) => ({responses: {create: implementation}});

test('OpenAI research adapter uses Responses web search and extracts deduplicated discovery sources', async () => {
  let request;
  const client = fakeClient(async (body) => {
    request = body;
    return {
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            queries: ['Creator profile'],
            sources: [
              {type: 'url', url: 'https://example.com/profile'},
              {type: 'url', url: 'https://youtube.com/watch?v=abc'},
            ],
          },
        },
        {
          type: 'message',
          status: 'completed',
          content: [{
            type: 'output_text',
            text: 'Sources',
            annotations: [{
              type: 'url_citation',
              url: 'https://example.com/profile',
              title: 'Creator profile',
              start_index: 0,
              end_index: 7,
            }],
          }],
        },
      ],
    };
  });
  const provider = createOpenAiResearchProvider({client, config});

  const result = await provider.search({topic: 'Creator profile'});

  assert.equal(request.model, config.model);
  assert.deepEqual(request.tools, [{type: 'web_search'}]);
  assert.deepEqual(request.include, ['web_search_call.action.sources']);
  assert.equal(request.store, false);
  assert.match(request.input, /Creator profile/);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0], {
    url: 'https://example.com/profile',
    platform: 'example.com',
    title: 'Creator profile',
    sourceType: 'search-result',
    discoveryStatus: 'discovered',
    citation: {title: 'Creator profile', startIndex: 0, endIndex: 7},
  });
  assert.equal('sourceId' in result.candidates[0], false);
});

test('OpenAI research adapter includes operator URLs only as discovery hints and never returns invented source IDs', async () => {
  let request;
  const client = fakeClient(async (body) => {
    request = body;
    return {
      status: 'completed',
      output: [{
        type: 'web_search_call',
        status: 'completed',
        action: {type: 'search', sources: [{type: 'url', url: 'https://example.org/result'}]},
      }],
    };
  });
  const provider = createOpenAiResearchProvider({client, config});
  const result = await provider.search({
    topic: 'Creator',
    sourceUrls: ['https://youtube.com/@creator'],
  });

  assert.match(request.input, /https:\/\/youtube\.com\/@creator/);
  assert.equal('sourceId' in result.candidates[0], false);
});

test('OpenAI research adapter maps incomplete and no-source responses to stable errors', async () => {
  const incomplete = createOpenAiResearchProvider({
    client: fakeClient(async () => ({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, output: []})),
    config,
  });
  await assert.rejects(
    () => incomplete.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_INCOMPLETE' && error.retryable === true,
  );

  const empty = createOpenAiResearchProvider({
    client: fakeClient(async () => ({status: 'completed', output: []})),
    config,
  });
  await assert.rejects(
    () => empty.search({topic: 'Creator'}),
    (error) => error instanceof AppError && error.code === 'PROVIDER_NO_RESULTS' && error.retryable === false,
  );
});

test('OpenAI research adapter classifies timeout, rate limit, transient and fatal provider failures without leaking messages', async () => {
  for (const [error, code, retryable] of [
    [Object.assign(new Error('sensitive timeout body'), {name: 'APIConnectionTimeoutError'}), 'PROVIDER_TIMEOUT', true],
    [Object.assign(new Error('sensitive rate body'), {status: 429}), 'PROVIDER_RATE_LIMITED', true],
    [Object.assign(new Error('sensitive server body'), {status: 503}), 'PROVIDER_TEMPORARY_FAILURE', true],
    [Object.assign(new Error('sensitive auth body'), {status: 401}), 'PROVIDER_FAILURE', false],
  ]) {
    const provider = createOpenAiResearchProvider({
      client: fakeClient(async () => { throw error; }),
      config,
    });
    await assert.rejects(
      () => provider.search({topic: 'Creator'}),
      (caught) => caught instanceof AppError
        && caught.code === code
        && caught.retryable === retryable
        && !caught.message.includes('sensitive'),
    );
  }
});

test('OpenAI research config validates required env without echoing secret values', () => {
  assert.deepEqual(loadOpenAiResearchConfig({
    OPENAI_API_KEY: 'secret-key',
    OPENAI_RESEARCH_MODEL: 'gpt-5-2026-08-07',
    OPENAI_TIMEOUT_MS: '30000',
    OPENAI_MAX_RETRIES: '2',
  }), {
    apiKey: 'secret-key',
    model: 'gpt-5-2026-08-07',
    timeoutMs: 30_000,
    maxRetries: 2,
  });

  assert.throws(
    () => loadOpenAiResearchConfig({OPENAI_API_KEY: 'secret-key'}),
    (error) => error instanceof AppError
      && error.code === 'OPENAI_CONFIG_INVALID'
      && !error.message.includes('secret-key'),
  );
  assert.throws(
    () => loadOpenAiResearchConfig({
      OPENAI_API_KEY: 'secret-key',
      OPENAI_RESEARCH_MODEL: 'gpt-5',
      OPENAI_TIMEOUT_MS: 'not-a-number',
    }),
    (error) => error instanceof AppError && error.code === 'OPENAI_CONFIG_INVALID',
  );
});
