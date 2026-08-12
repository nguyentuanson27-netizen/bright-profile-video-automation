import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items) => ({
  subject: {name: 'Emiru'},
  researchQuery: 'review 4914102085 regressions',
  researchedAt: '2026-08-12T07:45:00Z',
  items,
});

const conflictingExplicitProvenance = () => [
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=alpha',
    category: 'profile',
    title: 'Alpha profile title',
    publisher: 'Example Network',
    author: 'Reporter Alpha',
    publishedAt: '2024-01-01T00:00:00Z',
    excerpt: 'Evidence A.',
    sourceType: 'news',
    sourceRelationship: 'independent',
  },
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=bravo',
    category: 'profile',
    title: 'Bravo profile title',
    publisher: 'Example Network',
    author: 'Reporter Bravo',
    publishedAt: '2026-08-11T00:00:00Z',
    excerpt: 'Evidence B.',
    sourceType: 'news',
    sourceRelationship: 'independent',
  },
];

test('same-canonical conflicting explicit provenance is commutative and publication freshness is conservative', () => {
  const forward = normalizeEvidence(base(conflictingExplicitProvenance()));
  const reversed = normalizeEvidence(base([...conflictingExplicitProvenance()].reverse()));
  const left = forward.evidence[0];
  const right = reversed.evidence[0];

  assert.equal(left.sources.length, 1);
  assert.equal(right.sources.length, 1);
  assert.deepEqual(left.sources[0], right.sources[0]);
  assert.equal(left.sources[0].publishedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(left.qualityScore, right.qualityScore);
  assert.equal(left.confidence, right.confidence);
});
