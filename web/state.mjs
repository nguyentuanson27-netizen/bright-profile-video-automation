const ACTIVE = new Set(['researching', 'generating', 'media_ingest', 'tts', 'render_queued', 'rendering']);

const ACTIONS = Object.freeze({
  draft: ['research'],
  researching: ['cancel'],
  research_ready: ['generate'],
  generating: ['cancel'],
  review_required: ['approve'],
  approved: ['render'],
  media_ingest: ['cancel'],
  tts: ['cancel'],
  render_queued: ['cancel'],
  rendering: ['cancel'],
  failed: ['retry'],
  cancelled: [],
  completed: ['download'],
});

export const actionsForProject = (status) => [...(ACTIONS[status] ?? [])];

export const actionBlockedReason = (status, action, {draftDirty = false} = {}) => {
  if (!actionsForProject(status).includes(action)) return 'Action is not available for the current project state.';
  if (action === 'approve' && draftDirty) return 'Save review changes before approving this revision.';
  return '';
};

export const shouldPollProject = (status) => ACTIVE.has(status);

export const normalizePublicUrls = (value) => {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const urls = [...new Set(lines)];
  if (urls.length > 20) throw new TypeError('Public URLs are limited to at most 20 entries');
  return urls;
};

export const statusLabel = (status) => ({
  draft: 'Draft',
  researching: 'Researching',
  research_ready: 'Research ready',
  generating: 'Generating draft',
  review_required: 'Review required',
  approved: 'Approved',
  media_ingest: 'Preparing media',
  tts: 'Generating voiceover',
  render_queued: 'Render queued',
  rendering: 'Rendering',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
}[status] ?? 'Unknown');
