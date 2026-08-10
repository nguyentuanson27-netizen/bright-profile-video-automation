import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import {Transform} from 'node:stream';
import {checkServerIdentity} from 'node:tls';
import {clearTimeout, setTimeout} from 'node:timers';
import {AppError} from '../domain/errors.mjs';
import {resolvePublicTarget} from './url-policy.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const normalizeHostname = (value) => {
  const hostname = String(value).toLowerCase().replace(/\.$/, '');
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
};

const getHeader = (headers, name) => {
  const expected = name.toLowerCase();
  const direct = headers?.[expected];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === expected);
  if (!match) return undefined;
  return Array.isArray(match[1]) ? match[1][0] : match[1];
};

const safeHeaderValue = (value, fallback = '') => {
  const text = String(value || fallback);
  if (text.length > 512 || /[\r\n]/.test(text)) {
    throw new AppError('FETCH_HEADER_INVALID', 'Fetch header value is invalid', {status: 500});
  }
  return text;
};

const contentTypeAllowed = (contentType, allowlist) => allowlist.some((allowed) => {
  const rule = String(allowed).toLowerCase();
  if (rule.endsWith('/*')) return contentType.startsWith(rule.slice(0, -1));
  return contentType === rule;
});

const remainingMs = (deadline) => Math.max(0, deadline - Date.now());
const timeoutError = () => new AppError('FETCH_TIMEOUT', 'Remote fetch timed out', {status: 504, retryable: true});

const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  if (timeoutMs <= 0) {
    reject(timeoutError());
    return;
  }
  const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
});

const defaultRequestTransport = ({url, address, family, headers, timeoutMs}) => new Promise((resolve, reject) => {
  const client = url.protocol === 'https:' ? https : http;
  const originalHostname = normalizeHostname(url.hostname);
  const options = {
    protocol: url.protocol,
    hostname: address,
    family,
    port: url.port || undefined,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers,
    agent: false,
  };

  if (url.protocol === 'https:') {
    options.rejectUnauthorized = true;
    if (!isIP(originalHostname)) options.servername = originalHostname;
    options.checkServerIdentity = (_hostname, cert) => checkServerIdentity(originalHostname, cert);
  }

  let headerTimer;
  const request = client.request(options, (response) => {
    clearTimeout(headerTimer);
    resolve({statusCode: response.statusCode || 0, headers: response.headers, body: response});
  });
  headerTimer = setTimeout(() => request.destroy(timeoutError()), timeoutMs);
  request.setTimeout(timeoutMs, () => request.destroy(timeoutError()));
  request.on('error', (error) => {
    clearTimeout(headerTimer);
    reject(error);
  });
  request.end();
});

const boundedBody = (body, {maxBytes, timeoutMs}) => {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new AppError('FETCH_BODY_TOO_LARGE', 'Remote response exceeds the configured size limit', {status: 413}));
        return;
      }
      callback(null, chunk);
    },
  });

  const timer = setTimeout(() => limiter.destroy(timeoutError()), timeoutMs);
  const cleanup = () => clearTimeout(timer);
  limiter.once('close', cleanup);
  limiter.once('end', cleanup);
  limiter.once('error', () => body.destroy?.());
  body.once?.('error', (error) => limiter.destroy(error));
  body.pipe(limiter);
  return limiter;
};

const normalizeTransportError = (error) => {
  if (error instanceof AppError) return error;
  return new AppError('FETCH_NETWORK_ERROR', 'Remote fetch failed', {status: 502, retryable: true});
};

export async function safeFetchStream(input, {
  lookup,
  requestTransport = defaultRequestTransport,
  timeoutMs = 15_000,
  maxBytes = 5 * 1024 * 1024,
  maxRedirects = 5,
  allowedContentTypes = [],
  accept = '*/*',
  userAgent = 'BrightProfile/1.0',
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new AppError('FETCH_TIMEOUT_INVALID', 'Fetch timeout must be a positive integer', {status: 500});
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AppError('FETCH_SIZE_LIMIT_INVALID', 'Fetch size limit must be a positive integer', {status: 500});
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new AppError('FETCH_REDIRECT_LIMIT_INVALID', 'Fetch redirect limit is invalid', {status: 500});
  }
  if (!Array.isArray(allowedContentTypes)) {
    throw new AppError('FETCH_CONTENT_TYPES_INVALID', 'Fetch content type allowlist is invalid', {status: 500});
  }

  const deadline = Date.now() + timeoutMs;
  let current = input;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let target;
    try {
      target = await withTimeout(resolvePublicTarget(current, {lookup}), remainingMs(deadline));
    } catch (error) {
      throw normalizeTransportError(error);
    }

    const headers = {
      host: target.url.host,
      accept: safeHeaderValue(accept, '*/*'),
      'accept-encoding': 'identity',
      'user-agent': safeHeaderValue(userAgent, 'BrightProfile/1.0'),
    };

    let response;
    try {
      response = await withTimeout(requestTransport({
        url: target.url,
        address: target.address,
        family: target.family,
        headers,
        timeoutMs: remainingMs(deadline),
      }), remainingMs(deadline));
    } catch (error) {
      throw normalizeTransportError(error);
    }

    const statusCode = Number(response?.statusCode || 0);
    const location = getHeader(response?.headers, 'location');
    if (REDIRECT_STATUSES.has(statusCode) && location) {
      response.body?.destroy?.();
      if (redirectCount >= maxRedirects) {
        throw new AppError('FETCH_REDIRECT_LIMIT', 'Remote fetch exceeded the redirect limit', {status: 502});
      }
      try {
        current = new URL(String(location), target.url);
      } catch {
        throw new AppError('FETCH_REDIRECT_INVALID', 'Remote server returned an invalid redirect', {status: 502});
      }
      continue;
    }

    if (!response?.body || typeof response.body.pipe !== 'function') {
      throw new AppError('FETCH_RESPONSE_INVALID', 'Remote server returned an invalid response body', {status: 502});
    }

    const contentEncoding = String(getHeader(response.headers, 'content-encoding') || 'identity').toLowerCase();
    if (contentEncoding !== 'identity') {
      response.body.destroy?.();
      throw new AppError('FETCH_CONTENT_ENCODING_REJECTED', 'Compressed remote responses are not accepted', {status: 415});
    }

    const rawContentType = String(getHeader(response.headers, 'content-type') || '');
    const contentType = rawContentType.split(';', 1)[0].trim().toLowerCase();
    if (allowedContentTypes.length > 0 && (!contentType || !contentTypeAllowed(contentType, allowedContentTypes))) {
      response.body.destroy?.();
      throw new AppError('FETCH_CONTENT_TYPE_REJECTED', 'Remote response content type is not allowed', {status: 415});
    }

    const rawLength = getHeader(response.headers, 'content-length');
    if (rawLength !== undefined) {
      const lengthText = String(rawLength);
      if (!/^\d+$/.test(lengthText)) {
        response.body.destroy?.();
        throw new AppError('FETCH_CONTENT_LENGTH_INVALID', 'Remote response content length is invalid', {status: 502});
      }
      const contentLength = Number(lengthText);
      if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
        response.body.destroy?.();
        throw new AppError('FETCH_BODY_TOO_LARGE', 'Remote response exceeds the configured size limit', {status: 413});
      }
    }

    const bodyTimeoutMs = remainingMs(deadline);
    if (bodyTimeoutMs <= 0) {
      response.body.destroy?.();
      throw timeoutError();
    }

    return {
      url: target.url.href,
      statusCode,
      headers: response.headers || {},
      contentType,
      address: target.address,
      body: boundedBody(response.body, {maxBytes, timeoutMs: bodyTimeoutMs}),
    };
  }

  throw new AppError('FETCH_REDIRECT_LIMIT', 'Remote fetch exceeded the redirect limit', {status: 502});
}

export async function safeFetchBuffer(input, options) {
  const response = await safeFetchStream(input, options);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return {...response, body: Buffer.concat(chunks)};
}
