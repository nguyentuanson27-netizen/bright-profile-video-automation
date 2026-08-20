import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBrightHttpServer} from '../../mcp/server.mjs';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

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
      authorization: 'Bearer test-mcp-token-123456',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return {response, body: await readRpcBody(response)};
};

const sampleBundle = normalizeEvidence({
  researchedAt: '2026-08-20T00:00:00.000Z',
  subject: {name: 'Marques Brownlee'},
  items: [
    {
      url: 'https://en.wikipedia.org/wiki/MKBHD',
      claim: 'Marques Brownlee is an American YouTuber.',
      category: 'identity',
      value: 'Marques Brownlee',
    },
  ],
});

test('MCP server registers create_video_project and get_video_project in tools/list', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token',
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'bright-test', version: '1.0.0'},
    },
  });

  const headers = {'mcp-protocol-version': '2025-06-18'};
  const listed = await rpc(url, {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}, headers);
  assert.equal(listed.response.status, 200);

  const toolNames = listed.body.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes('normalize_evidence'));
  assert.ok(toolNames.includes('create_video_project'));
  assert.ok(toolNames.includes('get_video_project'));
});

test('create_video_project tool calls private backend and returns structured project status', async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url: String(url), options});
    return {
      ok: true,
      status: 201,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({
        project: {
          projectId: 'proj-123',
          status: 'generating',
          origin: 'chatgpt_mcp',
          progress: {currentStage: 'generation', stageStatus: 'queued', attemptCount: 0},
          evidenceSummary: {inputItems: 1, retainedEvidence: 1, conflictGroups: 0, rejectedItems: 0},
        },
        stage: {type: 'generation', state: 'queued'},
        isExisting: false,
      }),
    };
  };

  const customServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
    },
    handler: (await import('../../mcp/server.mjs')).createBrightMcpHandler({
      env: {
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
        BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
      },
      fetchFn: fakeFetch,
    }),
  });

  customServer.listen(0, '127.0.0.1');
  await once(customServer, 'listening');
  t.after(() => customServer.close());

  const url = `http://127.0.0.1:${customServer.address().port}/mcp`;

  await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'bright-test', version: '1.0.0'},
    },
  });

  const headers = {'mcp-protocol-version': '2025-06-18'};
  const called = await rpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'create_video_project',
      arguments: {
        creator: 'Marques Brownlee',
        topic: 'Milestones',
        instructions: 'Profile video',
        evidenceBundle: sampleBundle,
        idempotencyKey: 'key-123',
      },
    },
  }, headers);

  assert.equal(called.response.status, 200);
  assert.equal(called.body.result.isError, undefined);
  assert.equal(called.body.result.structuredContent?.projectId, 'proj-123');
  assert.equal(called.body.result.structuredContent?.status, 'generating');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/import');
  assert.equal(calls[0].options.headers['authorization'], 'Bearer service-token-xyz');
});

test('get_video_project tool calls private backend and returns structured project status', async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url: String(url), options});
    return {
      ok: true,
      status: 200,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({
        projectId: 'proj-123',
        status: 'review_required',
        origin: 'chatgpt_mcp',
        currentRevision: {
          id: 'rev-1',
          payloadHash: 'f'.repeat(64),
        },
      }),
    };
  };

  const customServer = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
    },
    handler: (await import('../../mcp/server.mjs')).createBrightMcpHandler({
      env: {
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
        BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
      },
      fetchFn: fakeFetch,
    }),
  });

  customServer.listen(0, '127.0.0.1');
  await once(customServer, 'listening');
  t.after(() => customServer.close());

  const url = `http://127.0.0.1:${customServer.address().port}/mcp`;

  await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'bright-test', version: '1.0.0'},
    },
  });

  const headers = {'mcp-protocol-version': '2025-06-18'};
  const called = await rpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_video_project',
      arguments: {
        projectId: 'proj-123',
      },
    },
  }, headers);

  assert.equal(called.response.status, 200);
  assert.equal(called.body.result.isError, undefined);
  assert.equal(called.body.result.structuredContent?.projectId, 'proj-123');
  assert.equal(called.body.result.structuredContent?.status, 'review_required');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123');
  assert.equal(calls[0].options.headers['authorization'], 'Bearer service-token-xyz');
});