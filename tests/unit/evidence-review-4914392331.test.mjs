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
  ...(item.title ? {title: item.title} : {}),
  publisher: item.publisher ?? 'profile.example',
  ...(item.author ? {author: item.author} : {}),
  ...(item.publishedAt ? {publishedAt: new Date(item.publishedAt).toISOString()} : {}),
  ...(item.excerpt ? {excerpt: item.excerpt} : {}),
  sourceType: item.sourceType ?? 'other',
  ...(item.sourceRelationship ? {sourceRelationship: item.sourceRelationship} : {}),
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

const threeWayObservations = () => [
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=a',
    category: 'profile',
    publisher: 'Publisher A',
    publishedAt: '2024-01-01T00:00:00Z',
    sourceType: 'news',
  },
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=b',
    category: 'profile',
    title: 'Observation B title',
    publisher: 'Publisher B',
    author: 'Reporter B',
    sourceType: 'news',
  },
  {
    claim: 'Emiru maintains a documented creator profile.',
    url: 'https://profile.example/emiru?utm_source=c',
    category: 'profile',
    title: 'Observation C title',
    publisher: 'Publisher C',
    author: 'Reporter C',
    publishedAt: '2026-08-11T00:00:00Z',
    sourceType: 'news',
  },
];

test('same-canonical coherent observation selection is permutation-stable across three candidates', () => {
  const input = threeWayObservations();
  const first = normalizeEvidence(base(input)).evidence[0];
  const second = normalizeEvidence(base([input[2], input[0], input[1]])).evidence[0];

  assert.deepEqual(first.sources[0], second.sources[0]);
  const realObservations = input.map(normalizedObservation);
  assert.ok(realObservations.some((source) => JSON.stringify(source) === JSON.stringify(first.sources[0])));
});
