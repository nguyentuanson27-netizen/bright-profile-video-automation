import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import net from 'node:net';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async (env = {}) => {
  const server = createBrightHttpServer({
    env: {MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', MCP_AUTH_TOKEN: 'test-mcp-token-123456', ...env},
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  return {server, port};
};

const stalledEarlyResponse = ({port, path = '/mcp', host, expectedStatus, guardMs = 800}) => new Promise((resolve, reject) => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  const started = Date.now();
  let response = '';
  let sawExpectedStatus = false;
  let settled = false;

  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (error) reject(error);
    else resolve({response, durationMs: Date.now() - started});
  };

  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write([
      `POST ${path} HTTP/1.1`,
      `Host: ${host ?? `127.0.0.1:${port}`}`,
      'Authorization: Bearer test-mcp-token-123456',
      'Content-Type: application/json',
      'Content-Length: 4096',
      'Connection: keep-alive',
      '',
      '',
    ].join('\r\n'));
    socket.write('{"partial":"');
  });
  socket.on('data', (chunk) => {
    response += chunk;
    if (new RegExp(`HTTP\\/1\\.1 ${expectedStatus}\\b`).test(response)) sawExpectedStatus = true;
  });
  socket.on('error', (error) => {
    if (!sawExpectedStatus) finish(error);
  });
  socket.on('close', () => {
    if (!sawExpectedStatus) {
      finish(new Error(`connection closed before ${expectedStatus} response: ${response}`));
      return;
    }
    finish();
  });

  const guard = setTimeout(() => {
    socket.destroy();
    finish(new Error(`early ${expectedStatus} response left an incomplete request body connection open`));
  }, guardMs);
});

for (const scenario of [
  {name: 'invalid Host', path: '/mcp', host: 'evil.example', status: 403},
  {name: 'unknown route', path: '/not-mcp', status: 404},
]) {
  test(`early ${scenario.status} for ${scenario.name} closes a stalled incomplete-body connection`, async (t) => {
    const {server, port} = await start({MCP_REQUEST_TIMEOUT_MS: '200'});
    t.after(() => server.close());

    const result = await stalledEarlyResponse({
      port,
      path: scenario.path,
      host: scenario.host,
      expectedStatus: scenario.status,
    });
    assert.match(result.response, new RegExp(`HTTP\\/1\\.1 ${scenario.status}\\b`));
    assert.match(result.response, /connection:\s*close/i);
    assert.ok(result.durationMs < 800);
  });
}
