import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const compose = await readFile(new URL('../../compose.yml', import.meta.url), 'utf8');

const workerBlock = () => {
  const workerStart = compose.indexOf('\n  worker:');
  assert.notEqual(workerStart, -1);
  const afterWorker = compose.slice(workerStart + 1);
  const nextService = afterWorker.slice(1).search(/\n  [a-zA-Z0-9_-]+:\s*$/m);
  return nextService === -1 ? afterWorker : afterWorker.slice(0, nextService + 1);
};

test('main compose owns standalone app and worker with shared local state and no n8n dependency', () => {
  assert.match(compose, /^\s{2}app:\s*$/m);
  assert.match(compose, /^\s{2}worker:\s*$/m);
  assert.match(compose, /127\.0\.0\.1:/);
  assert.match(compose, /BRIGHT_DATA_DIR:\s*\/app\/data/);
  assert.match(compose, /BRIGHT_DATABASE_PATH:\s*\/app\/data\/bright-profile\.sqlite/);
  assert.match(compose, /command:\s*\[?['"]?node['"]?,?\s*['"]?worker\.mjs/);
  assert.match(compose, /bright-data:/);
  assert.doesNotMatch(compose, /n8n/i);
  assert.doesNotMatch(compose, /\/root\/video_api|\/srv\/bright-profile/);
});

test('worker service has no published port and disables the app-only HTTP healthcheck', () => {
  const block = workerBlock();
  assert.doesNotMatch(block, /^\s{4}ports:/m);
  assert.match(block, /^\s{4}healthcheck:\s*\n\s{6}disable:\s*true\s*$/m);
});

test('worker credential file is mounted read-only at the configured ADC path', () => {
  const block = workerBlock();
  assert.match(block, /GOOGLE_APPLICATION_CREDENTIALS:\s*\/run\/secrets\/google-application-credentials\.json/);
  assert.match(block, /GOOGLE_APPLICATION_CREDENTIALS_FILE[^\n]*:\/run\/secrets\/google-application-credentials\.json:ro/);
});
