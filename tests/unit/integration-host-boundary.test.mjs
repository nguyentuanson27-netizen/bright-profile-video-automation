import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createAppServer} from '../../app/server.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-host-test-'));

const request = ({port, path, method = 'GET', host = '127.0.0.1', headers = {}, body = ''}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      host,
      ...headers,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(buffer.toString('utf8')); } catch {}
      resolve({status: res.statusCode, headers: res.headers, buffer, json});
    });
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('Integration host boundary allows internal docker service host "app" on integration/health endpoints but rejects it on browser UI', async (t) => {
  const serviceToken = 'internal-service-token-123456';
  const dir = tempDir();
  const db = openDatabase(join(dir, 'test.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);

  const server = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    allowedIntegrationHosts: ['127.0.0.1', 'localhost', 'app', '::1', '[::1]'],
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));

  // Setup sample project
  const timestamp = new Date().toISOString();
  repos.projects.createWithSources({
    id: 'proj-host-1',
    creator: 'Creator',
    topic: 'Topic',
    instructions: '',
    status: 'created',
    origin: 'chatgpt_mcp',
    idempotencyKey: 'k-host-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  }, []);

  // 1. Host: app:4180 on /health/ready -> succeeds
  const healthRes = await request({
    port,
    path: '/health/ready',
    host: 'app:4180',
  });
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.json?.ready, true);

  // 2. Host: app:4180 on /api/integrations/chatgpt/projects/:id with valid Bearer token -> succeeds
  const integRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/proj-host-1',
    host: 'app:4180',
    headers: {authorization: `Bearer ${serviceToken}`},
  });
  assert.equal(integRes.status, 200);
  assert.equal(integRes.json?.projectId, 'proj-host-1');

  // 3. Host: app:4180 on browser UI /api/projects/:id -> rejected with 403 HOST_NOT_ALLOWED
  const browserRes = await request({
    port,
    path: '/api/projects/proj-host-1',
    host: 'app:4180',
  });
  assert.equal(browserRes.status, 403);
  assert.equal(browserRes.json?.error?.code, 'HOST_NOT_ALLOWED');

  // 4. Host: attacker.com on /api/integrations/... -> rejected with 403 HOST_NOT_ALLOWED
  const attackerRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/proj-host-1',
    host: 'attacker.com',
    headers: {authorization: `Bearer ${serviceToken}`},
  });
  assert.equal(attackerRes.status, 403);
  assert.equal(attackerRes.json?.error?.code, 'HOST_NOT_ALLOWED');

  // 5. Host: app:4180 without Bearer token -> rejected with 401 UNAUTHORIZED
  const unauthRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/proj-host-1',
    host: 'app:4180',
  });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.json?.error?.code, 'UNAUTHORIZED');
});