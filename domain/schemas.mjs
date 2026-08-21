import Ajv2020 from 'ajv/dist/2020.js';
import {AppError, ErrorCodes, invalidDomainData} from './errors.mjs';
import {assertEvidenceBundle} from '../lib/evidence/schema-validator.mjs';

const sourceIds = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: {type: 'string', minLength: 1, maxLength: 200},
};

export const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'url', 'title', 'status'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 200},
    url: {type: 'string', minLength: 8, maxLength: 4096, pattern: '^https?://'},
    title: {type: 'string', minLength: 1, maxLength: 1000},
    status: {enum: ['available', 'unavailable']},
    reason: {type: 'string', minLength: 1, maxLength: 1000},
  },
};

export const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'sourceId', 'claim', 'confidence'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 200},
    sourceId: {type: 'string', minLength: 1, maxLength: 200},
    claim: {type: 'string', minLength: 1, maxLength: 10000},
    confidence: {enum: ['low', 'medium', 'high']},
    observedAt: {type: 'string', minLength: 1, maxLength: 100},
  },
};

const timedText = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'start', 'duration'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 200},
    text: {type: 'string', minLength: 1, maxLength: 20000},
    start: {type: 'number', minimum: 0},
    duration: {type: 'number', exclusiveMinimum: 0},
    sourceIds,
  },
};

const sceneSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'start', 'duration', 'sourceIds'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 200},
    type: {enum: ['hero', 'claim', 'vertical', 'source', 'social', 'stats']},
    start: {type: 'number', minimum: 0},
    duration: {type: 'number', exclusiveMinimum: 0},
    sourceIds,
    chapter: {type: 'string', maxLength: 1000},
    subtitle: {type: 'string', maxLength: 10000},
    heading: {type: 'string', maxLength: 10000},
    quote: {type: 'string', maxLength: 20000},
    label: {type: 'string', maxLength: 1000},
    source: {type: 'string', maxLength: 1000},
    mediaUrl: {type: 'string', maxLength: 4096},
    fit: {enum: ['contain', 'cover']},
    muted: {type: 'boolean'},
    words: {type: 'array', maxItems: 20, items: {type: 'string', maxLength: 1000}},
    stats: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: {
          label: {type: 'string', minLength: 1, maxLength: 1000},
          value: {type: 'string', minLength: 1, maxLength: 1000},
        },
      },
    },
  },
};

export const draftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['creatorName', 'summary', 'claims', 'script', 'voiceover', 'scenes', 'render'],
  properties: {
    creatorName: {type: 'string', minLength: 1, maxLength: 1000},
    summary: {type: 'string', minLength: 1, maxLength: 20000},
    claims: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'sourceIds', 'verified'],
        properties: {
          id: {type: 'string', minLength: 1, maxLength: 200},
          text: {type: 'string', minLength: 1, maxLength: 10000},
          sourceIds,
          verified: {type: 'boolean'},
          overrideReason: {type: 'string', minLength: 1, maxLength: 1000},
        },
      },
    },
    script: {
      type: 'array',
      maxItems: 500,
      items: {...timedText, required: [...timedText.required, 'sourceIds']},
    },
    voiceover: {
      type: 'object',
      additionalProperties: false,
      required: ['chunks'],
      properties: {
        chunks: {type: 'array', maxItems: 500, items: timedText},
      },
    },
    scenes: {type: 'array', minItems: 1, maxItems: 80, items: sceneSchema},
    render: {
      type: 'object',
      additionalProperties: false,
      required: ['duration'],
      properties: {
        duration: {type: 'number', exclusiveMinimum: 0, maximum: 1800},
        renderScale: {type: 'number', minimum: 0.25, maximum: 2},
        crf: {type: 'integer', minimum: 16, maximum: 35},
      },
    },
  },
};

export const approvedRevisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'projectId', 'payloadHash', 'approvedAt', 'payload'],
  properties: {
    id: {type: 'string', minLength: 1, maxLength: 200},
    projectId: {type: 'string', minLength: 1, maxLength: 200},
    payloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    approvedAt: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$'},
    payload: {type: 'object'},
  },
};

const ajv = new Ajv2020({allErrors: true, strict: true});
const validateSourceShape = ajv.compile(sourceSchema);
const validateEvidenceShape = ajv.compile(evidenceSchema);
const validateDraftShape = ajv.compile(draftSchema);
const validateApprovedShape = ajv.compile(approvedRevisionSchema);

const safeErrors = (errors = []) => errors.map(({instancePath, keyword, message}) => ({
  instancePath,
  keyword,
  message,
}));

const assertShape = (validator, value, name) => {
  if (!validator(value)) throw invalidDomainData(`Invalid ${name}`, safeErrors(validator.errors));
};

const knownSet = (knownSourceIds) => new Set(knownSourceIds ?? []);
const assertKnownSource = (id, known) => {
  if (!known.has(id)) {
    throw new AppError(
      ErrorCodes.UNKNOWN_SOURCE_REFERENCE,
      `Unknown source reference: ${id}`,
      {status: 400},
    );
  }
};

const assertWithinTimeline = (entry, duration, label) => {
  if (entry.start + entry.duration > duration + 1e-9) {
    throw invalidDomainData(`${label} falls outside render timeline`);
  }
};

export const validateSource = (source) => {
  assertShape(validateSourceShape, source, 'source');
  return source;
};

export const validateEvidence = (evidence, {knownSourceIds = []} = {}) => {
  assertShape(validateEvidenceShape, evidence, 'evidence');
  assertKnownSource(evidence.sourceId, knownSet(knownSourceIds));
  return evidence;
};

export const validateDraft = (draft, {knownSourceIds = []} = {}) => {
  assertShape(validateDraftShape, draft, 'draft');
  const known = knownSet(knownSourceIds);
  for (const claim of draft.claims) for (const sourceId of claim.sourceIds) assertKnownSource(sourceId, known);
  for (const item of draft.script) {
    for (const sourceId of item.sourceIds) assertKnownSource(sourceId, known);
    assertWithinTimeline(item, draft.render.duration, `Script item ${item.id}`);
  }
  for (const chunk of draft.voiceover.chunks) assertWithinTimeline(chunk, draft.render.duration, `Voice chunk ${chunk.id}`);
  for (const scene of draft.scenes) {
    for (const sourceId of scene.sourceIds) assertKnownSource(sourceId, known);
    assertWithinTimeline(scene, draft.render.duration, `Scene ${scene.id}`);
  }
  return draft;
};

export const validateApprovedRevision = (revision, options = {}) => {
  assertShape(validateApprovedShape, revision, 'approved revision');
  validateDraft(revision.payload, options);
  return revision;
};

export const APPROVAL_MODES = Object.freeze({
  USER_REVIEWED: 'user_reviewed',
});

export const PROJECT_ORIGINS = Object.freeze({
  STANDALONE: 'standalone',
  CHATGPT_MCP: 'chatgpt_mcp',
});

export const importProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['creator', 'topic', 'evidenceBundle', 'idempotencyKey'],
  properties: {
    creator: {type: 'string', minLength: 1, maxLength: 200},
    topic: {type: 'string', minLength: 1, maxLength: 500},
    instructions: {type: 'string', maxLength: 2000},
    evidenceBundle: {type: 'object'},
    idempotencyKey: {type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$'},
  },
};

export const approveProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'revisionId', 'expectedPayloadHash'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
    revisionId: {type: 'string', minLength: 1, maxLength: 200},
    expectedPayloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
  },
};

export const editDraftInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'revisionId', 'expectedPayloadHash', 'draft'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
    revisionId: {type: 'string', minLength: 1, maxLength: 200},
    expectedPayloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    draft: {type: 'object'},
  },
};

export const projectStatusOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'status'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
    status: {type: 'string', minLength: 1, maxLength: 100},
    origin: {type: 'string', maxLength: 50},
    currentRevision: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'payloadHash'],
      properties: {
        id: {type: 'string', minLength: 1, maxLength: 200},
        payloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
        draft: {type: 'object'},
      },
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        currentStage: {type: 'string'},
        stageStatus: {type: 'string'},
        attemptCount: {type: 'integer', minimum: 0},
        failureRetryable: {type: 'boolean'},
        failureCode: {type: 'string'},
      },
    },
    evidenceSummary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inputItems: {type: 'integer', minimum: 0},
        retainedEvidence: {type: 'integer', minimum: 0},
        conflictGroups: {type: 'integer', minimum: 0},
        rejectedItems: {type: 'integer', minimum: 0},
      },
    },
    output: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactId: {type: 'string'},
        downloadUrl: {type: 'string'},
        sizeBytes: {type: 'integer', minimum: 0},
        sha256: {type: 'string'},
      },
    },
    requestId: {type: 'string'},
  },
};

const validateImportProjectShape = ajv.compile(importProjectInputSchema);
const validateApproveProjectShape = ajv.compile(approveProjectInputSchema);
const validateEditDraftShape = ajv.compile(editDraftInputSchema);
const validateProjectStatusOutputShape = ajv.compile(projectStatusOutputSchema);

export const validateImportProjectInput = (input) => {
  assertShape(validateImportProjectShape, input, 'import project input');
  try {
    assertEvidenceBundle(input.evidenceBundle);
  } catch (error) {
    throw invalidDomainData('Invalid evidenceBundle in import project input', error?.details);
  }
  return input;
};

export const validateApproveProjectInput = (input) => {
  assertShape(validateApproveProjectShape, input, 'approve project input');
  return input;
};

export const validateEditDraftInput = (input, options = {}) => {
  assertShape(validateEditDraftShape, input, 'edit draft input');
  validateDraft(input.draft, options);
  return input;
};

export const validateProjectStatusOutput = (output) => {
  assertShape(validateProjectStatusOutputShape, output, 'project status output');
  return output;
};
