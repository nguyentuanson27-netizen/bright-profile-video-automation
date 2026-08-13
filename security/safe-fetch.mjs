import {randomUUID} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {once} from 'node:events';
import {createWriteStream, mkdirSync, renameSync, rmSync} from 'node:fs';
import {request as nodeHttpRequest} from 'node:http';
import {request as nodeHttpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {dirname, resolve} from 'node:path';

import {AppError, ErrorCodes} from '../domain/errors.mjs';
import {assertSafePublicUrl, isPublicIp, normalizedHostname} from './url-policy.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TIMEOUT_MS = 120_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const fetchError = (code, message, status = 502) => new AppError(code, message, {status});
const timeoutError = () => fetchError(ErrorCodes.FETCH_TIMEOUT, 'Outbound fetch timed out', 504);
const blockedError = (message = 'Outbound target did not resolve to a public address') => fetchError(
  ErrorCodes.FETCH_BLOCKED,
  message,
  400,
);

const assertInteger = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
};

const validateOptions = ({timeoutMs, maxBytes, maxRedirects = 5, allowedMimeTypes}) => {
  assertInteger(timeoutMs, 'timeoutMs', 1, MAX_TIMEOUT_MS);
  assertInteger(maxBytes, 'maxBytes', 1, MAX_BYTES);
  assertInteger(maxRedirects, 'maxRedirects', 0, MAX_REDIRECTS);
  if (!Array.isArray(allowedMimeTypes) || allowedMimeTypes.length === 0 || allowedMimeTypes.length > 32) {
    throw new TypeError('allowedMimeTypes must contain between 1 and 32 MIME patterns');
  }
  const mimeTypes = allowedMimeTypes.map((value) => String(value).trim().toLowerCase());
  if (mimeTypes.some((value) => !/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(value))) {
    throw new TypeError('allowedMimeTypes contains an invalid MIME pattern');
  }
  return {timeoutMs, maxBytes, maxRedirects, allowedMimeTypes: mimeTypes};
};

const firstHeader = (headers, name) => {
  const raw = headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

const mimeTypeFromHeaders = (headers) => {
  const value = firstHeader(headers, 'content-type');
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
};

const contentLengthFromHeaders = (headers) => {
  const value = firstHeader(headers, 'content-length');
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw fetchError(ErrorCodes.FETCH_TOO_LARGE, 'Response Content-Length is invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw fetchError(ErrorCodes.FETCH_TOO_LARGE, 'Response Content-Length is invalid');
  }
  return parsed;
};

const mimeAllowed = (mimeType, allowed) => allowed.some((pattern) => (
  pattern.endsWith('/*') ? mimeType.startsWith(pattern.slice(0, -1)) : mimeType === pattern
));

const withTimeout = async (operation, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const normalizeRecords = (result) => (Array.isArray(result) ? result : [result]).map((record) => {
  const address = String(record?.address ?? '');
  return {address, family: isIP(address)};
});

const networkError = (error) => {
  if (error instanceof AppError) return error;
  return fetchError(ErrorCodes.FETCH_NETWORK_ERROR, 'Outbound fetch failed');
};

export const createSafeFetcher = ({
  lookup = dnsLookup,
  httpRequest = nodeHttpRequest,
  httpsRequest = nodeHttpsRequest,
} = {}) => {
  const resolvePinnedAddress = async (url, timeoutMs) => {
    const hostname = normalizedHostname(url);
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      if (!isPublicIp(hostname)) throw blockedError('Non-public IP targets are not allowed');
      return {address: hostname, family: literalFamily};
    }

    let result;
    try {
      result = await withTimeout(() => lookup(hostname, {all: true, verbatim: true}), timeoutMs);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw blockedError('Hostname resolution failed closed');
    }
    const records = normalizeRecords(result);
    if (records.length === 0 || records.some(({address, family}) => !family || !isPublicIp(address))) {
      throw blockedError();
    }
    return records[0];
  };

  const openPinnedResponse = async (url, pinned, timeoutMs, allowedMimeTypes) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const originalHostname = normalizedHostname(url);
    const options = {
      protocol: url.protocol,
      method: 'GET',
      hostname: pinned.address,
      family: pinned.family,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        host: url.host,
        accept: allowedMimeTypes.join(', '),
        'user-agent': 'bright-profile-video-automation/0.1',
      },
    };
    if (url.protocol === 'https:') {
      options.rejectUnauthorized = true;
      if (!isIP(originalHostname)) options.servername = originalHostname;
    }

    let request;
    let response;
    let settled = false;
    let timer;
    return new Promise((resolveOpened, rejectOpened) => {
      const rejectBeforeHeaders = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectOpened(networkError(error));
      };
      timer = setTimeout(() => {
        const error = timeoutError();
        response?.destroy?.(error);
        request?.destroy?.(error);
        if (!settled) {
          settled = true;
          rejectOpened(error);
        }
      }, timeoutMs);
      timer.unref?.();

      try {
        request = requestFn(options, (incoming) => {
          if (settled) {
            incoming.destroy?.();
            return;
          }
          response = incoming;
          settled = true;
          resolveOpened({response, close: () => clearTimeout(timer)});
        });
        request.once('error', (error) => {
          if (!settled) rejectBeforeHeaders(error);
          else if (response && !response.destroyed) response.destroy(networkError(error));
        });
        request.end();
      } catch (error) {
        rejectBeforeHeaders(error);
      }
    });
  };

  const openFinalResponse = async (input, rawOptions) => {
    const options = validateOptions(rawOptions);
    let url = assertSafePublicUrl(input);
    for (let redirects = 0; ; redirects += 1) {
      const pinned = await resolvePinnedAddress(url, options.timeoutMs);
      const handle = await openPinnedResponse(url, pinned, options.timeoutMs, options.allowedMimeTypes);
      const {response} = handle;
      const statusCode = Number(response.statusCode ?? 0);
      if (REDIRECT_STATUSES.has(statusCode)) {
        const location = firstHeader(response.headers, 'location');
        response.destroy?.();
        handle.close();
        if (typeof location !== 'string' || location.length === 0) {
          throw fetchError(ErrorCodes.FETCH_HTTP_STATUS, 'Redirect response is missing Location');
        }
        if (redirects >= options.maxRedirects) {
          throw fetchError(ErrorCodes.FETCH_REDIRECT_LIMIT, 'Outbound redirect limit exceeded');
        }
        url = assertSafePublicUrl(new URL(location, url));
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.destroy?.();
        handle.close();
        throw fetchError(ErrorCodes.FETCH_HTTP_STATUS, `Outbound server returned HTTP ${statusCode}`);
      }
      const mimeType = mimeTypeFromHeaders(response.headers);
      if (!mimeAllowed(mimeType, options.allowedMimeTypes)) {
        response.destroy?.();
        handle.close();
        throw fetchError(ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE, 'Response MIME type is not allowed', 415);
      }
      const contentLength = contentLengthFromHeaders(response.headers);
      if (contentLength !== null && contentLength > options.maxBytes) {
        response.destroy?.();
        handle.close();
        throw fetchError(ErrorCodes.FETCH_TOO_LARGE, 'Response exceeds byte limit', 413);
      }
      return {url, response, close: handle.close, mimeType, options};
    }
  };

  const fetchBuffer = async (input, rawOptions) => {
    const opened = await openFinalResponse(input, rawOptions);
    const chunks = [];
    let bytes = 0;
    try {
      for await (const rawChunk of opened.response) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        bytes += chunk.length;
        if (bytes > opened.options.maxBytes) {
          opened.response.destroy?.();
          throw fetchError(ErrorCodes.FETCH_TOO_LARGE, 'Response exceeds byte limit', 413);
        }
        chunks.push(chunk);
      }
      return {
        url: opened.url.href,
        status: Number(opened.response.statusCode),
        mimeType: opened.mimeType,
        bytes,
        body: Buffer.concat(chunks, bytes),
      };
    } catch (error) {
      throw networkError(error);
    } finally {
      opened.close();
    }
  };

  const fetchToFile = async (input, destinationPath, rawOptions) => {
    if (typeof destinationPath !== 'string' || destinationPath.length === 0) throw new TypeError('destinationPath is required');
    const opened = await openFinalResponse(input, rawOptions);
    const destination = resolve(destinationPath);
    const tempPath = `${destination}.part-${randomUUID()}`;
    mkdirSync(dirname(destination), {recursive: true});
    const output = createWriteStream(tempPath, {flags: 'wx'});
    let bytes = 0;
    try {
      for await (const rawChunk of opened.response) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        bytes += chunk.length;
        if (bytes > opened.options.maxBytes) {
          opened.response.destroy?.();
          throw fetchError(ErrorCodes.FETCH_TOO_LARGE, 'Response exceeds byte limit', 413);
        }
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      renameSync(tempPath, destination);
      return {
        url: opened.url.href,
        status: Number(opened.response.statusCode),
        mimeType: opened.mimeType,
        bytes,
        path: destination,
      };
    } catch (error) {
      output.destroy();
      rmSync(tempPath, {force: true});
      throw networkError(error);
    } finally {
      opened.close();
    }
  };

  return Object.freeze({fetchBuffer, fetchToFile});
};
