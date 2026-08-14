import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';

import {createSafeFetcher} from '../../security/safe-fetch.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const response = (statusCode, headers = {}, chunks = []) => Object.assign(Readable.from(chunks), {
  statusCode,
  headers,
});

const requestFactory = (handler) => (options, callback) => {
  const request = new EventEmitter();
  request.end = () => callback(handler(options));
  request.destroy = (error) => {
    if (error) queueMicrotask(() => request.emit('error', error));
  };
  return request;
};

test('timeout budget is shared across DNS and redirect hops instead of resetting per operation', async () => {
  let nowMs = 1000;
  const fetcher = createSafeFetcher({
    now: () => nowMs,
    lookup: async (hostname) => {
      nowMs += 8;
      if (hostname === 'a.test') return [{address: '93.184.216.34', family: 4}];
      if (hostname === 'b.test') return [{address: '93.184.216.35', family: 4}];
      throw new Error('unexpected hostname');
    },
    httpRequest: requestFactory((options) => {
      nowMs += 8;
      if (options.headers.host === 'a.test') {
        return response(302, {location: 'http://b.test/final'});
      }
      return response(200, {'content-type': 'text/plain'}, ['late']);
    }),
  });

  await assert.rejects(
    fetcher.fetchBuffer('http://a.test/start', {
      timeoutMs: 20,
      maxBytes: 1024,
      maxRedirects: 3,
      allowedMimeTypes: ['text/plain'],
    }),
    (error) => error.code === ErrorCodes.FETCH_TIMEOUT,
  );
});
