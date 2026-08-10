import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const isApiOrOperationsPath = (pathname) => pathname === '/api'
  || pathname.startsWith('/api/')
  || pathname === '/health'
  || pathname.startsWith('/health/')
  || pathname === '/metrics';

const safeDecodedPath = (rawUrl) => {
  const rawPath = String(rawUrl || '/').split('?', 1)[0] || '/';
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) return null;
  return decoded;
};

const confinedFile = (root, relativePath) => {
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
};

const notFound = (res) => {
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end('Not found');
};

const sendFile = async ({req, res, absolutePath, contentType, cacheControl}) => {
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile()) {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(info.size),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(absolutePath).pipe(res);
};

export function createStandaloneHandler({apiHandler, webRoot = path.resolve('dist', 'web')} = {}) {
  if (typeof apiHandler !== 'function') throw new TypeError('apiHandler is required');
  if (!path.isAbsolute(webRoot)) throw new TypeError('webRoot must be absolute');
  const root = path.resolve(webRoot);
  const indexPath = confinedFile(root, 'index.html');

  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (isApiOrOperationsPath(url.pathname)) {
      await apiHandler(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      notFound(res);
      return;
    }

    const decodedPath = safeDecodedPath(req.url);
    if (!decodedPath) {
      notFound(res);
      return;
    }

    if (decodedPath.startsWith('/assets/')) {
      const relativeAsset = decodedPath.slice('/assets/'.length);
      if (!relativeAsset || relativeAsset.split('/').some((segment) => !segment || segment.startsWith('.'))) {
        notFound(res);
        return;
      }
      const absoluteAsset = confinedFile(root, path.join('assets', relativeAsset));
      const contentType = MIME_TYPES.get(path.extname(relativeAsset).toLowerCase());
      if (!absoluteAsset || !contentType) {
        notFound(res);
        return;
      }
      await sendFile({
        req,
        res,
        absolutePath: absoluteAsset,
        contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      return;
    }

    if (decodedPath.includes('.')) {
      notFound(res);
      return;
    }

    await sendFile({
      req,
      res,
      absolutePath: indexPath,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
    });
  };
}
