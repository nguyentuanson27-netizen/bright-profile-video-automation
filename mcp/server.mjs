import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMcpHandler, fromJsonSchema, McpServer} from '@modelcontextprotocol/server';
import {normalizeEvidence} from '../lib/evidence/normalize-evidence.mjs';
import {
  assertEvidenceBundle,
  assertEvidenceEnvelope,
  evidenceBundleSchema,
  evidenceInputSchema,
} from '../lib/evidence/schema-validator.mjs';
import {AppError} from '../domain/errors.mjs';
import {
  compareTokensConstantTime,
  extractBearerToken,
  redactSecrets,
} from '../security/integration-auth.mjs';
import {
  createOauthManager,
  createUserSessionToken,
  verifyUserSessionToken,
} from '../security/oauth.mjs';

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
const DEFAULT_RATE_LIMIT = 60;
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

export function buildBrightMcpServer({env = process.env, fetchFn = fetch} = {}) {
  const backendUrl = env.BRIGHT_BACKEND_URL?.trim() || 'http://127.0.0.1:4180';
  const serviceToken = env.BRIGHT_INTEGRATION_TOKEN?.trim() || '';
  const mcpPublicUrl = env.MCP_PUBLIC_URL || env.BRIGHT_PUBLIC_URL || `http://${env.MCP_HOST || '127.0.0.1'}:${env.MCP_PORT || DEFAULT_PORT}`;

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

  const assertScope = (requiredScope) => {
    const ctx = correlationContext.getStore();
    const auth = ctx?.auth;
    if (!auth) return;
    if (auth.isStaticToken) return;
    const scopes = auth.scopes || [];
    if (requiredScope === 'bright:profile:read') {
      if (!scopes.includes('bright:profile:read') && !scopes.includes('bright:profile:write')) {
        throw new AppError(
          'FORBIDDEN',
          `Forbidden: token lacks required scope "bright:profile:read". Available scopes: ${scopes.join(', ') || 'none'}`,
          {status: 403}
        );
      }
      return;
    }
    if (!scopes.includes(requiredScope)) {
      throw new AppError(
        'FORBIDDEN',
        `Forbidden: token lacks required scope "${requiredScope}". Available scopes: ${scopes.join(', ') || 'none'}`,
        {status: 403}
      );
    }
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
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:read']}],
      },
    },
    async (input) => {
      const started = Date.now();
      const correlationId = randomUUID();
      try {
        assertScope('bright:profile:read');
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
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
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
    },
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
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:read']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:read');
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
      description: 'Update the review draft (creator name, summary, claims, timed script, voiceover chunks, scenes, render settings) for a project. Requires expected revision ID and payload hash to prevent stale overwrites.',
      inputSchema: editDraftSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
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
    },
  );

  server.registerTool(
    'approve_video_project',
    {
      title: 'Approve video project draft',
      description: 'Approve the current review draft. Supports mode=user_reviewed (after human review) and mode=delegated_e2e (when user explicitly requested full autonomous generation and server-side safety checks pass).',
      inputSchema: approveProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
        const ctx = correlationContext.getStore();
        const authenticatedUserId = ctx?.auth?.userId || 'chatgpt_user';

        if (input.mode === 'delegated_e2e' && !input.delegationGrant) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: 'Delegated approval blocked: valid explicit user delegation grant is required for delegated_e2e mode.',
            }],
          };
        }
        const approveBody = {
          ...input,
          approvalActor: authenticatedUserId,
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
            text: `Project ${project.projectId} approved (mode: ${json.revision?.approvalMode || input.mode || 'user_reviewed'}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to approve video project.'}],
        };
      }
    },
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
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
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
            text: `Rendering started for project ${project.projectId} (stage: ${json.stage?.type || 'media_ingest'}).`,
          }],
          structuredContent: project,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{type: 'text', text: error?.message || 'Failed to start video render.'}],
        };
      }
    },
  );

  server.registerTool(
    'retry_video_project',
    {
      title: 'Retry failed stage for video project',
      description: 'Retry a failed retryable stage (e.g. generation, media ingest, TTS, or render) for a video project.',
      inputSchema: retryProjectSchema,
      outputSchema: projectStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
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
    },
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
        securitySchemes: [{type: 'oauth2', scopes: ['bright:profile:write']}],
      },
    },
    async (input) => {
      try {
        assertScope('bright:profile:write');
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
    },
  );

  return server;
}

export function createBrightMcpHandler({env = process.env, fetchFn = fetch} = {}) {
  return createMcpHandler(() => buildBrightMcpServer({env, fetchFn}));
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
  env = process.env,
  handler,
  log = (event) => console.error(JSON.stringify(event)),
} = {}) {
  const activeHandler = handler || createBrightMcpHandler({env});
  const allowedHosts = parseAllowedHosts(env);
  const maxBodyBytes = positiveFiniteOrDefault(env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const rateLimit = positiveFiniteOrDefault(env.MCP_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT);
  const requestTimeoutMs = positiveTimerDelayOrDefault(env.MCP_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  const allowRequest = makeRateLimiter({limit: rateLimit});

  const serviceToken = env.BRIGHT_INTEGRATION_TOKEN?.trim() || '';
  const expectedAuthToken = String(env.MCP_AUTH_TOKEN || '').trim();
  const isAuthConfigured = Boolean(expectedAuthToken || serviceToken || env.MCP_OAUTH_SECRET);
  const configuredPublicUrl = (env.MCP_PUBLIC_URL || env.BRIGHT_PUBLIC_URL || '').trim();
  let defaultIssuer = `http://${env.MCP_HOST || '127.0.0.1'}:${env.MCP_PORT || DEFAULT_PORT}`;
  let defaultCanonicalResource = `${defaultIssuer}/mcp`;
  if (configuredPublicUrl) {
    try {
      const parsed = new URL(configuredPublicUrl);
      defaultIssuer = parsed.origin;
      defaultCanonicalResource = configuredPublicUrl;
    } catch {}
  }

  // Dedicated OAuth secret - NEVER fall back to BRIGHT_INTEGRATION_TOKEN
  const oauthSecret = (env.MCP_OAUTH_SECRET || expectedAuthToken || 'bright-mcp-oauth-dedicated-secret-32-chars').trim();
  // Dedicated User Auth secret - NEVER fall back to BRIGHT_INTEGRATION_TOKEN or oauthSecret
  const userAuthSecret = (env.BRIGHT_USER_AUTH_SECRET || env.BRIGHT_USER_PASSWORD || '').trim();
  const clientStoragePath = env.MCP_CLIENT_STORAGE_PATH || (env.BRIGHT_DATA_DIR ? join(env.BRIGHT_DATA_DIR, 'oauth_clients.json') : null);
  const oauthManager = createOauthManager({
    issuer: defaultIssuer,
    canonicalResource: defaultCanonicalResource,
    secret: oauthSecret,
    clientStoragePath,
  });

  const authenticateUserSession = (req, bodySessionToken = null) => {
    let token = bodySessionToken;
    if (!token) {
      const cookieHeader = req.headers.cookie || '';
      if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
        if (match) token = decodeURIComponent(match[1]);
      }
    }
    if (!token && req.headers['x-session-token']) {
      token = req.headers['x-session-token'].trim();
    }
    if (!token && req.headers.authorization) {
      const bearer = extractBearerToken(req.headers.authorization);
      if (bearer) {
        try {
          return verifyUserSessionToken({sessionToken: bearer, secret: oauthSecret});
        } catch {}
      }
    }
    if (!token) return null;
    try {
      return verifyUserSessionToken({sessionToken: token, secret: oauthSecret});
    } catch {
      return null;
    }
  };

  return createServer((req, res) => {
    const requestId = randomUUID();
    const incomingCorr = req.headers['x-correlation-id'] || req.headers['x-request-id'];
    const correlationId = typeof incomingCorr === 'string' && incomingCorr.trim()
      ? incomingCorr.trim().slice(0, 200)
      : requestId;

    return correlationContext.run({correlationId, requestId, auth: null}, async () => {
      const started = Date.now();
      const deadlineAt = started + requestTimeoutMs;
      const host = hostnameFromHeader(req.headers.host);
      const remote = req.socket.remoteAddress || 'unknown';
      const method = req.method || 'GET';
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

        // Apply rate limit across all non-health application routes
        if (!allowRequest(remote)) {
          writeJsonBeforeBodyConsumed(req, res, 429, {error: {code: 'RATE_LIMITED', message: 'Too many requests', requestId}}, requestId);
          return;
        }

        const requestIssuer = configuredPublicUrl ? new URL(configuredPublicUrl).origin : (req.headers.host ? `http://${req.headers.host}` : defaultIssuer);
        const requestCanonicalResource = configuredPublicUrl || `${requestIssuer}/mcp`;

        // RFC 9470 OAuth Protected Resource Metadata (both root and /mcp/ prefix)
        if (['/.well-known/oauth-protected-resource', '/mcp/.well-known/oauth-protected-resource'].includes(url.pathname) && req.method === 'GET') {
          writeJsonBeforeBodyConsumed(req, res, 200, oauthManager.getProtectedResourceMetadata(requestCanonicalResource, requestIssuer), requestId);
          return;
        }

        // RFC 8414 OAuth Authorization Server Metadata & OpenID Configuration (both root and /mcp/ prefix)
        if (['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/mcp/.well-known/oauth-authorization-server', '/mcp/.well-known/openid-configuration'].includes(url.pathname) && req.method === 'GET') {
          writeJsonBeforeBodyConsumed(req, res, 200, oauthManager.getAuthorizationServerMetadata(requestIssuer), requestId);
          return;
        }

        // User Login / Session Creation endpoint (both root and /mcp/ prefix) — requires verified credentials
        if (['/oauth/session/login', '/mcp/oauth/session/login'].includes(url.pathname) && req.method === 'POST') {
          const rawBody = await readBody(req, maxBodyBytes, deadlineAt);
          let parsed = {};
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: 'Invalid JSON body', requestId},
            }, requestId);
            return;
          }
          const userId = (parsed.user_id || parsed.userId || '').trim();
          const credential = (parsed.password || parsed.credential || parsed.secret || extractBearerToken(req.headers.authorization) || '').trim();

          if (!userId) {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: 'user_id is required to login', requestId},
            }, requestId);
            return;
          }

          // Service token MUST NOT be used as user password
          if (serviceToken && credential && compareTokensConstantTime(credential, serviceToken)) {
            res.setHeader('WWW-Authenticate', `Bearer realm="bright-auth", error="invalid_credentials"`);
            writeJsonBeforeBodyConsumed(req, res, 401, {
              error: {code: 'UNAUTHORIZED', message: 'Service token cannot be used for user authentication', requestId},
            }, requestId);
            return;
          }

          // User authentication credentials MUST be verified:
          const isValid = userAuthSecret && credential && compareTokensConstantTime(credential, userAuthSecret);

          if (!isValid) {
            res.setHeader('WWW-Authenticate', `Bearer realm="bright-auth", error="invalid_credentials"`);
            writeJsonBeforeBodyConsumed(req, res, 401, {
              error: {code: 'UNAUTHORIZED', message: 'Invalid or missing user login credentials', requestId},
            }, requestId);
            return;
          }

          const sessionToken = createUserSessionToken({
            userId,
            email: parsed.email || null,
            secret: oauthSecret,
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Set-Cookie', `session_token=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax`);
          res.setHeader('x-request-id', requestId);
          res.end(JSON.stringify({
            session_token: sessionToken,
            user: {id: userId, email: parsed.email || null},
          }));
          return;
        }

        // RFC 7591 Dynamic Client Registration (both root and /mcp/ prefix)
        if (['/oauth/register', '/mcp/oauth/register'].includes(url.pathname) && req.method === 'POST') {
          const rawBody = await readBody(req, maxBodyBytes, deadlineAt);
          let parsed = {};
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: 'Invalid registration JSON body', requestId},
            }, requestId);
            return;
          }
          try {
            const regResponse = oauthManager.registerClient(parsed);
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('x-request-id', requestId);
            res.end(JSON.stringify(regResponse));
            return;
          } catch (err) {
            writeJsonBeforeBodyConsumed(req, res, err.status || 400, {
              error: {code: err.code || 'INVALID_REQUEST', message: err.message, requestId},
            }, requestId);
            return;
          }
        }

        // OAuth 2.1 Authorize endpoint (both root and /mcp/ prefix)
        // P0 SAFEGUARD: Never issue an authorization code directly from GET /oauth/authorize!
        // Always require explicit positive user consent decision via POST /oauth/authorize/consent.
        if (['/oauth/authorize', '/mcp/oauth/authorize'].includes(url.pathname) && req.method === 'GET') {
          const responseType = url.searchParams.get('response_type');
          const clientId = url.searchParams.get('client_id');
          const redirectUri = url.searchParams.get('redirect_uri');
          const scope = url.searchParams.get('scope') || 'bright:profile:write bright:profile:read';
          const state = url.searchParams.get('state');
          const codeChallenge = url.searchParams.get('code_challenge');
          const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
          const resource = url.searchParams.get('resource') || requestCanonicalResource;

          if (responseType !== 'code') {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'UNSUPPORTED_RESPONSE_TYPE', message: 'response_type must be code', requestId},
            }, requestId);
            return;
          }

          const client = oauthManager.getClient(clientId);
          if (!client) {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'UNAUTHORIZED_CLIENT', message: `Client ${clientId} is not registered`, requestId},
            }, requestId);
            return;
          }

          if (!client.redirectUris.includes(redirectUri)) {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: `redirect_uri is not registered for client ${clientId}`, requestId},
            }, requestId);
            return;
          }

          if (!codeChallenge) {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: 'code_challenge is required for PKCE', requestId},
            }, requestId);
            return;
          }

          let pendingConsent;
          try {
            pendingConsent = oauthManager.createPendingConsent({
              clientId,
              redirectUri,
              scope,
              codeChallenge,
              codeChallengeMethod,
              resource,
              state,
              issuer: requestIssuer,
            });
          } catch (err) {
            writeJsonBeforeBodyConsumed(req, res, err.status || 400, {
              error: {code: err.code || 'INVALID_REQUEST', message: err.message, requestId},
            }, requestId);
            return;
          }

          // User authentication check
          const user = authenticateUserSession(req);

          if (!user) {
            res.setHeader('WWW-Authenticate', `Bearer realm="bright-auth", error="login_required", resource="${requestCanonicalResource}"`);
            writeJsonBeforeBodyConsumed(req, res, 401, {
              error: {
                code: 'UNAUTHORIZED',
                message: 'User authentication and consent are required to authorize client',
                consent_required: true,
                consent_challenge: pendingConsent.consent_challenge,
                client_id: clientId,
                client_name: client.clientName,
                requested_scope: scope,
                redirect_uri: redirectUri,
                consent_endpoint: `${requestIssuer}/oauth/authorize/consent`,
                login_endpoint: `${requestIssuer}/oauth/session/login`,
                state,
                requestId,
              },
            }, requestId);
            return;
          }

          // Authenticated user: Return consent prompt with challenge transaction
          // Under NO circumstance is an authorization code minted silently on GET!
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('x-request-id', requestId);
          res.end(JSON.stringify({
            consent_required: true,
            consent_challenge: pendingConsent.consent_challenge,
            client_id: clientId,
            client_name: client.clientName,
            requested_scope: scope,
            redirect_uri: redirectUri,
            consent_endpoint: `${requestIssuer}/oauth/authorize/consent`,
            state,
            user: {id: user.userId, email: user.email || null},
          }));
          return;
        }

        // OAuth 2.1 Consent confirmation endpoint (both root and /mcp/ prefix)
        if (['/oauth/authorize/consent', '/mcp/oauth/authorize/consent'].includes(url.pathname) && req.method === 'POST') {
          const rawBody = await readBody(req, maxBodyBytes, deadlineAt);
          let parsed = {};
          const contentType = req.headers['content-type'] || '';
          if (contentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(rawBody.toString('utf8'));
            for (const [k, v] of params.entries()) parsed[k] = v;
          } else {
            try {
              parsed = JSON.parse(rawBody.toString('utf8'));
            } catch {
              writeJsonBeforeBodyConsumed(req, res, 400, {
                error: {code: 'INVALID_REQUEST', message: 'Invalid consent JSON body', requestId},
              }, requestId);
              return;
            }
          }

          // Strict user session verification: body/query user_id is NOT trusted
          const user = authenticateUserSession(req, parsed.session_token);
          if (!user || !user.userId) {
            res.setHeader('WWW-Authenticate', `Bearer realm="bright-auth", error="login_required", resource="${requestCanonicalResource}"`);
            writeJsonBeforeBodyConsumed(req, res, 401, {
              error: {
                code: 'UNAUTHORIZED',
                message: 'User authentication session is required to grant consent',
                login_endpoint: `${requestIssuer}/oauth/session/login`,
                requestId,
              },
            }, requestId);
            return;
          }

          try {
            const code = oauthManager.createAuthorizationCode({
              consent_challenge: parsed.consent_challenge,
              client_id: parsed.client_id,
              redirect_uri: parsed.redirect_uri,
              scope: parsed.scope || 'bright:profile:write bright:profile:read',
              code_challenge: parsed.code_challenge,
              code_challenge_method: parsed.code_challenge_method || 'S256',
              user: {id: user.userId, email: user.email},
              issuer: requestIssuer,
              resource: parsed.resource || requestCanonicalResource,
            });

            const effectiveRedirectUri = parsed.redirect_uri || oauthManager.getPendingConsent(parsed.consent_challenge)?.redirectUri;
            let redirectUrl = null;
            if (effectiveRedirectUri) {
              try {
                redirectUrl = new URL(effectiveRedirectUri);
                redirectUrl.searchParams.set('code', code);
                if (parsed.state) redirectUrl.searchParams.set('state', parsed.state);
              } catch {}
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('x-request-id', requestId);
            res.end(JSON.stringify({
              ok: true,
              code,
              state: parsed.state || null,
              redirect_url: redirectUrl ? redirectUrl.toString() : null,
              user: {id: user.userId, email: user.email || null},
            }));
            return;
          } catch (err) {
            writeJsonBeforeBodyConsumed(req, res, err.status || 400, {
              error: {code: err.code || 'INVALID_REQUEST', message: err.message, requestId},
            }, requestId);
            return;
          }
        }

        // OAuth 2.1 Token endpoint (both root and /mcp/ prefix)
        if (['/oauth/token', '/mcp/oauth/token'].includes(url.pathname) && req.method === 'POST') {
          const rawBody = await readBody(req, maxBodyBytes, deadlineAt);
          let parsedBody = {};
          const contentType = req.headers['content-type'] || '';
          if (contentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(rawBody.toString('utf8'));
            for (const [k, v] of params.entries()) parsedBody[k] = v;
          } else {
            try {
              parsedBody = JSON.parse(rawBody.toString('utf8'));
            } catch {
              writeJsonBeforeBodyConsumed(req, res, 400, {
                error: {code: 'INVALID_REQUEST', message: 'Invalid token request body', requestId},
              }, requestId);
              return;
            }
          }

          if (parsedBody.grant_type !== 'authorization_code') {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'UNSUPPORTED_GRANT_TYPE', message: 'grant_type must be authorization_code', requestId},
            }, requestId);
            return;
          }

          try {
            const tokenResponse = oauthManager.exchangeCodeForToken({
              code: parsedBody.code,
              clientId: parsedBody.client_id,
              redirectUri: parsedBody.redirect_uri,
              codeVerifier: parsedBody.code_verifier,
              issuer: requestIssuer,
              resource: parsedBody.resource || requestCanonicalResource,
            });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('x-request-id', requestId);
            res.end(JSON.stringify(tokenResponse));
            return;
          } catch (err) {
            writeJsonBeforeBodyConsumed(req, res, err.status || 400, {
              error: {code: err.code || 'INVALID_GRANT', message: err.message, requestId},
            }, requestId);
            return;
          }
        }

        // Download proxy route (authenticated strictly by signed HMAC capability token in query)
        if (['GET', 'HEAD'].includes(method) &&
            (url.pathname.startsWith('/artifacts/') || url.pathname.startsWith('/api/integrations/chatgpt/artifacts/')) &&
            url.pathname.endsWith('/download')) {
          const segments = url.pathname.split('/');
          const artifactId = segments[segments.length - 2];
          const token = (url.searchParams.get('token') || '').trim();
          if (!artifactId) {
            writeJsonBeforeBodyConsumed(req, res, 400, {
              error: {code: 'INVALID_REQUEST', message: 'Missing artifactId', requestId},
            }, requestId);
            return;
          }

          if (!token) {
            writeJsonBeforeBodyConsumed(req, res, 401, {
              error: {code: 'DOWNLOAD_TOKEN_REQUIRED', message: 'Signed download token is required', requestId},
            }, requestId);
            return;
          }

          const backendUrl = env.BRIGHT_BACKEND_URL?.trim() || 'http://127.0.0.1:4180';
          const backendEndpoint = `${backendUrl}/api/integrations/chatgpt/artifacts/${encodeURIComponent(artifactId)}/download?token=${encodeURIComponent(token)}`;

          const downloadTimeoutMs = positiveTimerDelayOrDefault(env.MCP_DOWNLOAD_TIMEOUT_MS, 60_000);
          const abortController = new AbortController();
          req.on('close', () => {
            if (!res.writableEnded) {
              abortController.abort();
            }
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

        if (!isAuthConfigured) {
          writeJsonBeforeBodyConsumed(req, res, 401, {
            error: {
              code: 'AUTH_NOT_CONFIGURED',
              message: 'MCP server authentication is not configured',
              requestId,
            },
          }, requestId);
          return;
        }

        const token = extractBearerToken(req.headers.authorization);
        if (!token) {
          res.setHeader('WWW-Authenticate', `Bearer realm="bright-mcp", error="invalid_token", error_description="Bearer token is required", resource="${requestCanonicalResource}"`);
          writeJsonBeforeBodyConsumed(req, res, 401, {
            error: {
              code: 'UNAUTHORIZED',
              message: 'Bearer token is required',
              requestId,
            },
          }, requestId);
          return;
        }

        let verifiedAuth = null;
        try {
          const verified = oauthManager.verifyAccessToken({
            token,
            expectedIssuer: requestIssuer,
            expectedAudience: requestCanonicalResource,
          });
          verifiedAuth = {
            userId: verified.userId,
            scopes: verified.scopes,
            isStaticToken: false,
          };
        } catch {
          if (expectedAuthToken && compareTokensConstantTime(token, expectedAuthToken)) {
            verifiedAuth = {
              userId: 'service_operator',
              scopes: ['bright:profile:write', 'bright:profile:read'],
              isStaticToken: true,
            };
          }
        }

        if (!verifiedAuth) {
          res.setHeader('WWW-Authenticate', `Bearer realm="bright-mcp", error="invalid_token", error_description="Access token is invalid, expired, or wrong audience/issuer", resource="${requestCanonicalResource}"`);
          writeJsonBeforeBodyConsumed(req, res, 401, {
            error: {
              code: 'UNAUTHORIZED',
              message: 'Unauthorized',
              requestId,
            },
          }, requestId);
          return;
        }

        // Set verified auth in AsyncLocalStorage
        correlationContext.getStore().auth = verifiedAuth;

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
