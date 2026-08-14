import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {assertLocalRenderInputs} from '../../lib/remotion-renderer.mjs';

test('normal renderer rejects arbitrary remote and file media references', () => {
  assert.throws(() => assertLocalRenderInputs({heroImage: 'https://example.test/a.png', scenes: []}), /local application-controlled/i);
  assert.throws(() => assertLocalRenderInputs({audioUrl: 'file:///etc/passwd', scenes: []}), /local application-controlled/i);
  assert.throws(() => assertLocalRenderInputs({scenes: [{mediaUrl: 'http://example.test/video.mp4'}]}), /local application-controlled/i);
  assert.doesNotThrow(() => assertLocalRenderInputs({
    heroImage: 'media/hero.png',
    audioUrl: 'audio/voice.mp3',
    scenes: [{mediaUrl: 'media/scene.mp4'}],
  }));
});

test('default Remotion renderer does not disable browser web security', async () => {
  const source = await readFile(new URL('../../lib/remotion-renderer.mjs', import.meta.url), 'utf8');
  assert.equal(/disableWebSecurity\s*:\s*true/.test(source), false);
});
