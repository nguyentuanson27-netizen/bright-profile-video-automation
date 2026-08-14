import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async (env = {}) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      ...env,
    },
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, port: server.address().port};
};

const requestStatus = ({port, host, origin}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/health',
    method: 'GET',
    headers: {
      host,
      ...(origin ? {origin} : {}),
    },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});

test('MCP_PUBLIC_URL allows the configured remote HTTPS host without weakening the host boundary', async (t) => {
  const {server, port} = await start({
    MCP_PUBLIC_URL: 'https://video.lanadesign.tech/mcp',
  });
  t.after(() => server.close());

  assert.equal(await requestStatus({
    port,
    host: 'video.lanadesign.tech',
    origin: 'https://video.lanadesign.tech',
  }), 200);

  assert.equal(await requestStatus({
    port,
    host: 'evil.example',
    origin: 'https://evil.example',
  }), 403);
});

test('MCP_PUBLIC_URL rejects non-HTTPS remote MCP configuration', () => {
  assert.throws(
    () => createBrightHttpServer({
      env: {
        MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
        MCP_PUBLIC_URL: 'http://video.lanadesign.tech/mcp',
      },
      log: () => {},
    }),
    /MCP_PUBLIC_URL.*HTTPS/i,
  );
});

test('compose remote profile keeps host publishing on loopback and passes MCP_PUBLIC_URL', async () => {
  const compose = await readFile(new URL('../../compose.mcp.yml', import.meta.url), 'utf8');

  assert.match(compose, /MCP_PUBLIC_URL:\s*\$\{MCP_PUBLIC_URL:-https:\/\/video\.lanadesign\.tech\/mcp\}/);
  assert.match(compose, /"127\.0\.0\.1:4190:4190"/);
});
