import {createHash} from 'node:crypto';
import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {validateDraft} from '../../domain/schemas.mjs';

const hashDraft = (draft) => createHash('sha256').update(JSON.stringify(draft)).digest('hex');
const projectNotFound = () => new AppError('PROJECT_NOT_FOUND', 'Project not found', {status: 404});

export const createApprovalService = ({repos, now = Date.now, revisionIdFactory} = {}) => {
  if (!repos?.projects || !repos?.sources || !repos?.revisions) throw new TypeError('repositories are required');
  if (typeof now !== 'function') throw new TypeError('now is required');
  if (typeof revisionIdFactory !== 'function') throw new TypeError('revisionIdFactory is required');

  const requireProject = (projectId) => {
    const project = repos.projects.get(projectId);
    if (!project) throw projectNotFound();
    return project;
  };
  const sourceIds = (projectId) => repos.sources.list(projectId)
    .filter((source) => source.status === 'available')
    .map((source) => source.id);
  const currentRevision = (project) => {
    if (!project.currentRevisionId) throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Project has no current review draft');
    const revision = repos.revisions.get(project.currentRevisionId);
    if (!revision || revision.projectId !== project.id) throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Current review revision is unavailable');
    return revision;
  };
  const generatedRevisionId = () => {
    const id = revisionIdFactory();
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new TypeError('revisionIdFactory must return a non-empty bounded string');
    return id;
  };

  return Object.freeze({
    getDraft(projectId) {
      const project = requireProject(projectId);
      return {project, revision: currentRevision(project)};
    },

    editDraft(projectId, draft) {
      requireProject(projectId);
      const knownSourceIds = sourceIds(projectId);
      validateDraft(draft, {knownSourceIds});
      const payloadHash = hashDraft(draft);
      return repos.revisions.editCurrent({
        projectId,
        revisionId: generatedRevisionId(),
        payload: draft,
        payloadHash,
        updatedAt: new Date(now()).toISOString(),
      });
    },

    approve(projectId) {
      const project = requireProject(projectId);
      if (project.status !== 'review_required') {
        throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Approval requires a review_required project');
      }
      const revision = currentRevision(project);
      validateDraft(revision.payload, {knownSourceIds: sourceIds(projectId)});
      for (const claim of revision.payload.claims) {
        if (!claim.verified && (typeof claim.overrideReason !== 'string' || claim.overrideReason.trim() === '')) {
          throw new AppError(
            ErrorCodes.APPROVAL_BLOCKED,
            `Unverified claim ${claim.id} requires an explicit stored override reason`,
          );
        }
      }
      if (hashDraft(revision.payload) !== revision.payloadHash) throw new Error('revision payload hash mismatch');
      const approved = repos.revisions.approve({
        projectId,
        revisionId: revision.id,
        expectedPayloadHash: revision.payloadHash,
        approvedAt: new Date(now()).toISOString(),
      });
      return {project: requireProject(projectId), revision: approved};
    },
  });
};
