import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionBlockedReason,
  actionsForProject,
  normalizePublicUrls,
  reviewModeForProject,
  shouldPollProject,
} from '../../web/state.mjs';

test('web workflow exposes only legal primary controls for each durable project state', () => {
  assert.deepEqual(actionsForProject({status: 'draft'}), ['research']);
  assert.deepEqual(actionsForProject({status: 'researching'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'research_ready'}), ['generate']);
  assert.deepEqual(actionsForProject({status: 'generating'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'review_required'}), ['approve']);
  assert.deepEqual(actionsForProject({status: 'approved'}), ['render']);
  assert.deepEqual(actionsForProject({status: 'media_ingest'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'tts'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'render_queued'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'rendering'}), ['cancel']);
  assert.deepEqual(actionsForProject({status: 'failed', failureRetryable: true}), ['retry']);
  assert.deepEqual(actionsForProject({status: 'failed', failureRetryable: false}), []);
  assert.deepEqual(actionsForProject({status: 'cancelled'}), []);
  assert.deepEqual(actionsForProject({status: 'completed'}), ['download']);
  assert.deepEqual(actionsForProject({status: 'unknown'}), []);
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
  assert.match(actionBlockedReason({status: 'review_required'}, 'approve', {draftDirty: true}), /save/i);
  assert.equal(actionBlockedReason({status: 'review_required'}, 'approve', {draftDirty: false}), '');
  assert.match(actionBlockedReason({status: 'draft'}, 'approve', {draftDirty: false}), /not available/i);
});

test('approved revision stays editable only before downstream work begins', () => {
  assert.deepEqual(reviewModeForProject({status: 'review_required'}), {visible: true, editable: true, invalidatesApproval: false});
  assert.deepEqual(reviewModeForProject({status: 'approved'}), {visible: true, editable: true, invalidatesApproval: true});
  for (const status of ['media_ingest', 'tts', 'render_queued', 'rendering', 'completed']) {
    assert.deepEqual(reviewModeForProject({status}), {visible: false, editable: false, invalidatesApproval: false}, status);
  }
});

test('public URL textarea normalization is bounded, trimmed and stable', () => {
  assert.deepEqual(normalizePublicUrls(' https://a.example/x \n\nhttps://b.example/y\nhttps://a.example/x '), [
    'https://a.example/x',
    'https://b.example/y',
  ]);
  assert.throws(() => normalizePublicUrls(Array.from({length: 21}, (_, index) => `https://e${index}.example`).join('\n')), /at most 20/i);
});
