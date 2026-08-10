import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {AppError} from '../../domain/errors.mjs';
import {isPublicIp, resolvePublicTarget} from '../../security/url-policy.mjs';
import {safeFetchBuffer, safeFetchStream} from '../../security/safe-fetch.mjs';

const PUBLIC_IP = '93.184.216.34';

const fakeLookup = (mapping) => async (hostname) => {
  const records = mapping[hostname];
  if (!records) {
    const error = new Error(`No fake DNS record for ${hostname}`);
    error.code = 'ENOTFOUND';
    throw error;
  }
  return records;
};

const response = ({statusCode = 200, headers = {}, chunks = []} = {}) => ({
  statusCode,
  headers,
  body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
});

test('IP policy rejects loopback, private, link-local, reserved, and mapped-private addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.10',
    '203.0.113.10',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp(PUBLIC_IP), true);
  assert.equal(isPublicIp('2606:2800:220:1:248:1893:25c8:1946'), true);
});

test('direct private IP is rejected before any transport call', async () => {
  let transportCalls = 0;
  await assert.rejects(
    () => safeFetchStream('http://127.0.0.1/private', {
      requestTransport: async () => {
        transportCalls += 1;
        return response();
      },
    }),
    (error) => error instanceof AppError && error.code === 'SSRF_BLOCKED_ADDRESS',
  );
  assert.equal(transportCalls, 0);
});

test('DNS resolving to a private IP is rejected before transport', async () => {
  let transportCalls = 0;
  await assert.rejects(
    () => safeFetchStream('https://private.test/data', {
      lookup: fakeLookup({'private.test': [{address: '10.10.0.4', family: 4}]}),
      requestTransport: async () => {
        transportCalls += 1;
        return response();
      },
    }),
    (error) => error instanceof AppError && error.code === 'SSRF_BLOCKED_ADDRESS',
  );
  assert.equal(transportCalls, 0);
});

test('public to private redirect is revalidated and blocked', async () => {
  const calls = [];
  await assert.rejects(
    () => safeFetchStream('https://public.test/start', {
      lookup: fakeLookup({
        'public.test': [{address: PUBLIC_IP, family: 4}],
        'internal.test': [{address: '192.168.1.10', family: 4}],
      }),
      requestTransport: async (request) => {
        calls.push(request);
        return response({statusCode: 302, headers: {location: 'http://internal.test/secret'}});
      },
    }),
    (error) => error instanceof AppError && error.code === 'SSRF_BLOCKED_ADDRESS',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, PUBLIC_IP);
});

test('public fetch connects to the validated IP and forwards only application-owned safe headers', async () => {
  let observed;
  const result = await safeFetchBuffer('https://public.test/profile', {
    lookup: fakeLookup({'public.test': [{address: PUBLIC_IP, family: 4}]}),
    allowedContentTypes: ['text/html'],
    maxBytes: 1024,
    accept: 'text/html',
    userAgent: 'BrightProfileTest/1.0',
    requestTransport: async (request) => {
      observed = request;
      return response({
        headers: {'content-type': 'text/html; charset=utf-8', 'content-length': '11'},
        chunks: ['hello ', 'world'],
      });
    },
  });

  assert.equal(result.body.toString('utf8'), 'hello world');
  assert.equal(result.contentType, 'text/html');
  assert.equal(observed.address, PUBLIC_IP);
  assert.equal(observed.headers.host, 'public.test');
  assert.equal(observed.headers['accept-encoding'], 'identity');
  assert.equal(observed.headers.accept, 'text/html');
  assert.equal(observed.headers['user-agent'], 'BrightProfileTest/1.0');
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers.cookie, undefined);
});

test('response MIME type must match the purpose allowlist', async () => {
  await assert.rejects(
    () => safeFetchStream('https://public.test/file', {
      lookup: fakeLookup({'public.test': [{address: PUBLIC_IP, family: 4}]}),
      allowedContentTypes: ['image/*'],
      requestTransport: async () => response({
        headers: {'content-type': 'text/html'},
        chunks: ['<html>not an image</html>'],
      }),
    }),
    (error) => error instanceof AppError && error.code === 'FETCH_CONTENT_TYPE_REJECTED',
  );
});

test('content-length above the configured bound is rejected before streaming', async () => {
  await assert.rejects(
    () => safeFetchStream('https://public.test/large', {
      lookup: fakeLookup({'public.test': [{address: PUBLIC_IP, family: 4}]}),
      maxBytes: 5,
      requestTransport: async () => response({
        headers: {'content-type': 'text/plain', 'content-length': '100'},
        chunks: ['too large'],
      }),
    }),
    (error) => error instanceof AppError && error.code === 'FETCH_BODY_TOO_LARGE',
  );
});

test('stream body is bounded even when content-length is absent', async () => {
  const result = await safeFetchStream('https://public.test/chunked', {
    lookup: fakeLookup({'public.test': [{address: PUBLIC_IP, family: 4}]}),
    maxBytes: 5,
    requestTransport: async () => response({
      headers: {'content-type': 'text/plain'},
      chunks: ['123', '456'],
    }),
  });

  await assert.rejects(
    async () => {
      for await (const _chunk of result.body) {
        // Consume the bounded stream; the second chunk must cross the limit.
      }
    },
    (error) => error instanceof AppError && error.code === 'FETCH_BODY_TOO_LARGE',
  );
});

test('URL policy rejects credentials, non-HTTP protocols, and empty DNS results', async () => {
  await assert.rejects(
    () => resolvePublicTarget('https://user:pass@public.test/', {
      lookup: fakeLookup({'public.test': [{address: PUBLIC_IP, family: 4}]}),
    }),
    (error) => error instanceof AppError && error.code === 'FETCH_URL_CREDENTIALS_REJECTED',
  );
  await assert.rejects(
    () => resolvePublicTarget('file:///etc/passwd'),
    (error) => error instanceof AppError && error.code === 'FETCH_PROTOCOL_REJECTED',
  );
  await assert.rejects(
    () => resolvePublicTarget('https://empty.test/', {lookup: async () => []}),
    (error) => error instanceof AppError && error.code === 'FETCH_DNS_EMPTY',
  );
});
