import React from 'react';

import {statusLabel} from '../state.mjs';

export function ProjectList({projects, selectedId, onSelect, loading}) {
  return <section className="panel project-list-panel" aria-labelledby="projects-title">
    <div className="section-heading compact">
      <div>
        <p className="eyebrow">Workspace</p>
        <h2 id="projects-title">Projects</h2>
      </div>
      <span className="count-badge" aria-label={`${projects.length} projects`}>{projects.length}</span>
    </div>
    {loading && projects.length === 0 ? <p className="empty-state">Loading projects…</p> : null}
    {!loading && projects.length === 0 ? <p className="empty-state">No projects yet. Create one to begin.</p> : null}
    <div className="project-list" role="list">
      {projects.map((project) => <button
        type="button"
        role="listitem"
        key={project.id}
        className={`project-row${project.id === selectedId ? ' selected' : ''}`}
        onClick={() => onSelect(project.id)}
        aria-pressed={project.id === selectedId}
      >
        <span className="project-row-main">
          <strong>{project.creator}</strong>
          <span>{project.topic}</span>
        </span>
        <span className={`status-dot status-${project.status}`}>{statusLabel(project.status)}</span>
      </button>)}
    </div>
  </section>;
}
