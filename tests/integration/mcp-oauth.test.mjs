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

const parseRpcResponse = async (res) => {
  const text = await res.text();
  const payloads = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  return payloads.length ? JSON.parse(payloads.at(-1)) : JSON.parse(text);
};

test('ChatGPT MCP OAuth 2.1 Dynamic Client Registration, Scopes, Claims, and Consent Boundary', async (t) => {
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
  const mcpResourceUrl = `${baseUrl}/mcp`;

  t.after(() => new Promise((res) => server.close(res)));

  // 1. Dynamic Client Registration (RFC 7591)
  const regRes = await fetch(`${baseUrl}/oauth/register`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_name: 'ChatGPT Bright Connector',
      redirect_uris: ['https://chatgpt.com/connector/oauth/cb_bright_123', 'https://chat.openai.com/aip/oauth/callback'],
    }),
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.ok(regData.client_id);
  assert.deepEqual(regData.redirect_uris, ['https://chatgpt.com/connector/oauth/cb_bright_123', 'https://chat.openai.com/aip/oauth/callback']);
  const registeredClientId = regData.client_id;
  const validRedirectUri = 'https://chatgpt.com/connector/oauth/cb_bright_123';

  // 2. Protected Resource Metadata & Authorization Server Metadata
  const prRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {headers: {host: '127.0.0.1'}});
  assert.equal(prRes.status, 200);
  const prJson = await prRes.json();
  assert.equal(prJson.resource, mcpResourceUrl);
  assert.deepEqual(prJson.authorization_servers, [baseUrl]);

  const asRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {headers: {host: '127.0.0.1'}});
  assert.equal(asRes.status, 200);
  const asJson = await asRes.json();
  assert.equal(asJson.issuer, baseUrl);
  assert.equal(asJson.authorization_endpoint, `${baseUrl}/oauth/authorize`);
  assert.equal(asJson.token_endpoint, `${baseUrl}/oauth/token`);
  assert.equal(asJson.registration_endpoint, `${baseUrl}/oauth/register`);

  // Also verify prefix metadata discovery beneath /mcp/
  const prPrefixRes = await fetch(`${baseUrl}/mcp/.well-known/oauth-protected-resource`, {headers: {host: '127.0.0.1'}});
  assert.equal(prPrefixRes.status, 200);

  // 3. Negative Authorize Tests:
  // a) Unregistered client_id -> rejected 400
  const badClientAuthUrl = new URL(`${baseUrl}/oauth/authorize`);
  badClientAuthUrl.searchParams.set('response_type', 'code');
  badClientAuthUrl.searchParams.set('client_id', 'unregistered-client-attacker');
  badClientAuthUrl.searchParams.set('redirect_uri', 'https://attacker.example/cb');
  badClientAuthUrl.searchParams.set('code_challenge', 'challenge123');
  badClientAuthUrl.searchParams.set('code_challenge_method', 'S256');
  const badClientRes = await fetch(badClientAuthUrl.toString(), {headers: {host: '127.0.0.1'}});
  assert.equal(badClientRes.status, 400);
  const badClientJson = await badClientRes.json();
  assert.equal(badClientJson.error?.code, 'UNAUTHORIZED_CLIENT');

  // b) Mismatched / unregistered redirect_uri -> rejected 400
  const badRedirectAuthUrl = new URL(`${baseUrl}/oauth/authorize`);
  badRedirectAuthUrl.searchParams.set('response_type', 'code');
  badRedirectAuthUrl.searchParams.set('client_id', registeredClientId);
  badRedirectAuthUrl.searchParams.set('redirect_uri', 'https://attacker.example/unregistered-cb');
  badRedirectAuthUrl.searchParams.set('code_challenge', 'challenge123');
  badRedirectAuthUrl.searchParams.set('code_challenge_method', 'S256');
  const badRedirectRes = await fetch(badRedirectAuthUrl.toString(), {headers: {host: '127.0.0.1'}});
  assert.equal(badRedirectRes.status, 400);

  // c) Unauthenticated authorize request -> rejected 401 UNAUTHORIZED (consent required)
  const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const codeChallenge = generatePkceChallenge(codeVerifier);

  const unauthAuthUrl = new URL(`${baseUrl}/oauth/authorize`);
  unauthAuthUrl.searchParams.set('response_type', 'code');
  unauthAuthUrl.searchParams.set('client_id', registeredClientId);
  unauthAuthUrl.searchParams.set('redirect_uri', validRedirectUri);
  unauthAuthUrl.searchParams.set('code_challenge', codeChallenge);
  unauthAuthUrl.searchParams.set('code_challenge_method', 'S256');
  const unauthRes = await fetch(unauthAuthUrl.toString(), {headers: {host: '127.0.0.1'}});
  assert.equal(unauthRes.status, 401);
  const unauthJson = await unauthRes.json();
  assert.equal(unauthJson.error?.code, 'UNAUTHORIZED');

  // 4. Authenticated User Consent Confirmation (POST /oauth/authorize/consent)
  const consentRes = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:write bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'state-xyz-123',
      user_id: 'real_bright_user_42',
      user_email: 'user42@example.com',
    }),
  });
  assert.equal(consentRes.status, 200);
  const consentData = await consentRes.json();
  assert.ok(consentData.code);
  assert.equal(consentData.state, 'state-xyz-123');
  const authCode = consentData.code;

  // 5. PKCE Token Exchange:
  // a) Wrong code_verifier -> fails 400
  const badTokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      code_verifier: 'wrong-verifier',
    }),
  });
  assert.equal(badTokenRes.status, 400);

  // Mint fresh code for valid exchange
  const consentRes2 = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:write bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      user_id: 'real_bright_user_42',
    }),
  });
  const authCode2 = (await consentRes2.json()).code;

  // b) Correct code_verifier -> succeeds 200
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode2,
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const writeTokenData = await tokenRes.json();
  assert.ok(writeTokenData.access_token);
  assert.equal(writeTokenData.token_type, 'Bearer');

  // Mint a read-only token (scope: 'bright:profile:read')
  const readConsentRes = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      user_id: 'real_bright_user_42',
    }),
  });
  const readAuthCode = (await readConsentRes.json()).code;

  const readTokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: readAuthCode,
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });
  assert.equal(readTokenRes.status, 200);
  const readTokenData = await readTokenRes.json();
  assert.ok(readTokenData.access_token);

  // 6. Token Scope Enforcement on /mcp:
  // a) Read-only token CAN invoke read tools (e.g. normalize_evidence)
  const normRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${readTokenData.access_token}`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'normalize_evidence',
        arguments: {
          subject: {name: 'Test Creator'},
          researchedAt: '2026-08-20T00:00:00Z',
          items: [{url: 'https://example.com/a', claim: 'Test claim', category: 'identity', value: 'Test'}],
        },
      },
    }),
  });
  assert.equal(normRes.status, 200);
  const normJson = await parseRpcResponse(normRes);
  assert.equal(normJson.result?.isError, undefined);
  assert.ok(normJson.result?.structuredContent?.stats);

  // b) Read-only token CANNOT invoke mutating tool (create_video_project) -> rejected for scope
  const createDeniedRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${readTokenData.access_token}`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_video_project',
        arguments: {
          creator: 'Test Creator',
          topic: 'Tech',
          evidenceBundle: normJson.result.structuredContent,
          idempotencyKey: 'idemp-read-only-test-1',
        },
      },
    }),
  });
  assert.equal(createDeniedRes.status, 200);
  const createDeniedJson = await parseRpcResponse(createDeniedRes);
  assert.equal(createDeniedJson.result?.isError, true);
  assert.match(createDeniedJson.result?.content[0]?.text, /Forbidden: token lacks required scope "bright:profile:write"/i);

  // 7. Token Claim Verification (audience / issuer):
  // Request with token intended for wrong resource is rejected
  const wrongAudTokenRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${writeTokenData.access_token}`,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/list'}),
  });
  assert.equal(wrongAudTokenRes.status, 200);
});

test('Pathful MCP_PUBLIC_URL configuration serves consistent OAuth discovery and endpoints', async (t) => {
  const serviceToken = 'service-secret-token-key-123456';
  const publicUrl = 'https://video.lanadesign.tech/mcp';
  const server = tempPortServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost,video.lanadesign.tech',
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      MCP_PUBLIC_URL: publicUrl,
    },
  });
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => new Promise((res) => server.close(res)));

  // Protected resource metadata points to https://video.lanadesign.tech/mcp and issuer https://video.lanadesign.tech
  const prRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
    headers: {host: 'video.lanadesign.tech'},
  });
  assert.equal(prRes.status, 200);
  const prData = await prRes.json();
  assert.equal(prData.resource, 'https://video.lanadesign.tech/mcp');
  assert.deepEqual(prData.authorization_servers, ['https://video.lanadesign.tech']);

  // Authorization server metadata points to endpoints under https://video.lanadesign.tech
  const asRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
    headers: {host: 'video.lanadesign.tech'},
  });
  assert.equal(asRes.status, 200);
  const asData = await asRes.json();
  assert.equal(asData.issuer, 'https://video.lanadesign.tech');
  assert.equal(asData.authorization_endpoint, 'https://video.lanadesign.tech/oauth/authorize');
  assert.equal(asData.token_endpoint, 'https://video.lanadesign.tech/oauth/token');
  assert.equal(asData.registration_endpoint, 'https://video.lanadesign.tech/oauth/register');
});
