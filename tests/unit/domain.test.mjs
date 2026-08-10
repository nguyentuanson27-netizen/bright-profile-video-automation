import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../domain/errors.mjs';
import {
  PROJECT_STATES,
  SUPPORTED_SCENE_TYPES,
  assertProjectTransition,
} from '../../domain/project.mjs';
import {
  assertGenerationConsistency,
  assertSchema,
} from '../../domain/schemas.mjs';

const source = {
  sourceId: 'source-1',
  url: 'https://www.youtube.com/watch?v=example',
  platform: 'youtube',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'A normalized public-source excerpt.',
  sourceType: 'social',
};

const generation = {
  researchSummary: 'Public-source research summary.',
  claims: [
    {
      id: 'claim-1',
      text: 'A supported factual claim.',
      sourceIds: ['source-1'],
      status: 'supported',
    },
    {
      id: 'claim-2',
      text: 'A statement that still needs verification.',
      sourceIds: [],
      status: 'unverified',
    },
  ],
  script: 'A short creator profile script.',
  voiceover: {
    chunks: [
      {id: 'hero', start: 0, duration: 6, text: 'Opening voiceover.'},
    ],
  },
  project: {
    duration: 6,
    creatorName: 'EMIRU',
    scenes: [
      {id: 'hero', type: 'hero', start: 0, duration: 6},
    ],
  },
};

test('project workflow exposes the approved lifecycle states and legal forward transitions', () => {
  assert.deepEqual(PROJECT_STATES, [
    'draft',
    'researching',
    'research_ready',
    'generating',
    'review_required',
    'approved',
    'media_ingest',
    'tts',
    'render_queued',
    'rendering',
    'completed',
    'failed',
    'cancelled',
  ]);

  assert.doesNotThrow(() => assertProjectTransition('draft', 'researching'));
  assert.doesNotThrow(() => assertProjectTransition('review_required', 'approved'));
  assert.doesNotThrow(() => assertProjectTransition('approved', 'review_required'));
  assert.doesNotThrow(() => assertProjectTransition('media_ingest', 'render_queued'));
  assert.doesNotThrow(() => assertProjectTransition('rendering', 'completed'));
});

test('invalid workflow transition returns a stable domain error', () => {
  assert.throws(
    () => assertProjectTransition('draft', 'approved'),
    (error) => error instanceof AppError
      && error.code === 'INVALID_PROJECT_TRANSITION'
      && error.status === 409
      && error.retryable === false,
  );
});

test('schemas validate project input and normalized source records', () => {
  assert.doesNotThrow(() => assertSchema('projectInput', {
    topic: 'Emiru streaming profile',
    sourceUrls: ['https://www.youtube.com/watch?v=example'],
    duration: 30,
  }));
  assert.doesNotThrow(() => assertSchema('sourceRecord', source));

  assert.throws(
    () => assertSchema('projectInput', {topic: '', sourceUrls: ['file:///etc/passwd']}),
    (error) => error instanceof AppError && error.code === 'SCHEMA_VALIDATION_FAILED',
  );
});

test('generation schema accepts supported and explicitly unverified claims', () => {
  assert.doesNotThrow(() => assertSchema('generationOutput', generation));
  assert.doesNotThrow(() => assertGenerationConsistency(generation, [source]));
});

test('supported claims must reference an existing normalized source', () => {
  const invalid = structuredClone(generation);
  invalid.claims[0].sourceIds = ['source-missing'];

  assert.throws(
    () => assertGenerationConsistency(invalid, [source]),
    (error) => error instanceof AppError && error.code === 'UNKNOWN_SOURCE_REFERENCE',
  );
});

test('supported claims require at least one source while unverified claims may have none', () => {
  const invalid = structuredClone(generation);
  invalid.claims[0].sourceIds = [];

  assert.throws(
    () => assertSchema('generationOutput', invalid),
    (error) => error instanceof AppError && error.code === 'SCHEMA_VALIDATION_FAILED',
  );
});

test('generation consistency rejects unsupported scene types and out-of-bounds timeline entries', () => {
  assert.deepEqual(SUPPORTED_SCENE_TYPES, ['hero', 'claim', 'vertical', 'source', 'social', 'stats']);

  const unsupported = structuredClone(generation);
  unsupported.project.scenes[0].type = 'unknown';
  assert.throws(
    () => assertSchema('generationOutput', unsupported),
    (error) => error instanceof AppError && error.code === 'SCHEMA_VALIDATION_FAILED',
  );

  const outsideTimeline = structuredClone(generation);
  outsideTimeline.project.scenes[0].start = 3;
  outsideTimeline.project.scenes[0].duration = 6;
  assert.throws(
    () => assertGenerationConsistency(outsideTimeline, [source]),
    (error) => error instanceof AppError && error.code === 'SCENE_OUTSIDE_TIMELINE',
  );
});

test('draft revisions and approved render snapshots share validated immutable-contract shapes', () => {
  const draft = {
    revisionId: 'revision-1',
    projectId: 'project-1',
    topic: 'Emiru',
    sources: [source],
    generation,
  };
  assert.doesNotThrow(() => assertSchema('draftRevision', draft));

  const approved = {
    ...draft,
    approvedAt: '2026-08-10T00:10:00.000Z',
    approvedBy: 'operator',
    claimOverrides: [],
    media: [],
    renderSettings: {renderScale: 1, crf: 20},
  };
  assert.doesNotThrow(() => assertSchema('approvedSnapshot', approved));
});
