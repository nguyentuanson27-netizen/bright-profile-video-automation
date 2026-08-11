import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createGeminiTtsProvider, loadGeminiTtsConfig} from '../../providers/tts/gemini.mjs';

const pcm = Buffer.alloc(48_000, 1);

const completedResponse = () => ({
  status: 'completed',
  output_audio: {data: pcm.toString('base64')},
});

const fakeClient = (response = completedResponse()) => {
  const calls = [];
  return {
    calls,
    client: {
      interactions: {
        async create(request, options) {
          calls.push({request, options});
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
  };
};

test('Gemini TTS uses Interactions audio response with configured voice and returns PCM metadata', async () => {
  const fake = fakeClient();
  const provider = createGeminiTtsProvider({
    client: fake.client,
    config: {
      apiKey: 'test-key',
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Kore',
      timeoutMs: 12_345,
    },
  });

  const result = await provider.synthesize({text: 'Xin chào từ Bright Profile.'});

  assert.deepEqual(fake.calls, [{
    request: {
      model: 'gemini-3.1-flash-tts-preview',
      input: 'Xin chào từ Bright Profile.',
      response_format: {type: 'audio'},
      generation_config: {speech_config: [{voice: 'Kore'}]},
      store: false,
    },
    options: {timeout_ms: 12_345},
  }]);
  assert.deepEqual(result.pcm, pcm);
  assert.equal(result.sampleRate, 24_000);
  assert.equal(result.channels, 1);
  assert.equal(result.sampleWidth, 2);
  assert.equal(result.voice, 'Kore');
  assert.equal(result.model, 'gemini-3.1-flash-tts-preview');
});

test('Gemini TTS allows a per-chunk voice override without changing provider config', async () => {
  const fake = fakeClient();
  const provider = createGeminiTtsProvider({
    client: fake.client,
    config: {apiKey: 'test-key', model: 'tts-model', voice: 'Kore', timeoutMs: 30_000},
  });

  const result = await provider.synthesize({text: 'Một câu ngắn.', voice: 'Puck'});

  assert.equal(fake.calls[0].request.generation_config.speech_config[0].voice, 'Puck');
  assert.equal(result.voice, 'Puck');
});

test('Gemini TTS rejects incomplete and missing-audio responses without persisting partial output', async () => {
  for (const response of [
    {status: 'incomplete', output_audio: {data: pcm.toString('base64')}},
    {status: 'requires_action', output_audio: {data: pcm.toString('base64')}},
  ]) {
    const fake = fakeClient(response);
    const provider = createGeminiTtsProvider({
      client: fake.client,
      config: {apiKey: 'test-key', model: 'tts-model', voice: 'Kore', timeoutMs: 30_000},
    });
    await assert.rejects(
      () => provider.synthesize({text: 'Không dùng audio chưa hoàn tất.'}),
      (error) => error instanceof AppError && error.code === 'PROVIDER_INCOMPLETE' && error.retryable === true,
    );
  }

  const missing = fakeClient({status: 'completed'});
  const provider = createGeminiTtsProvider({
    client: missing.client,
    config: {apiKey: 'test-key', model: 'tts-model', voice: 'Kore', timeoutMs: 30_000},
  });
  await assert.rejects(
    () => provider.synthesize({text: 'Audio phải tồn tại.'}),
    (error) => error instanceof AppError && error.code === 'TTS_OUTPUT_INVALID',
  );
});

test('Gemini TTS maps temporary provider failures to retryable application errors', async () => {
  const temporary = Object.assign(new Error('internal provider detail'), {status: 500});
  const fake = fakeClient(temporary);
  const provider = createGeminiTtsProvider({
    client: fake.client,
    config: {apiKey: 'test-key', model: 'tts-model', voice: 'Kore', timeoutMs: 30_000},
  });

  await assert.rejects(
    () => provider.synthesize({text: 'Retry me.'}),
    (error) => error instanceof AppError
      && error.code === 'PROVIDER_TEMPORARY_FAILURE'
      && error.retryable === true
      && !error.message.includes('internal provider detail'),
  );
});

test('Gemini TTS config loads API key from file and validates model voice and timeout', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-gemini-tts-'));
  const keyFile = path.join(directory, 'gemini-key');
  writeFileSync(keyFile, 'file-key\n');
  try {
    const config = loadGeminiTtsConfig({
      GEMINI_API_KEY: 'env-key',
      GEMINI_API_KEY_FILE: keyFile,
      GEMINI_TTS_MODEL: 'gemini-3.1-flash-tts-preview',
      GEMINI_TTS_VOICE: 'Kore',
      GEMINI_TTS_TIMEOUT_MS: '45000',
    });
    assert.deepEqual(config, {
      apiKey: 'file-key',
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Kore',
      timeoutMs: 45_000,
    });

    assert.throws(
      () => loadGeminiTtsConfig({GEMINI_API_KEY: 'key', GEMINI_TTS_TIMEOUT_MS: '999'}),
      (error) => error instanceof AppError && error.code === 'GEMINI_TTS_CONFIG_INVALID',
    );
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
