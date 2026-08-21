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
import {APPROVAL_MODES} from '../../domain/schemas.mjs';
import {generatePkceChallenge} from '../../security/oauth.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'bright-e2e-test-'));

const readRpcBody = async (response) => {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json();
  const text = await response.text();
  const payloads = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
  if (!payloads.length) throw new Error(`No JSON-RPC payload in response: ${text}`);
  return JSON.parse(payloads.at(-1));
};

const rpc = async (url, body, extraHeaders = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
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

  const mcpAuthToken = 'mcp-chatgpt-token-xyz-12345678';
  const serviceToken = 'internal-service-token-abc-87654321';

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
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
      MCP_AUTH_TOKEN: mcpAuthToken,
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
    mcpAuthToken,
    serviceToken,
    repos,
    jobs,
    artifactStore,
    close,
    reopenDatabase,
  };
};

test('Deterministic Explicit-E2E Flow: Candidate Evidence -> Normalize -> Import -> Generation -> Delegated Approval -> Render -> Authoritative MP4', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  // Step 1: Perform OAuth 2.1 Dynamic Client Registration, User Login, Consent, and PKCE Token Exchange
  const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const codeChallenge = generatePkceChallenge(codeVerifier);
  const redirectUri = 'https://chatgpt.com/connector/oauth/cb_bright_e2e';

  // 1a. Dynamic Client Registration (RFC 7591)
  const regRes = await fetch(new URL('/oauth/register', sys.mcpUrl).toString(), {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_name: 'ChatGPT MCP E2E Client',
      redirect_uris: [redirectUri],
    }),
  });
  assert.equal(regRes.status, 201);
  const {client_id: clientId} = await regRes.json();
  assert.ok(clientId);

  // 1b. User Login with valid credentials to establish authentic session
  const loginRes = await fetch(new URL('/oauth/session/login', sys.mcpUrl).toString(), {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      user_id: 'chatgpt_user_42',
      email: 'user42@example.com',
      password: sys.serviceToken,
    }),
  });
  assert.equal(loginRes.status, 200);
  const {session_token: userSessionToken} = await loginRes.json();
  assert.ok(userSessionToken);

  // 1c. Authenticated User Consent session
  const consentRes = await fetch(new URL('/oauth/authorize/consent', sys.mcpUrl).toString(), {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      'x-session-token': userSessionToken,
    },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'bright:profile:write bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'e2e-state-1',
    }),
  });
  assert.equal(consentRes.status, 200);
  const {code: authCode} = await consentRes.json();
  assert.ok(authCode);

  // 1d. PKCE Token Exchange
  const tokenUrl = new URL('/oauth/token', sys.mcpUrl);
  const tokenRes = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const {access_token: oauthAccessToken} = await tokenRes.json();
  assert.ok(oauthAccessToken);

  const mcpHeaders = {
    authorization: `Bearer ${oauthAccessToken}`,
    'mcp-protocol-version': '2025-06-18',
  };

  // Step 2: Call normalize_evidence via MCP
  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
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
  }, mcpHeaders);

  assert.equal(normRes.response.status, 200);
  assert.equal(normRes.body.result.isError, undefined);
  const evidenceBundle = normRes.body.result.structuredContent;
  assert.equal(evidenceBundle.stats.retainedEvidence, 2);
  assert.equal(evidenceBundle.stats.conflictGroups, 0);

  // Step 3: Call create_video_project
  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
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
  }, mcpHeaders);

  assert.equal(createRes.response.status, 200);
  assert.equal(createRes.body.result.isError, undefined);
  const projectId = createRes.body.result.structuredContent.projectId;
  assert.ok(projectId);
  assert.equal(createRes.body.result.structuredContent.origin, 'chatgpt_mcp');
  assert.equal(createRes.body.result.structuredContent.status, 'generating');

  // Step 4: Simulate Worker completing generation stage
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

  // Step 5: Query status via get_video_project -> should be in review_required
  const getRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'get_video_project',
      arguments: {projectId},
    },
  }, mcpHeaders);

  if (getRes.body?.result?.isError || !getRes.body?.result) {
    console.error('DEBUG getRes.body:', JSON.stringify(getRes.body, null, 2));
  }
  assert.equal(getRes.response.status, 200);
  assert.equal(getRes.body.result.structuredContent.status, 'review_required');
  assert.equal(getRes.body.result.structuredContent.currentRevision.id, revisionId);

  // Step 6a: Negative test - prove ungranted delegated_e2e fails closed over MCP
  const ungrantedApproveRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 50,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId,
        expectedPayloadHash: currentRev.payloadHash,
        mode: APPROVAL_MODES.DELEGATED_E2E,
      },
    },
  }, mcpHeaders);
  assert.equal(ungrantedApproveRes.response.status, 200);
  assert.equal(ungrantedApproveRes.body.result.isError, true);
  assert.match(ungrantedApproveRes.body.result.content[0].text, /Delegated approval blocked: valid explicit user delegation grant is required/i);

  // Step 6b: Real Remote ChatGPT flow - User reviews draft in ChatGPT and confirms approval (mode=user_reviewed)
  // This executes 100% through the authenticated MCP interface with zero direct/loopback app calls
  const approveRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId,
        expectedPayloadHash: currentRev.payloadHash,
        mode: APPROVAL_MODES.USER_REVIEWED,
      },
    },
  }, mcpHeaders);

  assert.equal(approveRes.response.status, 200);
  assert.equal(approveRes.body.result.isError, undefined);
  assert.equal(approveRes.body.result.structuredContent.status, 'approved');

  // Step 7: Call start_video_render via MCP
  const renderStartRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'start_video_render',
      arguments: {projectId},
    },
  }, mcpHeaders);

  assert.equal(renderStartRes.response.status, 200);

  // Step 8: Worker executes media_ingest -> tts -> render
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

  // Step 9: Get project status via MCP -> should be completed with output download URL
  const completedRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'get_video_project',
      arguments: {projectId},
    },
  }, mcpHeaders);

  assert.equal(completedRes.response.status, 200);
  const completedStatus = completedRes.body.result.structuredContent;
  assert.equal(completedStatus.status, 'completed');
  assert.ok(completedStatus.output);
  assert.equal(completedStatus.output.sizeBytes, mp4Content.length);
  assert.equal(completedStatus.output.sha256, mp4Sha);
  assert.ok(completedStatus.output.downloadUrl);

  // Step 10: Download the completed MP4 using the absolute public download URL via MCP gateway
  assert.ok(completedStatus.output.downloadUrl.startsWith('http://'), 'downloadUrl must be an absolute URL');
  const downloadRes = await httpGet(completedStatus.output.downloadUrl);
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers['content-type'], 'video/mp4');
  assert.equal(downloadRes.buffer.toString('utf8'), 'Authoritative 1080p MP4 Video Content Stream');

  // Step 11: Reopen database and prove all provenance and state survive
  const reopened = sys.reopenDatabase();
  const savedProject = reopened.repos.projects.get(projectId);
  assert.equal(savedProject.status, 'completed');
  assert.equal(savedProject.origin, 'chatgpt_mcp');
  assert.equal(savedProject.idempotencyKey, 'mkbhd-e2e-idemp-001');

  const savedRev = reopened.repos.revisions.get(revisionId);
  assert.equal(savedRev.approvalMode, 'user_reviewed');
  assert.equal(savedRev.approvalActor, 'chatgpt_user_42');
});

test('Default Flow stops at review_required and proves NO automatic approval/render occurs', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  const mcpHeaders = {
    authorization: `Bearer ${sys.mcpAuthToken}`,
    'mcp-protocol-version': '2025-06-18',
  };

  await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'chatgpt-client', version: '1.0.0'}},
  }, {authorization: `Bearer ${sys.mcpAuthToken}`});

  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'normalize_evidence',
      arguments: {
        subject: {name: 'Default Creator'},
        researchedAt: '2026-08-20T00:00:00Z',
        items: [{url: 'https://example.com/c1', claim: 'Claim 1', category: 'identity', value: 'Val 1'}],
      },
    },
  }, mcpHeaders);

  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
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
  }, mcpHeaders);

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

test('Adversarial Security: Conflicting evidence, unverified claims, and stale hashes block delegated approval', async (t) => {
  const sys = await startTestSystem();
  t.after(sys.close);

  const mcpHeaders = {
    authorization: `Bearer ${sys.mcpAuthToken}`,
    'mcp-protocol-version': '2025-06-18',
  };

  await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'chatgpt-client', version: '1.0.0'}},
  }, {authorization: `Bearer ${sys.mcpAuthToken}`});

  // Evidence with conflicting values
  const normRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'normalize_evidence',
      arguments: {
        subject: {name: 'Controversial Creator'},
        researchedAt: '2026-08-20T00:00:00Z',
        items: [
          {url: 'https://src-a.com', claim: 'Founded company in 2010', category: 'career', value: 2010},
          {url: 'https://src-b.com', claim: 'Founded company in 2015', category: 'career', value: 2015},
        ],
      },
    },
  }, mcpHeaders);

  const bundle = normRes.body.result.structuredContent;
  assert.ok(bundle.stats.conflictGroups > 0, 'Should detect conflict group');

  // Import conflicting project
  const createRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'create_video_project',
      arguments: {
        creator: 'Controversial Creator',
        topic: 'Company History',
        evidenceBundle: bundle,
        idempotencyKey: 'conflict-proj-001',
      },
    },
  }, mcpHeaders);

  const projectId = createRes.body.result.structuredContent.projectId;
  const sources = sys.repos.sources.list(projectId);

  // Worker commits generation
  const genClaim = sys.jobs.claimNext({workerId: 'worker-conflict', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  const {revisionId} = sys.jobs.commitGeneration({
    stageId: genClaim.stageId,
    claimToken: genClaim.claimToken,
    nowMs: Date.now(),
    draft: {
      creatorName: 'Controversial Creator',
      summary: 'Summary',
      claims: [{id: 'c-1', text: 'claim', sourceIds: [sources[0].id], verified: true}],
      script: [{id: 's-1', text: 'script', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      voiceover: {chunks: [{id: 'v-1', text: 'vo', start: 0, duration: 5, sourceIds: [sources[0].id]}]},
      scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: [sources[0].id]}],
      render: {duration: 5},
    },
  });
  const currentRev = sys.repos.revisions.get(revisionId);

  // 1. Attempt delegated approval WITHOUT explicit user intent -> must be rejected
  const approveNoIntentRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId,
        expectedPayloadHash: currentRev.payloadHash,
        mode: APPROVAL_MODES.DELEGATED_E2E,
      },
    },
  }, mcpHeaders);

  assert.equal(approveNoIntentRes.response.status, 200);
  assert.equal(approveNoIntentRes.body.result.isError, true);
  assert.match(approveNoIntentRes.body.result.content[0].text, /delegated approval blocked/i);

  // 2. Acquire grant via loopback user UI route, but project has unresolved conflicts -> must be rejected by backend safety gate
  const grantRes = await fetch(`${sys.appUrl}/api/projects/${projectId}/delegation-grant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
    },
    body: JSON.stringify({actor: 'operator_ui_user'}),
  });
  assert.equal(grantRes.status, 200);
  const {delegationGrant} = await grantRes.json();

  const approveConflictRes = await rpc(sys.mcpUrl, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId,
        revisionId,
        expectedPayloadHash: currentRev.payloadHash,
        mode: APPROVAL_MODES.DELEGATED_E2E,
        delegationGrant,
        delegatedContext: {userExplicitIntent: 'Approve automatically with conflicts'},
      },
    },
  }, mcpHeaders);

  assert.equal(approveConflictRes.response.status, 200);
  assert.equal(approveConflictRes.body.result.isError, true);
  assert.match(approveConflictRes.body.result.content[0].text, /unresolved evidence conflict group/i);

  // 3. Loopback UI endpoint rejects missing/malformed actor body
  const malformedGrantRes = await fetch(`${sys.appUrl}/api/projects/${projectId}/delegation-grant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
    },
    body: JSON.stringify({}),
  });
  assert.equal(malformedGrantRes.status, 400);

  // Verify project remains in review_required
  const project = sys.repos.projects.get(projectId);
  assert.equal(project.status, 'review_required');
});