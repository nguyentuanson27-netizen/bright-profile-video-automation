import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerHandlers} from '../../worker/handlers.mjs';

test('standalone worker handles research, generation, and rendering durable stages', async () => {
  const calls = [];
  const handlers = createWorkerHandlers({
    researchService: {execute: async ({job}) => calls.push(`research:${job.id}`)},
    generationService: {execute: async ({job}) => calls.push(`generate:${job.id}`)},
    renderService: {handleJob: async ({job}) => calls.push(`render:${job.id}`)},
  });

  assert.deepEqual(Object.keys(handlers).sort(), ['generating', 'rendering', 'researching']);
  await handlers.researching({job: {id: 'r'}});
  await handlers.generating({job: {id: 'g'}});
  await handlers.rendering({job: {id: 'v'}});
  assert.deepEqual(calls, ['research:r', 'generate:g', 'render:v']);
});

test('worker handler composition fails closed when a stage dependency is missing', () => {
  assert.throws(
    () => createWorkerHandlers({
      researchService: {execute: async () => {}},
      generationService: null,
      renderService: {handleJob: async () => {}},
    }),
    /generationService/,
  );
});
