import {
  importProjectInputSchema,
  editDraftInputSchema,
  projectStatusOutputSchema,
  APPROVAL_MODES,
} from '../../domain/schemas.mjs';

export const createVideoProjectInputSchema = importProjectInputSchema;

export const getVideoProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
  },
};

export const editVideoDraftInputSchema = editDraftInputSchema;

export const approveVideoProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'revisionId', 'expectedPayloadHash'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
    revisionId: {type: 'string', minLength: 1, maxLength: 200},
    expectedPayloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    mode: {type: 'string', maxLength: 100},
    delegationGrant: {type: 'string', maxLength: 2048},
    delegatedContext: {type: 'object'},
  },
};

export const startVideoRenderInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
  },
};

export const retryVideoProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
  },
};

export const cancelVideoProjectInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: {
    projectId: {type: 'string', minLength: 1, maxLength: 200},
  },
};

export const videoProjectStatusOutputSchema = projectStatusOutputSchema;
export {APPROVAL_MODES};