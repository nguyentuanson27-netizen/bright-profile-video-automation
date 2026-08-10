import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectPayload, projectStatusView} from '../../web/src/model.mjs';

test('project creation payload trims topic/instructions and deduplicates public URLs', () => {
  assert.deepEqual(createProjectPayload({
    topic: '  Creator Name  ',
    sourceUrlsText: 'https://youtube.com/watch?v=1\n\nhttps://x.com/post/1\nhttps://youtube.com/watch?v=1',
    instructions: '  Focus on public milestones.  ',
  }), {
    topic: 'Creator Name',
    sourceUrls: ['https://youtube.com/watch?v=1', 'https://x.com/post/1'],
    instructions: 'Focus on public milestones.',
  });
});

test('project status view exposes semantic pending, review, and failure states without inventing unsafe actions', () => {
  assert.deepEqual(projectStatusView({
    project: {id: 'p1', topic: 'Creator', status: 'researching'},
    latestJob: {stage: 'researching', status: 'running', attempt: 1, maxAttempts: 3},
    sourceSummary: {total: 2, available: 1, unavailable: 0, failed: 1},
  }), {
    label: 'Researching public sources',
    tone: 'pending',
    pending: true,
    needsReview: false,
    error: null,
    sourceText: '1/2 sources available',
  });

  const review = projectStatusView({
    project: {id: 'p2', topic: 'Creator', status: 'review_required'},
    latestJob: {stage: 'generating', status: 'succeeded', attempt: 1, maxAttempts: 3},
    sourceSummary: {total: 3, available: 3, unavailable: 0, failed: 0},
  });
  assert.equal(review.needsReview, true);
  assert.equal(review.pending, false);
  assert.equal(review.label, 'Ready for review');

  const failed = projectStatusView({
    project: {id: 'p3', topic: 'Creator', status: 'researching'},
    latestJob: {stage: 'researching', status: 'failed', errorCode: 'FETCH_FAILED', errorMessage: 'Research failed'},
    sourceSummary: {total: 0, available: 0, unavailable: 0, failed: 0},
  });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.error, 'Research failed');
  assert.equal(Object.hasOwn(failed, 'retryAction'), false);
  assert.equal(Object.hasOwn(failed, 'cancelAction'), false);
});
