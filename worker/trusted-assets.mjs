import {createHash, randomBytes} from 'node:crypto';
import {createReadStream, existsSync, statSync} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {AppError} from '../domain/errors.mjs';

const MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'],
]);
const ARTIFACT_PATTERN = /^artifact:\/\/([A-Za-z0-9._-]{1,160})$/;
const ASSET_PREFIX = 'asset://';

const mediaType = (file) => MIME_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
const routeId = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);

const containedPath = (root, relative, code, message) => {
  if (!relative || relative.includes('\0') || relative.includes('\\')) {
    throw new AppError(code, message, {status: 400});
  }
  const normalized = path.posix.normalize(relative.replace(/^\/+/, ''));
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new AppError(code, message, {status: 400});
  }
  const absolute = path.resolve(root, ...normalized.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new AppError(code, message, {status: 400});
  }
  return absolute;
};

const parseRange = (header, size) => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return {invalid: true};
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return {invalid: true};
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return {invalid: true};
  }
  return {start, end: Math.min(end, size - 1)};
};

export function createTrustedAssetServer({projectId, artifactStore, assetsDir = path.resolve('assets')}) {
  if (!projectId) throw new TypeError('trusted asset projectId is required');
  if (!artifactStore?.get) throw new TypeError('artifactStore is required');
  if (!path.isAbsolute(assetsDir)) throw new TypeError('assetsDir must be absolute');

  const assetsRoot = path.resolve(assetsDir);
  const token = randomBytes(24).toString('hex');
  const routes = new Map();
  const cached = new Map();
  let baseUrl = null;
  let server = null;

  const register = (key, file) => {
    if (!baseUrl) throw new AppError('TRUSTED_ASSET_SERVER_NOT_STARTED', 'Trusted asset server is not started', {status: 500});
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new AppError('TRUSTED_ASSET_MISSING', 'Trusted asset file is missing', {status: 409});
    }
    const basename = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_') || 'asset.bin';
    const pathname = `/${token}/${routeId(key)}/${encodeURIComponent(basename)}`;
    routes.set(pathname, file);
    const url = `${baseUrl}${pathname}`;
    cached.set(key, url);
    return url;
  };

  const handler = (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, {'cache-control': 'no-store'});
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, {'cache-control': 'no-store'});
      res.end();
      return;
    }
    const file = routes.get(pathname);
    if (!file) {
      res.writeHead(404, {'cache-control': 'no-store'});
      res.end();
      return;
    }

    const info = statSync(file);
    const range = parseRange(req.headers.range, info.size);
    const common = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': mediaType(file),
    };
    if (range?.invalid) {
      res.writeHead(416, {...common, 'content-range': `bytes */${info.size}`});
      res.end();
      return;
    }
    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...common,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file, {start: range.start, end: range.end}).pipe(res);
      return;
    }

    res.writeHead(200, {...common, 'content-length': String(info.size)});
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  };

  return Object.freeze({
    async start() {
      if (server) return baseUrl;
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Trusted asset server did not bind to TCP');
      baseUrl = `http://127.0.0.1:${address.port}`;
      return baseUrl;
    },

    resolve(value) {
      if (!value) return value || '';
      if (cached.has(value)) return cached.get(value);

      const artifactMatch = String(value).match(ARTIFACT_PATTERN);
      if (artifactMatch) {
        const artifact = artifactStore.get(projectId, artifactMatch[1]);
        if (!artifact) throw new AppError('TRUSTED_ARTIFACT_MISSING', 'Trusted render artifact is missing', {status: 409});
        return register(value, artifact.absolutePath);
      }

      if (String(value).startsWith(ASSET_PREFIX)) {
        const relative = String(value).slice(ASSET_PREFIX.length);
        const file = containedPath(assetsRoot, relative, 'TRUSTED_ASSET_PATH_INVALID', 'Bundled asset path is invalid');
        return register(value, file);
      }

      throw new AppError('RENDER_UNTRUSTED_ASSET', 'Render input is not a trusted asset reference', {status: 409});
    },

    async close() {
      if (!server) return;
      const closing = server;
      server = null;
      baseUrl = null;
      await new Promise((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
    },
  });
}
