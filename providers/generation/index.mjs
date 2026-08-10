import {AppError} from '../../domain/errors.mjs';
import {assertGenerationConsistency, assertSchema} from '../../domain/schemas.mjs';

const INPUT_KEYS = new Set(['topic', 'sources', 'instructions', 'duration', 'language']);

const inputError = (message = 'Generation provider input is invalid') => new AppError(
  'PROVIDER_INPUT_INVALID',
  message,
  {status: 400},
);

const outputError = () => new AppError(
  'PROVIDER_OUTPUT_INVALID',
  'Generation provider returned invalid structured output',
  {status: 502},
);

const validateInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw inputError();
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw inputError();
  if (typeof input.topic !== 'string' || input.topic.trim().length === 0 || input.topic.length > 500) {
    throw inputError('Generation provider topic is invalid');
  }
  if (!Array.isArray(input.sources) || input.sources.length > 500) {
    throw inputError('Generation provider sources are invalid');
  }
  for (const source of input.sources) {
    try {
      assertSchema('sourceRecord', source);
    } catch {
      throw inputError('Generation provider sources are invalid');
    }
  }
  if (input.instructions !== undefined
    && (typeof input.instructions !== 'string' || input.instructions.length > 20_000)) {
    throw inputError('Generation provider instructions are invalid');
  }
  if (input.duration !== undefined
    && (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 1800)) {
    throw inputError('Generation provider duration is invalid');
  }
  if (input.language !== undefined
    && (typeof input.language !== 'string' || input.language.length < 2 || input.language.length > 32)) {
    throw inputError('Generation provider language is invalid');
  }
};

const normalizeOutput = (output, sources) => {
  try {
    return assertGenerationConsistency(output, sources);
  } catch (error) {
    if (error instanceof AppError && [
      'UNKNOWN_SOURCE_REFERENCE',
      'SCENE_OUTSIDE_TIMELINE',
      'VOICEOVER_OUTSIDE_TIMELINE',
    ].includes(error.code)) {
      throw error;
    }
    if (error instanceof AppError && error.code === 'SCHEMA_VALIDATION_FAILED') throw outputError();
    throw error;
  }
};

export function createGenerationProvider({generate}) {
  if (typeof generate !== 'function') throw new TypeError('generation provider generate function is required');

  return Object.freeze({
    async generate(input) {
      validateInput(input);
      const request = {
        topic: input.topic.trim(),
        sources: input.sources.map((source) => structuredClone(source)),
      };
      if (input.instructions !== undefined) request.instructions = input.instructions;
      if (input.duration !== undefined) request.duration = input.duration;
      if (input.language !== undefined) request.language = input.language;

      const output = await generate(request);
      return structuredClone(normalizeOutput(output, input.sources));
    },
  });
}
