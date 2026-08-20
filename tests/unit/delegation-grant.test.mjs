import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueDelegationGrant,
  verifyDelegationGrant,
} from '../../security/delegation-grant.mjs';

test('issueDelegationGrant creates a verifiable HMAC signed grant', () => {
  const secret = 'service-secret-token-key-123456';
  const nowMs = 1700000000000;
  const grant = issueDelegationGrant({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  assert.ok(typeof grant === 'string');
  assert.ok(grant.includes('.'));

  const verified = verifyDelegationGrant({
    grant,
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    nowMs: nowMs + 10000,
  });

  assert.equal(verified.projectId, 'proj-1');
  assert.equal(verified.revisionId, 'rev-1');
  assert.equal(verified.payloadHash, 'a'.repeat(64));
});

test('verifyDelegationGrant rejects expired grant', () => {
  const secret = 'service-secret-token-key-123456';
  const nowMs = 1700000000000;
  const grant = issueDelegationGrant({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    ttlSeconds: 60,
    nowMs,
  });

  assert.throws(
    () => verifyDelegationGrant({
      grant,
      projectId: 'proj-1',
      revisionId: 'rev-1',
      payloadHash: 'a'.repeat(64),
      secret,
      nowMs: nowMs + 65000,
    }),
    {code: 'DELEGATED_APPROVAL_BLOCKED'},
  );
});

test('verifyDelegationGrant rejects mismatched projectId', () => {
  const secret = 'service-secret-token-key-123456';
  const nowMs = 1700000000000;
  const grant = issueDelegationGrant({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  assert.throws(
    () => verifyDelegationGrant({
      grant,
      projectId: 'proj-2',
      revisionId: 'rev-1',
      payloadHash: 'a'.repeat(64),
      secret,
      nowMs,
    }),
    {code: 'DELEGATED_APPROVAL_BLOCKED'},
  );
});

test('verifyDelegationGrant rejects mismatched payloadHash', () => {
  const secret = 'service-secret-token-key-123456';
  const nowMs = 1700000000000;
  const grant = issueDelegationGrant({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  assert.throws(
    () => verifyDelegationGrant({
      grant,
      projectId: 'proj-1',
      revisionId: 'rev-1',
      payloadHash: 'b'.repeat(64),
      secret,
      nowMs,
    }),
    {code: 'DELEGATED_APPROVAL_BLOCKED'},
  );
});

test('verifyDelegationGrant rejects tampered grant', () => {
  const secret = 'service-secret-token-key-123456';
  const nowMs = 1700000000000;
  const grant = issueDelegationGrant({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    payloadHash: 'a'.repeat(64),
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  const [payload, sig] = grant.split('.');
  const tampered = `${payload}.tampered${sig.slice(8)}`;

  assert.throws(
    () => verifyDelegationGrant({
      grant: tampered,
      projectId: 'proj-1',
      revisionId: 'rev-1',
      payloadHash: 'a'.repeat(64),
      secret,
      nowMs,
    }),
    {code: 'DELEGATED_APPROVAL_BLOCKED'},
  );
});