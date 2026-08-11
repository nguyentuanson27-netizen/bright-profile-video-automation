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

test('production render path uses Gemini TTS and removes Google Cloud TTS credentials and dependency', () => {
  const render = read('app/services/execute-render.mjs');
  const compose = read('compose.yml');
  const env = read('.env.example');
  const pkg = JSON.parse(read('package.json'));

  assert.match(render, /timed-gemini-tts\.mjs/);
  assert.doesNotMatch(render, /timed-google-tts\.mjs/);
  assert.match(render, /provider:\s*'gemini'/);
  assert.doesNotMatch(render, /provider:\s*'google-tts'/);

  assert.match(compose, /GEMINI_TTS_MODEL:\s*\$\{GEMINI_TTS_MODEL:-gemini-3\.1-flash-tts-preview\}/);
  assert.match(compose, /GEMINI_TTS_VOICE:\s*\$\{GEMINI_TTS_VOICE:-Kore\}/);
  assert.match(compose, /GEMINI_TTS_TIMEOUT_MS:\s*\$\{GEMINI_TTS_TIMEOUT_MS:-30000\}/);
  assert.doesNotMatch(compose, /GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_TTS_|google_tts_credentials/);

  assert.match(env, /^GEMINI_TTS_MODEL=gemini-3\.1-flash-tts-preview$/m);
  assert.match(env, /^GEMINI_TTS_VOICE=Kore$/m);
  assert.match(env, /^GEMINI_TTS_TIMEOUT_MS=30000$/m);
  assert.doesNotMatch(env, /GOOGLE_TTS_|google-tts\.json/);

  assert.equal(pkg.dependencies['@google-cloud/text-to-speech'], undefined);
  assert.equal(read('lib/timed-google-tts.mjs'), '');
});
