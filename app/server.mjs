import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {accessSync, constants as fsConstants, createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';

import {AppError} from '../domain/errors.mjs';
import {createArtifactStore} from '../storage/artifacts.mjs';
import {createArtifactsApi} from './http/artifacts.mjs';
import {createProjectsApi} from './http/projects.mjs';
import {createRevisionsApi} from './http/revisions.mjs';
import {matchRoute} from './http/router.mjs';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const WEB_ASSET_PATTERN = /^\/assets\/([A-Za-z0-9._-]+)$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const WEB_MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const hostnameFromAuthority = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const assertBrowserBoundary = (req) => {
  const host = hostnameFromAuthority(req.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host)) {
    throw new AppError('HOST_NOT_ALLOWED', 'Request Host is not allowed', {status: 403});
  }
  const method = String(req.method ?? 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    throw new AppError('ORIGIN_NOT_ALLOWED', 'Cross-site mutation requests are not allowed', {status: 403});
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  try {
    const parsed = new URL(String(origin));
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error('not loopback');
    }
  } catch {
    throw new AppError('ORIGIN_NOT_ALLOWED', 'Mutation Origin is not allowed', {status: 403});
  }
};

const json = (res, status, value, requestId) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(requestId ? {'x-request-id': requestId} : {}),
  });
  res.end(body);
};

const sendOutput = (res, output, requestId) => {
  res.writeHead(200, {
    'content-type': output.mimeType,
    'content-length': output.byteSize,
    'content-disposition': 'attachment; filename="bright-profile.mp4"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(requestId ? {'x-request-id': requestId} : {}),
  });
  const stream = createReadStream(output.absolutePath);
  stream.once('error', () => res.destroy());
  stream.pipe(res);
};

const webHeaders = (contentType, byteSize) => ({
  'content-type': contentType,
  'content-length': byteSize,
  'cache-control': contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=31536000, immutable',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

const sendWebFile = async (req, res, file, contentType) => {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1) return false;
  res.writeHead(200, webHeaders(contentType, info.size));
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(file);
  stream.once('error', () => res.destroy());
  stream.pipe(res);
  return true;
};

const tryServeWeb = async (req, res, pathname, webDir) => {
  if (!webDir || !['GET', 'HEAD'].includes(req.method ?? 'GET')) return false;
  const root = resolve(webDir);
  if (pathname === '/') {
    try {
      return await sendWebFile(req, res, resolve(root, 'index.html'), 'text/html; charset=utf-8');
    } catch {
      return false;
    }
  }
  const match = pathname.match(WEB_ASSET_PATTERN);
  if (!match) return false;
  const file = resolve(root, 'assets', match[1]);
  if (!file.startsWith(`${resolve(root, 'assets')}${sep}`)) return false;
  const contentType = WEB_MIME.get(extname(file).toLowerCase());
  if (!contentType) return false;
  try {
    return await sendWebFile(req, res, file, contentType);
  } catch {
    return false;
  }
};

const readJsonBody = async (req, maxBytes) => {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError('INVALID_REQUEST', 'Content-Type must be application/json', {status: 400});
  }
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError('REQUEST_TOO_LARGE', 'Request body is too large', {status: 413});
    }
    parts.push(chunk);
  }
  if (size === 0) throw new AppError('INVALID_REQUEST', 'JSON body is required', {status: 400});
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new AppError('INVALID_REQUEST', 'Request body must be valid JSON', {status: 400});
  }
};

const safeStatus = (error) => (
  Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : error instanceof TypeError
      ? 400
      : 500
);
const safeCode = (error) => (
  typeof error?.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code)
    ? error.code
    : error instanceof TypeError
      ? 'INVALID_REQUEST'
      : 'INTERNAL_ERROR'
);
const safeMessage = (error, status) => {
  if (status >= 500) return 'Internal server error';
  const message = typeof error?.message === 'string' ? error.message : 'Request failed';
  return message.slice(0, 500);
};

export const createAppServer = ({
  db,
  repos,
  jobs,
  artifactStore,
  dataDir,
  webDir,
  now = Date.now,
  nowMs = Date.now,
  projectIdFactory = randomUUID,
  stageIdFactory = randomUUID,
  sourceIdFactory = randomUUID,
  revisionIdFactory = randomUUID,
  requestIdFactory = randomUUID,
  researchMaxAttempts = 4,
  generationMaxAttempts = 4,
  mediaIngestMaxAttempts = 4,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) => {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('database is required');
  if (!dataDir) throw new TypeError('dataDir is required');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024) {
    throw new TypeError('maxBodyBytes must be between 1024 and 1048576');
  }
  if (typeof requestIdFactory !== 'function') throw new TypeError('requestIdFactory is required');
  const resolvedDataDir = resolve(dataDir);
  const resolvedWebDir = webDir ? resolve(webDir) : undefined;
  const projects = createProjectsApi({
    repos,
    jobs,
    now,
    nowMs,
    projectIdFactory,
    stageIdFactory,
    sourceIdFactory,
    researchMaxAttempts,
    generationMaxAttempts,
    mediaIngestMaxAttempts,
  });
  const revisions = createRevisionsApi({repos, now, revisionIdFactory});
  const resolvedArtifactStore = artifactStore ?? createArtifactStore(db);
  const artifacts = createArtifactsApi({repos, artifactStore: resolvedArtifactStore, dataDir: resolvedDataDir});
  const readinessQuery = db.prepare('SELECT 1 AS ok');

  return http.createServer(async (req, res) => {
    const requestIdValue = requestIdFactory();
    const requestId = typeof requestIdValue === 'string' && requestIdValue.length > 0
      ? requestIdValue.slice(0, 200)
      : randomUUID();
    try {
      assertBrowserBoundary(req);
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = matchRoute(req.method ?? 'GET', pathname);
      if (!route) {
        if (await tryServeWeb(req, res, pathname, resolvedWebDir)) return undefined;
        return json(res, 404, {error: {code: 'NOT_FOUND', message: 'Route not found'}, requestId}, requestId);
      }

      if (route.name === 'health.live') {
        return json(res, 200, {ok: true, requestId}, requestId);
      }
      if (route.name === 'health.ready') {
        try {
          const row = readinessQuery.get();
          if (row?.ok !== 1) throw new Error('database readiness query failed');
          accessSync(resolvedDataDir, fsConstants.R_OK | fsConstants.W_OK);
          return json(res, 200, {ready: true, requestId}, requestId);
        } catch {
          return json(res, 503, {
            ready: false,
            error: {code: 'NOT_READY', message: 'Local dependencies are not ready'},
            requestId,
          }, requestId);
        }
      }

      if (route.name === 'projects.create') {
        const body = await readJsonBody(req, maxBodyBytes);
        return json(res, 201, {project: projects.create(body), requestId}, requestId);
      }
      if (route.name === 'projects.list') {
        return json(res, 200, {projects: projects.list(), requestId}, requestId);
      }
      if (route.name === 'projects.get') {
        return json(res, 200, {project: projects.get(route.id), requestId}, requestId);
      }
      if (route.name === 'projects.sources') {
        return json(res, 200, {sources: projects.sources(route.id), requestId}, requestId);
      }
      if (route.name === 'projects.research') {
        const result = projects.startResearch(route.id);
        return json(res, 202, {...result, requestId}, requestId);
      }
      if (route.name === 'projects.generate') {
        const result = projects.startGeneration(route.id);
        return json(res, 202, {...result, requestId}, requestId);
      }
      if (route.name === 'projects.render') {
        const result = projects.startRender(route.id);
        return json(res, 202, {...result, requestId}, requestId);
      }
      if (route.name === 'projects.retry') {
        const result = projects.retry(route.id);
        return json(res, 202, {...result, requestId}, requestId);
      }
      if (route.name === 'projects.cancel') {
        const result = projects.cancel(route.id);
        return json(res, 200, {...result, requestId}, requestId);
      }
      if (route.name === 'projects.draft.get') {
        return json(res, 200, {...revisions.getDraft(route.id), requestId}, requestId);
      }
      if (route.name === 'projects.draft.edit') {
        const body = await readJsonBody(req, maxBodyBytes);
        return json(res, 200, {...revisions.editDraft(route.id, body), requestId}, requestId);
      }
      if (route.name === 'projects.approve') {
        return json(res, 200, {...revisions.approve(route.id), requestId}, requestId);
      }
      if (route.name === 'projects.artifacts.output') {
        const output = await artifacts.getOutput(route.id);
        sendOutput(res, output, requestId);
        return undefined;
      }
      return json(res, 404, {error: {code: 'NOT_FOUND', message: 'Route not found'}, requestId}, requestId);
    } catch (error) {
      req.resume?.();
      const status = safeStatus(error);
      return json(res, status, {
        error: {code: safeCode(error), message: safeMessage(error, status)},
        requestId,
      }, requestId);
    }
  });
};
