import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';
import {normalizeClaim, normalizeTypedValue} from '../../lib/evidence/primitives.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru', aliases: ['Emily Schunk']},
  researchQuery: 'review 4907856994 regressions',
  researchedAt: '2026-08-11T08:00:00Z',
  items,
  ...extra,
});

test('explicit numeric contradictions in claim text do not near-merge when value is omitted', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million Twitch followers on July 1 2026 according to the public platform profile.',
      url: 'https://a.example/twitch',
      unit: 'followers',
      category: 'audience_metric',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru had 2.4 million Twitch followers on July 1 2026 according to the public platform profile.',
      url: 'https://b.example/twitch',
      unit: 'followers',
      category: 'audience_metric',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.stats.nearDuplicatesMerged, 0);
  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
});

test('claimDate metadata does not consume an unrelated metric equal to the day number', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru attended 12 Twitch events during the reporting period.',
      url: 'https://a.example/events',
      unit: 'events',
      claimDate: '2026-07-12',
    },
    {
      claim: 'Emiru attended 14 Twitch events during the reporting period.',
      url: 'https://b.example/events',
      unit: 'events',
      claimDate: '2026-07-12',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
});

test('uncategorized comparable numeric facts can still form a conflict', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million Twitch followers.',
      url: 'https://a.example/twitch',
      value: 2_100_000,
      unit: 'followers',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru had 2.4 million Twitch followers.',
      url: 'https://b.example/twitch',
      value: 2_400_000,
      unit: 'followers',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.match(bundle.conflicts[0].factKey, /uncategorized/);
});

test('single three-digit separators stay textual without an explicit locale', () => {
  assert.deepEqual(normalizeTypedValue('1,234', 'followers'), {value: '1,234', unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('1.234', 'followers'), {value: '1.234', unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('2,1M', 'followers'), {value: 2_100_000, unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('12.5%', undefined), {value: 12.5, unit: 'percent'});
  assert.equal(
    normalizeClaim('Emiru had 1,234K followers and a public profile.', {name: 'Emiru'}),
    '__subject__ had 1 234k followers and a public profile.',
  );
  assert.equal(
    normalizeClaim('Emiru had 1.234K followers and a public profile.', {name: 'Emiru'}),
    '__subject__ had 1.234k followers and a public profile.',
  );
});

test('source overflow retains the strongest emitted provenance used for scoring', () => {
  const items = Array.from({length: 20}, (_, index) => ({
    claim: 'Emiru reached 2.1 million Twitch followers.',
    url: `https://a-${String(index).padStart(2, '0')}.example/story`,
    value: 2_100_000,
    unit: 'followers',
    category: 'audience_metric',
    claimDate: '2026-07-01',
    sourceType: 'news',
  }));
  items.push({
    claim: 'Emiru reached 2.1 million Twitch followers.',
    url: 'https://zzz-official.example/profile',
    title: 'Official profile',
    publisher: 'Official profile',
    author: 'Platform',
    publishedAt: '2026-07-01T00:00:00Z',
    excerpt: 'The official profile directly reports 2.1 million Twitch followers for Emiru.',
    value: 2_100_000,
    unit: 'followers',
    category: 'audience_metric',
    claimDate: '2026-07-01',
    sourceType: 'official',
  });

  const bundle = normalizeEvidence(base(items));
  const evidence = bundle.evidence[0];
  assert.equal(evidence.sources.length, 20);
  assert.equal(evidence.omittedSourceCount, 1);
  assert.ok(evidence.sources.some((source) => source.sourceType === 'official'));
  assert.equal(evidence.confidence, 'high');
});

test('production verification gates dependency audit and pins mutable supply-chain references', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/mcp-verify.yml', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../../Dockerfile.mcp', import.meta.url), 'utf8');

  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(dockerfile, /^FROM node:24\.18\.0-bookworm-slim@sha256:[0-9a-f]{64}$/m);
});

test('rate limiter bounds active remote buckets and admits new clients after expiry', async () => {
  const serverModule = await import('../../mcp/server.mjs');
  assert.equal(typeof serverModule.makeRateLimiter, 'function');

  const allow = serverModule.makeRateLimiter({limit: 1, windowMs: 1_000, maxBuckets: 2});
  assert.equal(allow('client-a', 0), true);
  assert.equal(allow('client-a', 1), false);
  assert.equal(allow('client-b', 1), true);
  assert.equal(allow('client-c', 1), false);
  assert.equal(allow('client-c', 1_001), true);
});
