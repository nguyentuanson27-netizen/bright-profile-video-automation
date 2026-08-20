import {
  importProjectInputSchema,
  approveProjectInputSchema,
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

export const approveVideoProjectInputSchema = approveProjectInputSchema;

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