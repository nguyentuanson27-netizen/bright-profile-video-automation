import Ajv from 'ajv';
import {AppError} from './errors.mjs';
import {SUPPORTED_SCENE_TYPES} from './project.mjs';

const HTTP_URL_PATTERN = '^https?://';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$';

const sourceRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceId',
    'url',
    'platform',
    'retrievedAt',
    'retrievalStatus',
    'excerpt',
    'sourceType',
  ],
  properties: {
    sourceId: {type: 'string', minLength: 1, maxLength: 128},
    url: {type: 'string', pattern: HTTP_URL_PATTERN, maxLength: 4096},
    platform: {type: 'string', minLength: 1, maxLength: 128},
    title: {type: 'string', maxLength: 1000},
    retrievedAt: {type: 'string', pattern: TIMESTAMP_PATTERN},
    retrievalStatus: {enum: ['available', 'unavailable', 'failed']},
    excerpt: {type: 'string', maxLength: 100000},
    contentHash: {type: 'string', minLength: 1, maxLength: 256},
    sourceType: {
      enum: ['search-result', 'page', 'social', 'operator-url', 'other'],
    },
  },
};

const claimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'sourceIds', 'status'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 128},
    text: {type: 'string', minLength: 1, maxLength: 10000},
    sourceIds: {
      type: 'array',
      uniqueItems: true,
      items: {type: 'string', minLength: 1, maxLength: 128},
      maxItems: 20,
    },
    status: {enum: ['supported', 'unverified']},
  },
  allOf: [
    {
      if: {
        properties: {status: {const: 'supported'}},
        required: ['status'],
      },
      then: {
        properties: {sourceIds: {minItems: 1}},
      },
    },
  ],
};

const voiceoverChunkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'start', 'duration', 'text'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 128},
    start: {type: 'number', minimum: 0},
    duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800},
    text: {type: 'string', minLength: 1, maxLength: 20000},
    voice: {type: 'string', minLength: 1, maxLength: 256},
    speakingRate: {type: 'number', exclusiveMinimum: 0, maximum: 4},
  },
};

const sceneSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['id', 'type', 'start', 'duration'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 128},
    type: {enum: SUPPORTED_SCENE_TYPES},
    start: {type: 'number', minimum: 0},
    duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800},
  },
};

const renderProjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['duration', 'creatorName', 'scenes'],
  properties: {
    duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800},
    creatorName: {type: 'string', minLength: 1, maxLength: 500},
    heroImage: {type: 'string', maxLength: 10000000},
    audioUrl: {type: 'string', maxLength: 10000000},
    renderScale: {type: 'number', minimum: 0.25, maximum: 2},
    crf: {type: 'number', minimum: 16, maximum: 35},
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 80,
      items: sceneSchema,
    },
  },
};

const generationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['researchSummary', 'claims', 'script', 'voiceover', 'project'],
  properties: {
    researchSummary: {type: 'string', minLength: 1, maxLength: 100000},
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      items: claimSchema,
    },
    script: {type: 'string', minLength: 1, maxLength: 200000},
    voiceover: {
      type: 'object',
      additionalProperties: false,
      required: ['chunks'],
      properties: {
        chunks: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: voiceoverChunkSchema,
        },
      },
    },
    project: renderProjectSchema,
  },
};

const projectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['topic'],
  properties: {
    topic: {type: 'string', minLength: 1, maxLength: 500},
    sourceUrls: {
      type: 'array',
      uniqueItems: true,
      maxItems: 50,
      items: {type: 'string', pattern: HTTP_URL_PATTERN, maxLength: 4096},
    },
    instructions: {type: 'string', maxLength: 20000},
    duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800},
    language: {type: 'string', minLength: 2, maxLength: 32},
    voice: {type: 'string', minLength: 1, maxLength: 256},
  },
};

const draftRevisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['revisionId', 'projectId', 'topic', 'sources', 'generation'],
  properties: {
    revisionId: {type: 'string', minLength: 1, maxLength: 128},
    projectId: {type: 'string', minLength: 1, maxLength: 128},
    topic: {type: 'string', minLength: 1, maxLength: 500},
    sources: {type: 'array', maxItems: 500, items: sourceRecordSchema},
    generation: generationOutputSchema,
  },
};

const approvedSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'revisionId',
    'projectId',
    'topic',
    'sources',
    'generation',
    'approvedAt',
    'approvedBy',
    'claimOverrides',
    'media',
    'renderSettings',
  ],
  properties: {
    ...draftRevisionSchema.properties,
    approvedAt: {type: 'string', pattern: TIMESTAMP_PATTERN},
    approvedBy: {type: 'string', minLength: 1, maxLength: 256},
    claimOverrides: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'reason'],
        properties: {
          claimId: {type: 'string', minLength: 1, maxLength: 128},
          reason: {type: 'string', minLength: 1, maxLength: 5000},
        },
      },
    },
    media: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId'],
        properties: {
          sourceId: {type: 'string', minLength: 1, maxLength: 128},
          localAsset: {type: 'string', minLength: 1, maxLength: 4096},
        },
      },
    },
    renderSettings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        renderScale: {type: 'number', minimum: 0.25, maximum: 2},
        crf: {type: 'number', minimum: 16, maximum: 35},
      },
    },
  },
};

export const SCHEMAS = Object.freeze({
  projectInput: projectInputSchema,
  sourceRecord: sourceRecordSchema,
  generationOutput: generationOutputSchema,
  draftRevision: draftRevisionSchema,
  approvedSnapshot: approvedSnapshotSchema,
});

const ajv = new Ajv({allErrors: true, strict: true});
const validators = new Map(
  Object.entries(SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

export function assertSchema(name, value) {
  const validator = validators.get(name);
  if (!validator) {
    throw new AppError('UNKNOWN_SCHEMA', `Unknown schema: ${name}`, {status: 500});
  }

  if (validator(value)) return value;

  const errors = (validator.errors || []).map(({instancePath, keyword, message}) => ({
    instancePath,
    keyword,
    message,
  }));
  throw new AppError(
    'SCHEMA_VALIDATION_FAILED',
    `Invalid ${name} payload`,
    {status: 400, details: errors},
  );
}

export function assertGenerationConsistency(generation, sources) {
  assertSchema('generationOutput', generation);
  for (const source of sources) assertSchema('sourceRecord', source);

  const knownSourceIds = new Set(sources.map((source) => source.sourceId));
  for (const claim of generation.claims) {
    if (claim.status !== 'supported') continue;
    for (const sourceId of claim.sourceIds) {
      if (!knownSourceIds.has(sourceId)) {
        throw new AppError(
          'UNKNOWN_SOURCE_REFERENCE',
          `Claim ${claim.id} references an unknown source`,
          {status: 409},
        );
      }
    }
  }

  const duration = generation.project.duration;
  for (const scene of generation.project.scenes) {
    if (scene.start + scene.duration > duration + 0.05) {
      throw new AppError(
        'SCENE_OUTSIDE_TIMELINE',
        `Scene ${scene.id} falls outside the project timeline`,
        {status: 409},
      );
    }
  }

  for (const chunk of generation.voiceover.chunks) {
    if (chunk.start + chunk.duration > duration + 0.05) {
      throw new AppError(
        'VOICEOVER_OUTSIDE_TIMELINE',
        `Voiceover chunk ${chunk.id} falls outside the project timeline`,
        {status: 409},
      );
    }
  }

  return generation;
}
