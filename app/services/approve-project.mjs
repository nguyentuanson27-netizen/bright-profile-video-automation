import {createHash, randomUUID} from 'node:crypto';
import {AppError} from '../../domain/errors.mjs';
import {assertGenerationConsistency, assertSchema} from '../../domain/schemas.mjs';

const defaultRevisionId = ({revisionId, generation}) => {
  const hash = createHash('sha256').update(JSON.stringify(generation)).digest('hex').slice(0, 16);
  return `${revisionId}-edit-${hash}`;
};

const revisionForProject = (repositories, projectId, revisionId) => {
  const revision = repositories.revisions.get(revisionId);
  if (!revision || revision.projectId !== projectId) {
    throw new AppError('REVISION_NOT_FOUND', 'Revision was not found', {status: 404});
  }
  return revision;
};

const availableSources = (payload) => payload.sources.filter((source) => source.retrievalStatus === 'available');

const validateOverrides = (generation, overrides) => {
  if (!Array.isArray(overrides)) {
    throw new AppError('CLAIM_OVERRIDE_INVALID', 'Claim overrides must be an array', {status: 400});
  }
  const unverified = new Set(generation.claims.filter((claim) => claim.status === 'unverified').map((claim) => claim.id));
  const seen = new Set();
  for (const override of overrides) {
    if (!override || typeof override !== 'object'
      || typeof override.claimId !== 'string'
      || typeof override.reason !== 'string'
      || override.reason.trim().length === 0
      || override.reason.length > 5000
      || !unverified.has(override.claimId)
      || seen.has(override.claimId)) {
      throw new AppError('CLAIM_OVERRIDE_INVALID', 'Claim override is invalid', {status: 400});
    }
    seen.add(override.claimId);
  }
  const missing = [...unverified].filter((claimId) => !seen.has(claimId));
  if (missing.length > 0) {
    throw new AppError('UNVERIFIED_CLAIMS', 'Unverified claims require an explicit operator override', {status: 409});
  }
  return overrides.map((override) => ({claimId: override.claimId, reason: override.reason.trim()}));
};

const renderSettingsFrom = (generation) => {
  const settings = {};
  if (generation.project.renderScale !== undefined) settings.renderScale = generation.project.renderScale;
  if (generation.project.crf !== undefined) settings.crf = generation.project.crf;
  return settings;
};

export function createApprovalService({
  repositories,
  projectStateStore,
  revisionIdGenerator = defaultRevisionId,
  clock = () => new Date(),
}) {
  if (!repositories?.projects || !repositories?.revisions || !projectStateStore?.approveRevision) {
    throw new TypeError('approval storage dependencies are required');
  }

  return Object.freeze({
    editDraft({projectId, revisionId, generation}) {
      const project = repositories.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      const revision = revisionForProject(repositories, projectId, revisionId);
      assertGenerationConsistency(generation, availableSources(revision.payload));

      const targetRevisionId = revision.status === 'approved'
        ? revisionIdGenerator({projectId, revisionId, generation})
        : revisionId;
      const payload = {
        revisionId: targetRevisionId,
        projectId,
        topic: revision.payload.topic,
        sources: revision.payload.sources,
        generation: structuredClone(generation),
      };
      assertSchema('draftRevision', payload);
      const saved = repositories.revisions.saveDraft({projectId, revisionId: targetRevisionId, payload});

      if (revision.status === 'approved' && project.status === 'approved') {
        projectStateStore.setStatus({projectId, status: 'review_required', now: clock()});
      }
      return saved;
    },

    approve({projectId, revisionId, approvedBy, claimOverrides = []}) {
      const project = repositories.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      const revision = revisionForProject(repositories, projectId, revisionId);
      if (revision.status !== 'draft') {
        throw new AppError('APPROVED_REVISION_IMMUTABLE', 'Approved revision cannot be approved again', {status: 409});
      }
      if (typeof approvedBy !== 'string' || approvedBy.trim().length === 0 || approvedBy.length > 256) {
        throw new AppError('APPROVER_INVALID', 'Approver is invalid', {status: 400});
      }

      assertGenerationConsistency(revision.payload.generation, availableSources(revision.payload));
      const overrides = validateOverrides(revision.payload.generation, claimOverrides);
      const approvedAt = clock().toISOString();
      const payload = {
        ...revision.payload,
        approvedAt,
        approvedBy: approvedBy.trim(),
        claimOverrides: overrides,
        media: [],
        renderSettings: renderSettingsFrom(revision.payload.generation),
      };
      assertSchema('approvedSnapshot', payload);
      return projectStateStore.approveRevision({
        projectId,
        revisionId,
        payload,
        approvedAt,
        approvedBy: approvedBy.trim(),
        now: clock(),
      });
    },

    assertRenderAllowed({projectId, revisionId}) {
      const project = repositories.projects.get(projectId);
      const revision = revisionForProject(repositories, projectId, revisionId);
      if (!project || project.status !== 'approved' || revision.status !== 'approved') {
        throw new AppError('APPROVED_REVISION_REQUIRED', 'An active approved revision is required before render', {status: 409});
      }
      return revision;
    },
  });
}
