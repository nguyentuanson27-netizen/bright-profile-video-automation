import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDownloadToken,
  verifyDownloadToken,
} from '../../security/download-token.mjs';

test('generateDownloadToken creates an HMAC signed token with expiration', () => {
  const secret = 'secret-key-1234567890-abcdefg';
  const nowMs = 1700000000000;
  const token = generateDownloadToken({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    artifactId: 'art-1',
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  assert.ok(typeof token === 'string');
  assert.ok(token.includes('.'));

  const verified = verifyDownloadToken({
    token,
    secret,
    nowMs: nowMs + 10000,
  });

  assert.equal(verified.projectId, 'proj-1');
  assert.equal(verified.revisionId, 'rev-1');
  assert.equal(verified.artifactId, 'art-1');
});

test('verifyDownloadToken rejects expired token', () => {
  const secret = 'secret-key-1234567890-abcdefg';
  const nowMs = 1700000000000;
  const token = generateDownloadToken({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    artifactId: 'art-1',
    secret,
    ttlSeconds: 60,
    nowMs,
  });

  assert.throws(
    () => verifyDownloadToken({token, secret, nowMs: nowMs + 65000}),
    {code: 'DOWNLOAD_TOKEN_EXPIRED'},
  );
});

test('verifyDownloadToken rejects tampered signature', () => {
  const secret = 'secret-key-1234567890-abcdefg';
  const nowMs = 1700000000000;
  const token = generateDownloadToken({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    artifactId: 'art-1',
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  const [payload, sig] = token.split('.');
  const tampered = `${payload}.tampered${sig.slice(8)}`;

  assert.throws(
    () => verifyDownloadToken({token: tampered, secret, nowMs}),
    {code: 'DOWNLOAD_TOKEN_INVALID'},
  );
});

test('verifyDownloadToken rejects wrong secret', () => {
  const secret = 'secret-key-1234567890-abcdefg';
  const wrongSecret = 'different-secret-key-9999999';
  const nowMs = 1700000000000;
  const token = generateDownloadToken({
    projectId: 'proj-1',
    revisionId: 'rev-1',
    artifactId: 'art-1',
    secret,
    ttlSeconds: 600,
    nowMs,
  });

  assert.throws(
    () => verifyDownloadToken({token, secret: wrongSecret, nowMs}),
    {code: 'DOWNLOAD_TOKEN_INVALID'},
  );
});