import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('plugin domain challenge token is documented and passed into the MCP container without a secret default', async () => {
  const compose = await readFile(new URL('../../compose.mcp.yml', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');

  assert.match(compose, /OPENAI_APPS_CHALLENGE_TOKEN:\s*\$\{OPENAI_APPS_CHALLENGE_TOKEN:-\}/);
  assert.match(envExample, /OPENAI_APPS_CHALLENGE_TOKEN=\s*(?:\n|$)/);
  assert.doesNotMatch(envExample, /OPENAI_APPS_CHALLENGE_TOKEN=\S+/);
});
