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

const DEFAULT_PORT = 4190;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
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

const parseAllowedHosts = (env) => new Set(
  String(env.MCP_ALLOWED_HOSTS || '127.0.0.1,localhost')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

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

const readBody = (req, maxBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  req.on('data', (chunk) => {
    if (settled) return;
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      fail(error);
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks));
  });
  req.on('error', fail);
});

const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    const error = new Error('MCP request timed out');
    error.status = 504;
    reject(error);
  }, timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const makeRateLimiter = ({limit, windowMs = 60_000}) => {
  const buckets = new Map();
  return (key, now = Date.now()) => {
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
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
  const maxBodyBytes = Number(env.MCP_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  const rateLimit = Number(env.MCP_RATE_LIMIT_PER_MINUTE || DEFAULT_RATE_LIMIT);
  const requestTimeoutMs = Number(env.MCP_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS);
  const allowRequest = makeRateLimiter({limit: Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : DEFAULT_RATE_LIMIT});

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    const host = hostnameFromHeader(req.headers.host);
    const remote = req.socket.remoteAddress || 'unknown';
    try {
      if (!allowedHosts.has(host)) {
        writeJson(res, 403, {error: {code: 'HOST_NOT_ALLOWED', message: 'Host is not allowed', requestId}}, requestId);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, allowedHosts)) {
        writeJson(res, 403, {error: {code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed', requestId}}, requestId);
        return;
      }
      if (!allowRequest(remote)) {
        writeJson(res, 429, {error: {code: 'RATE_LIMITED', message: 'Too many requests', requestId}}, requestId);
        return;
      }

      const base = `http://${req.headers.host}`;
      const url = new URL(req.url || '/', base);
      if (url.pathname === '/health' && req.method === 'GET') {
        writeJson(res, 200, {ok: true}, requestId);
        return;
      }
      if (url.pathname !== '/mcp') {
        writeJson(res, 404, {error: {code: 'NOT_FOUND', message: 'Route not found', requestId}}, requestId);
        return;
      }

      let body;
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) body = await readBody(req, maxBodyBytes);
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
      const timeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
      const response = await withTimeout(handler.fetch(request), timeoutMs);
      await writeWebResponse(response, res, requestId);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (!res.headersSent) {
        writeJson(res, status, {
          error: {
            code: status === 413 ? 'REQUEST_TOO_LARGE' : status === 504 ? 'REQUEST_TIMEOUT' : 'INTERNAL_ERROR',
            message: status === 413 ? 'Request body is too large' : status === 504 ? 'Request timed out' : 'Internal server error',
            requestId,
          },
        }, requestId);
      } else {
        res.destroy();
      }
    } finally {
      log({event: 'mcp.request', requestId, method: req.method, path: req.url, status: res.statusCode, durationMs: Date.now() - started});
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
