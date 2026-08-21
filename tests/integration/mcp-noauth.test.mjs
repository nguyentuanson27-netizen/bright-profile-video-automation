import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {createBrightHttpServer} from '../../mcp/server.mjs';
import {createAppServer} from '../../app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'mcp-noauth-test-'));

const httpAgent = new http.Agent({keepAlive: true, maxSockets: 50});

const sendRawRpc = ({port, path = '/mcp', body = {}, headers = {}}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    agent: httpAgent,
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    },
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      data += chunk;
      if (data.includes('data:')) {
        const line = data.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) {
            try {
              const parsed = JSON.parse(jsonStr);
              req.destroy();
              resolve({status: res.statusCode, body: parsed});
              return;
            } catch {}
          }
        }
      }
    });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve({status: res.statusCode, body: parsed});
      } catch {
        const line = data.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          resolve({status: res.statusCode, body: JSON.parse(line.slice(5).trim())});
        } else {
          resolve({status: res.statusCode, body: null, raw: data});
        }
      }
    });
  });
  req.on('error', (err) => {
    // If we destroyed the request after receiving data, ignore aborted error
    if (err.code === 'ECONNRESET' || req.destroyed) return;
    reject(err);
  });
  req.write(payload);
  req.end();
});

const sendRawHttp = ({port, path = '/mcp', method = 'POST', headers = {}, body = ''}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      accept: 'application/json, text/event-stream',
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
  if (body) req.write(body);
  req.end();
});

const makeSampleBundle = (name = 'Test Subject') => {
  return normalizeEvidence({
    subject: {name},
    researchedAt: '2026-08-21T00:00:00.000Z',
    items: [
      {
        url: 'https://example.com/item1',
        claim: `${name} is a renowned creator.`,
        category: 'identity',
        value: name,
      },
    ],
  });
};

test('MCP No-Auth: Tool Discovery & Security Scheme Metadata', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'false',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((res) => server.close(res)));

  // 1. Initializing and listing tools requires NO Authorization header
  const listRes = await sendRawRpc({
    port,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    },
  });

  assert.equal(listRes.status, 200);
  assert.ok(listRes.body?.result?.tools);
  const tools = listRes.body.result.tools;

  // Expected 8 tools
  const toolNames = tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    'approve_video_project',
    'cancel_video_project',
    'create_video_project',
    'edit_video_draft',
    'get_video_project',
    'normalize_evidence',
    'retry_video_project',
    'start_video_render',
  ].sort());

  // 2. All tools declare securitySchemes: [{type: 'noauth'}] at tool root
  for (const tool of tools) {
    assert.ok(tool.securitySchemes, `Tool ${tool.name} missing root-level securitySchemes`);
    assert.deepEqual(tool.securitySchemes, [{type: 'noauth'}], `Tool ${tool.name} must declare root-level noauth`);
    assert.equal(tool.annotations?.securitySchemes, undefined, `Tool ${tool.name} must not hide securitySchemes inside annotations`);
  }
});

test('MCP No-Auth: Deferred OAuth/DCR/Session Routes Return 404', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((res) => server.close(res)));

  const deferredPaths = [
    '/oauth/register',
    '/oauth/authorize',
    '/oauth/authorize/consent',
    '/oauth/token',
    '/oauth/session/login',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ];

  for (const path of deferredPaths) {
    const res = await fetch(`${baseUrl}${path}`, {headers: {host: '127.0.0.1'}});
    assert.equal(res.status, 404, `Path ${path} must return 404`);
    await res.text();
  }
});

test('MCP No-Auth: Kill-Switch (MCP_NOAUTH_WRITE_ENABLED=false)', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'false',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((res) => server.close(res)));

  // Read-only normalize_evidence works when writes disabled
  const normRes = await sendRawRpc({
    port,
    body: {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'normalize_evidence',
        arguments: {
          subject: {name: 'Test Subject'},
          researchedAt: '2026-08-21T00:00:00Z',
          items: [{url: 'https://example.com/1', claim: 'Claim 1'}],
        },
      },
    },
  });
  assert.equal(normRes.status, 200);
  assert.equal(normRes.body?.result?.isError, undefined);

  const sampleHash = 'a'.repeat(64);
  const sampleDraft = {
    creatorName: 'Test',
    summary: 'Summary',
    claims: [{id: 'c-1', text: 'claim', sourceIds: ['src-1'], verified: true}],
    script: [{id: 's-1', text: 'script', start: 0, duration: 5, sourceIds: ['src-1']}],
    voiceover: {chunks: [{id: 'v-1', text: 'vo', start: 0, duration: 5, sourceIds: ['src-1']}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: ['src-1']}],
    render: {duration: 5, renderScale: 1, crf: 22},
  };

  // All mutating tools are blocked with NOAUTH_WRITE_DISABLED
  const mutatingCalls = [
    {name: 'create_video_project', arguments: {creator: 'Test', topic: 'Topic', evidenceBundle: makeSampleBundle(), idempotencyKey: 'idemp-1'}},
    {name: 'edit_video_draft', arguments: {projectId: 'p-1', revisionId: 'r-1', expectedPayloadHash: sampleHash, draft: sampleDraft}},
    {name: 'approve_video_project', arguments: {projectId: 'p-1', revisionId: 'r-1', expectedPayloadHash: sampleHash}},
    {name: 'start_video_render', arguments: {projectId: 'p-1'}},
    {name: 'retry_video_project', arguments: {projectId: 'p-1'}},
    {name: 'cancel_video_project', arguments: {projectId: 'p-1'}},
  ];

  for (const call of mutatingCalls) {
    const res = await sendRawRpc({
      port,
      body: {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: call,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body?.result?.isError, true, `Mutating tool ${call.name} must return isError: true when writes disabled`);
    assert.match(res.body?.result?.content?.[0]?.text, /NOAUTH_WRITE_DISABLED/, `Tool ${call.name} must return NOAUTH_WRITE_DISABLED`);
  }
});

test('MCP No-Auth: In-Flight Write Cap & Rate Limiting', async (t) => {
  const serviceToken = 'service-token-123';
  let activeFetches = 0;
  let maxConcurrentFetches = 0;
  const mockFetch = async () => {
    activeFetches += 1;
    maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
    await new Promise((r) => setTimeout(r, 200));
    activeFetches -= 1;
    return new Response(JSON.stringify({project: {projectId: 'p-mock', status: 'generating'}}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };

  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_MAX_INFLIGHT_WRITE_REQUESTS: '2',
      MCP_RATE_LIMIT_PER_MINUTE: '5',
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
    fetchFn: mockFetch,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((res) => server.close(res)));

  // Test in-flight gate: launch 4 concurrent writes when max is 2
  const bundle = makeSampleBundle();
  const writePromises = [1, 2, 3, 4].map((i) => sendRawRpc({
    port,
    body: {
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: {
        name: 'create_video_project',
        arguments: {creator: 'Test', topic: 'Topic', evidenceBundle: bundle, idempotencyKey: `idemp-inflight-${i}`},
      },
    },
  }));

  const writeResults = await Promise.all(writePromises);
  const inFlightRejected = writeResults.filter((r) => r.body?.result?.isError && /NOAUTH_INFLIGHT_CAP_REACHED/.test(r.body?.result?.content?.[0]?.text || ''));
  assert.ok(inFlightRejected.length >= 1, 'At least 1 write must be rejected by in-flight gate');
  assert.ok(maxConcurrentFetches <= 2, 'Never more than 2 in-flight writes reach backend');

  // Test rate limiting: exceed 5 requests in a minute
  let rateLimitHit = false;
  for (let i = 0; i < 10; i++) {
    const res = await sendRawHttp({
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 100 + i, method: 'tools/list'}),
    });
    if (res.status === 429) {
      rateLimitHit = true;
      break;
    }
  }
  assert.equal(rateLimitHit, true, 'Rate limiter must return 429 when rate limit exceeded');
});

test('MCP No-Auth: Host and Origin Protection', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((res) => server.close(res)));

  // Disallowed Host via raw HTTP
  const badHostRes = await sendRawHttp({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      host: 'evil.attacker.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });
  assert.equal(badHostRes.status, 403);
  assert.equal(badHostRes.json?.error?.code, 'HOST_NOT_ALLOWED');

  // Disallowed Origin via raw HTTP
  const badOriginRes = await sendRawHttp({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      origin: 'http://malicious-site.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal(badOriginRes.json?.error?.code, 'ORIGIN_NOT_ALLOWED');
});

test('Backend Private Service Authentication Boundary', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'backend-auth-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'real-private-token-12345';

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

  t.after(() => {
    appServer.close();
    db.close();
  });

  // Direct unauthenticated call to integrations API -> 401 UNAUTHORIZED
  const unauthRes = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({creator: 'Test', topic: 'Topic', evidenceBundle: makeSampleBundle(), idempotencyKey: 'k-1'}),
  });
  assert.equal(unauthRes.status, 401);
  const unauthJson = await unauthRes.json();
  assert.equal(unauthJson.error?.code, 'UNAUTHORIZED');

  // Direct call with wrong token -> 401 UNAUTHORIZED
  const badTokenRes = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer wrong-service-token'},
    body: JSON.stringify({creator: 'Test', topic: 'Topic', evidenceBundle: makeSampleBundle(), idempotencyKey: 'k-1'}),
  });
  assert.equal(badTokenRes.status, 401);
  await badTokenRes.text();

  // Call with valid service token -> 201 Created
  const validRes = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    body: JSON.stringify({creator: 'Test', topic: 'Topic', evidenceBundle: makeSampleBundle(), idempotencyKey: 'k-1'}),
  });
  assert.equal(validRes.status, 201);
  const validJson = await validRes.json();
  assert.ok(validJson.project?.projectId);
});

test('Durable Transactional Capacity Cap on Create and Retry/Reactivation', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'capacity-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';
  const maxActiveProjects = 2;

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    db.close();
  });

  const importProject = async (idemp) => {
    const res = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
      body: JSON.stringify({creator: 'Creator', topic: 'Topic', evidenceBundle: makeSampleBundle(idemp), idempotencyKey: idemp}),
    });
    return {status: res.status, json: await res.json()};
  };

  // 1. Create project 1 (active count = 1) -> 201
  const p1 = await importProject('idemp-cap-1');
  assert.equal(p1.status, 201);
  assert.ok(p1.json.project.projectId);

  // 2. Create project 2 (active count = 2) -> 201
  const p2 = await importProject('idemp-cap-2');
  assert.equal(p2.status, 201);
  assert.ok(p2.json.project.projectId);

  // 3. Create project 3 (active count would be 3 > max 2) -> 429 NOAUTH_CAPACITY_REACHED
  const p3 = await importProject('idemp-cap-3');
  assert.equal(p3.status, 429);
  assert.equal(p3.json.error?.code, 'NOAUTH_CAPACITY_REACHED');

  // Verify DB state: exactly 2 projects exist
  const count = repos.projects.countActiveChatGptProjects();
  assert.equal(count, 2);

  // 4. Idempotent replay of p1 -> returns 200 with existing project, does not fail capacity
  const replayP1 = await importProject('idemp-cap-1');
  assert.equal(replayP1.status, 200);
  assert.equal(replayP1.json.project.projectId, p1.json.project.projectId);

  // 5. Fail project 1 to make it terminal/inactive
  const claim = jobs.claimNext({workerId: 'worker-1', allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
  assert.ok(claim);
  jobs.fail({
    stageId: claim.stageId,
    claimToken: claim.claimToken,
    nowMs: Date.now(),
    errorCode: 'GENERATION_FAILED',
    errorMessage: 'Test error',
    retryable: true,
  });

  // Now active count = 1 (p2 is active, p1 is failed)
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);

  // 6. Now creating project 3 succeeds because a slot was freed
  const p3Retry = await importProject('idemp-cap-3');
  assert.equal(p3Retry.status, 201);
  assert.equal(repos.projects.countActiveChatGptProjects(), 2);

  // 7. Retrying project 1 while active count = 2 (capacity full) fails with NOAUTH_CAPACITY_REACHED
  const retryRes = await fetch(`${appUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(p1.json.project.projectId)}/retry`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
  });
  assert.equal(retryRes.status, 429);
  const retryJson = await retryRes.json();
  assert.equal(retryJson.error?.code, 'NOAUTH_CAPACITY_REACHED');
});

test('Concurrent Admission Race: Never Exceeds Configured Active Cap', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'race-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';
  const maxActiveProjects = 3;

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    db.close();
  });

  // Launch 10 concurrent creates against cap=3
  const results = await Promise.all(
    Array.from({length: 10}, (_, i) =>
      fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
        body: JSON.stringify({
          creator: `Creator ${i}`,
          topic: 'Topic',
          evidenceBundle: makeSampleBundle(`Subject ${i}`),
          idempotencyKey: `concurrent-race-${i}`,
        }),
      }).then(async (res) => ({status: res.status, json: await res.json()})),
    ),
  );

  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 429 && r.json?.error?.code === 'NOAUTH_CAPACITY_REACHED');

  assert.equal(created.length, 3, 'Exactly 3 projects must be created');
  assert.equal(rejected.length, 7, 'Exactly 7 projects must be rejected with NOAUTH_CAPACITY_REACHED');
  assert.equal(repos.projects.countActiveChatGptProjects(), 3, 'Committed active count in SQLite must equal exactly 3');
});

test('Concurrent Mixed Admission Race (Create vs Retry vs Retry) at Cap Boundary', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'mixed-race-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';
  const maxActiveProjects = 2;

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    db.close();
  });

  const importProject = async (idemp) => {
    const res = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
      body: JSON.stringify({creator: 'Creator', topic: 'Topic', evidenceBundle: makeSampleBundle(idemp), idempotencyKey: idemp}),
    });
    return {status: res.status, json: await res.json()};
  };

  // Step 1: Create 2 projects (occupying cap=2)
  const p1 = await importProject('mixed-p1');
  const p2 = await importProject('mixed-p2');
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 201);
  assert.equal(repos.projects.countActiveChatGptProjects(), 2);

  // Step 2: Fail both projects so both become failed/retryable (active count = 0)
  for (let i = 0; i < 2; i++) {
    const claim = jobs.claimNext({workerId: `w-${i}`, allowedTypes: ['generation'], nowMs: Date.now(), leaseMs: 30000});
    assert.ok(claim);
    jobs.fail({
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      nowMs: Date.now(),
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'Test fail',
      retryable: true,
    });
  }
  assert.equal(repos.projects.countActiveChatGptProjects(), 0);

  // Step 3: Fill slot 1 with a new active project (p3) -> active count = 1
  const p3 = await importProject('mixed-p3');
  assert.equal(p3.status, 201);
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);

  // Step 4: Now exactly 1 slot remains under cap=2.
  // Concurrently launch:
  // - 1 new create (p4)
  // - Retry of p1
  // - Retry of p2
  // All 3 compete simultaneously for the 1 remaining slot!
  const [createResult, retryResult1, retryResult2] = await Promise.all([
    importProject('mixed-p4'),
    fetch(`${appUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(p1.json.project.projectId)}/retry`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    }).then(async (res) => ({status: res.status, json: await res.json()})),
    fetch(`${appUrl}/api/integrations/chatgpt/projects/${encodeURIComponent(p2.json.project.projectId)}/retry`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    }).then(async (res) => ({status: res.status, json: await res.json()})),
  ]);

  const outcomes = [createResult, retryResult1, retryResult2];
  const succeeded = outcomes.filter((r) => r.status === 200 || r.status === 201);
  const rejected = outcomes.filter((r) => r.status === 429 && r.json?.error?.code === 'NOAUTH_CAPACITY_REACHED');

  assert.equal(succeeded.length, 1, 'Exactly 1 concurrent admission must win the remaining slot');
  assert.equal(rejected.length, 2, 'Exactly 2 concurrent admissions must be rejected with 429 NOAUTH_CAPACITY_REACHED');
  assert.equal(repos.projects.countActiveChatGptProjects(), 2, 'Active count in SQLite must not exceed configured cap=2');
});

test('Authoritative Bright Profile Configuration: Deployed Env Cap Overrides Defaults', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'env-cap-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';

  // Load config with custom BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS=1
  const config = (await import('../../app/config.mjs')).loadConfig({
    BRIGHT_DATA_DIR: dir,
    BRIGHT_DATABASE_PATH: dbPath,
    BRIGHT_INTEGRATION_TOKEN: serviceToken,
    BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS: '1',
  });
  assert.equal(config.integration.chatgptMaxActiveProjects, 1);

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects: config.integration.chatgptMaxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    db.close();
  });

  // Project 1 succeeds -> 201
  const res1 = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    body: JSON.stringify({creator: 'Creator 1', topic: 'Topic', evidenceBundle: makeSampleBundle('1'), idempotencyKey: 'cap-env-1'}),
  });
  assert.equal(res1.status, 201);

  // Project 2 immediately rejected by authoritative backend cap -> 429
  const res2 = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    body: JSON.stringify({creator: 'Creator 2', topic: 'Topic', evidenceBundle: makeSampleBundle('2'), idempotencyKey: 'cap-env-2'}),
  });
  assert.equal(res2.status, 429);
  const json2 = await res2.json();
  assert.equal(json2.error?.code, 'NOAUTH_CAPACITY_REACHED');
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);
});

test('Authoritative Bright Profile Configuration: MCP_MAX_ACTIVE_PROJECTS in Compose environment configures backend capacity', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'mcp-env-cap-test.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';

  // In Compose, an operator sets MCP_MAX_ACTIVE_PROJECTS=1 which is forwarded into the backend
  const config = (await import('../../app/config.mjs')).loadConfig({
    BRIGHT_DATA_DIR: dir,
    BRIGHT_DATABASE_PATH: dbPath,
    BRIGHT_INTEGRATION_TOKEN: serviceToken,
    MCP_MAX_ACTIVE_PROJECTS: '1',
  });
  assert.equal(config.integration.chatgptMaxActiveProjects, 1);

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects: config.integration.chatgptMaxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;

  t.after(() => {
    appServer.close();
    db.close();
  });

  const res1 = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    body: JSON.stringify({creator: 'Creator 1', topic: 'Topic', evidenceBundle: makeSampleBundle('1'), idempotencyKey: 'mcp-cap-1'}),
  });
  assert.equal(res1.status, 201);

  const res2 = await fetch(`${appUrl}/api/integrations/chatgpt/projects/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${serviceToken}`},
    body: JSON.stringify({creator: 'Creator 2', topic: 'Topic', evidenceBundle: makeSampleBundle('2'), idempotencyKey: 'mcp-cap-2'}),
  });
  assert.equal(res2.status, 429);
  const json2 = await res2.json();
  assert.equal(json2.error?.code, 'NOAUTH_CAPACITY_REACHED');
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);
});

test('Deployment-Shaped MCP_PUBLIC_URL=/mcp: Emitted downloadUrl is served by MCP Download Proxy', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'download-mcp-prefix.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token';

  // Seed a completed project with an output artifact
  const projectId = 'proj-download-prefix-1';
  const timestamp = new Date().toISOString();
  repos.projects.createWithSources({
    id: projectId,
    creator: 'Creator',
    topic: 'Topic',
    instructions: '',
    status: 'approved',
    origin: 'chatgpt_mcp',
    idempotencyKey: 'k-prefix-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  }, []);

  repos.revisions.create({
    id: 'rev-prefix-1',
    projectId,
    revisionNo: 1,
    payload: {creatorName: 'Creator', summary: 'Summary'},
    payloadHash: 'a'.repeat(64),
  });

  db.prepare(`
    UPDATE projects
    SET approved_revision_id = 'rev-prefix-1', current_revision_id = 'rev-prefix-1', status = 'completed'
    WHERE id = ?
  `).run(projectId);

  const artifactPayload = Buffer.from('fake-mp4-video-content-stream-bytes');
  const videoRelPath = `artifacts/${projectId}/rev-prefix-1/authoritative.mp4`;
  const videoAbsPath = join(dir, videoRelPath);
  const {mkdirSync, writeFileSync} = await import('node:fs');
  const {dirname} = await import('node:path');
  mkdirSync(dirname(videoAbsPath), {recursive: true});
  writeFileSync(videoAbsPath, artifactPayload);

  const sha256 = (await import('node:crypto')).createHash('sha256').update(artifactPayload).digest('hex');
  db.prepare(`
    INSERT INTO artifacts (
      id, project_id, revision_id, stage_id, attempt_id, kind, relative_path,
      mime_type, byte_size, sha256, is_authoritative, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    'art-prefix-1',
    projectId,
    'rev-prefix-1',
    'output_mp4',
    videoRelPath,
    'video/mp4',
    artifactPayload.length,
    sha256,
    timestamp,
  );

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

  // Start MCP server on port with MCP_PUBLIC_URL configured to include /mcp prefix (as in compose.mcp.yml)
  const mcpServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      BRIGHT_BACKEND_URL: `http://127.0.0.1:${appPort}`,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      // Will set MCP_PUBLIC_URL after listening
    },
  });
  mcpServer.listen(0, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpPort = mcpServer.address().port;

  // Reconfigure MCP server instance with exact deployment shape MCP_PUBLIC_URL=http://127.0.0.1:<port>/mcp
  mcpServer.close();
  const deploymentMcpServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      BRIGHT_BACKEND_URL: `http://127.0.0.1:${appPort}`,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
  });
  deploymentMcpServer.listen(mcpPort, '127.0.0.1');
  await once(deploymentMcpServer, 'listening');

  t.after(() => {
    deploymentMcpServer.close();
    appServer.close();
    db.close();
  });

  // Call get_video_project over MCP RPC
  const listRes = await sendRawRpc({
    port: mcpPort,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_video_project',
        arguments: {projectId},
      },
    },
  });

  assert.equal(listRes.status, 200);
  const project = listRes.body?.result?.structuredContent;
  assert.ok(project?.output?.downloadUrl, 'Must include output downloadUrl');
  assert.ok(
    project.output.downloadUrl.startsWith(`http://127.0.0.1:${mcpPort}/mcp/artifacts/`),
    `downloadUrl must start with deployment prefix: ${project.output.downloadUrl}`,
  );

  // Now fetch the EXACT emitted downloadUrl directly from the MCP server with browser navigation headers
  const downloadRes = await fetch(project.output.downloadUrl, {
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,video/*,*/*;q=0.8',
    },
  });
  assert.equal(downloadRes.status, 200, 'MCP server must serve the /mcp/artifacts/.../download URL to browser document navigations');
  assert.equal(downloadRes.headers.get('content-type'), 'video/mp4');
  const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
  assert.deepEqual(downloadedBytes, artifactPayload, 'Downloaded payload must match authoritative MP4 bytes');

  // Verify that document navigation to /mcp itself remains strictly rejected
  const mcpDocRes = await sendRawHttp({
    port: mcpPort,
    path: '/mcp',
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'sec-fetch-dest': 'document',
      'content-type': 'application/json',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
  });
  assert.equal(mcpDocRes.status, 403);
  assert.equal(mcpDocRes.json?.error?.code, 'HOST_NOT_ALLOWED');
});

test('Deployment-Shaped Topology & Capacity: Documented single cap setting rejects second project when cap is 1', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'mcp-deployment-cap.sqlite');
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const artifactStore = createArtifactStore(db);
  const serviceToken = 'service-secret-token-12345';

  // Load config with documented single BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS=1
  const config = (await import('../../app/config.mjs')).loadConfig({
    BRIGHT_DATA_DIR: dir,
    BRIGHT_DATABASE_PATH: dbPath,
    BRIGHT_INTEGRATION_TOKEN: serviceToken,
    BRIGHT_CHATGPT_MAX_ACTIVE_PROJECTS: '1',
  });
  assert.equal(config.integration.chatgptMaxActiveProjects, 1);

  const appServer = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir: dir,
    integrationToken: serviceToken,
    maxActiveProjects: config.integration.chatgptMaxActiveProjects,
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appPort = appServer.address().port;

  const mcpServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      BRIGHT_BACKEND_URL: `http://127.0.0.1:${appPort}`,
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
    },
  });
  mcpServer.listen(0, '127.0.0.1');
  await once(mcpServer, 'listening');
  const mcpPort = mcpServer.address().port;

  t.after(() => {
    mcpServer.close();
    appServer.close();
    db.close();
  });

  // 1. Tool discovery returns root-level securitySchemes: [{type: 'noauth'}]
  const listRes = await sendRawRpc({
    port: mcpPort,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    },
  });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body?.result?.tools?.length, 8);
  for (const tool of listRes.body.result.tools) {
    assert.deepEqual(tool.securitySchemes, [{type: 'noauth'}]);
    assert.equal(tool.annotations?.securitySchemes, undefined);
  }

  // 2. First create_video_project over MCP succeeds
  const create1Res = await sendRawRpc({
    port: mcpPort,
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_video_project',
        arguments: {
          creator: 'Creator 1',
          topic: 'Topic 1',
          evidenceBundle: makeSampleBundle('Creator 1'),
          idempotencyKey: 'deploy-cap-1',
        },
      },
    },
  });
  assert.equal(create1Res.status, 200);
  assert.equal(create1Res.body?.result?.isError, undefined);
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);

  // 3. Second create_video_project over MCP is rejected with NOAUTH_CAPACITY_REACHED
  const create2Res = await sendRawRpc({
    port: mcpPort,
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_video_project',
        arguments: {
          creator: 'Creator 2',
          topic: 'Topic 2',
          evidenceBundle: makeSampleBundle('Creator 2'),
          idempotencyKey: 'deploy-cap-2',
        },
      },
    },
  });
  assert.equal(create2Res.status, 200);
  assert.equal(create2Res.body?.result?.isError, true);
  assert.ok(
    create2Res.body?.result?.content?.[0]?.text?.includes('Anonymous active project capacity reached')
    || create2Res.body?.result?.content?.[0]?.text?.includes('429'),
  );
  assert.equal(repos.projects.countActiveChatGptProjects(), 1);
});
