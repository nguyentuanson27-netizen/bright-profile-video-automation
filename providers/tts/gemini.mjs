import {AppError} from '../../domain/errors.mjs';
import {loadSecretValue} from '../../security/secret-file.mjs';

const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Kore';
const INCOMPLETE_STATUSES = new Set(['queued', 'in_progress', 'incomplete', 'requires_action']);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'budget_exceeded']);

const configError = (message) => new AppError('GEMINI_TTS_CONFIG_INVALID', message, {status: 500});

const positiveInteger = (env, key, fallback, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw configError(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configError(`${key} is out of range`);
  return value;
};

export function loadGeminiTtsConfig(env = process.env) {
  const apiKey = loadSecretValue({
    env,
    valueKey: 'GEMINI_API_KEY',
    fileKey: 'GEMINI_API_KEY_FILE',
    errorFactory: configError,
  });
  if (!apiKey) throw configError('GEMINI_API_KEY is required');
  const model = String(env.GEMINI_TTS_MODEL || DEFAULT_MODEL).trim();
  if (!model) throw configError('GEMINI_TTS_MODEL is required');
  const voice = String(env.GEMINI_TTS_VOICE || DEFAULT_VOICE).trim();
  if (!voice) throw configError('GEMINI_TTS_VOICE is required');
  return Object.freeze({
    apiKey,
    model,
    voice,
    timeoutMs: positiveInteger(env, 'GEMINI_TTS_TIMEOUT_MS', 30_000, {min: 1_000, max: 300_000}),
  });
}

const classifyGeminiError = (error) => {
  const status = Number(error?.status);
  if (error?.name === 'RequestTimeoutError') {
    return new AppError('PROVIDER_TIMEOUT', 'Gemini TTS request timed out', {status: 504, retryable: true});
  }
  if (status === 429) {
    return new AppError('PROVIDER_RATE_LIMITED', 'Gemini TTS rate limit reached', {status: 429, retryable: true});
  }
  if (status >= 500 || error?.name === 'ConnectionError') {
    return new AppError('PROVIDER_TEMPORARY_FAILURE', 'Gemini TTS is temporarily unavailable', {status: 502, retryable: true});
  }
  return new AppError('PROVIDER_FAILURE', 'Gemini TTS request failed', {status: 502, retryable: false});
};

const createClient = async (apiKey) => {
  const {GoogleGenAI} = await import('@google/genai');
  return new GoogleGenAI({apiKey});
};

export function createGeminiTtsProvider({client, config = loadGeminiTtsConfig()} = {}) {
  let resolvedClient = client;
  const getClient = async () => {
    if (!resolvedClient) resolvedClient = await createClient(config.apiKey);
    return resolvedClient;
  };

  return Object.freeze({
    async synthesize({text, voice} = {}) {
      const normalizedText = String(text || '').trim();
      if (!normalizedText) {
        throw new AppError('TTS_INPUT_INVALID', 'Gemini TTS text is required', {status: 500});
      }
      const selectedVoice = String(voice || config.voice).trim();
      if (!selectedVoice) {
        throw new AppError('TTS_INPUT_INVALID', 'Gemini TTS voice is required', {status: 500});
      }

      let response;
      try {
        const gemini = await getClient();
        response = await gemini.interactions.create({
          model: config.model,
          input: normalizedText,
          response_format: {type: 'audio'},
          generation_config: {speech_config: [{voice: selectedVoice}]},
          store: false,
        }, {timeout_ms: config.timeoutMs});
      } catch (error) {
        throw classifyGeminiError(error);
      }

      if (INCOMPLETE_STATUSES.has(response?.status)) {
        throw new AppError('PROVIDER_INCOMPLETE', 'Gemini TTS response was incomplete', {status: 502, retryable: true});
      }
      if (FAILED_STATUSES.has(response?.status) || response?.status !== 'completed') {
        throw new AppError('PROVIDER_FAILURE', 'Gemini TTS response failed', {status: 502, retryable: false});
      }

      const encoded = typeof response?.output_audio?.data === 'string' ? response.output_audio.data : '';
      const pcm = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
      if (pcm.length === 0) {
        throw new AppError('TTS_OUTPUT_INVALID', 'Gemini TTS returned no audio', {status: 502});
      }

      return Object.freeze({
        pcm,
        sampleRate: 24_000,
        channels: 1,
        sampleWidth: 2,
        voice: selectedVoice,
        model: config.model,
      });
    },
  });
}
