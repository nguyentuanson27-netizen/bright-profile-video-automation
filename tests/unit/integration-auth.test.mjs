import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidBearerToken,
  compareTokensConstantTime,
  extractBearerToken,
  redactSecrets,
} from '../../security/integration-auth.mjs';

test('extractBearerToken extracts token from standard Authorization header', () => {
  assert.equal(extractBearerToken('Bearer secret-token-123'), 'secret-token-123');
  assert.equal(extractBearerToken('bearer secret-token-123'), 'secret-token-123');
  assert.equal(extractBearerToken('BEARER   secret-token-123  '), 'secret-token-123');
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(extractBearerToken('Bearer '), null);
});

test('compareTokensConstantTime safely verifies matching and non-matching tokens', () => {
  assert.equal(compareTokensConstantTime('token-abc-123', 'token-abc-123'), true);
  assert.equal(compareTokensConstantTime('token-abc-123', 'token-abc-124'), false);
  assert.equal(compareTokensConstantTime('short', 'longer-token-value'), false);
  assert.equal(compareTokensConstantTime('', 'token'), false);
  assert.equal(compareTokensConstantTime(null, 'token'), false);
  assert.equal(compareTokensConstantTime('token', undefined), false);
});

test('assertValidBearerToken validates token against expected secret and throws on mismatch', () => {
  assert.doesNotThrow(() => assertValidBearerToken('Bearer valid-secret', 'valid-secret'));

  assert.throws(
    () => assertValidBearerToken('Bearer wrong-secret', 'valid-secret'),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401,
  );

  assert.throws(
    () => assertValidBearerToken('', 'valid-secret'),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401,
  );

  assert.throws(
    () => assertValidBearerToken(undefined, 'valid-secret'),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401,
  );
});

test('assertValidBearerToken fails closed when expected secret is empty or not configured', () => {
  assert.throws(
    () => assertValidBearerToken('Bearer valid-secret', ''),
    (error) => error.code === 'AUTH_NOT_CONFIGURED' && error.status === 500,
  );
  assert.throws(
    () => assertValidBearerToken('Bearer valid-secret', undefined),
    (error) => error.code === 'AUTH_NOT_CONFIGURED' && error.status === 500,
  );
});

test('redactSecrets sanitizes headers and objects containing credentials', () => {
  const headers = {
    authorization: 'Bearer super-secret-key',
    'x-bright-service-token': 'another-secret',
    'content-type': 'application/json',
  };
  const redacted = redactSecrets(headers);
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted['x-bright-service-token'], '[REDACTED]');
  assert.equal(redacted['content-type'], 'application/json');
});