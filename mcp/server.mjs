import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createMcpHandler, fromJsonSchema, McpServer} from '@modelcontextprotocol/server';
import {normalizeEvidence} from '../lib/evidence/normalize-evidence.mjs';
import {
  assertEvidenceBundle,
  assertEvidenceEnvelope,
  evidenceBundleSchema,
  evidenceInputSchema,
} from '../lib/evidence/schema-validator.mjs';
import {
  compareTokensConstantTime,
  extractBearerToken,
  redactSecrets,
} from '../security/integration-auth.mjs';

const DEFAULT_PORT = 4190;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const inputSchema = fromJsonSchema(evidenceInputSchema);
const outputSchema = fromJsonSchema(evidenceBundleSchema);

const formatToolSummary = (bundle) => [
  `Normalized ${bundle.stats.inputItems} candidates into ${bundle.stats.retainedEvidence} evidence records.`,
  `Merged ${bundle.stats.exactDuplicatesRemoved + bundle.stats.nearDuplicatesMerged} exact/near duplicates.`,
  `Found ${bundle.stats.conflictGroups} unresolved conflict groups.`,
  `Rejected ${bundle.stats.rejectedItems} malformed evidence items.`,
].join(' ');

export function buildBrightMcpServer() {
  const server = new McpServer({name: 'bright-evidence', version: '1.0.0'});
  server.registerTool(
    'normalize_evidence',
    {
      title: 'Normalize public-source evidence',
      description: 'Pure deterministic normalization and deduplication of caller-provided public-source evidence. Does not browse, persist data, call another model, or execute source content.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertEvidenceEnvelope(input);
        const bundle = assertEvidenceBundle(normalizeEvidence(input));
        return {
          content: [{type: 'text', text: formatToolSummary(bundle)}],
          structuredContent: {...bundle},
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: error?.code === 'EVIDENCE_INPUT_INVALID'
              ? 'Evidence input failed schema validation.'
              : 'Evidence normalization failed.',
          }],
        };
      }
    },
  );
  return server;
}

export function createBrightMcpHandler() {
  return createMcpHandler(buildBrightMcpServer);
}

const parsePublicMcpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MCP_PUBLIC_URL must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('MCP_PUBLIC_URL must use HTTPS');
  return url;
};

const parseAllowedHosts = (env) => {
  const allowedHosts = new Set(
    String(env.MCP_ALLOWED_HOSTS || '127.0.0.1,localhost')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const publicUrl = parsePublicMcpUrl(env.MCP_PUBLIC_URL);
  if (publicUrl) allowedHosts.add(publicUrl.hostname.toLowerCase());
  return allowedHosts;
};

const positiveFiniteOrDefault = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const positiveTimerDelayOrDefault = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS ? parsed : fallback;
};

const hostnameFromHeader = (value) => {
  if (!value) return '';
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const isAllowedOrigin = (origin, allowedHosts) => {
  if (!origin) return true;
  try {
    return allowedHosts.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const requestDeclaresBody = (req) => {
  if (req.headers['transfer-encoding']) return true;
  const contentLength = req.headers['content-length'];
  if (contentLength === undefined) return false;
  const parsed = Number(contentLength);
  return !Number.isFinite(parsed) || parsed > 0;
};

const requestTimeoutError = () => {
  const error = new Error('MCP request timed out');
  error.status = 504;
  return error;
};

const remainingDeadlineMs = (deadlineAt) => Math.max(0, deadlineAt - Date.now());

const readBody = (req, maxBytes, deadlineAt) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  let timer;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const remaining = remainingDeadlineMs(deadlineAt);
  if (remaining <= 0) {
    fail(requestTimeoutError());
    return;
  }
  timer = setTimeout(() => {
    req.pause();
    fail(requestTimeoutError());
  }, remaining);
  req.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      req.pause();
      fail(error);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(Buffer.concat(chunks));
  });
  req.on('error', fail);
});

const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  if (timeoutMs <= 0) {
    reject(requestTimeoutError());
    return;
  }
  const timer = setTimeout(() => reject(requestTimeoutError()), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

export const makeRateLimiter = ({limit, windowMs = 60_000, maxBuckets = 4_096}) => {
  const buckets = new Map();
  return (key, now = Date.now()) => {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }

    const current = buckets.get(key);
    if (!current) {
      if (buckets.size >= maxBuckets) return false;
      buckets.set(key, {count: 1, resetAt: now + windowMs});
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
};

const writeJson = (res, status, body, requestId) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  res.end(payload);
};

const closeAfterResponse = (req, res) => {
  res.setHeader('connection', 'close');
  res.once('finish', () => req.destroy());
};

const writeJsonBeforeBodyConsumed = (req, res, status, body, requestId) => {
  closeAfterResponse(req, res);
  writeJson(res, status, body, requestId);
};

const writeWebResponse = async (response, res, requestId) => {
  const headers = Object.fromEntries(response.headers.entries());
  headers['x-request-id'] = requestId;
  headers['cache-control'] ??= 'no-store';
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body);
    stream.on('error', reject);
    res.on('finish', resolve);
    stream.pipe(res);
  });
};

export function createBrightHttpServer({
  handler = createBrightMcpHandler(),
  env = process.env,
  log = (event) => console.error(JSON.stringify(event)),
} = {}) {
  const allowedHosts = parseAllowedHosts(env);
  const maxBodyBytes = positiveFiniteOrDefault(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const rateLimit = positiveFiniteOrDefault(env.MCP_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT);
  const requestTimeoutMs = positiveTimerDelayOrDefault(env.MCP_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  const allowRequest = makeRateLimiter({limit: rateLimit});

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    const deadlineAt = started + requestTimeoutMs;
    const host = hostnameFromHeader(req.headers.host);
    const remote = req.socket.remoteAddress || 'unknown';
    let requestPath = '/';
    try {
      try {
        requestPath = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        requestPath = '/';
      }

      if (!allowedHosts.has(host)) {
        writeJsonBeforeBodyConsumed(req, res, 403, {error: {code: 'HOST_NOT_ALLOWED', message: 'Host is not allowed', requestId}}, requestId);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, allowedHosts)) {
        writeJsonBeforeBodyConsumed(req, res, 403, {error: {code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed', requestId}}, requestId);
        return;
      }

      const base = `http://${req.headers.host}`;
      const url = new URL(req.url || '/', base);
      requestPath = url.pathname;
      if (url.pathname === '/health' && req.method === 'GET') {
        writeJsonBeforeBodyConsumed(req, res, 200, {ok: true}, requestId);
        return;
      }

      if (!allowRequest(remote)) {
        writeJsonBeforeBodyConsumed(req, res, 429, {error: {code: 'RATE_LIMITED', message: 'Too many requests', requestId}}, requestId);
        return;
      }
      if (url.pathname !== '/mcp') {
        writeJsonBeforeBodyConsumed(req, res, 404, {error: {code: 'NOT_FOUND', message: 'Route not found', requestId}}, requestId);
        return;
      }

      const expectedAuthToken = String(env.MCP_AUTH_TOKEN || '').trim();
      if (expectedAuthToken) {
        const token = extractBearerToken(req.headers.authorization);
        if (!token || !compareTokensConstantTime(token, expectedAuthToken)) {
          writeJsonBeforeBodyConsumed(req, res, 401, {
            error: {
              code: 'UNAUTHORIZED',
              message: 'Unauthorized',
              requestId,
            },
          }, requestId);
          return;
        }
      }

      const method = req.method || 'GET';
      if (['GET', 'HEAD'].includes(method) && requestDeclaresBody(req)) {
        writeJsonBeforeBodyConsumed(req, res, 400, {
          error: {
            code: 'REQUEST_BODY_NOT_ALLOWED',
            message: 'Request body is not allowed for this method',
            requestId,
          },
        }, requestId);
        return;
      }

      let body;
      if (!['GET', 'HEAD'].includes(method)) body = await readBody(req, maxBodyBytes, deadlineAt);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(body?.length ? {body} : {}),
      });
      const response = await withTimeout(handler.fetch(request), remainingDeadlineMs(deadlineAt));
      await writeWebResponse(response, res, requestId);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (!res.headersSent) {
        const errorBody = {
          error: {
            code: status === 413 ? 'REQUEST_TOO_LARGE' : status === 504 ? 'REQUEST_TIMEOUT' : 'INTERNAL_ERROR',
            message: status === 413 ? 'Request body is too large' : status === 504 ? 'Request timed out' : 'Internal server error',
            requestId,
          },
        };
        if (status === 413 || status === 504) {
          writeJsonBeforeBodyConsumed(req, res, status, errorBody, requestId);
        } else {
          writeJson(res, status, errorBody, requestId);
        }
      } else {
        res.destroy();
      }
    } finally {
      log(redactSecrets({event: 'mcp.request', requestId, method: req.method, path: requestPath, status: res.statusCode, durationMs: Date.now() - started}));
    }
  });
}

export function startBrightMcpServer({env = process.env} = {}) {
  const port = Number(env.MCP_PORT || DEFAULT_PORT);
  const host = env.MCP_HOST || '127.0.0.1';
  const server = createBrightHttpServer({env});
  server.listen(port, host, () => console.error(JSON.stringify({event: 'mcp.started', host, port})));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startBrightMcpServer();
