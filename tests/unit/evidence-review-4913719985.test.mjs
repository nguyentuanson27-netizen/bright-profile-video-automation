import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru'},
  researchQuery: 'review 4913719985 regressions',
  researchedAt: '2026-08-12T06:30:00Z',
  items,
  ...extra,
});

const provenanceInput = () => [
  {
    claim: 'Emiru maintains an official creator profile.',
    url: 'https://profile.example/emiru?utm_source=sparse',
    category: 'profile',
  },
  {
    claim: 'Emiru maintains an official creator profile.',
    url: 'https://profile.example/emiru?utm_source=rich',
    category: 'profile',
    title: 'Emiru official creator profile',
    publisher: 'Example Network',
    publishedAt: '2026-08-11T12:00:00Z',
    excerpt: 'Emiru maintains an official creator profile on Example Network.',
    sourceType: 'official',
    sourceRelationship: 'primary',
  },
];

test('same-canonical source provenance merge is deterministic and prefers explicit richer metadata', () => {
  const forward = normalizeEvidence(base(provenanceInput()));
  const reversed = normalizeEvidence(base([...provenanceInput()].reverse()));
  const left = forward.evidence[0];
  const right = reversed.evidence[0];

  assert.equal(left.sources.length, 1);
  assert.equal(right.sources.length, 1);
  for (const key of ['title', 'publisher', 'publishedAt', 'excerpt', 'sourceType', 'sourceRelationship']) {
    assert.equal(left.sources[0][key], right.sources[0][key], `${key} must not depend on input order`);
  }
  assert.equal(left.sources[0].publisher, 'Example Network');
  assert.equal(left.sources[0].sourceType, 'official');
  assert.equal(left.sources[0].sourceRelationship, 'primary');
  assert.equal(left.qualityScore, right.qualityScore);
  assert.equal(left.confidence, right.confidence);
});

const confidenceBundle = (sourceRelationship) => normalizeEvidence(base([
  {
    claim: 'Emiru reached a documented creator milestone.',
    url: 'https://news-a.example/emiru',
    title: 'Creator milestone report A',
    publisher: 'News A',
    publishedAt: '2026-08-11T10:00:00Z',
    excerpt: 'Emiru reached a documented creator milestone according to the public report.',
    sourceType: 'news',
    sourceRelationship,
  },
  {
    claim: 'Emiru reached a documented creator milestone.',
    url: 'https://news-b.example/emiru',
    title: 'Creator milestone report B',
    publisher: 'News B',
    publishedAt: '2026-08-11T11:00:00Z',
    excerpt: 'Emiru reached a documented creator milestone according to the public report.',
    sourceType: 'news',
    sourceRelationship,
  },
]));

test('high confidence from multiple publishers requires explicit independent relationships', () => {
  const unknown = confidenceBundle('unknown');
  const independent = confidenceBundle('independent');

  assert.ok(unknown.evidence[0].qualityScore >= 0.68);
  assert.equal(unknown.evidence[0].confidence, 'medium');
  assert.equal(independent.evidence[0].confidence, 'high');
});

test('source relationship vocabulary rejects typo values batch-safely', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru has a public creator profile.',
      url: 'https://example.com/emiru',
      sourceRelationship: 'indepedent',
    },
  ]));

  assert.equal(bundle.evidence.length, 0);
  assert.equal(bundle.rejectedItems.length, 1);
  assert.match(bundle.rejectedItems[0].reasons.join(' '), /sourceRelationship/i);
});
