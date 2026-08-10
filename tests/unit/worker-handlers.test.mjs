import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerHandlers} from '../../worker/handlers.mjs';

test('standalone worker automatically chains successful research into generation', async () => {
  const calls = [];
  const handlers = createWorkerHandlers({
    researchService: {execute: async ({job}) => calls.push(`research:${job.id}`)},
    generationService: {
      execute: async ({job}) => calls.push(`generate:${job.id}`),
      enqueueGeneration: async (projectId, {jobId}) => calls.push(`enqueue-generation:${projectId}:${jobId}`),
    },
    renderService: {handleJob: async ({job}) => calls.push(`render:${job.id}`)},
  });

  assert.deepEqual(Object.keys(handlers).sort(), ['generating', 'rendering', 'researching']);
  await handlers.researching({job: {id: 'research-job', projectId: 'project-1'}});
  await handlers.generating({job: {id: 'generation-job', projectId: 'project-1'}});
  await handlers.rendering({job: {id: 'render-job', projectId: 'project-1'}});
  assert.deepEqual(calls, [
    'research:research-job',
    'enqueue-generation:project-1:generation-research-job',
    'generate:generation-job',
    'render:render-job',
  ]);
});

test('research failure does not enqueue generation', async () => {
  let enqueued = false;
  const handlers = createWorkerHandlers({
    researchService: {execute: async () => { throw new Error('research failed'); }},
    generationService: {
      execute: async () => {},
      enqueueGeneration: async () => { enqueued = true; },
    },
    renderService: {handleJob: async () => {}},
  });

  await assert.rejects(() => handlers.researching({job: {id: 'r', projectId: 'p'}}), /research failed/);
  assert.equal(enqueued, false);
});

test('worker handler composition fails closed when a stage dependency is missing', () => {
  assert.throws(
    () => createWorkerHandlers({
      researchService: {execute: async () => {}},
      generationService: {execute: async () => {}},
      renderService: {handleJob: async () => {}},
    }),
    /enqueueGeneration/,
  );
});
