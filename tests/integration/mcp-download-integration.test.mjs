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
  assert.equal(signedRes.buffer.toString('utf8'), 'fake mp4 video stream bytes for testing');

  // 3. Download with invalid token fails
  const invalidRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download?token=invalid.token`,
  });
  assert.equal(invalidRes.status, 401);
  assert.equal(invalidRes.json?.error?.code, 'DOWNLOAD_TOKEN_INVALID');

  // 4. Download with token for wrong project fails
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

  // 5. Download with token for wrong revision fails
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

  // 6. Download with expired token fails
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

  // 7. Download without any auth fails
  const unauthRes = await request({
    port,
    path: `/api/integrations/chatgpt/artifacts/${art.id}/download`,
  });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.json?.error?.code, 'UNAUTHORIZED');
});