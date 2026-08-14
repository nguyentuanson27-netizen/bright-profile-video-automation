import test from 'node:test';
import assert from 'node:assert/strict';

import {actionBlockedReason, actionsForProject, normalizePublicUrls, shouldPollProject} from '../../web/state.mjs';

test('web workflow exposes only legal primary controls for each durable project state', () => {
  assert.deepEqual(actionsForProject('draft'), ['research']);
  assert.deepEqual(actionsForProject('researching'), ['cancel']);
  assert.deepEqual(actionsForProject('research_ready'), ['generate']);
  assert.deepEqual(actionsForProject('generating'), ['cancel']);
  assert.deepEqual(actionsForProject('review_required'), ['approve']);
  assert.deepEqual(actionsForProject('approved'), ['render']);
  assert.deepEqual(actionsForProject('media_ingest'), ['cancel']);
  assert.deepEqual(actionsForProject('tts'), ['cancel']);
  assert.deepEqual(actionsForProject('render_queued'), ['cancel']);
  assert.deepEqual(actionsForProject('rendering'), ['cancel']);
  assert.deepEqual(actionsForProject('failed'), ['retry']);
  assert.deepEqual(actionsForProject('cancelled'), []);
  assert.deepEqual(actionsForProject('completed'), ['download']);
  assert.deepEqual(actionsForProject('unknown'), []);
});

test('web polling tracks only active asynchronous states', () => {
  for (const status of ['researching', 'generating', 'media_ingest', 'tts', 'render_queued', 'rendering']) {
    assert.equal(shouldPollProject(status), true, status);
  }
  for (const status of ['draft', 'research_ready', 'review_required', 'approved', 'failed', 'cancelled', 'completed']) {
    assert.equal(shouldPollProject(status), false, status);
  }
});

test('approval stays blocked while structured review edits are unsaved', () => {
  assert.match(actionBlockedReason('review_required', 'approve', {draftDirty: true}), /save/i);
  assert.equal(actionBlockedReason('review_required', 'approve', {draftDirty: false}), '');
  assert.match(actionBlockedReason('draft', 'approve', {draftDirty: false}), /not available/i);
});

test('public URL textarea normalization is bounded, trimmed and stable', () => {
  assert.deepEqual(normalizePublicUrls(' https://a.example/x \n\nhttps://b.example/y\nhttps://a.example/x '), [
    'https://a.example/x',
    'https://b.example/y',
  ]);
  assert.throws(() => normalizePublicUrls(Array.from({length: 21}, (_, index) => `https://e${index}.example`).join('\n')), /at most 20/i);
});
