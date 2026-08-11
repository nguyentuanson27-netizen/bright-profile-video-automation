import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEvidenceBundle, assertEvidenceEnvelope} from '../../lib/evidence/schema-validator.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const valid = {
  subject: {name: 'Example Creator'},
  researchedAt: '2026-08-11T08:00:00Z',
  items: [{claim: 'Example Creator launched a public channel.', url: 'https://example.com/profile'}],
};

test('accepts valid envelope and output bundle', () => {
  assert.doesNotThrow(() => assertEvidenceEnvelope(valid));
  assert.doesNotThrow(() => assertEvidenceBundle(normalizeEvidence(valid)));
});

test('rejects unknown root fields', () => {
  assert.throws(() => assertEvidenceEnvelope({...valid, privilegedAction: 'shell'}), (error) => {
    assert.equal(error.code, 'EVIDENCE_INPUT_INVALID');
    return true;
  });
});

test('allows malformed items through envelope for item-level rejection', () => {
  const input = {...valid, items: [{claim: 'x'}, null]};
  assert.doesNotThrow(() => assertEvidenceEnvelope(input));
  const bundle = normalizeEvidence(input);
  assert.equal(bundle.rejectedItems.length, 2);
  assert.deepEqual(bundle.rejectedItems.map((item) => item.index), [0, 1]);
});
