import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateTimedGeminiTts} from '../../lib/timed-gemini-tts.mjs';

const oneSecondPcm = Buffer.alloc(24_000 * 2, 1);

test('timed Gemini TTS converts 24kHz mono PCM and fits each chunk into its approved slot', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-timed-gemini-tts-'));
  const output = path.join(directory, 'voice.mp3');
  const synthCalls = [];
  const commandCalls = [];
  const chunkEvents = [];
  const ttsProvider = {
    async synthesize(input) {
      synthCalls.push(input);
      return {
        pcm: oneSecondPcm,
        sampleRate: 24_000,
        channels: 1,
        sampleWidth: 2,
        voice: 'Kore',
        model: 'gemini-3.1-flash-tts-preview',
      };
    },
  };
  const runCommand = async (command, args) => {
    commandCalls.push({command, args});
    const destination = args.at(-1);
    if (typeof destination === 'string' && path.isAbsolute(destination)) {
      writeFileSync(destination, Buffer.from(`generated:${path.basename(destination)}`));
    }
  };

  try {
    const result = await generateTimedGeminiTts({
      manifest: {
        duration: 2,
        chunks: [{id: 'intro', start: 0, duration: 1.5, text: 'Xin chào.'}],
      },
      output,
      workDir: directory,
      ttsProvider,
      runCommand,
      probeDuration: async () => 2,
      env: {TTS_MAX_SPEED: '1.35', TTS_END_GAP_SECONDS: '0.18'},
      onChunk: (event) => chunkEvents.push(event),
    });

    assert.deepEqual(synthCalls, [{text: 'Xin chào.'}]);
    const fit = commandCalls.find(({args}) => args.includes('-f') && args.includes('s16le'));
    assert.ok(fit);
    assert.deepEqual(fit.args.slice(0, 8), ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i']);
    assert.match(fit.args[fit.args.indexOf('-af') + 1], /^atempo=1\.000000,apad,atrim=0:1\.500000$/);
    assert.equal(commandCalls.some(({args}) => args.includes('anullsrc=r=48000:cl=stereo')), true);
    assert.equal(commandCalls.at(-1).args.at(-1), output);
    assert.deepEqual(chunkEvents, [{id: 'intro', slot: 1.5, rawDuration: 1, speed: 1, voice: 'Kore'}]);
    assert.equal(result.output, output);
    assert.equal(result.duration, 2);
    assert.equal(result.voice, 'Kore');
    assert.equal(result.model, 'gemini-3.1-flash-tts-preview');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
