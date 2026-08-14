export const GenerationProviderErrorCodes = Object.freeze({
  TIMEOUT: 'GENERATION_PROVIDER_TIMEOUT',
  RATE_LIMIT: 'GENERATION_PROVIDER_RATE_LIMIT',
  FAILED: 'GENERATION_PROVIDER_FAILED',
  INCOMPLETE: 'GENERATION_PROVIDER_INCOMPLETE',
  REFUSED: 'GENERATION_PROVIDER_REFUSED',
  INVALID_RESULT: 'GENERATION_PROVIDER_INVALID_RESULT',
  INVALID_INPUT: 'GENERATION_INPUT_INVALID',
});

export class GenerationProviderError extends Error {
  constructor(code, message, {retryable = false} = {}) {
    super(message);
    this.name = 'GenerationProviderError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

// Keep the provider-facing schema inside OpenAI's documented Structured Outputs
// subset. Full length/uniqueness/reference/timeline checks remain authoritative in
// the local Ajv draft validator after the provider returns.
export const generationOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['creatorName', 'summary', 'claims', 'script', 'voiceover', 'scenes', 'render'],
  properties: {
    creatorName: {type: 'string'},
    summary: {type: 'string'},
    claims: {
      type: 'array', maxItems: 500,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'text', 'sourceIds', 'verified'],
        properties: {
          id: {type: 'string'},
          text: {type: 'string'},
          sourceIds: {type: 'array', minItems: 1, maxItems: 200, items: {type: 'string'}},
          verified: {type: 'boolean'},
        },
      },
    },
    script: {
      type: 'array', maxItems: 500,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'text', 'start', 'duration', 'sourceIds'],
        properties: {
          id: {type: 'string'},
          text: {type: 'string'},
          start: {type: 'number', minimum: 0},
          duration: {type: 'number', exclusiveMinimum: 0},
          sourceIds: {type: 'array', minItems: 1, maxItems: 200, items: {type: 'string'}},
        },
      },
    },
    voiceover: {
      type: 'object', additionalProperties: false, required: ['chunks'],
      properties: {
        chunks: {
          type: 'array', maxItems: 500,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'text', 'start', 'duration'],
            properties: {
              id: {type: 'string'},
              text: {type: 'string'},
              start: {type: 'number', minimum: 0},
              duration: {type: 'number', exclusiveMinimum: 0},
            },
          },
        },
      },
    },
    scenes: {
      type: 'array', minItems: 1, maxItems: 80,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'type', 'start', 'duration', 'sourceIds'],
        properties: {
          id: {type: 'string'},
          type: {type: 'string', enum: ['hero', 'claim', 'vertical', 'source', 'social', 'stats']},
          start: {type: 'number', minimum: 0},
          duration: {type: 'number', exclusiveMinimum: 0},
          sourceIds: {type: 'array', minItems: 1, maxItems: 200, items: {type: 'string'}},
        },
      },
    },
    render: {
      type: 'object', additionalProperties: false, required: ['duration'],
      properties: {duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800}},
    },
  },
});

const invalidResult = (message) => new GenerationProviderError(
  GenerationProviderErrorCodes.INVALID_RESULT,
  message,
  {retryable: false},
);

export const assertGenerationProvider = (provider) => {
  if (!provider || typeof provider.generate !== 'function') {
    throw new TypeError('generation provider with a generate() method is required');
  }
  return provider;
};

export const validateGenerationProviderResult = (value, {maxBytes = 2 * 1024 * 1024} = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResult('generation result must be an object');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw invalidResult('generation result is too large');
  return value;
};
