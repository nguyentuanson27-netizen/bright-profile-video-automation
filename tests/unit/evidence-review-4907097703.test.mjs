import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';
import {normalizeClaim, normalizeTypedValue} from '../../lib/evidence/primitives.mjs';
import {assertEvidenceBundle} from '../../lib/evidence/schema-validator.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru', aliases: ['Emily Schunk']},
  researchQuery: 'review 4907097703 regressions',
  researchedAt: '2026-08-11T08:00:00Z',
  items,
  ...extra,
});

test('paraphrased claims about the same metric still form a numeric conflict', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru had 2.1 million Twitch followers.',
      url: 'https://a.example/twitch',
      value: 2_100_000,
      unit: 'followers',
      category: 'audience_metric',
      claimDate: '2026-07-01',
    },
    {
      claim: "Emiru's Twitch follower count was 2.4 million.",
      url: 'https://b.example/twitch',
      value: 2_400_000,
      unit: 'followers',
      category: 'audience_metric',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
  assert.match(bundle.conflicts[0].factKey, /twitch/);
});

test('paraphrased claims about the same event can disagree on the event date', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru joined Acme on July 4, 2026.',
      url: 'https://a.example/acme',
      category: 'career_event',
      claimDate: '2026-07-04',
    },
    {
      claim: 'On July 5, 2026, Emiru joined the Acme organization.',
      url: 'https://b.example/acme',
      category: 'career_event',
      claimDate: '2026-07-05',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
  assert.match(bundle.conflicts[0].factKey, /acme/);
  assert.match(bundle.conflicts[0].factKey, /event-date-disputed/);
});

test('numeric separator parsing stays conservative without locale', () => {
  assert.deepEqual(normalizeTypedValue('2,100', 'followers'), {value: '2,100', unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('2,100K', 'followers'), {value: '2,100K', unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('2,1M', 'followers'), {value: 2_100_000, unit: 'followers'});
  assert.deepEqual(normalizeTypedValue('12,5%', undefined), {value: 12.5, unit: 'percent'});
  assert.deepEqual(normalizeTypedValue('1,2345', 'followers'), {value: '1,2345', unit: 'followers'});
});

test('source overflow is deterministic and observable instead of silently lossy', () => {
  const items = Array.from({length: 25}, (_, index) => ({
    claim: 'Emiru reached 2.1 million Twitch followers.',
    url: `https://source-${String(index).padStart(2, '0')}.example/story`,
    value: 2_100_000,
    unit: 'followers',
    category: 'audience_metric',
    claimDate: '2026-07-01',
  }));

  const forward = normalizeEvidence(base(items));
  const reversed = normalizeEvidence(base([...items].reverse()));

  assert.deepEqual(forward, reversed);
  assert.doesNotThrow(() => assertEvidenceBundle(forward));
  assert.equal(forward.evidence.length, 1);
  assert.equal(forward.evidence[0].sources.length, 20);
  assert.equal(forward.evidence[0].omittedSourceCount, 5);
  assert.deepEqual(
    forward.evidence[0].sources.map(({canonicalUrl}) => canonicalUrl),
    [...forward.evidence[0].sources.map(({canonicalUrl}) => canonicalUrl)].sort(),
  );
});

test('subject alias replacement respects token boundaries', () => {
  assert.equal(
    normalizeClaim('An announcement about Ann aired live.', {name: 'Ann'}),
    'an announcement about __subject__ aired live.',
  );
  assert.equal(
    normalizeClaim('Li was listed live on LinkedIn.', {name: 'Li'}),
    '__subject__ was listed live on linkedin.',
  );
});
