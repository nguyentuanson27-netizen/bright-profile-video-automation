const STATUS_LABELS = Object.freeze({
  draft: 'Preparing project',
  researching: 'Researching public sources',
  research_ready: 'Research complete',
  generating: 'Generating script and scenes',
  review_required: 'Ready for review',
  approved: 'Approved',
  media_ingest: 'Ingesting approved media',
  tts: 'Generating voiceover',
  render_queued: 'Queued for render',
  rendering: 'Rendering video',
  completed: 'Video completed',
  failed: 'Project failed',
  cancelled: 'Project cancelled',
});
const PENDING = new Set(['draft', 'researching', 'research_ready', 'generating', 'approved', 'media_ingest', 'tts', 'render_queued', 'rendering']);

export function createProjectPayload({topic, sourceUrlsText = '', instructions = ''}) {
  const cleanTopic = String(topic || '').trim();
  const cleanInstructions = String(instructions || '').trim();
  const sourceUrls = [...new Set(String(sourceUrlsText || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean))];

  return {
    topic: cleanTopic,
    ...(sourceUrls.length > 0 ? {sourceUrls} : {}),
    ...(cleanInstructions ? {instructions: cleanInstructions} : {}),
  };
}

export function projectStatusView({project, latestJob = null, sourceSummary = null}) {
  const summary = sourceSummary || {total: 0, available: 0, unavailable: 0, failed: 0};
  const jobFailed = latestJob?.status === 'failed';
  const projectFailed = project.status === 'failed';
  const error = jobFailed
    ? (latestJob.errorMessage || latestJob.errorCode || 'Background job failed')
    : (projectFailed ? 'Project failed' : null);

  return {
    label: error ? (STATUS_LABELS[project.status] || 'Needs attention') : (STATUS_LABELS[project.status] || project.status),
    tone: error ? 'error' : (project.status === 'completed' ? 'success' : (project.status === 'review_required' ? 'review' : 'pending')),
    pending: !error && PENDING.has(project.status),
    needsReview: project.status === 'review_required',
    error,
    sourceText: `${summary.available}/${summary.total} sources available`,
  };
}
