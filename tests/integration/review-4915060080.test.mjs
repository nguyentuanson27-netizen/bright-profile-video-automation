import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const start = async ({env = {}, handler} = {}) => {
  const server = createBrightHttpServer({
    ...(handler ? {handler} : {}),
    env: {MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', ...env},
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  return {server, url: `http://127.0.0.1:${port}/mcp`};
};

test('credential-bearing public-source URLs are batch-rejected without leaking userinfo into the bundle', () => {
  const secret = 'review-4915060080-secret';
  const bundle = normalizeEvidence({
    subject: {name: 'Emiru'},
    researchedAt: '2026-08-12T09:30:00Z',
    items: [
      {
        claim: 'Emiru has a public creator profile.',
        url: 'https://example.com/emiru',
        category: 'profile',
      },
      {
        claim: 'Emiru has another cited creator profile.',
        url: `https://alice:${secret}@example.org/emiru`,
        category: 'profile',
      },
    ],
  });

  assert.equal(bundle.stats.inputItems, 2);
  assert.equal(bundle.stats.rejectedItems, 1);
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.rejectedItems[0].index, 1);
  assert.match(bundle.rejectedItems[0].reasons.join(' '), /url.*credential|userinfo/i);
  assert.doesNotMatch(JSON.stringify(bundle), new RegExp(secret));
});

test('overflow MCP_REQUEST_TIMEOUT_MS falls back instead of becoming an immediate Node timer', async (t) => {
  const handler = {
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ok: true}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    },
  };
  const {server, url} = await start({
    handler,
    env: {MCP_REQUEST_TIMEOUT_MS: '3000000000'},
  });
  t.after(() => server.close());

  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: '{}',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {ok: true});
});
