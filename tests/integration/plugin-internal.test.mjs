import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const PUBLIC_HOST = 'video.lanadesign.tech';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

const start = async () => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_PUBLIC_URL: `${PUBLIC_ORIGIN}/mcp`,
      MCP_RATE_LIMIT_PER_MINUTE: '1000',
    },
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, port: server.address().port};
};

const request = ({port, path}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'GET',
    headers: {host: PUBLIC_HOST, origin: PUBLIC_ORIGIN},
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error', reject);
  req.end();
});

test('internal plugin does not add public listing, legal, support, or submission challenge routes', async (t) => {
  const {server, port} = await start();
  t.after(() => server.close());

  for (const path of ['/plugin', '/privacy', '/terms', '/support', '/.well-known/openai-apps-challenge']) {
    const response = await request({port, path});
    assert.equal(response.status, 404, `${path} should remain outside the internal MCP surface`);
  }
});

test('plugin manifest is portable internal metadata with a local MCP app mapping pointer', async () => {
  const manifestUrl = new URL('../../plugins/bright-evidence/.codex-plugin/plugin.json', import.meta.url);
  const manifestText = await readFile(manifestUrl, 'utf8');
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, 'bright-evidence');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.apps, './.app.json');
  assert.doesNotMatch(manifestText, /plugin_asdk_app/);
  assert.equal(manifest.interface?.displayName, 'Bright Evidence');
  assert.equal(manifest.interface?.developerName, 'Lana Design');
  assert.deepEqual(manifest.interface?.capabilities, ['Read']);
  assert.equal(manifest.homepage, undefined);
  assert.equal(manifest.interface?.websiteURL, undefined);
  assert.equal(manifest.interface?.privacyPolicyURL, undefined);
  assert.equal(manifest.interface?.termsOfServiceURL, undefined);
});

test('repo marketplace exposes Bright Evidence only as an internal install source', async () => {
  const marketplaceUrl = new URL('../../.agents/plugins/marketplace.json', import.meta.url);
  const marketplace = JSON.parse(await readFile(marketplaceUrl, 'utf8'));

  assert.equal(marketplace.name, 'bright-profile-internal');
  assert.equal(marketplace.interface?.displayName, 'Bright Profile Internal');
  assert.equal(marketplace.plugins?.length, 1);

  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'bright-evidence');
  assert.equal(entry.source?.source, 'local');
  assert.equal(entry.source?.path, './plugins/bright-evidence');
  assert.equal(entry.policy?.installation, 'AVAILABLE');
  assert.equal(entry.policy?.authentication, 'ON_INSTALL');
  assert.equal(entry.category, 'Productivity');
});

test('public-submission-only challenge configuration is absent', async () => {
  const compose = await readFile(new URL('../../compose.mcp.yml', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');

  assert.doesNotMatch(compose, /OPENAI_APPS_CHALLENGE_TOKEN/);
  assert.doesNotMatch(envExample, /OPENAI_APPS_CHALLENGE_TOKEN/);
});

test('account-specific MCP app mapping is ignored by git', async () => {
  const gitignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^plugins\/bright-evidence\/\.app\.json$/m);
});

test('internal guide accepts direct ChatGPT MCP use without requiring desktop or Codex packaging', async () => {
  const guide = await readFile(new URL('../../docs/bright-evidence-plugin-internal.md', import.meta.url), 'utf8');

  assert.match(guide, /sufficient live acceptance of the ChatGPT ↔ Bright Evidence MCP integration/);
  assert.match(guide, /No further desktop-marketplace or Codex acceptance work is required/);
  assert.match(guide, /account\/workspace-specific `\.app\.json` mapping remains git-ignored/);
  assert.doesNotMatch(guide, /must be installed through the ChatGPT desktop repo marketplace/);
});
