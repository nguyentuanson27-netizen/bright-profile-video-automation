import React from 'react';

const evidenceText = (item) => item?.claim ?? item?.text ?? item?.summary ?? 'Evidence record';

export function EvidencePanel({project, sources}) {
  const evidence = project?.research?.evidence ?? [];
  const conflicts = project?.research?.conflicts ?? [];
  return <section className="evidence-grid" aria-label="Research evidence">
    <div className="subpanel">
      <div className="subpanel-heading">
        <h3>Sources</h3>
        <span>{sources.length}</span>
      </div>
      {sources.length === 0 ? <p className="empty-state small">No persisted sources yet.</p> : <ul className="plain-list">
        {sources.map((source) => <li key={source.id}>
          <div className="source-line">
            <span className={`source-state source-${source.status}`}>{source.status}</span>
            <strong>{source.payload?.title || source.title || source.id}</strong>
          </div>
          <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
        </li>)}
      </ul>}
    </div>
    <div className="subpanel">
      <div className="subpanel-heading">
        <h3>Evidence</h3>
        <span>{evidence.length}</span>
      </div>
      {evidence.length === 0 ? <p className="empty-state small">Research evidence will appear here.</p> : <ul className="plain-list">
        {evidence.map((item, index) => <li key={item.id || `${item.sourceId}-${index}`}>
          <p>{evidenceText(item)}</p>
          <span className="meta-line">Source {item.sourceId || 'unknown'} · {item.confidence || 'unrated'}</span>
        </li>)}
      </ul>}
    </div>
    <div className="subpanel conflict-panel">
      <div className="subpanel-heading">
        <h3>Conflicts</h3>
        <span>{conflicts.length}</span>
      </div>
      {conflicts.length === 0 ? <p className="empty-state small">No normalized conflicts reported.</p> : <ul className="plain-list">
        {conflicts.map((item, index) => <li key={item.id || index}>
          <strong>{item.category || item.metric || 'Conflict'}</strong>
          <p>{item.summary || item.claim || item.reason || 'Conflicting evidence requires review.'}</p>
        </li>)}
      </ul>}
    </div>
  </section>;
}
