import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

test('ChatGPT MCP OAuth 2.1 Security: Credentials Authentication, Exploit Regressions, Restart DCR Persistence, and Scopes', async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), 'oauth-dcr-test-'));
  const clientStoragePath = join(testDir, 'oauth_clients.json');
  const serviceToken = 'service-secret-token-key-123456';
  const oauthSecret = 'super-secret-oauth-key-123456';
  const userAuthSecret = 'super-user-password-secret-123456';

  let server = tempPortServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      BRIGHT_USER_AUTH_SECRET: userAuthSecret,
      MCP_OAUTH_SECRET: oauthSecret,
      MCP_CLIENT_STORAGE_PATH: clientStoragePath,
      MCP_RATE_LIMIT_PER_MINUTE: 100,
    },
  });
  await once(server, 'listening');
  let port = server.address().port;
  let baseUrl = `http://127.0.0.1:${port}`;
  let mcpResourceUrl = `${baseUrl}/mcp`;

  t.after(async () => {
    if (server) await new Promise((res) => server.close(res));
  });

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

  // 2. Restart Regression: Recreate MCP server process and prove DCR registration is durably retained
  await new Promise((res) => server.close(res));
  server = tempPortServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      BRIGHT_INTEGRATION_TOKEN: serviceToken,
      BRIGHT_USER_AUTH_SECRET: userAuthSecret,
      MCP_OAUTH_SECRET: oauthSecret,
      MCP_CLIENT_STORAGE_PATH: clientStoragePath,
      MCP_RATE_LIMIT_PER_MINUTE: 100,
    },
  });
  await once(server, 'listening');
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  mcpResourceUrl = `${baseUrl}/mcp`;

  // 3. Metadata Discovery
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

  // 4. Exploit Regressions:
  const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const codeChallenge = generatePkceChallenge(codeVerifier);

  // a) Attacker unauthenticated login attempt (no password or wrong password) -> FAILS CLOSED 401
  const unauthLoginRes1 = await fetch(`${baseUrl}/oauth/session/login`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({user_id: 'attacker_user'}),
  });
  assert.equal(unauthLoginRes1.status, 401, 'Anonymous login without credentials must return 401');
  const unauthLoginJson1 = await unauthLoginRes1.json();
  assert.equal(unauthLoginJson1.error?.code, 'UNAUTHORIZED');

  const unauthLoginRes2 = await fetch(`${baseUrl}/oauth/session/login`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({user_id: 'attacker_user', password: 'wrong-attacker-password'}),
  });
  assert.equal(unauthLoginRes2.status, 401, 'Login with invalid credentials must return 401');

  // b) Attacker direct POST to /oauth/authorize/consent without valid session -> FAILS CLOSED 401
  const exploitConsentRes = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:write',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      user_id: 'attacker_chosen_user_id',
    }),
  });
  assert.equal(exploitConsentRes.status, 401, 'Direct consent without verified user session must fail 401');

  // c) Unauthenticated GET /oauth/authorize -> FAILS 401
  const unauthAuthUrl = new URL(`${baseUrl}/oauth/authorize`);
  unauthAuthUrl.searchParams.set('response_type', 'code');
  unauthAuthUrl.searchParams.set('client_id', registeredClientId);
  unauthAuthUrl.searchParams.set('redirect_uri', validRedirectUri);
  unauthAuthUrl.searchParams.set('code_challenge', codeChallenge);
  unauthAuthUrl.searchParams.set('code_challenge_method', 'S256');
  const unauthRes = await fetch(unauthAuthUrl.toString(), {headers: {host: '127.0.0.1'}});
  assert.equal(unauthRes.status, 401);

  // 5. Positive User Authentication & Consent Flow:
  // a) User authenticates with valid credentials
  const loginRes = await fetch(`${baseUrl}/oauth/session/login`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/json'},
    body: JSON.stringify({
      user_id: 'real_bright_user_42',
      email: 'user42@example.com',
      password: userAuthSecret,
    }),
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.session_token);
  const userSessionToken = loginData.session_token;

  // b) Authenticated user grants consent with valid session token
  const validConsentRes = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      'x-session-token': userSessionToken,
    },
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:write bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'oauth-state-abc',
    }),
  });
  assert.equal(validConsentRes.status, 200);
  const consentData = await validConsentRes.json();
  assert.ok(consentData.code);
  const authCode = consentData.code;

  // 6. PKCE Token Exchange:
  // a) Wrong code_verifier -> fails 400
  const badTokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {host: '127.0.0.1', 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      code_verifier: 'wrong-verifier',
    }).toString(),
  });
  assert.equal(badTokenRes.status, 400);

  // Mint fresh code for valid exchange
  const consent2Res = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      'x-session-token': userSessionToken,
    },
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:write bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }),
  });
  const authCode2 = (await consent2Res.json()).code;

  // b) Correct verifier -> succeeds
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
  const tokenData = await tokenRes.json();
  assert.ok(tokenData.access_token);
  assert.equal(tokenData.token_type, 'Bearer');

  // Mint read-only token
  const readConsentRes = await fetch(`${baseUrl}/oauth/authorize/consent`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      'x-session-token': userSessionToken,
    },
    body: JSON.stringify({
      client_id: registeredClientId,
      redirect_uri: validRedirectUri,
      scope: 'bright:profile:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
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
  const readTokenData = await readTokenRes.json();

  // 7. Scope Enforcement on /mcp:
  // a) Read-only token can call normalize_evidence
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
          subject: {name: 'Test Subject'},
          researchedAt: '2026-08-21T00:00:00Z',
          items: [{url: 'https://example.com/item', claim: 'Sample claim', category: 'identity', value: 'Value'}],
        },
      },
    }),
  });
  assert.equal(normRes.status, 200);
  const normJson = await parseRpcResponse(normRes);
  assert.equal(normJson.result?.isError, undefined);

  // b) Read-only token CANNOT call create_video_project -> rejected for scope
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
          idempotencyKey: 'idemp-read-test-01',
        },
      },
    }),
  });
  assert.equal(createDeniedRes.status, 200);
  const createDeniedJson = await parseRpcResponse(createDeniedRes);
  assert.equal(createDeniedJson.result?.isError, true);
  assert.match(createDeniedJson.result?.content[0]?.text, /Forbidden: token lacks required scope "bright:profile:write"/i);
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

  const prRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
    headers: {host: 'video.lanadesign.tech'},
  });
  assert.equal(prRes.status, 200);
  const prData = await prRes.json();
  assert.equal(prData.resource, 'https://video.lanadesign.tech/mcp');
  assert.deepEqual(prData.authorization_servers, ['https://video.lanadesign.tech']);

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
