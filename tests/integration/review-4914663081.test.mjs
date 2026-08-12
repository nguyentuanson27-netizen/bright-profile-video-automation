import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import net from 'node:net';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async (env = {}) => {
  const server = createBrightHttpServer({
    env: {MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', ...env},
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  return {server, port};
};

const stalledHealthResponse = ({port, guardMs = 800}) => new Promise((resolve, reject) => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  const started = Date.now();
  let response = '';
  let sawOk = false;
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
      'GET /health HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Content-Length: 4096',
      'Connection: keep-alive',
      '',
      '',
    ].join('\r\n'));
    socket.write('partial-health-body');
  });
  socket.on('data', (chunk) => {
    response += chunk;
    if (/HTTP\/1\.1 200\b/.test(response)) sawOk = true;
  });
  socket.on('error', (error) => {
    if (!sawOk) finish(error);
  });
  socket.on('close', () => {
    if (!sawOk) {
      finish(new Error(`connection closed before health response: ${response}`));
      return;
    }
    finish();
  });

  const guard = setTimeout(() => {
    socket.destroy();
    finish(new Error('health response left an incomplete request body connection open'));
  }, guardMs);
});

test('GET /health closes a stalled body-bearing keep-alive connection after the 200 response', async (t) => {
  const {server, port} = await start({MCP_REQUEST_TIMEOUT_MS: '200'});
  t.after(() => server.close());

  const result = await stalledHealthResponse({port});
  assert.match(result.response, /HTTP\/1\.1 200\b/);
  assert.match(result.response, /connection:\s*close/i);
  assert.ok(result.durationMs < 800);
});

test('Spec 001 has an explicit amendment for coherent same-canonical source observation selection', async () => {
  const amendmentUrl = new URL(
    '../../specs/001-chatgpt-mcp-evidence/amendments/002-review-4914663081.md',
    import.meta.url,
  );
  const amendment = await readFile(amendmentUrl, 'utf8');

  assert.match(amendment, /same-canonical/i);
  assert.match(amendment, /supersedes[^\n]*Step 6/i);
  assert.match(amendment, /coherent/i);
  assert.match(amendment, /must not synthesize/i);
  assert.match(amendment, /complete normalized input observation/i);
});
