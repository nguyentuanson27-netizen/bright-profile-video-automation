import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createBrightHttpServer} from '../../mcp/server.mjs';

const PUBLIC_HOST = 'video.lanadesign.tech';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

const start = async (env = {}) => {
  const server = createBrightHttpServer({
    env: {
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      MCP_PUBLIC_URL: `${PUBLIC_ORIGIN}/mcp`,
      MCP_RATE_LIMIT_PER_MINUTE: '1000',
      ...env,
    },
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, port: server.address().port};
};

const request = ({port, path, host = PUBLIC_HOST, origin = PUBLIC_ORIGIN}) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path,
    method: 'GET',
    headers: {
      host,
      ...(origin ? {origin} : {}),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  req.on('error', reject);
  req.end();
});

test('public plugin, privacy, terms, and support pages are available on the configured remote host', async (t) => {
  const {server, port} = await start();
  t.after(() => server.close());

  for (const path of ['/plugin', '/privacy', '/terms', '/support']) {
    const response = await request({port, path});
    assert.equal(response.status, 200, `${path} should be public`);
    assert.match(response.headers['content-type'] || '', /text\/html/i);
    assert.match(response.body, /Lana Design/);
  }

  const privacy = await request({port, path: '/privacy'});
  assert.match(privacy.body, /personal data|data categories/i);
  assert.match(privacy.body, /0 days|zero days/i);
  assert.match(privacy.body, /30 days/i);
  assert.match(privacy.body, /OpenAI|ChatGPT/i);

  const support = await request({port, path: '/support'});
  assert.match(support.body, /support/i);
  assert.match(support.body, /github\.com\/nguyentuanson27-netizen\/bright-profile-video-automation\/issues/i);
});

test('OpenAI domain challenge is disabled when unset and returns exactly the configured token when enabled', async (t) => {
  const disabled = await start();
  t.after(() => disabled.server.close());
  const disabledResponse = await request({port: disabled.port, path: '/.well-known/openai-apps-challenge'});
  assert.equal(disabledResponse.status, 404);

  const token = 'openai-domain-verification-test-token';
  const enabled = await start({OPENAI_APPS_CHALLENGE_TOKEN: token});
  t.after(() => enabled.server.close());
  const enabledResponse = await request({port: enabled.port, path: '/.well-known/openai-apps-challenge'});
  assert.equal(enabledResponse.status, 200);
  assert.match(enabledResponse.headers['content-type'] || '', /text\/plain/i);
  assert.equal(enabledResponse.body, token);
});

test('publication routes do not weaken the existing Host and Origin boundary', async (t) => {
  const {server, port} = await start({OPENAI_APPS_CHALLENGE_TOKEN: 'token'});
  t.after(() => server.close());

  assert.equal((await request({port, path: '/privacy', host: 'evil.example', origin: 'https://evil.example'})).status, 403);
  assert.equal((await request({port, path: '/.well-known/openai-apps-challenge', host: PUBLIC_HOST, origin: 'https://evil.example'})).status, 403);
});

test('plugin package manifest identifies Lana Design and only advertises read capability', async () => {
  const manifestUrl = new URL('../../plugins/bright-evidence/.codex-plugin/plugin.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

  assert.equal(manifest.name, 'bright-evidence');
  assert.equal(manifest.author?.name, 'Lana Design');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.apps, undefined, 'portable public package must not hard-code a registered plugin_asdk_app id');
  assert.equal(manifest.interface?.displayName, 'Bright Evidence');
  assert.equal(manifest.interface?.developerName, 'Lana Design');
  assert.deepEqual(manifest.interface?.capabilities, ['Read']);
  assert.equal(manifest.interface?.websiteURL, `${PUBLIC_ORIGIN}/plugin`);
  assert.equal(manifest.interface?.privacyPolicyURL, `${PUBLIC_ORIGIN}/privacy`);
  assert.equal(manifest.interface?.termsOfServiceURL, `${PUBLIC_ORIGIN}/terms`);
  assert.ok(Array.isArray(manifest.interface?.defaultPrompt));
  assert.ok(manifest.interface.defaultPrompt.length >= 2);
});

test('public-evidence skill keeps research public, source content inert, and normalization delegated to MCP', async () => {
  const skillUrl = new URL('../../plugins/bright-evidence/skills/public-evidence/SKILL.md', import.meta.url);
  const skill = await readFile(skillUrl, 'utf8');

  assert.match(skill, /public sources/i);
  assert.match(skill, /normalize_evidence/);
  assert.match(skill, /untrusted data|untrusted content/i);
  assert.match(skill, /do not deduplicate|don't deduplicate|without pre-deduplic/i);
  assert.match(skill, /do not.*scrap|do not.*bypass|access controls/i);
  assert.match(skill, /credentials|payment|PHI|government identifiers/i);
});

test('submission fixtures contain exactly five positive and three negative reviewer cases', async () => {
  const casesUrl = new URL('../../plugins/bright-evidence/submission/test-cases.json', import.meta.url);
  const cases = JSON.parse(await readFile(casesUrl, 'utf8'));

  assert.equal(cases.positive?.length, 5);
  assert.equal(cases.negative?.length, 3);

  for (const entry of [...cases.positive, ...cases.negative]) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.userPrompt, 'string');
    assert.equal(typeof entry.expectedBehavior, 'string');
    assert.equal(typeof entry.expectedResultShape, 'string');
  }

  for (const entry of cases.negative) {
    assert.equal(typeof entry.whyNot, 'string');
  }
});
