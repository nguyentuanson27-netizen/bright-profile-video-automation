import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {createBrightHttpServer} from '../../mcp/server.mjs';
import {generatePkceChallenge} from '../../security/oauth.mjs';

function tempPortServer(options = {}) {
  const server = createBrightHttpServer(options);
  server.listen(0, '127.0.0.1');
  return server;
}

test('ChatGPT MCP OAuth 2.1 Authorization Server and Protected Resource Flow', async (t) => {
  const serviceToken = 'service-secret-token-key-123456';
  const server = tempPortServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      MCP_RATE_LIMIT_PER_MINUTE: 100,
    },
  });
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => new Promise((res) => server.close(res)));

  // 1. Protected Resource Metadata
  const prRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
    headers: {host: '127.0.0.1'},
  });
  assert.equal(prRes.status, 200);
  const prJson = await prRes.json();
  assert.equal(prJson.resource, baseUrl);
  assert.deepEqual(prJson.scopes_supported, ['bright:profile:write', 'bright:profile:read']);

  // 2. Authorization Server Metadata
  const asRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
    headers: {host: '127.0.0.1'},
  });
  assert.equal(asRes.status, 200);
  const asJson = await asRes.json();
  assert.equal(asJson.authorization_endpoint, `${baseUrl}/oauth/authorize`);
  assert.equal(asJson.token_endpoint, `${baseUrl}/oauth/token`);

  // 3. Unauthenticated request to /mcp returns 401 with WWW-Authenticate header
  const unauthMcpRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  });
  assert.equal(unauthMcpRes.status, 401);
  const wwwAuth = unauthMcpRes.headers.get('www-authenticate');
  assert.ok(wwwAuth, 'Must include WWW-Authenticate header');
  assert.ok(wwwAuth.includes('Bearer realm="bright-mcp"'));

  // 4. PKCE Authorization Code flow
  const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const codeChallenge = generatePkceChallenge(codeVerifier);

  const authUrl = new URL(`${baseUrl}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'chatgpt-client');
  authUrl.searchParams.set('redirect_uri', 'https://chatgpt.com/aip/oauth/callback');
  authUrl.searchParams.set('scope', 'bright:profile:write bright:profile:read');
  authUrl.searchParams.set('state', 'xyz123');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const authRes = await fetch(authUrl.toString(), {
    headers: {host: '127.0.0.1'},
    redirect: 'manual',
  });
  assert.equal(authRes.status, 302);
  const redirectLocation = authRes.headers.get('location');
  assert.ok(redirectLocation);
  const redirectUrl = new URL(redirectLocation);
  assert.equal(redirectUrl.searchParams.get('state'), 'xyz123');
  const authCode = redirectUrl.searchParams.get('code');
  assert.ok(authCode);

  // 5. Exchange code for token with WRONG code_verifier -> fails
  const badTokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: 'chatgpt-client',
      redirect_uri: 'https://chatgpt.com/aip/oauth/callback',
      code_verifier: 'wrong-verifier-code-12345',
    }),
  });
  assert.equal(badTokenRes.status, 400);

  // 6. Get a new code and exchange with CORRECT code_verifier -> succeeds
  const authRes2 = await fetch(authUrl.toString(), {
    headers: {host: '127.0.0.1'},
    redirect: 'manual',
  });
  const authCode2 = new URL(authRes2.headers.get('location')).searchParams.get('code');

  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode2,
      client_id: 'chatgpt-client',
      redirect_uri: 'https://chatgpt.com/aip/oauth/callback',
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const tokenData = await tokenRes.json();
  assert.ok(tokenData.access_token);
  assert.equal(tokenData.token_type, 'Bearer');
  assert.ok(tokenData.expires_in > 0);

  // 7. Request to /mcp with OAuth access_token -> succeeds
  const mcpRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${tokenData.access_token}`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
  });
  assert.equal(mcpRes.status, 200);
  const mcpText = await mcpRes.text();
  const mcpPayloads = mcpText.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  const mcpJson = mcpPayloads.length ? JSON.parse(mcpPayloads.at(-1)) : JSON.parse(mcpText);
  assert.ok(mcpJson.result?.tools);

  // 8. Request to /mcp with tampered access_token -> 401
  const tamperedMcpRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${tokenData.access_token}tampered`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/list'}),
  });
  assert.equal(tamperedMcpRes.status, 401);
  assert.ok(tamperedMcpRes.headers.get('www-authenticate'));
});
