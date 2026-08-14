import React, {useEffect, useState} from 'react';

import {DraftEditor} from './DraftEditor.jsx';
import {EvidencePanel} from './EvidencePanel.jsx';
import {actionBlockedReason, actionsForProject, reviewModeForProject, statusLabel} from '../state.mjs';

const actionCopy = {
  research: 'Start research',
  generate: 'Generate draft',
  approve: 'Approve revision',
  render: 'Start render',
  retry: 'Retry failed stage',
  cancel: 'Cancel active work',
};

export function ProjectWorkspace({project, sources, draft, pendingAction, onAction, onSaveDraft}) {
  const [draftDirty, setDraftDirty] = useState(false);
  useEffect(() => setDraftDirty(false), [project?.id, project?.status, draft]);

  if (!project) return <section className="panel workspace-empty">
    <p className="eyebrow">Project detail</p>
    <h2>Select a project</h2>
    <p className="empty-state">Choose a project from the workspace list to inspect its durable pipeline state.</p>
  </section>;

  const actions = actionsForProject(project);
  const reviewMode = reviewModeForProject(project);
  return <section className="panel workspace-panel" aria-labelledby="workspace-title">
    <header className="workspace-header">
      <div>
        <p className="eyebrow">{project.topic}</p>
        <h2 id="workspace-title">{project.creator}</h2>
        <p className="project-id">Project {project.id}</p>
      </div>
      <span className={`status-pill status-${project.status}`}>{statusLabel(project.status)}</span>
    </header>

    {project.failureCode ? <div className="failure-banner" role="alert">
      <strong>{project.failureCode}</strong>
      <span>{project.failureRetryable ? 'Retry is available.' : 'This failure is terminal for the current stage.'}</span>
    </div> : null}

    <div className="action-bar" aria-label="Project actions">
      {actions.filter((action) => action !== 'download').map((action) => {
        const blockedReason = actionBlockedReason(project, action, {draftDirty});
        return <button
          key={action}
          type="button"
          className={`button ${action === 'cancel' ? 'danger' : action === 'approve' || action === 'render' ? 'primary' : 'secondary'}`}
          disabled={Boolean(pendingAction) || Boolean(blockedReason)}
          title={blockedReason || undefined}
          onClick={() => onAction(action)}
        >{pendingAction === action ? 'Working…' : actionCopy[action]}</button>;
      })}
      {actions.includes('download') ? <a className="button primary" href={`/api/projects/${encodeURIComponent(project.id)}/artifacts/output`} download>
        Download MP4
      </a> : null}
      {draftDirty ? <span className="pending-copy" role="status">Save review changes before continuing.</span> : null}
      {pendingAction ? <span className="pending-copy" role="status" aria-live="polite">Updating durable state…</span> : null}
    </div>

    <div className="workflow-track" aria-label="Pipeline progress">
      {['Research', 'Draft', 'Review', 'Media', 'Voice', 'Render'].map((label, index) => <div key={label} className="workflow-step">
        <span>{String(index + 1).padStart(2, '0')}</span><strong>{label}</strong>
      </div>)}
    </div>

    <EvidencePanel project={project} sources={sources} />

    {reviewMode.visible ? <section className="review-shell" aria-labelledby="review-title">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Human gate</p>
          <h3 id="review-title">{reviewMode.invalidatesApproval ? 'Edit approved revision before downstream work' : 'Review generated draft'}</h3>
        </div>
        <span className="step-chip">Review</span>
      </div>
      {reviewMode.invalidatesApproval ? <div className="approval-warning" role="note">
        This revision is approved. Saving any approval-relevant change invalidates that approval and returns the project to Review required. If downstream work starts first, the server rejects the edit with DOWNSTREAM_WORK_STARTED.
      </div> : null}
      <DraftEditor
        draft={draft?.draft ?? draft?.revision?.payload ?? draft}
        onSave={onSaveDraft}
        onDirtyChange={setDraftDirty}
        pending={Boolean(pendingAction)}
        availableSourceIds={sources.filter((source) => source.status === 'available').map((source) => source.id)}
      />
    </section> : null}
  </section>;
}
