import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_STATES,
  transitionProject,
  failProject,
  retryFailedProject,
  cancelProject,
  decideApprovedEdit,
  assertCanCreateFirstDescendant,
} from '../../domain/project.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';
import {validateDraft, validateApprovedRevision} from '../../domain/schemas.mjs';

const baseProject = (status, overrides = {}) => ({
  id: 'project-1',
  status,
  currentRevisionId: 'revision-1',
  approvedRevisionId: status === 'approved' ? 'revision-1' : null,
  failure: null,
  ...overrides,
});

const validDraft = () => ({
  creatorName: 'Creator',
  summary: 'A concise profile.',
  claims: [
    {id: 'claim-1', text: 'Verified fact', sourceIds: ['source-1'], verified: true},
  ],
  script: [
    {id: 'script-1', text: 'Opening narration', start: 0, duration: 4, sourceIds: ['source-1']},
  ],
  voiceover: {
    chunks: [{id: 'voice-1', text: 'Opening narration', start: 0, duration: 4}],
  },
  scenes: [
    {id: 'scene-1', type: 'hero', start: 0, duration: 4, sourceIds: ['source-1']},
    {id: 'scene-2', type: 'stats', start: 4, duration: 3, sourceIds: ['source-1']},
  ],
  render: {duration: 7, renderScale: 1, crf: 20},
});

test('project lifecycle covers the retained happy path in order', () => {
  const path = [
    'draft', 'researching', 'research_ready', 'generating', 'review_required', 'approved',
    'media_ingest', 'tts', 'render_queued', 'rendering', 'completed',
  ];
  assert.deepEqual(PROJECT_STATES, path.concat(['failed', 'cancelled']));

  let project = baseProject(path[0], {approvedRevisionId: null});
  for (const next of path.slice(1)) project = transitionProject(project, next);
  assert.equal(project.status, 'completed');
});

test('illegal lifecycle transition returns a stable transition error', () => {
  assert.throws(
    () => transitionProject(baseProject('draft', {approvedRevisionId: null}), 'approved'),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );
});

test('failure records durable failed stage and only retryable failure can be requeued', () => {
  const failed = failProject(baseProject('generating', {approvedRevisionId: null}), {
    stage: 'generating',
    retryable: true,
    code: 'PROVIDER_TIMEOUT',
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, {stage: 'generating', retryable: true, code: 'PROVIDER_TIMEOUT'});
  assert.equal(retryFailedProject(failed).status, 'generating');

  const terminal = failProject(baseProject('generating', {approvedRevisionId: null}), {
    stage: 'generating', retryable: false, code: 'INVALID_PROVIDER_OUTPUT',
  });
  assert.throws(
    () => retryFailedProject(terminal),
    (error) => error.code === ErrorCodes.FAILED_STAGE_NOT_RETRYABLE,
  );
});

test('cancel is legal for active durable stages and repeated cancel is an idempotent no-op', () => {
  const first = cancelProject(baseProject('rendering'));
  assert.equal(first.changed, true);
  assert.equal(first.project.status, 'cancelled');

  const second = cancelProject(first.project);
  assert.equal(second.changed, false);
  assert.strictEqual(second.project, first.project);

  assert.throws(
    () => cancelProject(baseProject('completed')),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );
});

test('post-approval edit invalidates approval only before descendant work exists', () => {
  const project = baseProject('approved');
  const allowed = decideApprovedEdit(project, {hasDescendantStage: false});
  assert.deepEqual(allowed, {nextStatus: 'review_required', invalidateApproval: true});

  assert.throws(
    () => decideApprovedEdit(project, {hasDescendantStage: true}),
    (error) => error.code === ErrorCodes.DOWNSTREAM_WORK_STARTED,
  );
});

test('first descendant creation requires the same current approved revision', () => {
  assert.doesNotThrow(() => assertCanCreateFirstDescendant(baseProject('approved'), {
    revisionId: 'revision-1', hasDescendantStage: false,
  }));
  assert.throws(
    () => assertCanCreateFirstDescendant(baseProject('approved'), {
      revisionId: 'revision-old', hasDescendantStage: false,
    }),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );
});

test('draft schema accepts supported scenes and rejects unknown source references', () => {
  const draft = validDraft();
  assert.deepEqual(validateDraft(draft, {knownSourceIds: ['source-1']}), draft);

  draft.claims[0].sourceIds = ['source-missing'];
  assert.throws(
    () => validateDraft(draft, {knownSourceIds: ['source-1']}),
    (error) => error.code === ErrorCodes.UNKNOWN_SOURCE_REFERENCE,
  );
});

test('draft schema rejects unsupported scene types, invalid timelines, malformed payloads and render settings', () => {
  const unsupported = validDraft();
  unsupported.scenes[0].type = 'arbitrary-html';
  assert.throws(() => validateDraft(unsupported, {knownSourceIds: ['source-1']}));

  const badTimeline = validDraft();
  badTimeline.scenes[1].start = 6;
  badTimeline.scenes[1].duration = 3;
  assert.throws(() => validateDraft(badTimeline, {knownSourceIds: ['source-1']}));

  const malformed = validDraft();
  malformed.extra = true;
  assert.throws(() => validateDraft(malformed, {knownSourceIds: ['source-1']}));

  const badRender = validDraft();
  badRender.render.crf = 99;
  assert.throws(() => validateDraft(badRender, {knownSourceIds: ['source-1']}));
});

test('approved revision contract carries an immutable payload hash envelope', () => {
  const revision = {
    id: 'revision-1',
    projectId: 'project-1',
    payloadHash: 'a'.repeat(64),
    approvedAt: '2026-08-13T00:00:00.000Z',
    payload: validDraft(),
  };
  assert.deepEqual(validateApprovedRevision(revision, {knownSourceIds: ['source-1']}), revision);

  assert.throws(() => validateApprovedRevision({...revision, payloadHash: 'not-a-sha256'}, {
    knownSourceIds: ['source-1'],
  }));
});
