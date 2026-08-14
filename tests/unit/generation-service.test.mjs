import test from 'node:test';
import assert from 'node:assert/strict';

import {createGenerationService} from '../../app/services/generate-project.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const project = {
  id: 'project-1',
  creator: 'Creator',
  topic: 'career',
  instructions: 'Factual only.',
  research: {
    evidence: [{
      id: 'ev-1',
      claim: 'Creator reached 100 followers.',
      confidence: 'high',
      conflictGroupId: null,
      sources: [{
        url: 'https://research.example/profile',
        canonicalUrl: 'https://research.example/profile',
      }],
    }],
  },
};
const sources = [{
  id: 'source-1',
  status: 'available',
  url: 'https://research.example/profile',
  payload: {title: 'Profile'},
}];

const validDraft = () => ({
  creatorName: 'Creator',
  summary: 'Creator profile summary.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
});

const serviceFor = (draft) => createGenerationService({
  provider: {async generate() { return draft; }},
});

test('generation service rejects provider output with unknown application source IDs', async () => {
  const draft = validDraft();
  draft.claims[0].sourceIds = ['invented-source'];
  await assert.rejects(
    serviceFor(draft).generate({project, sources}),
    (error) => error.code === ErrorCodes.UNKNOWN_SOURCE_REFERENCE,
  );
});

test('generation service rejects unsupported scene types after provider output', async () => {
  const draft = validDraft();
  draft.scenes[0].type = 'arbitrary';
  await assert.rejects(
    serviceFor(draft).generate({project, sources}),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );
});

test('generation service rejects invalid timelines after provider output', async () => {
  const draft = validDraft();
  draft.scenes[0].start = 3;
  draft.scenes[0].duration = 3;
  await assert.rejects(
    serviceFor(draft).generate({project, sources}),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );
});

test('generation service does not trust an LLM-provided verified flag as human verification', async () => {
  const generated = await serviceFor(validDraft()).generate({project, sources});
  assert.equal(generated.claims[0].verified, false);
  assert.equal(Object.hasOwn(generated.claims[0], 'overrideReason'), false);
});
