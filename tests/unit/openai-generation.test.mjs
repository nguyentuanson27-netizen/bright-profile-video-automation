import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GenerationProviderErrorCodes,
  createOpenAIGenerationProvider,
} from '../../providers/generation/openai.mjs';

const draft = {
  creatorName: 'Creator',
  summary: 'Creator profile summary.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
};

const input = {
  creator: 'Creator',
  topic: 'career and audience',
  instructions: 'Keep it factual.',
  sources: [{id: 'source-1', url: 'https://research.example/profile', title: 'Profile'}],
  evidence: [{id: 'ev-1', claim: 'Creator reached 100 followers.', confidence: 'high', conflictGroupId: null, sourceIds: ['source-1']}],
};

test('OpenAI generation uses Responses Structured Outputs without browsing and returns parsed draft data', async () => {
  let request;
  const client = {responses: {async create(value) {
    request = value;
    return {status: 'completed', output_text: JSON.stringify(draft), output: []};
  }}};
  const provider = createOpenAIGenerationProvider({client, model: 'gpt-5', timeoutMs: 1000, maxRetries: 1});

  const result = await provider.generate(input);

  assert.deepEqual(result, draft);
  assert.equal(request.model, 'gpt-5');
  assert.equal(request.store, false);
  assert.equal(request.tools, undefined);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.ok(JSON.stringify(request.input).includes('source-1'));
});

test('OpenAI generation rejects refusals, incomplete responses, malformed JSON, timeout and rate limit with stable classifications', async () => {
  const cases = [
    [{status: 'completed', output_text: '', output: [{type: 'message', content: [{type: 'refusal', refusal: 'no'}]}]}, GenerationProviderErrorCodes.REFUSED, false],
    [{status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, output: []}, GenerationProviderErrorCodes.INCOMPLETE, true],
    [{status: 'completed', output_text: '{bad json', output: []}, GenerationProviderErrorCodes.INVALID_RESULT, false],
  ];
  for (const [response, code, retryable] of cases) {
    const provider = createOpenAIGenerationProvider({
      client: {responses: {async create() { return response; }}},
      model: 'gpt-5', timeoutMs: 1000, maxRetries: 0,
    });
    await assert.rejects(provider.generate(input), (error) => error.code === code && error.retryable === retryable);
  }

  for (const [error, code] of [
    [Object.assign(new Error('timeout'), {name: 'APIConnectionTimeoutError'}), GenerationProviderErrorCodes.TIMEOUT],
    [Object.assign(new Error('rate'), {status: 429}), GenerationProviderErrorCodes.RATE_LIMIT],
  ]) {
    const provider = createOpenAIGenerationProvider({
      client: {responses: {async create() { throw error; }}},
      model: 'gpt-5', timeoutMs: 1000, maxRetries: 0,
    });
    await assert.rejects(provider.generate(input), (caught) => caught.code === code && caught.retryable === true);
  }
});
