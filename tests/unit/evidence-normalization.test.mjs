import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeUrl,
  normalizeClaim,
  normalizeTypedValue,
  tokenSetSimilarity,
} from '../../lib/evidence/primitives.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru', aliases: ['Emily Schunk']},
  researchQuery: 'career and audience metrics',
  researchedAt: '2026-08-11T08:00:00Z',
  items,
  ...extra,
});

test('canonical URL removes tracking params but preserves identity params', () => {
  assert.equal(
    canonicalizeUrl('HTTPS://Example.COM:443/story/?utm_source=x&id=42&fbclid=abc#section'),
    'https://example.com/story?id=42',
  );
});

test('normalizes typed abbreviations and aliases for comparison', () => {
  assert.deepEqual(normalizeTypedValue('2.1M', 'followers'), {value: 2_100_000, unit: 'followers'});
  assert.equal(
    normalizeClaim('Emily Schunk reached 2.1 million followers.', {name: 'Emiru', aliases: ['Emily Schunk']}),
    '__subject__ reached 2100000 followers.',
  );
});

test('token similarity is deterministic', () => {
  assert.equal(tokenSetSimilarity('alpha beta gamma', 'alpha beta gamma'), 1);
  assert.ok(tokenSetSimilarity('alpha beta gamma', 'alpha beta delta') > 0.6);
});

test('exact duplicate URL/claim variants collapse and preserve source coverage', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million followers on July 1, 2026.',
      url: 'https://news-a.example/story?utm_source=x',
      sourceType: 'news',
      value: 2_100_000,
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru had 2.1M followers on July 1, 2026.',
      url: 'https://news-b.example/repost',
      sourceType: 'news',
      value: '2.1M',
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].sources.length, 2);
  assert.equal(bundle.stats.exactDuplicatesRemoved, 1);
});

test('guarded near duplicate merges close paraphrases', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru reached 2.1 million Twitch followers by July 1 2026.',
      url: 'https://a.example/one',
      value: 2_100_000,
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'By July 1 2026 Emiru reached 2.1 million Twitch followers.',
      url: 'https://b.example/two',
      value: 2_100_000,
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.stats.nearDuplicatesMerged, 1);
  assert.equal(bundle.evidence[0].sources.length, 2);
});

test('different explicit values remain separate and form a conflict', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million Twitch followers.',
      url: 'https://a.example/one',
      value: 2_100_000,
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru had 2.4 million Twitch followers.',
      url: 'https://b.example/two',
      value: 2_400_000,
      unit: 'followers',
      category: 'twitch_followers',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
  assert.ok(bundle.evidence.every((item) => item.confidence === 'low'));
});

test('different claim dates do not merge', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million followers.',
      url: 'https://a.example/one',
      value: 2_100_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru had 2.1 million followers.',
      url: 'https://b.example/two',
      value: 2_100_000,
      unit: 'followers',
      category: 'followers',
      claimDate: '2026-07-02',
    },
  ]));
  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 0);
});

test('negated and positive claims never merge', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Emiru joined Example Org in 2026.', url: 'https://a.example/one', category: 'membership'},
    {claim: 'Emiru did not join Example Org in 2026.', url: 'https://b.example/two', category: 'membership'},
  ]));
  assert.equal(bundle.evidence.length, 2);
});

test('malformed individual items are rejected without failing valid evidence', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'A valid factual claim.', url: 'https://example.com/source'},
    {claim: 'x', url: 'javascript:alert(1)'},
  ]));
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.rejectedItems.length, 1);
  assert.equal(bundle.rejectedItems[0].index, 1);
});

test('mixed Vietnamese and English close evidence can merge when tokens align', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Emiru reached 2100000 Twitch followers in 2026.', url: 'https://a.example/one', value: 2100000, unit: 'followers', category: 'followers', claimDate: '2026-07-01'},
    {claim: 'Emiru reached 2.1M Twitch followers in 2026.', url: 'https://b.example/two', value: '2.1M', unit: 'followers', category: 'followers', claimDate: '2026-07-01'},
  ]));
  assert.equal(bundle.evidence.length, 1);
});

test('same input produces byte-equivalent bundle', () => {
  const input = base([{claim: 'Emiru is a creator.', url: 'https://example.com/profile', sourceType: 'official'}]);
  assert.deepEqual(normalizeEvidence(input), normalizeEvidence(input));
});

test('unrelated uncategorized numeric facts do not form a conflict', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Emiru published 100 videos.', url: 'https://a.example/videos', value: 100, unit: 'count'},
    {claim: 'Emiru attended 12 events.', url: 'https://b.example/events', value: 12, unit: 'count'},
  ]));
  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 0);
});

test('exact dedupe propagates fingerprint keys across duplicate chains', () => {
  const bundle = normalizeEvidence(base([
    {claim: 'Emiru reached 1 million followers.', url: 'https://a.example/profile'},
    {claim: 'Emiru reached 1M followers.', url: 'https://a.example/profile', value: 1_000_000, unit: 'followers', category: 'followers'},
    {claim: 'Emiru reached 1M followers.', url: 'https://b.example/profile', value: 1_000_000, unit: 'followers', category: 'followers'},
  ]));
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].sources.length, 2);
  assert.equal(bundle.stats.exactDuplicatesRemoved, 2);
});
