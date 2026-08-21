import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createBrightHttpServer} from '../../mcp/server.mjs';

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

test('MCP server registers edit_video_draft, approve_video_project, start_video_render, retry_video_project, cancel_video_project', async (t) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
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
  assert.ok(toolNames.includes('edit_video_draft'));
  assert.ok(toolNames.includes('approve_video_project'));
  assert.ok(toolNames.includes('start_video_render'));
  assert.ok(toolNames.includes('retry_video_project'));
  assert.ok(toolNames.includes('cancel_video_project'));
});

test('edit_video_draft tool sends draft update to backend and returns revised project', async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url: String(url), options});
    return {
      ok: true,
      status: 200,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({
        project: {
          projectId: 'proj-123',
          status: 'review_required',
          origin: 'chatgpt_mcp',
          currentRevision: {
            id: 'rev-2',
            payloadHash: '2'.repeat(64),
            draft: {creatorName: 'Creator', summary: 'Updated'},
          },
        },
        revision: {id: 'rev-2', payloadHash: '2'.repeat(64)},
      }),
    };
  };

  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
    },
    handler: (await import('../../mcp/server.mjs')).createBrightMcpHandler({
      env: {
        MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
        BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
      },
      fetchFn: fakeFetch,
    }),
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
  const draft = {
    creatorName: 'Creator',
    summary: 'Updated',
    claims: [{id: 'c-1', text: 'claim', sourceIds: ['src-1'], verified: true}],
    script: [{id: 's-1', text: 'script', start: 0, duration: 5, sourceIds: ['src-1']}],
    voiceover: {chunks: [{id: 'v-1', text: 'vo', start: 0, duration: 5, sourceIds: ['src-1']}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: ['src-1']}],
    render: {duration: 5},
  };

  const called = await rpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'edit_video_draft',
      arguments: {
        projectId: 'proj-123',
        revisionId: 'rev-1',
        expectedPayloadHash: '1'.repeat(64),
        draft,
      },
    },
  }, headers);

  assert.equal(called.response.status, 200);
  assert.equal(called.body.result.isError, undefined);
  assert.equal(called.body.result.structuredContent?.currentRevision?.id, 'rev-2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123/draft');
});

test('approve_video_project tool submits user_reviewed or delegated_e2e approval', async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url: String(url), options});
    return {
      ok: true,
      status: 200,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({
        project: {
          projectId: 'proj-123',
          status: 'approved',
          origin: 'chatgpt_mcp',
        },
        revision: {
          id: 'rev-1',
          approvalMode: 'delegated_e2e',
        },
      }),
    };
  };

  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
    },
    handler: (await import('../../mcp/server.mjs')).createBrightMcpHandler({
      env: {
        MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
        BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
      },
      fetchFn: fakeFetch,
    }),
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
  const called = await rpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'approve_video_project',
      arguments: {
        projectId: 'proj-123',
        revisionId: 'rev-1',
        expectedPayloadHash: '1'.repeat(64),
        mode: 'delegated_e2e',
        delegationGrant: 'grant-token-123456',
        delegatedContext: {userExplicitIntent: 'Approve and build video'},
      },
    },
  }, headers);

  assert.equal(called.response.status, 200);
  assert.equal(called.body.result.isError, undefined);
  assert.equal(called.body.result.structuredContent?.status, 'approved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123/approve');
});

test('start_video_render, retry_video_project, cancel_video_project tool calls dispatch correctly', async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url: String(url), method: options?.method});
    return {
      ok: true,
      status: 200,
      headers: new Headers({'content-type': 'application/json'}),
      json: async () => ({
        project: {projectId: 'proj-123', status: 'rendering', origin: 'chatgpt_mcp'},
        stage: {type: 'media_ingest', state: 'queued'},
      }),
    };
  };

  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
      BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
    },
    handler: (await import('../../mcp/server.mjs')).createBrightMcpHandler({
      env: {
        MCP_NOAUTH_WRITE_ENABLED: 'true',
        BRIGHT_BACKEND_URL: 'http://127.0.0.1:4180',
        BRIGHT_INTEGRATION_TOKEN: 'service-token-xyz',
      },
      fetchFn: fakeFetch,
    }),
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

  // 1. start_video_render
  const renderRes = await rpc(url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {name: 'start_video_render', arguments: {projectId: 'proj-123'}},
  }, headers);
  assert.equal(renderRes.response.status, 200);
  assert.equal(renderRes.body.result.isError, undefined);

  // 2. retry_video_project
  const retryRes = await rpc(url, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {name: 'retry_video_project', arguments: {projectId: 'proj-123'}},
  }, headers);
  assert.equal(retryRes.response.status, 200);
  assert.equal(retryRes.body.result.isError, undefined);

  // 3. cancel_video_project
  const cancelRes = await rpc(url, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {name: 'cancel_video_project', arguments: {projectId: 'proj-123'}},
  }, headers);
  assert.equal(cancelRes.response.status, 200);
  assert.equal(cancelRes.body.result.isError, undefined);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123/render');
  assert.equal(calls[1].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123/retry');
  assert.equal(calls[2].url, 'http://127.0.0.1:4180/api/integrations/chatgpt/projects/proj-123/cancel');
});