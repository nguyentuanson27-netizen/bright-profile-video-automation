import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ResearchProviderErrorCodes,
  validateResearchProviderResult,
} from '../../providers/research/index.mjs';

test('research provider rejects source relationships outside the canonical evidence vocabulary', () => {
  assert.throws(
    () => validateResearchProviderResult({
      candidates: [{
        claim: 'Creator has a public profile.',
        url: 'https://example.com/profile',
        sourceRelationship: 'independant',
      }],
      sources: [],
      unavailableSources: [],
    }),
    (error) => error.code === ResearchProviderErrorCodes.INVALID_RESULT,
  );
});
