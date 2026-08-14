import {AppError} from '../../domain/errors.mjs';
import {createApprovalService} from '../services/approve-project.mjs';

const invalidRequest = (message) => new AppError('INVALID_REQUEST', message, {status: 400});

const rejectManagedMediaFields = (draft) => {
  if (!Array.isArray(draft?.scenes)) return;
  for (const scene of draft.scenes) {
    if (scene && typeof scene === 'object' && !Array.isArray(scene) && Object.hasOwn(scene, 'mediaUrl')) {
      throw invalidRequest('scene.mediaUrl is managed by the media workflow and cannot be edited directly');
    }
  }
};

export const createRevisionsApi = ({repos, now, revisionIdFactory} = {}) => {
  const approval = createApprovalService({repos, now, revisionIdFactory});
  return Object.freeze({
    getDraft(projectId) {
      return approval.getDraft(projectId);
    },
    editDraft(projectId, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('JSON object body is required');
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'draft') throw invalidRequest('Only a structured draft field is accepted');
      rejectManagedMediaFields(body.draft);
      return approval.editDraft(projectId, body.draft);
    },
    approve(projectId) {
      return approval.approve(projectId);
    },
  });
};
