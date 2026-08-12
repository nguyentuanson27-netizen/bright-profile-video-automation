import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import net from 'node:net';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async ({handler, env = {}} = {}) => {
  const server = createBrightHttpServer({
    ...(handler ? {handler} : {}),
    env: {MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', ...env},
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  return {server, port};
};

const stalledBodyResponse = ({method, port, guardMs = 800}) => new Promise((resolve, reject) => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  const started = Date.now();
  let response = '';
  let sawResponse = false;
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
      `${method} /mcp HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Content-Length: 4096',
      'Connection: keep-alive',
      '',
      '',
    ].join('\r\n'));
    socket.write('partial-mcp-body');
  });
  socket.on('data', (chunk) => {
    response += chunk;
    if (/HTTP\/1\.1 \d{3}\b/.test(response)) sawResponse = true;
  });
  socket.on('error', (error) => {
    if (!sawResponse) finish(error);
  });
  socket.on('close', () => {
    if (!sawResponse) {
      finish(new Error(`connection closed before response: ${response}`));
      return;
    }
    finish();
  });

  const guard = setTimeout(() => {
    socket.destroy();
    finish(new Error(`${method} /mcp left a stalled declared request body connection open`));
  }, guardMs);
});

const immediateHandler = (calls) => ({
  async fetch() {
    calls.count += 1;
    return new globalThis.Response(JSON.stringify({ok: true}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  },
});

for (const method of ['GET', 'HEAD']) {
  test(`${method} /mcp rejects and closes a stalled body-bearing keep-alive request before invoking the handler`, async (t) => {
    const calls = {count: 0};
    const {server, port} = await start({
      handler: immediateHandler(calls),
      env: {MCP_REQUEST_TIMEOUT_MS: '200'},
    });
    t.after(() => server.close());

    const result = await stalledBodyResponse({method, port});
    assert.match(result.response, /HTTP\/1\.1 400\b/);
    assert.match(result.response, /connection:\s*close/i);
    assert.equal(calls.count, 0);
    assert.ok(result.durationMs < 800);
  });
}
