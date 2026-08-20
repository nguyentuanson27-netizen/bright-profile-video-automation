import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const startServer = async (env = {}) => {
  const loggedEvents = [];
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      ...env,
    },
    log: (evt) => loggedEvents.push(evt),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    loggedEvents,
  };
};

const sendRequest = ({port, path = '/mcp', method = 'POST', headers = {}, body = ''}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method,
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        // not json
      }
      resolve({status: res.statusCode, headers: res.headers, body: data, json});
    });
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('when MCP_AUTH_TOKEN is configured, unauthenticated requests to /mcp receive 401 UNAUTHORIZED', async (t) => {
  const {server, port} = await startServer({
    MCP_AUTH_TOKEN: 'chatgpt-secure-secret-token',
  });
  t.after(() => server.close());

  const res = await sendRequest({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });

  assert.equal(res.status, 401);
  assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
});

test('when MCP_AUTH_TOKEN is configured, invalid Bearer token receives 401 UNAUTHORIZED', async (t) => {
  const {server, port} = await startServer({
    MCP_AUTH_TOKEN: 'chatgpt-secure-secret-token',
  });
  t.after(() => server.close());

  const res = await sendRequest({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer wrong-token',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });

  assert.equal(res.status, 401);
  assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
});

test('when MCP_AUTH_TOKEN is configured, valid Bearer token is accepted', async (t) => {
  const {server, port} = await startServer({
    MCP_AUTH_TOKEN: 'chatgpt-secure-secret-token',
  });
  t.after(() => server.close());

  const res = await sendRequest({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer chatgpt-secure-secret-token',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });

  assert.equal(res.status, 200);
});

test('/health remains unauthenticated and rate-limit exempt even with MCP_AUTH_TOKEN', async (t) => {
  const {server, port} = await startServer({
    MCP_AUTH_TOKEN: 'chatgpt-secure-secret-token',
  });
  t.after(() => server.close());

  const res = await sendRequest({
    port,
    path: '/health',
    method: 'GET',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {ok: true});
});

test('request logs redact Authorization headers and never leak tokens', async (t) => {
  const {server, port, loggedEvents} = await startServer({
    MCP_AUTH_TOKEN: 'chatgpt-secure-secret-token',
  });
  t.after(() => server.close());

  await sendRequest({
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer chatgpt-secure-secret-token',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });

  const serialized = JSON.stringify(loggedEvents);
  assert.equal(serialized.includes('chatgpt-secure-secret-token'), false);
});