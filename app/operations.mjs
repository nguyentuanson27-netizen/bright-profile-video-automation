import {constants} from 'node:fs';
import {access} from 'node:fs/promises';

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const text = (res, status, body, contentType = 'text/plain; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export function createHealthService({db, dataDir}) {
  if (!db?.prepare) throw new TypeError('health database is required');
  if (!dataDir) throw new TypeError('health dataDir is required');
  const databaseCheck = db.prepare('SELECT 1 AS ok');

  return Object.freeze({
    live() {
      return {ok: true, service: 'bright-profile'};
    },

    async ready() {
      const checks = {database: 'ok', dataDir: 'ok'};
      try {
        const result = databaseCheck.get();
        if (result?.ok !== 1) checks.database = 'error';
      } catch {
        checks.database = 'error';
      }
      try {
        await access(dataDir, constants.R_OK | constants.W_OK);
      } catch {
        checks.dataDir = 'error';
      }
      return {ok: checks.database === 'ok' && checks.dataDir === 'ok', checks};
    },
  });
}

export async function handleOperationsRoute({req, res, url, healthService, observability}) {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/health' || url.pathname === '/health/live') {
    json(res, 200, healthService?.live?.() || {ok: true, service: 'bright-profile'});
    return true;
  }

  if (url.pathname === '/health/ready') {
    if (!healthService?.ready) {
      json(res, 503, {ok: false, checks: {database: 'unknown', dataDir: 'unknown'}});
      return true;
    }
    const readiness = await healthService.ready();
    json(res, readiness.ok ? 200 : 503, readiness);
    return true;
  }

  if (url.pathname === '/metrics') {
    if (!observability?.metrics) {
      json(res, 503, {error: {code: 'METRICS_UNAVAILABLE', message: 'Metrics are not configured'}});
      return true;
    }
    text(res, 200, await observability.metrics(), observability.contentType);
    return true;
  }

  return false;
}

export function createOperationsHandler({healthService, observability}) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      json(res, 400, {error: {code: 'INVALID_URL', message: 'Request URL is invalid'}});
      return;
    }
    if (await handleOperationsRoute({req, res, url, healthService, observability})) return;
    json(res, 404, {error: {code: 'NOT_FOUND', message: 'Route was not found'}});
  };
}
