import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const base = (items, extra = {}) => ({
  subject: {name: 'Emiru'},
  researchQuery: 'review 4908399564 regressions',
  researchedAt: '2026-08-12T02:00:00Z',
  items,
  ...extra,
});

test('explicit currency symbols remain part of claim identity when typed metadata is omitted', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Acme paid Emiru $5 million.',
      url: 'https://a.example/payment',
      category: 'payment_amount',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Acme paid Emiru €5 million.',
      url: 'https://b.example/payment',
      category: 'payment_amount',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.stats.exactDuplicatesRemoved, 0);
  assert.equal(bundle.evidence.length, 2);
  assert.notEqual(bundle.evidence[0].claimNormalized, bundle.evidence[1].claimNormalized);
});

test('signed numeric contradictions do not near-merge when value is omitted', () => {
  const percent = normalizeEvidence(base([
    {
      claim: 'Emiru margin was -5% in July 2026 according to the public quarterly report.',
      url: 'https://a.example/margin',
      category: 'margin',
      unit: 'percent',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru margin was +5% in July 2026 according to the public quarterly report.',
      url: 'https://b.example/margin',
      category: 'margin',
      unit: 'percent',
      claimDate: '2026-07-01',
    },
  ]));
  assert.equal(percent.stats.nearDuplicatesMerged, 0);
  assert.equal(percent.evidence.length, 2);
  assert.equal(percent.conflicts.length, 1);

  const abbreviated = normalizeEvidence(base([
    {
      claim: 'Emiru monthly views changed by -2.1M in July 2026 according to the public analytics report.',
      url: 'https://a.example/views',
      category: 'views_change',
      unit: 'views',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru monthly views changed by +2.1M in July 2026 according to the public analytics report.',
      url: 'https://b.example/views',
      category: 'views_change',
      unit: 'views',
      claimDate: '2026-07-01',
    },
  ]));
  assert.equal(abbreviated.stats.nearDuplicatesMerged, 0);
  assert.equal(abbreviated.evidence.length, 2);
  assert.equal(abbreviated.conflicts.length, 1);
});

test('named-month date cleanup does not consume a metric equal to the month number', () => {
  const bundle = normalizeEvidence(base([
    {
      claim: 'Emiru attended 7 Twitch events in July 2026.',
      url: 'https://a.example/events',
      category: 'event_count',
      unit: 'events',
      claimDate: '2026-07-01',
    },
    {
      claim: 'Emiru attended 8 Twitch events in July 2026.',
      url: 'https://b.example/events',
      category: 'event_count',
      unit: 'events',
      claimDate: '2026-07-01',
    },
  ]));

  assert.equal(bundle.evidence.length, 2);
  assert.equal(bundle.conflicts.length, 1);
  assert.equal(bundle.conflicts[0].evidenceIds.length, 2);
});

test('explicit string and boolean values are excluded from fact identity before conflict comparison', () => {
  const stringBundle = normalizeEvidence(base([
    {
      claim: 'Emiru partnership with Acme ended.',
      url: 'https://a.example/partnership',
      category: 'partnership_status',
      claimDate: '2026-07-01',
      value: 'ended',
    },
    {
      claim: 'Emiru partnership with Acme remains active.',
      url: 'https://b.example/partnership',
      category: 'partnership_status',
      claimDate: '2026-07-01',
      value: 'active',
    },
  ]));
  assert.equal(stringBundle.evidence.length, 2);
  assert.equal(stringBundle.conflicts.length, 1);

  const booleanBundle = normalizeEvidence(base([
    {
      claim: 'Emiru sponsorship with Acme is active.',
      url: 'https://a.example/sponsorship',
      category: 'sponsorship_status',
      claimDate: '2026-07-01',
      value: true,
    },
    {
      claim: 'Emiru sponsorship with Acme is inactive.',
      url: 'https://b.example/sponsorship',
      category: 'sponsorship_status',
      claimDate: '2026-07-01',
      value: false,
    },
  ]));
  assert.equal(booleanBundle.evidence.length, 2);
  assert.equal(booleanBundle.conflicts.length, 1);
});

test('required subject text and aliases reject blank normalized content while blank claims stay batch-safe', () => {
  assert.throws(
    () => normalizeEvidence({
      subject: {name: ' '},
      items: [{claim: 'Valid evidence claim.', url: 'https://example.com/valid'}],
    }),
    /subject\.name/i,
  );

  assert.throws(
    () => normalizeEvidence({
      subject: {name: 'Emiru', aliases: ['   ']},
      items: [{claim: 'Valid evidence claim.', url: 'https://example.com/valid'}],
    }),
    /alias/i,
  );

  const bundle = normalizeEvidence(base([
    {claim: '   ', url: 'https://example.com/blank'},
    {claim: 'Valid evidence claim.', url: 'https://example.com/valid'},
  ]));
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.rejectedItems.length, 1);
  assert.equal(bundle.rejectedItems[0].index, 0);
  assert.match(bundle.rejectedItems[0].reasons.join(' '), /claim/i);
});
