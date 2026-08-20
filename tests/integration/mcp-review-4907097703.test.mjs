import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async (maxBodyBytes) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_AUTH_TOKEN: 'test-mcp-token-123456',
      MCP_MAX_BODY_BYTES: maxBodyBytes,
    },
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  return {server, url: `http://127.0.0.1:${port}/mcp`};
};

const postStatus = (url, body) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname,
    method: 'POST',
    headers: {
      host: parsed.host,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: 'Bearer test-mcp-token-123456',
    },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end(body);
});

test('invalid MCP_MAX_BODY_BYTES falls back to the 2 MB safety limit', async (t) => {
  const oversizedBody = JSON.stringify({padding: 'x'.repeat((2 * 1024 * 1024) + 1024)});

  for (const configured of ['not-a-number', 'Infinity', '0', '-1']) {
    await t.test(configured, async (st) => {
      const {server, url} = await start(configured);
      st.after(() => server.close());
      assert.equal(await postStatus(url, oversizedBody), 413);
    });
  }
});
