import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {assertSafePublicUrl, isPublicIp} from '../../security/url-policy.mjs';
import {createSafeFetcher} from '../../security/safe-fetch.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const response = (statusCode, headers = {}, chunks = []) => Object.assign(Readable.from(chunks), {
  statusCode,
  headers,
});

const requestFactory = (handler) => (options, callback) => {
  const request = new EventEmitter();
  let finished = false;
  request.end = () => {
    Promise.resolve(handler(options, request)).then((value) => {
      if (!finished && value) callback(value);
    }, (error) => {
      if (!finished) request.emit('error', error);
    });
  };
  request.destroy = (error) => {
    finished = true;
    request.emit('close');
    if (error) queueMicrotask(() => {
      if (request.listenerCount('error') > 0) request.emit('error', error);
    });
  };
  return request;
};

const lookupFactory = (records) => async (hostname) => {
  const value = records[hostname];
  if (!value) throw new Error(`unexpected DNS lookup: ${hostname}`);
  return value;
};

const expectCode = async (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('URL policy rejects direct private/reserved/metadata targets, localhost and embedded credentials', () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://localhost/',
    'http://service.localhost/',
    'http://user:secret@example.com/',
    'ftp://example.com/file',
  ]) {
    assert.throws(() => assertSafePublicUrl(url), (error) => error.code === ErrorCodes.FETCH_BLOCKED, url);
  }
  assert.equal(isPublicIp('93.184.216.34'), true);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('192.168.1.1'), false);
  assert.equal(isPublicIp('2001:4860:4860::8888'), true);
  assert.equal(isPublicIp('fc00::1'), false);
});

test('DNS resolving to a private address fails before any outbound request', async () => {
  let requests = 0;
  const fetcher = createSafeFetcher({
    lookup: lookupFactory({'private.test': [{address: '10.0.0.7', family: 4}]}),
    httpRequest: requestFactory(() => { requests += 1; return response(200, {'content-type': 'text/plain'}, ['no']); }),
  });
  await expectCode(fetcher.fetchBuffer('http://private.test/', {
    timeoutMs: 100, maxBytes: 1024, allowedMimeTypes: ['text/plain'],
  }), ErrorCodes.FETCH_BLOCKED);
  assert.equal(requests, 0);
});

test('DNS rebinding cannot trigger a second hostname lookup after public validation', async () => {
  let lookups = 0;
  const requestedAddresses = [];
  const fetcher = createSafeFetcher({
    lookup: async (hostname) => {
      assert.equal(hostname, 'rebind.test');
      lookups += 1;
      return lookups === 1
        ? [{address: '93.184.216.34', family: 4}]
        : [{address: '127.0.0.1', family: 4}];
    },
    httpRequest: requestFactory((options) => {
      requestedAddresses.push(options.hostname);
      assert.equal(options.hostname, '93.184.216.34');
      assert.equal(options.headers.host, 'rebind.test');
      assert.equal(options.headers.authorization, undefined);
      return response(200, {'content-type': 'text/plain'}, ['safe']);
    }),
  });
  const result = await fetcher.fetchBuffer('http://rebind.test/resource', {
    timeoutMs: 100, maxBytes: 1024, allowedMimeTypes: ['text/plain'],
  });
  assert.equal(result.body.toString(), 'safe');
  assert.equal(lookups, 1);
  assert.deepEqual(requestedAddresses, ['93.184.216.34']);
});

test('HTTPS pins the validated IP while preserving Host and SNI/certificate hostname', async () => {
  const fetcher = createSafeFetcher({
    lookup: lookupFactory({'secure.test': [{address: '93.184.216.35', family: 4}]}),
    httpsRequest: requestFactory((options) => {
      assert.equal(options.hostname, '93.184.216.35');
      assert.equal(options.headers.host, 'secure.test');
      assert.equal(options.servername, 'secure.test');
      assert.equal(options.rejectUnauthorized, true);
      return response(200, {'content-type': 'application/json'}, ['{}']);
    }),
  });
  await fetcher.fetchBuffer('https://secure.test/data', {
    timeoutMs: 100, maxBytes: 1024, allowedMimeTypes: ['application/json'],
  });
});

test('redirect to a private target is independently resolved and rejected before the second request', async () => {
  const requests = [];
  const fetcher = createSafeFetcher({
    lookup: lookupFactory({
      'public.test': [{address: '93.184.216.34', family: 4}],
      'internal.test': [{address: '10.0.0.8', family: 4}],
    }),
    httpRequest: requestFactory((options) => {
      requests.push(options.hostname);
      return response(302, {location: 'http://internal.test/secret'}, []);
    }),
  });
  await expectCode(fetcher.fetchBuffer('http://public.test/start', {
    timeoutMs: 100, maxBytes: 1024, maxRedirects: 3, allowedMimeTypes: ['text/plain'],
  }), ErrorCodes.FETCH_BLOCKED);
  assert.deepEqual(requests, ['93.184.216.34']);
});

test('every public redirect hop gets a fresh resolve-validation-pin decision', async () => {
  const lookups = [];
  const requests = [];
  const fetcher = createSafeFetcher({
    lookup: async (hostname) => {
      lookups.push(hostname);
      if (hostname === 'a.test') return [{address: '93.184.216.34', family: 4}];
      if (hostname === 'b.test') return [{address: '93.184.216.35', family: 4}];
      throw new Error('unexpected hostname');
    },
    httpRequest: requestFactory((options) => {
      requests.push({hostname: options.hostname, host: options.headers.host});
      if (options.headers.host === 'a.test') return response(301, {location: 'http://b.test/final'}, []);
      return response(200, {'content-type': 'text/plain'}, ['done']);
    }),
  });
  const result = await fetcher.fetchBuffer('http://a.test/start', {
    timeoutMs: 100, maxBytes: 1024, maxRedirects: 3, allowedMimeTypes: ['text/plain'],
  });
  assert.equal(result.body.toString(), 'done');
  assert.deepEqual(lookups, ['a.test', 'b.test']);
  assert.deepEqual(requests, [
    {hostname: '93.184.216.34', host: 'a.test'},
    {hostname: '93.184.216.35', host: 'b.test'},
  ]);
});

test('oversize and disallowed MIME responses fail closed', async () => {
  const lookup = lookupFactory({'asset.test': [{address: '93.184.216.34', family: 4}]});
  const oversize = createSafeFetcher({
    lookup,
    httpRequest: requestFactory(() => response(200, {'content-type': 'image/png', 'content-length': '20'}, ['01234567890123456789'])),
  });
  await expectCode(oversize.fetchBuffer('http://asset.test/image', {
    timeoutMs: 100, maxBytes: 10, allowedMimeTypes: ['image/png'],
  }), ErrorCodes.FETCH_TOO_LARGE);

  const badMime = createSafeFetcher({
    lookup,
    httpRequest: requestFactory(() => response(200, {'content-type': 'text/html'}, ['html'])),
  });
  await expectCode(badMime.fetchBuffer('http://asset.test/image', {
    timeoutMs: 100, maxBytes: 100, allowedMimeTypes: ['image/png'],
  }), ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE);
});

test('request timeout fails with a stable timeout error', async () => {
  const fetcher = createSafeFetcher({
    lookup: lookupFactory({'slow.test': [{address: '93.184.216.34', family: 4}]}),
    httpRequest: requestFactory((options, req) => new Promise((_, reject) => {
      req.once('close', () => reject(new Error('request closed')));
    })),
  });
  await expectCode(fetcher.fetchBuffer('http://slow.test/', {
    timeoutMs: 20, maxBytes: 1024, allowedMimeTypes: ['text/plain'],
  }), ErrorCodes.FETCH_TIMEOUT);
});

test('allowed media streams to disk under byte and MIME limits', async () => {
  const fetcher = createSafeFetcher({
    lookup: lookupFactory({'media.test': [{address: '93.184.216.34', family: 4}]}),
    httpRequest: requestFactory(() => response(200, {'content-type': 'image/png'}, [Buffer.from('abc'), Buffer.from('def')])),
  });
  const destination = join(mkdtempSync(join(tmpdir(), 'bright-fetch-')), 'asset.bin');
  const result = await fetcher.fetchToFile('http://media.test/asset', destination, {
    timeoutMs: 100, maxBytes: 10, allowedMimeTypes: ['image/png'],
  });
  assert.equal(result.bytes, 6);
  assert.equal(readFileSync(destination).toString(), 'abcdef');
});
