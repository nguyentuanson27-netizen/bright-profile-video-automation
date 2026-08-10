import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const serviceBlock = (compose, name) => {
  const match = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|^networks:|^volumes:|^secrets:|\\Z)`, 'm'));
  return match ? match[0] : '';
};

test('compose defines authenticated standalone topology with only Caddy publishing ports', () => {
  const compose = read('compose.yml');
  assert.doesNotMatch(compose, /n8n/i);

  const caddy = serviceBlock(compose, 'caddy');
  const oauth = serviceBlock(compose, 'oauth2-proxy');
  const app = serviceBlock(compose, 'app');
  const worker = serviceBlock(compose, 'worker');
  for (const [name, block] of Object.entries({caddy, oauth, app, worker})) {
    assert.notEqual(block, '', `${name} service is required`);
  }

  assert.match(caddy, /ports:/);
  assert.match(caddy, /"80:80"/);
  assert.match(caddy, /"443:443"/);
  assert.doesNotMatch(oauth, /\n    ports:/);
  assert.doesNotMatch(app, /\n    ports:/);
  assert.doesNotMatch(worker, /\n    ports:/);

  assert.match(app, /image: \$\{BRIGHT_IMAGE:\?/);
  assert.match(worker, /image: \$\{BRIGHT_IMAGE:\?/);
  assert.match(app, /bright_data:\/app\/data/);
  assert.match(worker, /bright_data:\/app\/data/);
  assert.match(worker, /worker\.mjs/);

  assert.match(oauth, /provider=github|OAUTH2_PROXY_PROVIDER:\s*github/);
  assert.match(oauth, /GITHUB_ALLOWED_USERS/);
  assert.match(oauth, /trusted-proxy-ip|TRUSTED_PROXY_IP/);
  assert.match(oauth, /client-secret-file|CLIENT_SECRET_FILE/);
  assert.match(oauth, /cookie-secret-file|COOKIE_SECRET_FILE/);

  assert.doesNotMatch(app, /OPENAI_API_KEY(?:_FILE)?:/);
  assert.doesNotMatch(app, /\n    secrets:\n[\s\S]*- openai_api_key/);
  assert.match(worker, /OPENAI_API_KEY_FILE:\s*\/run\/secrets\/openai_api_key/);
  assert.match(worker, /\n    secrets:\n[\s\S]*- openai_api_key/);
  assert.doesNotMatch(worker, /OPENAI_API_KEY:\s/);

  assert.match(compose, /^volumes:\n[\s\S]*bright_data:/m);
  assert.match(compose, /^secrets:\n[\s\S]*openai_api_key:/m);
});

test('app composition does not load OpenAI providers or require provider credentials', () => {
  const server = read('server.mjs');
  assert.doesNotMatch(server, /providers\/(?:research|generation)\/openai\.mjs/);
  assert.doesNotMatch(server, /createOpenAi(?:Research|Generation)Provider/);
});

test('Caddy is the only public edge and proxies exclusively to oauth2-proxy', () => {
  const caddyfile = read('Caddyfile');
  assert.match(caddyfile, /\{\$APP_DOMAIN\}/);
  assert.match(caddyfile, /reverse_proxy\s+oauth2-proxy:4182/);
  assert.doesNotMatch(caddyfile, /app:4180/);
  assert.match(caddyfile, /Strict-Transport-Security/);
  assert.match(caddyfile, /X-Content-Type-Options/);
});

test('Docker image uses lockfile-frozen installs, builds the web app, and runs non-root', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24\.18\.0-bookworm-slim AS /m);
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  assert.match(dockerfile, /npm ci --strict-allow-scripts=true/);
  assert.match(dockerfile, /npm ci --omit=dev --strict-allow-scripts=true/);
  assert.doesNotMatch(dockerfile, /npm install/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /COPY --from=web-build .*\/app\/dist .*\.\/dist/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /REMOTION_BROWSER_EXECUTABLE=\/usr\/bin\/chromium/);
});

test('deployment examples contain placeholders and immutable image-tag inputs, not old API token/n8n settings', () => {
  const env = read('.env.example');
  assert.doesNotMatch(env, /BRIGHT_API_TOKEN/);
  assert.doesNotMatch(env, /n8n/i);
  assert.match(env, /BRIGHT_IMAGE=ghcr\.io\/.*:sha-/);
  assert.match(env, /APP_DOMAIN=/);
  assert.match(env, /GITHUB_ALLOWED_USERS=/);
  assert.match(env, /GITHUB_OAUTH_CLIENT_ID=/);
  assert.match(env, /GITHUB_OAUTH_CLIENT_SECRET_FILE=/);
  assert.match(env, /OAUTH2_PROXY_COOKIE_SECRET_FILE=/);
  assert.match(env, /GOOGLE_TTS_CREDENTIALS_FILE=/);
  assert.match(env, /OPENAI_API_KEY_FILE=/);
  assert.doesNotMatch(env, /^OPENAI_API_KEY=/m);
});

test('file-backed Compose secrets keep the host directory private while remaining readable by non-root containers', () => {
  const deployment = read('docs/operations/deployment.md');
  const workflow = read('.github/workflows/t18-static-web.yml');

  assert.match(deployment, /secret directory[^\n]*`0700`/i);
  assert.match(deployment, /secret files[^\n]*`0444`/i);
  assert.match(deployment, /non-root/i);
  assert.doesNotMatch(deployment, /mode `0600`/i);

  assert.match(workflow, /chmod 700 \.ci-secrets/);
  assert.match(workflow, /chmod 444 \.ci-secrets\/\*/);
  assert.doesNotMatch(workflow, /chmod 600 \.ci-secrets\/\*/);
});

test('runtime publication checks inspect actual host bindings instead of treating exposed ports as published', () => {
  const workflow = read('.github/workflows/t18-static-web.yml');

  assert.match(workflow, /HostConfig\.PortBindings/);
  assert.doesNotMatch(workflow, /docker compose port app 4180/);
  assert.doesNotMatch(workflow, /docker compose port worker 4181/);
  assert.doesNotMatch(workflow, /docker compose port oauth2-proxy 4182/);
});
