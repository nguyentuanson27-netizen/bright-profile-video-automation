import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru', aliases: ['Emily Schunk']},
  researchQuery: 'review blocker regressions',
  researchedAt: '2026-08-11T08:00:00Z',
  items,
  ...extra,
});

test('schema-invalid optional item fields are rejected instead of coerced', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'A valid factual claim.', url: 'https://example.com/valid'},
    {claim: 'Category has the wrong type.', url: 'https://example.com/category', category: 123},
    {claim: 'Unit has the wrong type.', url: 'https://example.com/unit', unit: {name: 'followers'}},
    {claim: 'Value has the wrong type.', url: 'https://example.com/value', value: ['2.1M']},
    {claim: 'Title is too long.', url: 'https://example.com/title', title: 'x'.repeat(1001)},
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.deepEqual(bundle.rejectedItems.map(({index}) => index), [1, 2, 3, 4]);
});

test('exact dedupe enriches compatible typed metadata from richer duplicates', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Emiru reached 1 million followers.', url: 'https://a.example/profile'},
    {
      claim: 'Emiru reached 1M followers.',
      url: 'https://a.example/profile',
      value: 1_000_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru reached 1M followers.',
      url: 'https://b.example/profile',
      value: 1_000_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].category, 'followers');
  assert.equal(bundle.evidence[0].claimDate, '2026-07-01');
  assert.equal(bundle.evidence[0].value, 1_000_000);
  assert.equal(bundle.evidence[0].unit, 'followers');
  assert.equal(bundle.evidence[0].sources.length, 2);
  assert.equal(bundle.stats.exactDuplicatesRemoved, 2);
});

test('exact dedupe does not combine incompatible typed metadata fragments', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru reported an audience metric.',
      url: 'https://same.example/profile',
      category: 'subscribers',
      unit: 'subscribers',
    },
    {
      claim: 'Emiru reported an audience metric.',
      url: 'https://same.example/profile',
      category: 'followers',
      value: 1_000_000,
      unit: 'followers',
    },
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].category, 'subscribers');
  assert.equal(bundle.evidence[0].unit, 'subscribers');
  assert.equal(bundle.evidence[0].value, undefined);
});

test('near dedupe enriches compatible typed metadata from the richer candidate', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru reached one major audience milestone in July 2026.',
      url: 'https://a.example/profile',
    },
    {
      claim: 'In July 2026 Emiru reached one major audience milestone.',
      url: 'https://b.example/profile',
      value: 1_000_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
    },
  ], {options: {nearDuplicateThreshold: 0.7}}));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].category, 'followers');
  assert.equal(bundle.evidence[0].claimDate, '2026-07-01');
  assert.equal(bundle.evidence[0].value, 1_000_000);
  assert.equal(bundle.evidence[0].unit, 'followers');
  assert.equal(bundle.stats.nearDuplicatesMerged, 1);
});

test('impossible ISO datetimes are rejected instead of calendar-normalized', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Valid dated evidence.', url: 'https://example.com/valid', publishedAt: '2026-02-28T08:00:00Z'},
    {claim: 'Impossible publication datetime.', url: 'https://example.com/bad-published', publishedAt: '2026-02-31T08:00:00Z'},
    {claim: 'Impossible claim datetime.', url: 'https://example.com/bad-claim', claimDate: '2026-04-31T09:30:00+07:00'},
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.deepEqual(bundle.rejectedItems.map(({index}) => index), [1, 2]);
});

test('maxEvidence keeps the highest-quality non-conflict evidence', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru low quality fact.',
      url: 'https://aggregator.example/low',
      sourceType: 'aggregator',
    },
    {
      claim: 'Emiru official high quality fact.',
      url: 'https://official.example/high',
      sourceType: 'official',
      title: 'Official profile',
      publisher: 'Official Example',
      publishedAt: '2026-08-10T08:00:00Z',
      excerpt: 'Emiru official high quality fact with direct supporting context from the primary source.',
    },
  ], {options: {maxEvidence: 1}}));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].sources[0].sourceType, 'official');
});

test('maxEvidence detects conflicts first and retains a conflict group atomically', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million followers.',
      url: 'https://a.example/followers',
      value: 2_100_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
      sourceType: 'news',
    },
    {
      claim: 'Emiru had 2.4 million followers.',
      url: 'https://b.example/followers',
      value: 2_400_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
      sourceType: 'news',
    },
    {
      claim: 'Emiru official high quality fact.',
      url: 'https://official.example/high',
      sourceType: 'official',
      title: 'Official profile',
      publisher: 'Official Example',
      publishedAt: '2026-08-10T08:00:00Z',
      excerpt: 'Emiru official high quality fact with direct supporting context from the primary source.',
    },
  ], {options: {maxEvidence: 2}}));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
  assert.deepEqual(
    bundle.evidence.map(({value}) => value).sort((a, b) => a - b),
    [2_100_000, 2_400_000],
  );
});
