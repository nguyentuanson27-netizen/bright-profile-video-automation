import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalReadiness, buildApprovalPayload, projectWorkflowActions} from '../../web/src/review-model.mjs';

const generation = {
  claims: [
    {id: 'supported', text: 'Supported fact.', sourceIds: ['source-1'], status: 'supported'},
    {id: 'needs-review', text: 'Needs manual verification.', sourceIds: [], status: 'unverified'},
  ],
};

test('unverified claims block approval until each has a non-empty operator reason', () => {
  assert.deepEqual(approvalReadiness(generation, {}), {
    ready: false,
    missingClaimIds: ['needs-review'],
  });
  assert.deepEqual(approvalReadiness(generation, {'needs-review': '  verified manually  '}), {
    ready: true,
    missingClaimIds: [],
  });
  assert.deepEqual(buildApprovalPayload({
    revisionId: 'revision-1',
    approvedBy: ' operator ',
    generation,
    overrideReasons: {'needs-review': '  verified manually  '},
  }), {
    revisionId: 'revision-1',
    approvedBy: 'operator',
    claimOverrides: [{claimId: 'needs-review', reason: 'verified manually'}],
  });
});

test('workflow actions expose review, render and download only for valid persisted states', () => {
  assert.deepEqual(projectWorkflowActions({
    project: {status: 'review_required'},
    latestRevision: {status: 'draft'},
  }), {canEdit: true, canApprove: true, canRender: false, canDownload: false});

  assert.deepEqual(projectWorkflowActions({
    project: {status: 'approved'},
    latestRevision: {status: 'approved'},
  }), {canEdit: true, canApprove: false, canRender: true, canDownload: false});

  assert.deepEqual(projectWorkflowActions({
    project: {status: 'completed'},
    latestRevision: {status: 'approved'},
    videoState: 'ready',
  }), {canEdit: false, canApprove: false, canRender: false, canDownload: true});

  assert.deepEqual(projectWorkflowActions({
    project: {status: 'completed'},
    latestRevision: {status: 'approved'},
    videoState: 'error',
  }), {canEdit: false, canApprove: false, canRender: false, canDownload: false});
});
