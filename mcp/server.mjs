import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createMcpHandler, fromJsonSchema, McpServer} from '@modelcontextprotocol/server';
import {normalizeEvidence} from '../lib/evidence/normalize-evidence.mjs';
import {
  assertEvidenceBundle,
  assertEvidenceEnvelope,
  evidenceBundleSchema,
  evidenceInputSchema,
} from '../lib/evidence/schema-validator.mjs';
import {redactSecrets} from '../security/integration-auth.mjs';

import {
  createVideoProjectInputSchema,
  getVideoProjectInputSchema,
  editVideoDraftInputSchema,
  approveVideoProjectInputSchema,
  startVideoRenderInputSchema,
  retryVideoProjectInputSchema,
  cancelVideoProjectInputSchema,
  videoProjectStatusOutputSchema,
} from './schemas/tool-schemas.mjs';

const correlationContext = new AsyncLocalStorage();

const DEFAULT_PORT = 4190;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 20;
const DEFAULT_MAX_INFLIGHT_WRITES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const inputSchema = fromJsonSchema(evidenceInputSchema);
const outputSchema = fromJsonSchema(evidenceBundleSchema);
const createProjectSchema = fromJsonSchema(createVideoProjectInputSchema);
const getProjectSchema = fromJsonSchema(getVideoProjectInputSchema);
const editDraftSchema = fromJsonSchema(editVideoDraftInputSchema);
const approveProjectSchema = fromJsonSchema(approveVideoProjectInputSchema);
const startRenderSchema = fromJsonSchema(startVideoRenderInputSchema);
const retryProjectSchema = fromJsonSchema(retryVideoProjectInputSchema);
const cancelProjectSchema = fromJsonSchema(cancelVideoProjectInputSchema);
const projectStatusSchema = fromJsonSchema(videoProjectStatusOutputSchema);

const formatToolSummary = (bundle) => [
  `Normalized ${bundle.stats.inputItems} candidates into ${bundle.stats.retainedEvidence} evidence records.`,
  `Merged ${bundle.stats.exactDuplicatesRemoved + bundle.stats.nearDuplicatesMerged} exact/near duplicates.`,
  `Found ${bundle.stats.conflictGroups} unresolved conflict groups.`,
  `Rejected ${bundle.stats.rejectedItems} malformed evidence items.`,
].join(' ');

const positiveFiniteOrDefault = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const positiveTimerDelayOrDefault = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS ? parsed : fallback;
};

export function buildBrightMcpServer({env = process.env, fetchFn = fetch, inFlightState} = {}) {
  const backendUrl = env.BRIGHT_BACKEND_URL?.trim() || 'http://127.0.0.1:4180';
  const serviceToken = env.BRIGHT_INTEGRATION_TOKEN?.trim() || '';
  const mcpPublicUrl = env.MCP_PUBLIC_URL || env.BRIGHT_PUBLIC_URL || `http://${env.MCP_HOST || '127.0.0.1'}:${env.MCP_PORT || DEFAULT_PORT}`;

  const noauthWriteEnabled = env.MCP_NOAUTH_WRITE_ENABLED === 'true' || env.MCP_NOAUTH_WRITE_ENABLED === '1';
  const maxInflightWrites = positiveFiniteOrDefault(env.MCP_MAX_INFLIGHT_WRITE_REQUESTS, DEFAULT_MAX_INFLIGHT_WRITES);
  const inFlightRef = inFlightState || {current: 0};

  const withWriteGate = async (operation) => {
    if (!noauthWriteEnabled) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'Anonymous MCP writes are disabled by policy (NOAUTH_WRITE_DISABLED).',
        }],
      };
    }
    if (inFlightRef.current >= maxInflightWrites) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'Anonymous in-flight write limit exceeded (NOAUTH_INFLIGHT_CAP_REACHED).',
        }],
      };
    }
    inFlightRef.current += 1;
    try {
      return await operation();
    } finally {
      inFlightRef.current -= 1;
    }
  };

  const fetchWithCorrelation = async (endpoint, options = {}, { toolName, projectId, idempotencyKey } = {}) => {
    const started = Date.now();
    const store = correlationContext.getStore();
    const correlationId = store?.correlationId || randomUUID();
    const requestId = store?.requestId || correlationId;
    const headers = {
      ...options.headers,
      'x-correlation-id': correlationId,
      'x-request-id': requestId,
    };
    try {
      const res = await fetchFn(endpoint, {...options, headers});
      console.error(JSON.stringify(redactSecrets({
        event: 'mcp.tool_call',
        correlationId,
        tool: toolName,
        projectId,
        idempotencyKey,
        status: res.ok ? 'ok' : 'error',
        httpStatus: res.status,
        durationMs: Date.now() - started,
      })));
      return res;
    } catch (err) {
      console.error(JSON.stringify(redactSecrets({
        event: 'mcp.tool_call',
        correlationId,
        tool: toolName,
        projectId,
        idempotencyKey,
        status: 'error',
        error: err?.message,
        durationMs: Date.now() - started,
      })));
      throw err;
    }
  };

  const normalizeProjectOutput = (project) => {
    if (!project || typeof project !== 'object') return project;
    const copy = {...project};
    if (copy.output?.downloadUrl) {
      const urlStr = copy.output.downloadUrl;
      const base = (mcpPublicUrl || '').trim().replace(/\/+$/, '');
      if (base) {
        let pathAndQuery = urlStr;
        try {
          const parsed = new URL(urlStr);
          pathAndQuery = `${parsed.pathname}${parsed.search}`;
        } catch {
          if (!urlStr.startsWith('/')) pathAndQuery = `/${urlStr}`;
        }
        copy.output = {...copy.output, downloadUrl: `${base}${pathAndQuery}`};
      }
    }
    return copy;
  };

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
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => {
      const started = Date.now();
      const correlationId = randomUUID();
      try {
        assertEvidenceEnvelope(input);
        const bundle = assertEvidenceBundle(normalizeEvidence(input));
        console.error(JSON.stringify(redactSecrets({
          event: 'mcp.tool_call',
          correlationId,
          tool: 'normalize_evidence',
          status: 'ok',
          durationMs: Date.now() - started,
        })));
        return {
          content: [{type: 'text', text: formatToolSummary(bundle)}],
          structuredContent: {...bundle},
        };
      } catch (error) {
        console.error(JSON.stringify(redactSecrets({
          event: 'mcp.tool_call',
          correlationId,
          tool: 'normalize_evidence',
          status: 'error',
          error: error?.message,
          durationMs: Date.now() - started,
        })));
        return {
          isError: true,
          content: [{
            type: 'text',
            text: error?.code === 'EVIDENCE_INPUT_INVALID'
              ? 'Evidence input failed schema validation.'
              : error?.message || 'Evidence normalization failed.',
          }],
        };
      }
    },
  );

  server.registerTool(
    'create_video_project',
    {
      title: 'Create and start video project from normalized evidence',
      description: 'Import normalized EvidenceBundle into Bright Profile system and automatically queue structured generation stage. Default workflow stops safely at review_required for user review.',
      inputSchema: createProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        assertEvidenceBundle(input.evidenceBundle);
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/import`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
          body: JSON.stringify(input),
        }, {toolName: 'create_video_project', idempotencyKey: input.idempotencyKey});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Import failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Project ${project.projectId} imported (status: ${project.status}, stage: ${json.stage?.type || 'queued'}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to create video project.'}],
        };
      }
    }),
  );

  server.registerTool(
    'get_video_project',
    {
      title: 'Get video project status and progress',
      description: 'Query status, active stage, failure reasons, evidence summary, and downloadable output artifact for a video project.',
      inputSchema: getProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => {
      try {
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
        }, {toolName: 'get_video_project', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Get project failed with status ${res.status}`}],
          };
        }
        const projectData = normalizeProjectOutput(json.project || json);
        return {
          content: [{
            type: 'text',
            text: `Project ${projectData.projectId} status: ${projectData.status}${projectData.progress?.currentStage ? ` (stage: ${projectData.progress.currentStage}, state: ${projectData.progress.stageStatus})` : ''}.`,
          }],
          structuredContent: projectData,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to get video project.'}],
        };
      }
    },
  );

  server.registerTool(
    'edit_video_draft',
    {
      title: 'Edit structured video draft before approval',
      description: 'Update the review draft for a project. Requires expected revision ID and payload hash to prevent stale overwrites.',
      inputSchema: editDraftSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}/draft`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
          body: JSON.stringify(input),
        }, {toolName: 'edit_video_draft', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Edit draft failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Project ${project.projectId} draft updated (revision: ${json.revision?.id}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to edit video draft.'}],
        };
      }
    }),
  );

  server.registerTool(
    'approve_video_project',
    {
      title: 'Approve video project draft',
      description: 'Approve the current review draft after external review acknowledgment.',
      inputSchema: approveProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        const approveBody = {
          projectId: input.projectId,
          revisionId: input.revisionId,
          expectedPayloadHash: input.expectedPayloadHash,
          mode: 'user_reviewed',
          approvalActor: 'chatgpt_mcp_noauth',
          approvalContext: {semantic: 'external_review_acknowledged'},
        };
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}/approve`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
          body: JSON.stringify(approveBody),
        }, {toolName: 'approve_video_project', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Approve project failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Project ${project.projectId} external review acknowledged (status: ${project.status}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to approve video project.'}],
        };
      }
    }),
  );

  server.registerTool(
    'start_video_render',
    {
      title: 'Start downstream rendering pipeline for approved project',
      description: 'Queue media ingest, Google Cloud TTS voice synthesis, and Remotion video rendering for an approved project.',
      inputSchema: startRenderSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}/render`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
        }, {toolName: 'start_video_render', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Start render failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Render pipeline started for project ${project.projectId} (stage: ${json.stage?.type}, status: ${json.stage?.state}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to start video render.'}],
        };
      }
    }),
  );

  server.registerTool(
    'retry_video_project',
    {
      title: 'Retry failed stage for video project',
      description: 'Retry the current failed stage for a video project when durable backend state marks it retryable.',
      inputSchema: retryProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}/retry`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
        }, {toolName: 'retry_video_project', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Retry failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Stage retry requested for project ${project.projectId} (stage: ${json.stage?.type}, status: ${json.stage?.state}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to retry stage.'}],
        };
      }
    }),
  );

  server.registerTool(
    'cancel_video_project',
    {
      title: 'Cancel active stage for video project',
      description: 'Cancel an active queued or executing stage for a video project.',
      inputSchema: cancelProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        securitySchemes: [{type: 'noauth'}],
      },
    },
    async (input) => withWriteGate(async () => {
      try {
        const res = await fetchWithCorrelation(`${backendUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(input.projectId)}/cancel`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(serviceToken ? {authorization: `Bearer ${serviceToken}`} : {}),
          },
        }, {toolName: 'cancel_video_project', projectId: input.projectId});
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [{type: 'text', text: json?.error?.message || `Cancel failed with status ${res.status}`}],
          };
        }
        const project = normalizeProjectOutput(json.project);
        return {
          content: [{
            type: 'text',
            text: `Stage cancelled for project ${project.projectId} (stage: ${json.stage?.type}, status: ${json.stage?.state}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to cancel stage.'}],
        };
      }
    }),
  );

  return server;
}

export function createBrightMcpHandler({env = process.env, fetchFn = fetch, inFlightState = {current: 0}} = {}) {
  return createMcpHandler(() => buildBrightMcpServer({env, fetchFn, inFlightState}));
}

const parsePublicMcpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MCP_PUBLIC_URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS');
  }
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

const writeJsonBeforeBodyConsumed = (req, res, status, body, requestId) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'connection': 'close',
    'x-request-id': requestId,
  });
  res.end(payload, () => {
    req.socket?.destroy();
  });
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
  env = process.env,
  handler,
  fetchFn = fetch,
  inFlightState = {current: 0},
  log = (event) => console.error(JSON.stringify(event)),
} = {}) {
  const activeHandler = handler || createBrightMcpHandler({env, fetchFn, inFlightState});
  const allowedHosts = parseAllowedHosts(env);
  const maxBodyBytes = positiveFiniteOrDefault(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const rateLimit = positiveFiniteOrDefault(env.MCP_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT);
  const requestTimeoutMs = positiveTimerDelayOrDefault(env.MCP_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  const allowRequest = makeRateLimiter({limit: rateLimit});

  return createServer((req, res) => {
    const requestId = randomUUID();
    const incomingCorr = req.headers['x-correlation-id'] || req.headers['x-request-id'];
    const correlationId = typeof incomingCorr === 'string' && incomingCorr.trim()
      ? incomingCorr.trim().slice(0, 200)
      : requestId;

    return correlationContext.run({correlationId, requestId}, async () => {
      const started = Date.now();
      const deadlineAt = started + requestTimeoutMs;
      const host = hostnameFromHeader(req.headers.host);
      const remote = req.socket.remoteAddress || 'unknown';
      const method = req.method || 'GET';
      let requestPath = '/';

      try {
        try {
          requestPath = new URL(req.url || '/', 'http://localhost').pathname;
        } catch { requestPath = '/'; }

        if (!allowedHosts.has(host)) {
          writeJsonBeforeBodyConsumed(req, res, 403, {error: {code: 'HOST_NOT_ALLOWED', message: 'Host is not allowed', requestId}}, requestId);
          return;
        }
        if (!isAllowedOrigin(req.headers.origin, allowedHosts)) {
          writeJsonBeforeBodyConsumed(req, res, 403, {error: {code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed', requestId}}, requestId);
          return;
        }

        const base = `http://${req.headers.host || 'localhost'}`;
        const url = new URL(req.url || '/', base);
        requestPath = url.pathname;

        if (url.pathname === '/health' && req.method === 'GET') {
          if (requestDeclaresBody(req)) {
            writeJsonBeforeBodyConsumed(req, res, 200, {ok: true}, requestId);
          } else {
            writeJson(res, 200, {ok: true}, requestId);
          }
          return;
        }

        if (!allowRequest(remote)) {
          writeJsonBeforeBodyConsumed(req, res, 429, {error: {code: 'RATE_LIMITED', message: 'Too many requests', requestId}}, requestId);
          return;
        }

        if (['GET', 'HEAD'].includes(method) &&
            (url.pathname.startsWith('/artifacts/') || url.pathname.startsWith('/api/integrations/chatgpt/artifacts/')) &&
            url.pathname.endsWith('/download')) {
          const segments = url.pathname.split('/');
          const artifactId = segments[segments.length - 2];
          const token = (url.searchParams.get('token') || '').trim();
          if (!artifactId) {
            writeJsonBeforeBodyConsumed(req, res, 400, {error: {code: 'INVALID_REQUEST', message: 'Missing artifactId', requestId}}, requestId);
            return;
          }
          if (!token) {
            writeJsonBeforeBodyConsumed(req, res, 401, {error: {code: 'DOWNLOAD_TOKEN_REQUIRED', message: 'Signed download token is required', requestId}}, requestId);
            return;
          }
          const backendUrl = env.BRIGHT_BACKEND_URL?.trim() || 'http://127.0.0.1:4180';
          const backendEndpoint = `${backendUrl}/api/integrations/chatgpt/artifacts/${encodeURIComponent(artifactId)}/download?token=${encodeURIComponent(token)}`;
          const downloadTimeoutMs = positiveTimerDelayOrDefault(env.MCP_DOWNLOAD_TIMEOUT_MS, 60_000);
          const abortController = new AbortController();
          req.on('close', () => {
            if (!res.writableEnded) abortController.abort();
          });
          const timeoutSignal = AbortSignal.timeout(downloadTimeoutMs);
          const combinedSignal = AbortSignal.any([abortController.signal, timeoutSignal]);

          const headers = {
            accept: '*/*',
            'x-correlation-id': correlationId,
            'x-request-id': requestId,
          };

          const backendRes = await fetch(backendEndpoint, {method, headers, signal: combinedSignal});
          res.statusCode = backendRes.status;
          for (const [key, value] of backendRes.headers.entries()) {
            if (['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified'].includes(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          }
          res.setHeader('x-request-id', requestId);
          if (method === 'HEAD' || !backendRes.body) {
            res.end();
            return;
          }
          const nodeReadable = Readable.fromWeb(backendRes.body);
          await pipeline(nodeReadable, res);
          return;
        }

        if (url.pathname !== '/mcp') {
          writeJsonBeforeBodyConsumed(req, res, 404, {error: {code: 'NOT_FOUND', message: 'Route not found', requestId}}, requestId);
          return;
        }

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
        const response = await withTimeout(activeHandler.fetch(request), remainingDeadlineMs(deadlineAt));
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
        log(redactSecrets({event: 'mcp.request', requestId, correlationId, method: req.method, path: requestPath, status: res.statusCode, durationMs: Date.now() - started}));
      }
    });
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
