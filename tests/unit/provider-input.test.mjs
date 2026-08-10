import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError} from '../../domain/errors.mjs';
import {createResearchProvider} from '../../providers/research/index.mjs';

test('operator-provided non-HTTP source URL is classified as provider input error', async () => {
  const provider = createResearchProvider({search: async () => ({candidates: []})});

  await assert.rejects(
    () => provider.search({topic: 'Creator', sourceUrls: ['file:///etc/passwd']}),
    (error) => error instanceof AppError
      && error.code === 'PROVIDER_INPUT_INVALID'
      && error.status === 400,
  );
});
