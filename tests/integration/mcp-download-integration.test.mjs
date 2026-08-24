import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createAppServer} from '../../app/server.mjs';
import {generateDownloadToken} from '../../security/download-token.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-download-test-'));

const request = ({port, path, method = 'GET', headers = {}}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      host: '127.0.0.1',
      ...headers,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(buffer.toString('utf8')); } catch {}
      resolve({status: res.statusCode, headers: res.headers, buffer, json});
    });
  });
  req.on('error', reject);
  req.end();
});

test('GET /api/integrations/chatgpt/artifacts/:artifactId/download streams authoritative MP4 with signed token', async (t) => {
  const serviceToken = 'service-secret-token-key-123456';
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
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));

  // Setup project, revision, and artifact
  const timestamp = new Date().toISOString();
  repos.projects.createWithSources({
    id: 'proj-down-1',
    creator: 'Creator',
    topic: 'Topic',
    instructions: '',
    status: 'approved',
    origin: 'chatgpt_mcp',
    idempotencyKey: 'k-down-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  }, []);

  repos.revisions.create({
    id: 'rev-down-1',
    projectId: 'proj-down-1',
    revisionNo: 1,
    payload: {creatorName: 'Creator', summary: 'Summary'},
    payloadHash: 'a'.repeat(64),
  });

  // Manually approve project with approvedRevisionId
  db.prepare(`
    UPDATE projects
    SET approved_revision_id = 'rev-down-1', current_revision_id = 'rev-down-1', status = 'approved'
    WHERE id = 'proj-down-1'
  `).run();

  // Create fake MP4 file
  const videoContent = Buffer.from('fake mp4 video stream bytes for testing');
  const videoRelPath = 'artifacts/proj-down-1/rev-down-1/authoritative.mp4';
  const videoAbsPath = join(dir, videoRelPath);
  const {mkdirSync} = await import('node:fs');
  const {dirname} = await import('node:path');
  mkdirSync(dirname(videoAbsPath), {recursive: true});
  writeFileSync(videoAbsPath, videoContent);

  const sha256 = (await import('node:crypto')).createHash('sha256').update(videoContent).digest('hex');
  db.prepare(`
    INSERT INTO artifacts (
      id, project_id, revision_id, stage_id, attempt_id, kind, relative_path,
      mime_type, byte_size, sha256, is_authoritative, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    'art-down-1',
    'proj-down-1',
    'rev-down-1',
    'output_mp4',
    videoRelPath,
    'video/mp4',
    videoContent.length,
    sha256,
    timestamp,
  );

  const art = {id: 'art-down-1'};

  // 1. Download with Bearer token
  const bearerRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download`,
    headers: {authorization: `Bearer ${serviceToken}`},
  });
  assert.equal(bearerRes.status, 200);
  assert.equal(bearerRes.headers['content-type'], 'video/mp4');
  assert.equal(bearerRes.buffer.toString('utf8'), 'fake mp4 video stream bytes for testing');

  // 2. Download with signed short-lived query token
  const queryToken = generateDownloadToken({
    projectId: 'proj-down-1',
    revisionId: 'rev-down-1',
    artifactId: art.id,
    secret: serviceToken,
    ttlSeconds: 600,
  });

  const signedRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=${encodeURIComponent(queryToken)}`,
  });
  assert.equal(signedRes.status, 200);
  assert.equal(signedRes.headers['content-type'], 'video/mp4');
  assert.equal(signedRes.headers['content-disposition'], 'inline; filename="bright-profile.mp4"');
  assert.equal(signedRes.buffer.toString('utf8'), 'fake mp4 video stream bytes for testing');

  // 3. HEAD returns playback metadata without streaming the artifact body.
  const signedHeadRes = await request({
    port,
    method: 'HEAD',
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=${encodeURIComponent(queryToken)}`,
  });
  assert.equal(signedHeadRes.status, 200);
  assert.equal(signedHeadRes.headers['content-type'], 'video/mp4');
  assert.equal(signedHeadRes.headers['content-length'], String(videoContent.length));
  assert.equal(signedHeadRes.headers['content-disposition'], 'inline; filename="bright-profile.mp4"');
  assert.equal(signedHeadRes.buffer.length, 0);

  // 4. Download with invalid token fails
  const invalidRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=invalid.token`,
  });
  assert.equal(invalidRes.status, 401);
  assert.equal(invalidRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 5. Download with token for wrong project fails
  const wrongProjectToken = generateDownloadToken({
    projectId: 'wrong-proj-999',
    revisionId: 'rev-down-1',
    artifactId: art.id,
    secret: serviceToken,
    ttlSeconds: 600,
  });
  const wrongProjRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=${encodeURIComponent(wrongProjectToken)}`,
  });
  assert.equal(wrongProjRes.status, 401);
  assert.equal(wrongProjRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 6. Download with token for wrong revision fails
  const wrongRevToken = generateDownloadToken({
    projectId: 'proj-down-1',
    revisionId: 'wrong-rev-999',
    artifactId: art.id,
    secret: serviceToken,
    ttlSeconds: 600,
  });
  const wrongRevRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=${encodeURIComponent(wrongRevToken)}`,
  });
  assert.equal(wrongRevRes.status, 401);
  assert.equal(wrongRevRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 7. Download with expired token fails
  const expiredToken = generateDownloadToken({
    projectId: 'proj-down-1',
    revisionId: 'rev-down-1',
    artifactId: art.id,
    secret: serviceToken,
    ttlSeconds: -10,
  });
  const expiredRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=${encodeURIComponent(expiredToken)}`,
  });
  assert.equal(expiredRes.status, 401);
  assert.equal(expiredRes.json?.error?.code, 'DOWNLOAD_TOKEN_EXPIRED');

  // 8. Download without any auth fails
  const unauthRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download`,
  });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.json?.error?.code, 'UNAUTHORIZED');
});

test('Public MCP Server streams authoritative MP4 through /artifacts/:artifactId/download proxy', async (t) => {
  const serviceToken = 'service-secret-token-key-123456';
  const mcpAuthToken = 'mcp-public-auth-token-123456';
  const dir = tempDir();
  const db = openDatabase(join(dir, 'test-proxy.sqlite'));
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
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const appPort = server.address().port;

  const mcpServer = (await import('../../mcp/server.mjs')).createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: mcpAuthToken,
      BRIGHT_BACKEND_URL: `http://127.0.0.1:${appPort}`,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
  });

  mcpServer.listen(0, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpPort = mcpServer.address().port;

  t.after(async () => {
    await new Promise((res) => mcpServer.close(res));
    await new Promise((res) => server.close(res));
    db.close();
  });

  // Setup project and artifact in DB
  const timestamp = new Date().toISOString();
  repos.projects.createWithSources({
    id: 'proj-mcp-down-1',
    creator: 'Creator',
    topic: 'Topic',
    instructions: '',
    status: 'approved',
    origin: 'chatgpt_mcp',
    idempotencyKey: 'k-mcp-down-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  }, []);

  repos.revisions.create({
    id: 'rev-mcp-down-1',
    projectId: 'proj-mcp-down-1',
    revisionNo: 1,
    payload: {creatorName: 'Creator', summary: 'Summary'},
    payloadHash: 'a'.repeat(64),
  });

  db.prepare(`
    UPDATE projects
    SET approved_revision_id = 'rev-mcp-down-1', current_revision_id = 'rev-mcp-down-1', status = 'approved'
    WHERE id = 'proj-mcp-down-1'
  `).run();

  const videoContent = Buffer.from('streamed via public mcp proxy');
  const videoRelPath = 'artifacts/proj-mcp-down-1/rev-mcp-down-1/authoritative.mp4';
  const videoAbsPath = join(dir, videoRelPath);
  const {mkdirSync} = await import('node:fs');
  const {dirname} = await import('node:path');
  mkdirSync(dirname(videoAbsPath), {recursive: true});
  writeFileSync(videoAbsPath, videoContent);

  const sha256 = (await import('node:crypto')).createHash('sha256').update(videoContent).digest('hex');
  db.prepare(`
    INSERT INTO artifacts (
      id, project_id, revision_id, stage_id, attempt_id, kind, relative_path,
      mime_type, byte_size, sha256, is_authoritative, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    'art-mcp-down-1',
    'proj-mcp-down-1',
    'rev-mcp-down-1',
    'output_mp4',
    videoRelPath,
    'video/mp4',
    videoContent.length,
    sha256,
    timestamp,
  );

  const queryToken = generateDownloadToken({
    projectId: 'proj-mcp-down-1',
    revisionId: 'rev-mcp-down-1',
    artifactId: 'art-mcp-down-1',
    secret: serviceToken,
    ttlSeconds: 600,
  });

  // 1. Request with missing token fails with 401 DOWNLOAD_TOKEN_REQUIRED
  const missingTokenRes = await request({
    port: mcpPort,
    path: '/artifacts/art-mcp-down-1/download',
  });
  assert.equal(missingTokenRes.status, 401);
  assert.equal(missingTokenRes.json?.error?.code, 'DOWNLOAD_TOKEN_REQUIRED');

  // 2. Request with empty token fails with 401 DOWNLOAD_TOKEN_REQUIRED
  const emptyTokenRes = await request({
    port: mcpPort,
    path: '/artifacts/art-mcp-down-1/download?token=',
  });
  assert.equal(emptyTokenRes.status, 401);
  assert.equal(emptyTokenRes.json?.error?.code, 'DOWNLOAD_TOKEN_REQUIRED');

  // 3. Request with tampered/invalid token fails with 401 DOWNLOAD_TOKEN_INVALID
  const tamperedTokenRes = await request({
    port: mcpPort,
    path: '/artifacts/art-mcp-down-1/download?token=invalid.tampered.token',
  });
  assert.equal(tamperedTokenRes.status, 401);
  assert.equal(tamperedTokenRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 4. Request with expired token fails with 401 DOWNLOAD_TOKEN_EXPIRED
  const expiredToken = generateDownloadToken({
    projectId: 'proj-mcp-down-1',
    revisionId: 'rev-mcp-down-1',
    artifactId: 'art-mcp-down-1',
    secret: serviceToken,
    ttlSeconds: -10,
  });
  const expiredRes = await request({
    port: mcpPort,
    path: `/artifacts/art-mcp-down-1/download?token=${encodeURIComponent(expiredToken)}`,
  });
  assert.equal(expiredRes.status, 401);
  assert.equal(expiredRes.json?.error?.code, 'DOWNLOAD_TOKEN_EXPIRED');

  // 5. Request with token bound to wrong artifact fails with 401 DOWNLOAD_TOKEN_INVALID
  const wrongArtToken = generateDownloadToken({
    projectId: 'proj-mcp-down-1',
    revisionId: 'rev-mcp-down-1',
    artifactId: 'art-wrong-999',
    secret: serviceToken,
    ttlSeconds: 600,
  });
  const wrongArtRes = await request({
    port: mcpPort,
    path: `/artifacts/art-mcp-down-1/download?token=${encodeURIComponent(wrongArtToken)}`,
  });
  assert.equal(wrongArtRes.status, 401);
  assert.equal(wrongArtRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 6. Request to public MCP port without Bearer token with valid signed token in query -> succeeds
  const proxyRes = await request({
    port: mcpPort,
    path: `/artifacts/art-mcp-down-1/download?token=${encodeURIComponent(queryToken)}`,
  });

  assert.equal(proxyRes.status, 200);
  assert.equal(proxyRes.headers['content-type'], 'video/mp4');
  assert.equal(proxyRes.headers['content-disposition'], 'inline; filename="bright-profile.mp4"');
  assert.equal(proxyRes.buffer.toString('utf8'), 'streamed via public mcp proxy');

  const proxyHeadRes = await request({
    port: mcpPort,
    method: 'HEAD',
    path: `/artifacts/art-mcp-down-1/download?token=${encodeURIComponent(queryToken)}`,
  });
  assert.equal(proxyHeadRes.status, 200);
  assert.equal(proxyHeadRes.headers['content-type'], 'video/mp4');
  assert.equal(proxyHeadRes.headers['content-length'], String(videoContent.length));
  assert.equal(proxyHeadRes.headers['content-disposition'], 'inline; filename="bright-profile.mp4"');
  assert.equal(proxyHeadRes.buffer.length, 0);
});

test('Public MCP Server enforces rate limiting on public download proxy', async (t) => {
  const serviceToken = 'service-secret-token-key-123456';
  const dir = tempDir();
  const db = openDatabase(join(dir, 'test-rate.sqlite'));
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
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const appPort = server.address().port;

  // Configure strict rate limit of 2 requests per minute
  const mcpServer = (await import('../../mcp/server.mjs')).createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      BRIGHT_BACKEND_URL: `http://127.0.0.1:${appPort}`,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      MCP_RATE_LIMIT_PER_MINUTE: 2,
    },
  });

  mcpServer.listen(0, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpPort = mcpServer.address().port;

  t.after(async () => {
    await new Promise((res) => mcpServer.close(res));
    await new Promise((res) => server.close(res));
    db.close();
  });

  // 1st and 2nd request succeed or reach token check
  const res1 = await request({port: mcpPort, path: '/artifacts/art-1/download'});
  assert.equal(res1.status, 401); // token required
  const res2 = await request({port: mcpPort, path: '/artifacts/art-1/download'});
  assert.equal(res2.status, 401);

  // 3rd request exceeds rate limit of 2
  const res3 = await request({port: mcpPort, path: '/artifacts/art-1/download'});
  assert.equal(res3.status, 429);
  assert.equal(res3.json?.error?.code, 'RATE_LIMITED');
});
