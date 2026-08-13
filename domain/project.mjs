import {AppError, ErrorCodes, invalidTransition} from './errors.mjs';

export const PROJECT_STATES = Object.freeze([
  'draft',
  'researching',
  'research_ready',
  'generating',
  'review_required',
  'approved',
  'media_ingest',
  'tts',
  'render_queued',
  'rendering',
  'completed',
  'failed',
  'cancelled',
]);

export const ACTIVE_DURABLE_STATES = Object.freeze([
  'researching',
  'generating',
  'media_ingest',
  'tts',
  'render_queued',
  'rendering',
]);

const nextState = new Map([
  ['draft', 'researching'],
  ['researching', 'research_ready'],
  ['research_ready', 'generating'],
  ['generating', 'review_required'],
  ['review_required', 'approved'],
  ['approved', 'media_ingest'],
  ['media_ingest', 'tts'],
  ['tts', 'render_queued'],
  ['render_queued', 'rendering'],
  ['rendering', 'completed'],
]);

const assertProjectState = (project) => {
  if (!project || !PROJECT_STATES.includes(project.status)) {
    throw new TypeError('project must contain a known status');
  }
};

export const transitionProject = (project, target) => {
  assertProjectState(project);
  if (nextState.get(project.status) !== target) throw invalidTransition(project.status, target);
  return {...project, status: target, failure: null};
};

export const failProject = (project, {stage, retryable, code}) => {
  assertProjectState(project);
  if (!ACTIVE_DURABLE_STATES.includes(project.status) || stage !== project.status) {
    throw invalidTransition(project.status, 'failed', {stage});
  }
  if (typeof retryable !== 'boolean' || typeof code !== 'string' || code.length === 0) {
    throw new TypeError('failure requires retryable boolean and stable code');
  }
  return {...project, status: 'failed', failure: {stage, retryable, code}};
};

export const retryFailedProject = (project) => {
  assertProjectState(project);
  if (project.status !== 'failed' || !project.failure?.retryable) {
    throw new AppError(
      ErrorCodes.FAILED_STAGE_NOT_RETRYABLE,
      'Failed stage is not retryable',
    );
  }
  const target = project.failure.stage === 'rendering' ? 'render_queued' : project.failure.stage;
  if (!ACTIVE_DURABLE_STATES.includes(target)) {
    throw new AppError(ErrorCodes.FAILED_STAGE_NOT_RETRYABLE, 'Failed stage cannot be requeued');
  }
  return {...project, status: target, failure: null};
};

export const cancelProject = (project) => {
  assertProjectState(project);
  if (project.status === 'cancelled') return {changed: false, project};
  if (!ACTIVE_DURABLE_STATES.includes(project.status)) throw invalidTransition(project.status, 'cancelled');
  return {changed: true, project: {...project, status: 'cancelled'}};
};

const hasCurrentApproval = (project) => (
  project.status === 'approved'
  && Boolean(project.currentRevisionId)
  && project.currentRevisionId === project.approvedRevisionId
);

export const decideApprovedEdit = (project, {hasDescendantStage}) => {
  assertProjectState(project);
  if (!hasCurrentApproval(project)) throw invalidTransition(project.status, 'review_required');
  if (hasDescendantStage) {
    throw new AppError(
      ErrorCodes.DOWNSTREAM_WORK_STARTED,
      'Approval-relevant edit is blocked after downstream work starts',
    );
  }
  return {nextStatus: 'review_required', invalidateApproval: true};
};

export const assertCanCreateFirstDescendant = (project, {revisionId, hasDescendantStage}) => {
  assertProjectState(project);
  if (
    !hasCurrentApproval(project)
    || revisionId !== project.approvedRevisionId
    || hasDescendantStage
  ) {
    throw invalidTransition(project.status, 'media_ingest', {revisionId});
  }
};
