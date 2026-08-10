import {randomUUID} from 'node:crypto';
import {AppError} from '../../domain/errors.mjs';

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
    if (!text.trim()) {
      resolve({});
      return;
    }
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

const routeProjectId = (pathname, suffix = '') => {
  const pattern = suffix
    ? new RegExp(`^/api/projects/([^/]+)/${suffix}$`)
    : /^\/api\/projects\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new AppError('INVALID_PROJECT_ID', 'Project ID is invalid', {status: 400});
  }
};

const errorResponse = (error, requestId) => {
  if (error instanceof AppError) {
    return {
      status: error.status || 500,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable === true,
          requestId,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        retryable: false,
        requestId,
      },
    },
  };
};

export function createHttpHandler({
  repositories,
  researchService,
  requestIdGenerator = randomUUID,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  if (!repositories?.projects || !repositories?.sources) throw new TypeError('HTTP repositories are required');
  if (!researchService) throw new TypeError('researchService is required');

  return async (req, res) => {
    const requestId = requestIdGenerator();
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health/live') {
        json(res, 200, {ok: true}, requestId);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await readJsonBody(req, maxBodyBytes);
        json(res, 201, researchService.createProject(input), requestId);
        return;
      }

      const researchProjectId = routeProjectId(url.pathname, 'research');
      if (req.method === 'POST' && researchProjectId) {
        await readJsonBody(req, maxBodyBytes);
        json(res, 202, researchService.enqueueResearch(researchProjectId), requestId);
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
      json(res, response.status, response.body, requestId);
    }
  };
}
