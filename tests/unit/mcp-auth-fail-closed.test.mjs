import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      port,
      close: () => new Promise((res) => server.close(res)),
    });
  });
});

test('MCP server fails closed with 401 AUTH_NOT_CONFIGURED when MCP_AUTH_TOKEN is absent/empty', async () => {
  const server = createBrightHttpServer({
    env: {
      MCP_AUTH_TOKEN: '',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  const {port, close} = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body?.error?.code, 'AUTH_NOT_CONFIGURED');
  } finally {
    await close();
  }
});

test('MCP server rejects missing Bearer token with 401 UNAUTHORIZED when MCP_AUTH_TOKEN is configured', async () => {
  const server = createBrightHttpServer({
    env: {
      MCP_AUTH_TOKEN: 'secret-token-key-123456',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  const {port, close} = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body?.error?.code, 'UNAUTHORIZED');
  } finally {
    await close();
  }
});

test('MCP server rejects invalid Bearer token with 401 UNAUTHORIZED', async () => {
  const server = createBrightHttpServer({
    env: {
      MCP_AUTH_TOKEN: 'secret-token-key-123456',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  const {port, close} = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-secret-token-999999',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body?.error?.code, 'UNAUTHORIZED');
  } finally {
    await close();
  }
});

test('MCP server accepts valid Bearer token and dispatches to handler', async () => {
  const server = createBrightHttpServer({
    env: {
      MCP_AUTH_TOKEN: 'secret-token-key-123456',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
  });
  const {port, close} = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        authorization: 'Bearer secret-token-key-123456',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('normalize_evidence'));
  } finally {
    await close();
  }
});