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

const oversizedStalledConnection = ({port, guardMs = 1_000}) => new Promise((resolve, reject) => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  const started = Date.now();
  let response = '';
  let saw413 = false;
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
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Authorization: Bearer test-mcp-token-123456',
      'Content-Type: application/json',
      'Content-Length: 4096',
      'Connection: keep-alive',
      '',
      '',
    ].join('\r\n'));
    socket.write('x'.repeat(128));
  });
  socket.on('data', (chunk) => {
    response += chunk;
    if (/HTTP\/1\.1 413\b/.test(response)) saw413 = true;
  });
  socket.on('error', (error) => {
    if (!saw413) finish(error);
  });
  socket.on('close', () => {
    if (!saw413) {
      finish(new Error(`connection closed before 413 response: ${response}`));
      return;
    }
    finish();
  });

  const guard = setTimeout(() => {
    socket.destroy();
    finish(new Error('oversized stalled upload connection remained open after the body-size rejection'));
  }, guardMs);
});

test('oversized stalled upload receives 413 and the server closes the connection promptly', async (t) => {
  const {server, port} = await start({
    MCP_MAX_BODY_BYTES: '64',
    MCP_REQUEST_TIMEOUT_MS: '200',
  });
  t.after(() => server.close());

  const result = await oversizedStalledConnection({port, guardMs: 800});
  assert.match(result.response, /HTTP\/1\.1 413\b/);
  assert.match(result.response, /connection:\s*close/i);
  assert.ok(result.durationMs < 800);
});
