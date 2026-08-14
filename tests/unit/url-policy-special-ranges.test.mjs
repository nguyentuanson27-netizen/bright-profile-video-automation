import test from 'node:test';
import assert from 'node:assert/strict';

import {assertSafePublicUrl, isPublicIp} from '../../security/url-policy.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const blockedIps = [
  '192.31.196.1',
  '192.52.193.1',
  '192.175.48.1',
  '::ffff:8.8.8.8',
  '2001:3::1',
  '2001:4:112::1',
  '2620:4f:8000::1',
  '5f00::1',
];

test('IANA special-purpose IP ranges remain blocked even when some are globally reachable', () => {
  for (const address of blockedIps) {
    assert.equal(isPublicIp(address), false, address);
    const literal = address.includes(':') ? `[${address}]` : address;
    assert.throws(
      () => assertSafePublicUrl(`https://${literal}/`),
      (error) => error.code === ErrorCodes.FETCH_BLOCKED,
      address,
    );
  }
});
