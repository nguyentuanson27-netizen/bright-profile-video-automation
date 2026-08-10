import {AppError} from './errors.mjs';

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

export const SUPPORTED_SCENE_TYPES = Object.freeze([
  'hero',
  'claim',
  'vertical',
  'source',
  'social',
  'stats',
]);

const FORWARD_TRANSITIONS = Object.freeze({
  draft: ['researching'],
  researching: ['research_ready'],
  research_ready: ['researching', 'generating'],
  generating: ['review_required'],
  review_required: ['researching', 'generating', 'approved'],
  approved: ['review_required', 'media_ingest'],
  media_ingest: ['tts', 'render_queued'],
  tts: ['render_queued'],
  render_queued: ['rendering'],
  rendering: ['completed'],
  completed: [],
  failed: [],
  cancelled: [],
});

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const CANCELLABLE_STATES = new Set([
  'draft',
  'researching',
  'research_ready',
  'generating',
  'review_required',
  'approved',
  'media_ingest',
  'tts',
  'render_queued',
]);
const FAILABLE_STATES = new Set([
  'researching',
  'generating',
  'media_ingest',
  'tts',
  'render_queued',
  'rendering',
]);

export function assertProjectTransition(from, to) {
  if (!PROJECT_STATES.includes(from) || !PROJECT_STATES.includes(to)) {
    throw new AppError(
      'UNKNOWN_PROJECT_STATE',
      `Unknown project state transition: ${from} -> ${to}`,
      {status: 500},
    );
  }

  const allowed = FORWARD_TRANSITIONS[from].includes(to)
    || (to === 'failed' && FAILABLE_STATES.has(from))
    || (to === 'cancelled' && CANCELLABLE_STATES.has(from));

  if (!allowed || TERMINAL_STATES.has(from)) {
    throw new AppError(
      'INVALID_PROJECT_TRANSITION',
      `Project cannot transition from ${from} to ${to}`,
      {status: 409},
    );
  }

  return true;
}
