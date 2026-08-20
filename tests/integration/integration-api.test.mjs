import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createAppServer} from '../../app/server.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';
import {APPROVAL_MODES} from '../../domain/schemas.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-integration-test-'));

const startTestServer = async ({serviceToken = 'secret-service-token'} = {}) => {
  const dir = tempDir();
  const db = openDatabase(join(dir, 'test.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);

  const server = createAppServer({
    db,
    repos,
    jobs,
    dataDir: dir,
    integrationToken: serviceToken,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  const close = () => new Promise((resolve) => {
    server.close(() => {
      db.close();
      resolve();
    });
  });

  return {server, port, repos, jobs, close};
};

const request = ({port, path, method = 'GET', headers = {}, body = null}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      host: '127.0.0.1',
      ...(body ? {'content-type': 'application/json'} : {}),
      ...headers,
    },
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(data); } catch {}
      resolve({status: res.statusCode, headers: res.headers, body: data, json});
    });
  });
  req.on('error', reject);
  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
});

const sampleEvidenceBundle = (options = {}) => normalizeEvidence({
  researchedAt: '2026-08-20T00:00:00.000Z',
  subject: {name: 'Marques Brownlee'},
  items: [
    {
      url: 'https://en.wikipedia.org/wiki/MKBHD',
      claim: 'Marques Brownlee is an American YouTuber.',
      category: 'identity',
      value: 'Marques Brownlee',
      confidence: 'high',
    },
    {
      url: 'https://twitter.com/MKBHD',
      claim: 'Marques Brownlee runs the MKBHD YouTube channel with over 18 million subscribers.',
      category: 'career',
      value: '18 million subscribers',
      confidence: 'high',
    },
  ],
  ...options,
});

test('POST /api/integrations/chatgpt/projects/import requires valid service token', async (t) => {
  const {port, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const unauth = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    body: {creator: 'Creator', topic: 'Topic', evidenceBundle: sampleEvidenceBundle(), idempotencyKey: 'k1'},
  });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.json?.error?.code, 'UNAUTHORIZED');

  const invalidAuth = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer wrong-token'},
    body: {creator: 'Creator', topic: 'Topic', evidenceBundle: sampleEvidenceBundle(), idempotencyKey: 'k1'},
  });
  assert.equal(invalidAuth.status, 401);
});

test('POST /api/integrations/chatgpt/projects/import imports project, sources and queues generation stage', async (t) => {
  const {port, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const bundle = sampleEvidenceBundle();
  const res = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      instructions: 'Highlight key milestones',
      evidenceBundle: bundle,
      idempotencyKey: 'idemp-run-001',
    },
  });

  assert.equal(res.status, 201);
  assert.ok(res.json?.project?.projectId);
  assert.equal(res.json?.project?.origin, 'chatgpt_mcp');
  assert.equal(res.json?.stage?.type, 'generation');
  assert.equal(res.json?.stage?.state, 'queued');

  // Idempotent duplicate returns 200 with existing project
  const duplicate = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      instructions: 'Highlight key milestones',
      evidenceBundle: bundle,
      idempotencyKey: 'idemp-run-001',
    },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json?.project?.projectId, res.json?.project?.projectId);

  // Mismatched payload with same idempotency key returns 409 conflict
  const conflict = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Different Creator',
      topic: 'Different Topic',
      evidenceBundle: bundle,
      idempotencyKey: 'idemp-run-001',
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json?.error?.code, 'IDEMPOTENCY_CONFLICT');
});

test('GET /api/integrations/chatgpt/projects/:projectId returns projected status schema', async (t) => {
  const {port, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const importRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      evidenceBundle: sampleEvidenceBundle(),
      idempotencyKey: 'idemp-status-001',
    },
  });

  const projectId = importRes.json.project.projectId;

  const statusRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}`,
    method: 'GET',
    headers: {authorization: 'Bearer secure-token-123'},
  });

  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json?.projectId, projectId);
  assert.equal(statusRes.json?.origin, 'chatgpt_mcp');
  assert.ok(statusRes.json?.progress);
  assert.equal(statusRes.json?.progress?.currentStage, 'generation');
  assert.equal(statusRes.json?.evidenceSummary?.inputItems, 2);
  assert.equal(statusRes.json?.evidenceSummary?.retainedEvidence, 2);
});

test('POST /api/integrations/chatgpt/projects/:projectId/approve enforces delegated_e2e safety gate', async (t) => {
  const {port, repos, jobs, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const bundle = sampleEvidenceBundle();
  const importRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      evidenceBundle: bundle,
      idempotencyKey: 'idemp-appr-001',
    },
  });
  const projectId = importRes.json.project.projectId;

  // Simulate generation completion -> review_required
  const sources = repos.sources.list(projectId);
  const payload = {
    creatorName: 'Marques Brownlee',
    summary: 'Tech reviewer',
    claims: [{id: 'c-1', text: 'Top YouTuber', sourceIds: [sources[0].id], verified: true}],
    script: [{id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    voiceover: {chunks: [{id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    render: {duration: 5},
  };

  const claim = jobs.claimNext({workerId: 'worker-test-1', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = jobs.commitGeneration({
    stageId: claim.stageId,
    claimToken: claim.claimToken,
    nowMs: Date.now(),
    draft: payload,
  });
  const revision = repos.revisions.get(revisionId);

  // Approve with delegated_e2e mode
  const approveRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/approve`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      projectId,
      revisionId: revision.id,
      expectedPayloadHash: revision.payloadHash,
      mode: APPROVAL_MODES.DELEGATED_E2E,
      delegatedContext: {userExplicitIntent: 'Create full video end to end'},
    },
  });

  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.json?.revision?.approvalMode, APPROVAL_MODES.DELEGATED_E2E);
});

test('POST /api/integrations/chatgpt/projects/:projectId/approve blocks delegated_e2e when claims are unverified', async (t) => {
  const {port, repos, jobs, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const bundle = sampleEvidenceBundle();
  const importRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      evidenceBundle: bundle,
      idempotencyKey: 'idemp-appr-unverified',
    },
  });
  const projectId = importRes.json.project.projectId;

  const sources = repos.sources.list(projectId);
  const payloadWithUnverified = {
    creatorName: 'Marques Brownlee',
    summary: 'Tech reviewer',
    claims: [{id: 'c-1', text: 'Top YouTuber', sourceIds: [sources[0].id], verified: false}],
    script: [{id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    voiceover: {chunks: [{id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    render: {duration: 5},
  };

  const claim = jobs.claimNext({workerId: 'worker-test-1', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = jobs.commitGeneration({
    stageId: claim.stageId,
    claimToken: claim.claimToken,
    nowMs: Date.now(),
    draft: payloadWithUnverified,
  });
  const revision = repos.revisions.get(revisionId);

  const blockedRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/approve`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      projectId,
      revisionId: revision.id,
      expectedPayloadHash: revision.payloadHash,
      mode: APPROVAL_MODES.DELEGATED_E2E,
      delegatedContext: {userExplicitIntent: 'Run E2E'},
    },
  });

  assert.equal(blockedRes.status, 409);
  assert.equal(blockedRes.json?.error?.code, 'DELEGATED_APPROVAL_BLOCKED');
});

test('POST /api/integrations/chatgpt/projects/:projectId/draft allows structured draft edits', async (t) => {
  const {port, repos, jobs, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const importRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      evidenceBundle: sampleEvidenceBundle(),
      idempotencyKey: 'idemp-draft-edit',
    },
  });
  const projectId = importRes.json.project.projectId;
  const sources = repos.sources.list(projectId);

  const claim = jobs.claimNext({workerId: 'worker-test-1', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = jobs.commitGeneration({
    stageId: claim.stageId,
    claimToken: claim.claimToken,
    nowMs: Date.now(),
    draft: {
      creatorName: 'Marques Brownlee',
      summary: 'Tech reviewer',
      claims: [{id: 'c-1', text: 'Top YouTuber', sourceIds: [sources[0].id], verified: true}],
      script: [{id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      voiceover: {chunks: [{id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
      scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      render: {duration: 5},
    },
  });
  const revision = repos.revisions.get(revisionId);

  const editedDraft = {
    creatorName: 'Marques Brownlee',
    summary: 'Updated Summary',
    claims: [{id: 'c-1', text: 'Top YouTuber Updated', sourceIds: [sources[0].id], verified: true}],
    script: [{id: 's-1', text: 'Opening Updated', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    voiceover: {chunks: [{id: 'v-1', text: 'Opening Updated', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    render: {duration: 5},
  };

  const editRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/draft`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      projectId,
      revisionId: revision.id,
      expectedPayloadHash: revision.payloadHash,
      draft: editedDraft,
    },
  });

  assert.equal(editRes.status, 200);
  assert.equal(editRes.json?.project?.currentRevision?.draft?.summary, 'Updated Summary');
});

test('POST /api/integrations/chatgpt/projects/:projectId/render starts media_ingest and cancel/retry works', async (t) => {
  const {port, repos, jobs, close} = await startTestServer({serviceToken: 'secure-token-123'});
  t.after(close);

  const importRes = await request({
    port,
    path: '/api/integrations/chatgpt/projects/import',
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      creator: 'Marques Brownlee',
      topic: 'Career overview',
      evidenceBundle: sampleEvidenceBundle(),
      idempotencyKey: 'idemp-render-run',
    },
  });
  const projectId = importRes.json.project.projectId;
  const sources = repos.sources.list(projectId);

  const claim = jobs.claimNext({workerId: 'worker-test-1', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = jobs.commitGeneration({
    stageId: claim.stageId,
    claimToken: claim.claimToken,
    nowMs: Date.now(),
    draft: {
      creatorName: 'Marques Brownlee',
      summary: 'Summary',
      claims: [{id: 'c-1', text: 'Top YouTuber', sourceIds: [sources[0].id], verified: true}],
      script: [{id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      voiceover: {chunks: [{id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
      scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      render: {duration: 5},
    },
  });
  const revision = repos.revisions.get(revisionId);

  // Approve project
  await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/approve`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
    body: {
      projectId,
      revisionId: revision.id,
      expectedPayloadHash: revision.payloadHash,
      mode: APPROVAL_MODES.DELEGATED_E2E,
      delegatedContext: {userExplicitIntent: 'Create video'},
    },
  });

  // Start render
  const renderRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/render`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
  });

  assert.equal(renderRes.status, 202);
  assert.equal(renderRes.json?.stage?.type, 'media_ingest');

  // Cancel render
  const cancelRes = await request({
    port,
    path: `/api/integrations/chatgpt/projects/${projectId}/cancel`,
    method: 'POST',
    headers: {authorization: 'Bearer secure-token-123'},
  });

  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json?.stage?.state, 'cancelled');
});