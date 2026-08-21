import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createAppServer} from '../../app/server.mjs';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-e2e-test-'));

const readRpcBody = async (response) => {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) {
            await reader.cancel();
            return JSON.parse(jsonStr);
          }
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  throw new Error(`No SSE JSON payload received in: ${buffer}`);
};

const rpc = async (url, body, extraHeaders = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      host: '127.0.0.1',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {response, body: await readRpcBody(response)};
};

const httpGet = (url, headers = {}) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'GET',
    headers: {
      host: parsed.host,
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
  req.end();
});

const startTestSystem = async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'bright-test.sqlite');
  let db = openDatabase(dbPath);
  migrateDatabase(db);
  let repos = createRepositories(db);
  let jobs = createJobStore(db);
  let artifactStore = createArtifactStore(db);

  const serviceToken = 'internal-service-token-abc-87654321';

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects: 5,
  });

  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  const net = await import('node:net');
  const tempServer = net.createServer();
  tempServer.listen(0, '127.0.0.1');
  await once(tempServer, 'listening');
  const mcpPort = tempServer.address().port;
  await new Promise((res) => tempServer.close(res));

  const mcpPublicUrl = `http://127.0.0.1:${mcpPort}`;
  const mcpServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_MAX_ACTIVE_PROJECTS: '5',
      MCP_MAX_INFLIGHT_WRITE_REQUESTS: '4',
      MCP_PORT: String(mcpPort),
      MCP_PUBLIC_URL: mcpPublicUrl,
      BRIGHT_BACKEND_URL: appUrl,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
  });

  mcpServer.listen(mcpPort, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpUrl = `${mcpPublicUrl}/mcp`;

  const close = async () => {
    await new Promise((res) => mcpServer.close(res));
    await new Promise((res) => appServer.close(res));
    db.close();
  };

  const reopenDatabase = () => {
    db.close();
    db = openDatabase(dbPath);
    repos = createRepositories(db);
    jobs = createJobStore(db);
    artifactStore = createArtifactStore(db);
    return {db, repos, jobs, artifactStore};
  };

  return {
    dir,
    dbPath,
    appServer,
    mcpServer,
    appUrl,
    mcpUrl,
    serviceToken,
    repos,
    jobs,
    artifactStore,
    close,
    reopenDatabase,
  };
};

test('Deterministic No-Auth E2E Flow: Normalize -> Import -> Worker Generation -> User Review Approval -> Render -> Authoritative MP4', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  // Step 1: Call normalize_evidence via MCP (no auth header needed)
  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'normalize_evidence',
      arguments: {
        subject: {name: 'Marques Brownlee'},
        researchedAt: '2026-08-20T00:00:00Z',
        items: [
          {
            url: 'https://en.wikipedia.org/wiki/MKBHD',
            claim: 'Marques Brownlee is an American technology YouTuber.',
            category: 'identity',
            value: 'Marques Brownlee',
          },
          {
            url: 'https://youtube.com/mkbhd',
            claim: 'MKBHD channel has over 18 million subscribers.',
            category: 'career',
            value: 18000000,
            unit: 'subscribers',
          },
        ],
      },
    },
  });

  assert.equal(normRes.response.status, 200);
  assert.equal(normRes.body.result.isError, undefined);
  const evidenceBundle = normRes.body.result.structuredContent;
  assert.equal(evidenceBundle.stats.retainedEvidence, 2);
  assert.equal(evidenceBundle.stats.conflictGroups, 0);

  // Step 2: Call create_video_project via MCP
  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_video_project',
      arguments: {
        creator: 'Marques Brownlee',
        topic: 'Creator Milestones',
        instructions: 'Focus on technology reviews and YouTube growth.',
        evidenceBundle,
        idempotencyKey: 'mkbhd-e2e-idemp-001',
      },
    },
  });

  assert.equal(createRes.response.status, 200);
  assert.equal(createRes.body.result.isError, undefined);
  const projectId = createRes.body.result.structuredContent.projectId;
  assert.ok(projectId);
  assert.equal(createRes.body.result.structuredContent.origin, 'chatgpt_mcp');
  assert.equal(createRes.body.result.structuredContent.status, 'generating');

  // Step 3: Worker simulates completing generation stage
  const sources = sys.repos.sources.list(projectId);
  assert.equal(sources.length, 2);

  const draftPayload = {
    creatorName: 'Marques Brownlee',
    summary: 'Marques Brownlee is a renowned tech reviewer on YouTube.',
    claims: [
      {id: 'c-1', text: 'Top tech YouTuber', sourceIds: [sources[0].id], verified: true},
      {id: 'c-2', text: '18M subscribers', sourceIds: [sources[1].id], verified: true},
    ],
    script: [
      {id: 's-1', text: 'Marques Brownlee leads tech journalism on YouTube.', start: 0, duration: 5, sourceIds: [sources[0].id]},
      {id: 's-2', text: 'With 18 million subscribers, his reviews set the standard.', start: 5, duration: 5, sourceIds: [sources[1].id]},
    ],
    voiceover: {
      chunks: [
        {id: 'v-1', text: 'Marques Brownlee leads tech journalism on YouTube.', start: 0, duration: 5, sourceIds: [sources[0].id]},
        {id: 'v-2', text: 'With 18 million subscribers, his reviews set the standard.', start: 5, duration: 5, sourceIds: [sources[1].id]},
      ],
    },
    scenes: [
      {id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]},
      {id: 'sc-2', type: 'stat', start: 5, duration: 5, sourceIds: [sources[1].id]},
    ],
    render: {duration: 10, renderScale: 1, crf: 22},
  };

  const genClaim = sys.jobs.claimNext({workerId: 'worker-e2e', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = sys.jobs.commitGeneration({
    stageId: genClaim.stageId,
    claimToken: genClaim.claimToken,
    nowMs: Date.now(),
    draft: draftPayload,
  });

  const currentRev = sys.repos.revisions.get(revisionId);

  // Step 4: Query status via get_video_project -> review_required
  const getRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'get_video_project',
      arguments: {projectId},
    },
  });

  assert.equal(getRes.response.status, 200);
  assert.equal(getRes.body.result.structuredContent.status, 'review_required');
  assert.equal(getRes.body.result.structuredContent.currentRevision.id, revisionId);

  // Step 5: Approve project via approve_video_project tool
  const approveRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId,
        expectedPayloadHash: currentRev.payloadHash,
      },
    },
  });

  assert.equal(approveRes.response.status, 200);
  assert.equal(approveRes.body.result.isError, undefined);
  assert.equal(approveRes.body.result.structuredContent.status, 'approved');

  // Step 6: Start video render via start_video_render tool
  const renderStartRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'start_video_render',
      arguments: {projectId},
    },
  });

  assert.equal(renderStartRes.response.status, 200);

  // Step 7: Worker executes media_ingest -> tts -> render
  // Media Ingest
  const mediaClaim = sys.jobs.claimNext({workerId: 'worker-e2e', allowedTypes: ['media_ingest'], nowMs: Date.now(), leaseMs: 30000});
  const manifestPath = `artifacts/${projectId}/${revisionId}/manifest.json`;
  const absManifest = join(sys.dir, manifestPath);
  mkdirSync(dirname(absManifest), {recursive: true});
  writeFileSync(absManifest, JSON.stringify({scenes: draftPayload.scenes}));
  sys.artifactStore.commitMediaIngest({
    stageId: mediaClaim.stageId,
    claimToken: mediaClaim.claimToken,
    nowMs: Date.now(),
    nextMaxAttempts: 4,
    manifestArtifact: {
      kind: 'media_manifest',
      relativePath: manifestPath,
      mimeType: 'application/json',
      byteSize: 100,
      sha256: 'a'.repeat(64),
    },
  });

  // TTS
  const ttsClaim = sys.jobs.claimNext({workerId: 'worker-e2e', allowedTypes: ['tts'], nowMs: Date.now(), leaseMs: 30000});
  const audioPath = `artifacts/${projectId}/${revisionId}/audio.wav`;
  const absAudio = join(sys.dir, audioPath);
  writeFileSync(absAudio, Buffer.from('fake audio bytes'));
  sys.artifactStore.commitTts({
    stageId: ttsClaim.stageId,
    claimToken: ttsClaim.claimToken,
    nowMs: Date.now(),
    nextMaxAttempts: 4,
    audioArtifact: {
      kind: 'tts_audio',
      relativePath: audioPath,
      mimeType: 'audio/wav',
      byteSize: 16,
      sha256: 'b'.repeat(64),
    },
  });

  // Render
  const renderClaim = sys.jobs.claimNext({workerId: 'worker-e2e', allowedTypes: ['render'], nowMs: Date.now(), leaseMs: 30000});
  sys.artifactStore.markRendering({
    stageId: renderClaim.stageId,
    claimToken: renderClaim.claimToken,
    nowMs: Date.now(),
  });

  const mp4Content = Buffer.from('Authoritative 1080p MP4 Video Content Stream');
  const mp4RelPath = `artifacts/${projectId}/${revisionId}/authoritative.mp4`;
  const absMp4 = join(sys.dir, mp4RelPath);
  writeFileSync(absMp4, mp4Content);
  const mp4Sha = createHash('sha256').update(mp4Content).digest('hex');

  sys.artifactStore.commitRender({
    stageId: renderClaim.stageId,
    claimToken: renderClaim.claimToken,
    nowMs: Date.now(),
    outputArtifact: {
      kind: 'output_mp4',
      relativePath: mp4RelPath,
      mimeType: 'video/mp4',
      byteSize: mp4Content.length,
      sha256: mp4Sha,
    },
  });

  // Step 8: Get project status via MCP -> completed with output download URL
  const completedRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'get_video_project',
      arguments: {projectId},
    },
  });

  assert.equal(completedRes.response.status, 200);
  const completedStatus = completedRes.body.result.structuredContent;
  assert.equal(completedStatus.status, 'completed');
  assert.ok(completedStatus.output);
  assert.equal(completedStatus.output.sizeBytes, mp4Content.length);
  assert.equal(completedStatus.output.sha256, mp4Sha);
  assert.ok(completedStatus.output.downloadUrl);

  // Step 9: Download the completed MP4 using the absolute download URL
  assert.ok(completedStatus.output.downloadUrl.startsWith('http://'), 'downloadUrl must be an absolute URL');
  const downloadRes = await httpGet(completedStatus.output.downloadUrl);
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers['content-type'], 'video/mp4');
  assert.equal(downloadRes.buffer.toString('utf8'), 'Authoritative 1080p MP4 Video Content Stream');

  // Step 10: Reopen database and verify persisted state
  const reopened = sys.reopenDatabase();
  const savedProject = reopened.repos.projects.get(projectId);
  assert.equal(savedProject.status, 'completed');
  assert.equal(savedProject.origin, 'chatgpt_mcp');
  assert.equal(savedProject.idempotencyKey, 'mkbhd-e2e-idemp-001');

  const savedRev = reopened.repos.revisions.get(revisionId);
  assert.equal(savedRev.approvalMode, 'user_reviewed');
  assert.equal(savedRev.approvalActor, 'chatgpt_mcp_noauth');
});

test('Default Flow stops at review_required and proves NO automatic approval/render occurs', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'normalize_evidence',
      arguments: {
        subject: {name: 'Default Creator'},
        researchedAt: '2026-08-20T00:00:00Z',
        items: [{url: 'https://example.com/c1', claim: 'Claim 1', category: 'identity', value: 'Val 1'}],
      },
    },
  });

  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_video_project',
      arguments: {
        creator: 'Default Creator',
        topic: 'Default Topic',
        evidenceBundle: normRes.body.result.structuredContent,
        idempotencyKey: 'default-flow-001',
      },
    },
  });

  const projectId = createRes.body.result.structuredContent.projectId;
  const sources = sys.repos.sources.list(projectId);

  // Worker commits generation
  const genClaim = sys.jobs.claimNext({workerId: 'worker-default', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  sys.jobs.commitGeneration({
    stageId: genClaim.stageId,
    claimToken: genClaim.claimToken,
    nowMs: Date.now(),
    draft: {
      creatorName: 'Default Creator',
      summary: 'Summary',
      claims: [{id: 'c-1', text: 'claim', sourceIds: [sources[0].id], verified: true}],
      script: [{id: 's-1', text: 'script', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      voiceover: {chunks: [{id: 'v-1', text: 'vo', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
      scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      render: {duration: 5},
    },
  });

  // Verify project is in review_required
  const project = sys.repos.projects.get(projectId);
  assert.equal(project.status, 'review_required');

  // Verify no runnable stages exist for media_ingest, tts, or render
  const nextClaim = sys.jobs.claimNext({workerId: 'worker-default', allowedTypes: ['media_ingest', 'tts', 'render'], nowMs: Date.now(), leaseMs: 30000});
  assert.equal(nextClaim, null, 'No downstream stage should be runnable before human review approval');
});

test('Draft Modification and Rejection Flow via MCP Tools', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'normalize_evidence',
      arguments: {
        subject: {name: 'Edit Test Creator'},
        researchedAt: '2026-08-20T00:00:00Z',
        items: [{url: 'https://example.com/edit1', claim: 'Edit claim 1', category: 'identity', value: 'Edit Creator'}],
      },
    },
  });

  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_video_project',
      arguments: {
        creator: 'Edit Test Creator',
        topic: 'Editing Drafts',
        evidenceBundle: normRes.body.result.structuredContent,
        idempotencyKey: 'edit-draft-proj-001',
      },
    },
  });

  const projectId = createRes.body.result.structuredContent.projectId;
  const sources = sys.repos.sources.list(projectId);

  // Worker commits generation
  const genClaim = sys.jobs.claimNext({workerId: 'worker-edit', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId: r1Id} = sys.jobs.commitGeneration({
    stageId: genClaim.stageId,
    claimToken: genClaim.claimToken,
    nowMs: Date.now(),
    draft: {
      creatorName: 'Edit Test Creator',
      summary: 'Summary 1',
      claims: [{id: 'c-1', text: 'claim 1', sourceIds: [sources[0].id], verified: true}],
      script: [{id: 's-1', text: 'script 1', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      voiceover: {chunks: [{id: 'v-1', text: 'vo 1', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
      scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      render: {duration: 5},
    },
  });
  const r1 = sys.repos.revisions.get(r1Id);

  // 1. Stale payload hash rejection
  const staleApproveRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId: r1Id,
        expectedPayloadHash: '0'.repeat(64),
      },
    },
  });
  assert.equal(staleApproveRes.response.status, 200);
  assert.equal(staleApproveRes.body.result.isError, true);
  assert.match(staleApproveRes.body.result.content[0].text, /does not match/i);

  // 2. Edit draft via MCP
  const editedDraft = {
    creatorName: 'Edit Test Creator (Revised)',
    summary: 'Revised summary',
    claims: [{id: 'c-1', text: 'revised claim', sourceIds: [sources[0].id], verified: true}],
    script: [{id: 's-1', text: 'revised script', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    voiceover: {chunks: [{id: 'v-1', text: 'revised voice', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
    render: {duration: 5},
  };

  const editRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'edit_video_draft',
      arguments: {
        projectId,
        revisionId: r1Id,
        expectedPayloadHash: r1.payloadHash,
        draft: editedDraft,
      },
    },
  });
  assert.equal(editRes.response.status, 200);
  assert.equal(editRes.body.result.isError, undefined);
  const updatedRev = editRes.body.result.structuredContent.currentRevision;
  assert.notEqual(updatedRev.payloadHash, r1.payloadHash);

  // 3. Approve revised draft
  const approveR2Res = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId: updatedRev.id,
        expectedPayloadHash: updatedRev.payloadHash,
      },
    },
  });
  assert.equal(approveR2Res.response.status, 200);
  assert.equal(approveR2Res.body.result.structuredContent.status, 'approved');
});
