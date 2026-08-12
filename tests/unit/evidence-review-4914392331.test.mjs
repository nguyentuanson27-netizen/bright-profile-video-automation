import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items) => ({
  subject: {name: 'Emiru'},
  researchQuery: 'review 4914392331 provenance regression',
  researchedAt: '2026-08-12T08:00:00Z',
  items,
});

const observations = () => [
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=alpha',
    category: 'profile',
    title: 'A substantially longer title supplied by observation Alpha',
    publisher: 'Alpha Publisher',
    author: 'Amy',
    publishedAt: '2024-01-01T00:00:00Z',
    excerpt: 'Alpha excerpt is deliberately much longer than the competing excerpt so field-wise merging would choose it.',
    sourceType: 'news',
    sourceRelationship: 'independent',
  },
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=bravo',
    category: 'profile',
    title: 'Bravo title',
    publisher: 'Bravo Publisher With A Longer Name',
    author: 'Reporter Bravo With A Longer Name',
    publishedAt: '2026-08-11T00:00:00Z',
    excerpt: 'Bravo excerpt.',
    sourceType: 'official',
    sourceRelationship: 'primary',
  },
];

const normalizedObservation = (item) => ({
  url: item.url,
  canonicalUrl: 'https://profile.example/emiru',
  title: item.title,
  publisher: item.publisher,
  author: item.author,
  publishedAt: new Date(item.publishedAt).toISOString(),
  excerpt: item.excerpt,
  sourceType: item.sourceType,
  sourceRelationship: item.sourceRelationship,
});

test('same-canonical provenance merge selects a coherent real observation instead of synthesizing fields', () => {
  const input = observations();
  const forward = normalizeEvidence(base(input));
  const reversed = normalizeEvidence(base([...input].reverse()));
  const left = forward.evidence[0];
  const right = reversed.evidence[0];

  assert.equal(left.sources.length, 1);
  assert.deepEqual(left.sources[0], right.sources[0]);
  assert.equal(left.qualityScore, right.qualityScore);
  assert.equal(left.confidence, right.confidence);

  const realObservations = input.map(normalizedObservation);
  assert.ok(
    realObservations.some((source) => {
      try {
        assert.deepEqual(left.sources[0], source);
        return true;
      } catch {
        return false;
      }
    }),
    `merged source must remain traceable to one input observation; got ${JSON.stringify(left.sources[0])}`,
  );
});
