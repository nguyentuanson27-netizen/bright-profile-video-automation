import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {AppError} from '../../domain/errors.mjs';
import {handleOperationsRoute} from '../operations.mjs';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const json = (res, status, value, requestId) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  });
  res.end(body);
};

const readJsonBody = (req, maxBodyBytes) => new Promise((resolve, reject) => {
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
    if (size > maxBodyBytes) {
      fail(new AppError('REQUEST_BODY_TOO_LARGE', 'Request body is too large', {status: 413}));
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return resolve({});
    try {
      resolve(JSON.parse(text));
    } catch {
      reject(new AppError('INVALID_JSON', 'Request body must be valid JSON', {status: 400}));
    }
  });
  req.on('error', () => fail(new AppError('REQUEST_READ_FAILED', 'Request body could not be read', {status: 400})));
});

const projectOrThrow = (repositories, projectId) => {
  const project = repositories.projects.get(projectId);
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
  return project;
};

const sourceSummary = (sources) => sources.reduce((summary, source) => {
  summary.total += 1;
  if (Object.hasOwn(summary, source.retrievalStatus)) summary[source.retrievalStatus] += 1;
  return summary;
}, {total: 0, available: 0, unavailable: 0, failed: 0});

const revisionSummary = (revision) => revision ? {
  revisionId: revision.revisionId,
  status: revision.status,
  payloadHash: revision.payloadHash,
  approvedAt: revision.approvedAt,
  approvedBy: revision.approvedBy,
} : null;

const projectReadModel = (repositories, project) => {
  const sources = repositories.sources.listByProject(project.id);
  return {
    project,
    sourceSummary: sourceSummary(sources),
    latestJob: repositories.jobs.latestByProject(project.id),
    latestRevision: revisionSummary(repositories.revisions.latestByProject(project.id)),
  };
};

const decodeId = (value, code, message) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(code, message, {status: 400});
  }
};

const routeProjectId = (pathname, suffix = '') => {
  const pattern = suffix
    ? new RegExp(`^/api/projects/([^/]+)/${suffix}$`)
    : /^\/api\/projects\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  return decodeId(match[1], 'INVALID_PROJECT_ID', 'Project ID is invalid');
};

const routeRevisionIds = (pathname) => {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/revisions\/([^/]+)$/);
  if (!match) return null;
  return {
    projectId: decodeId(match[1], 'INVALID_PROJECT_ID', 'Project ID is invalid'),
    revisionId: decodeId(match[2], 'INVALID_REVISION_ID', 'Revision ID is invalid'),
  };
};

const requestProjectId = (pathname) => {
  const match = pathname.match(/^\/api\/projects\/([^/]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
};

const serviceOrThrow = (service, name) => {
  if (!service) throw new AppError('FEATURE_NOT_READY', `${name} is not configured`, {status: 503, retryable: true});
  return service;
};

const errorResponse = (error, requestId) => {
  if (error instanceof AppError) {
    return {
      status: error.status || 500,
      body: {error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable === true,
        requestId,
      }},
    };
  }
  return {
    status: 500,
    body: {error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: false,
      requestId,
    }},
  };
};

const safeDownloadName = (projectId) => `bright-${String(projectId).replace(/[^A-Za-z0-9._-]/g, '_')}.mp4`;

const sendVideo = async ({req, res, requestId, repositories, artifactStore, videoProbe, projectId}) => {
  const project = projectOrThrow(repositories, projectId);
  if (project.status !== 'completed') {
    throw new AppError('VIDEO_NOT_READY', 'Rendered video is not ready', {status: 409});
  }
  serviceOrThrow(artifactStore, 'Artifact store');
  serviceOrThrow(videoProbe, 'Video validation');

  const artifact = repositories.artifacts.listByProject(projectId)
    .filter((candidate) => candidate.kind === 'rendered-video')
    .at(-1);
  if (!artifact) throw new AppError('RENDER_OUTPUT_MISSING', 'Rendered video is missing', {status: 409});

  const stored = artifactStore.get(projectId, artifact.id);
  if (!stored) throw new AppError('RENDER_OUTPUT_MISSING', 'Rendered video is missing', {status: 409});
  const info = await stat(stored.absolutePath).catch(() => null);
  if (!info?.isFile() || info.size <= 0) {
    throw new AppError('RENDER_OUTPUT_INVALID', 'Rendered video is corrupt', {status: 409});
  }
  const duration = await videoProbe(stored.absolutePath);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('RENDER_OUTPUT_INVALID', 'Rendered video is corrupt', {status: 409});
  }

  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': String(info.size),
    'content-disposition': `attachment; filename="${safeDownloadName(projectId)}"`,
    'x-request-id': requestId,
    'cache-control': 'private, no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(stored.absolutePath).pipe(res);
};

export function createHttpHandler({
  repositories,
  researchService,
  generationService,
  approvalService,
  renderService,
  artifactStore,
  videoProbe,
  healthService,
  observability,
  requestIdGenerator = randomUUID,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  if (!repositories?.projects || !repositories?.sources || !repositories?.revisions || !repositories?.jobs || !repositories?.artifacts) {
    throw new TypeError('HTTP repositories are required');
  }
  if (!researchService) throw new TypeError('researchService is required');

  return async (req, res) => {
    const requestId = requestIdGenerator();
    const started = performance.now();
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const correlationProjectId = requestProjectId(url.pathname);
      res.once('finish', () => observability?.log?.('http.request', {
        requestId,
        projectId: correlationProjectId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Math.round(Math.max(0, performance.now() - started)),
      }));

      if (await handleOperationsRoute({req, res, url, healthService, observability})) return;

      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const projects = repositories.projects.list({limit: 100}).map((project) => projectReadModel(repositories, project));
        json(res, 200, {projects}, requestId);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/projects') {
        if (typeof researchService.createAndEnqueueResearch !== 'function') {
          throw new AppError('FEATURE_NOT_READY', 'Automatic research queueing is not configured', {status: 503, retryable: true});
        }
        json(res, 201, researchService.createAndEnqueueResearch(await readJsonBody(req, maxBodyBytes)), requestId);
        return;
      }

      const statusProjectId = routeProjectId(url.pathname, 'status');
      if (req.method === 'GET' && statusProjectId) {
        const project = projectOrThrow(repositories, statusProjectId);
        json(res, 200, projectReadModel(repositories, project), requestId);
        return;
      }

      const videoProjectId = routeProjectId(url.pathname, 'video');
      if ((req.method === 'GET' || req.method === 'HEAD') && videoProjectId) {
        await sendVideo({req, res, requestId, repositories, artifactStore, videoProbe, projectId: videoProjectId});
        return;
      }

      const researchProjectId = routeProjectId(url.pathname, 'research');
      if (req.method === 'POST' && researchProjectId) {
        await readJsonBody(req, maxBodyBytes);
        json(res, 202, researchService.enqueueResearch(researchProjectId), requestId);
        return;
      }

      const generationProjectId = routeProjectId(url.pathname, 'generate');
      if (req.method === 'POST' && generationProjectId) {
        await readJsonBody(req, maxBodyBytes);
        json(res, 202, serviceOrThrow(generationService, 'Generation service').enqueueGeneration(generationProjectId), requestId);
        return;
      }

      const draftProjectId = routeProjectId(url.pathname, 'draft');
      if (req.method === 'PATCH' && draftProjectId) {
        const body = await readJsonBody(req, maxBodyBytes);
        json(res, 200, serviceOrThrow(approvalService, 'Approval service').editDraft({
          projectId: draftProjectId,
          revisionId: body.revisionId,
          generation: body.generation,
        }), requestId);
        return;
      }

      const approveProjectId = routeProjectId(url.pathname, 'approve');
      if (req.method === 'POST' && approveProjectId) {
        const body = await readJsonBody(req, maxBodyBytes);
        json(res, 200, serviceOrThrow(approvalService, 'Approval service').approve({
          projectId: approveProjectId,
          revisionId: body.revisionId,
          approvedBy: body.approvedBy,
          claimOverrides: body.claimOverrides || [],
        }), requestId);
        return;
      }

      const renderProjectId = routeProjectId(url.pathname, 'render');
      if (req.method === 'POST' && renderProjectId) {
        const body = await readJsonBody(req, maxBodyBytes);
        json(res, 202, await serviceOrThrow(renderService, 'Render service').enqueue({
          projectId: renderProjectId,
          revisionId: body.revisionId,
        }), requestId);
        return;
      }

      const revisionIds = routeRevisionIds(url.pathname);
      if (req.method === 'GET' && revisionIds) {
        projectOrThrow(repositories, revisionIds.projectId);
        const revision = repositories.revisions.get(revisionIds.revisionId);
        if (!revision || revision.projectId !== revisionIds.projectId) {
          throw new AppError('REVISION_NOT_FOUND', 'Revision was not found', {status: 404});
        }
        json(res, 200, revision, requestId);
        return;
      }

      const sourcesProjectId = routeProjectId(url.pathname, 'sources');
      if (req.method === 'GET' && sourcesProjectId) {
        projectOrThrow(repositories, sourcesProjectId);
        json(res, 200, {sources: repositories.sources.listByProject(sourcesProjectId)}, requestId);
        return;
      }

      const projectId = routeProjectId(url.pathname);
      if (req.method === 'GET' && projectId) {
        json(res, 200, projectOrThrow(repositories, projectId), requestId);
        return;
      }

      throw new AppError('NOT_FOUND', 'Route was not found', {status: 404});
    } catch (error) {
      const response = errorResponse(error, requestId);
      if (!res.headersSent) json(res, response.status, response.body, requestId);
      else res.destroy();
    }
  };
}
