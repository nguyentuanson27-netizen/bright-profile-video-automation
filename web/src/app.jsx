import {useCallback, useEffect, useMemo, useState} from 'react';
import {apiJson, listProjects} from './api.mjs';
import {createProjectPayload, projectStatusView} from './model.mjs';
import {ReviewWorkspace} from './review.jsx';

const isPendingEntry = (entry) => projectStatusView(entry).pending;

function StatusBadge({entry}) {
  const view = projectStatusView(entry);
  return <span className={`status status--${view.tone}`}>{view.label}</span>;
}

function ProjectCard({entry, onOpen}) {
  const view = projectStatusView(entry);
  const {project, latestJob, latestRevision} = entry;
  return (
    <article className="project-card" aria-labelledby={`project-${project.id}`}>
      <div className="project-card__head">
        <div>
          <p className="eyebrow">Creator profile</p>
          <h3 id={`project-${project.id}`}>{project.topic}</h3>
        </div>
        <StatusBadge entry={entry} />
      </div>

      <div className="project-meta">
        <span>{view.sourceText}</span>
        {latestJob ? <span>Job: {latestJob.stage} · {latestJob.status}</span> : <span>No job yet</span>}
        {latestRevision ? <span>Revision: {latestRevision.status}</span> : null}
      </div>

      {view.error ? <p className="message message--error" role="alert">{view.error}</p> : null}
      {view.needsReview ? <p className="message message--review">Human review is required before render.</p> : null}
      {view.pending ? <div className="activity" aria-label="Background work in progress"><span /></div> : null}
      <button className="secondary project-open" type="button" onClick={() => onOpen(project.id)}>
        {view.needsReview ? 'Review draft' : project.status === 'completed' ? 'Open output' : 'Open project'}
      </button>
    </article>
  );
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [topic, setTopic] = useState('');
  const [sourceUrlsText, setSourceUrlsText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(null);

  const loadProjects = useCallback(async ({quiet = false} = {}) => {
    if (!quiet) setLoading(true);
    try {
      const body = await listProjects();
      setProjects(Array.isArray(body.projects) ? body.projects : []);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const hasPending = useMemo(() => projects.some(isPendingEntry), [projects]);
  useEffect(() => {
    if (!hasPending) return undefined;
    const timer = setInterval(() => loadProjects({quiet: true}), 3000);
    return () => clearInterval(timer);
  }, [hasPending, loadProjects]);

  const submit = async (event) => {
    event.preventDefault();
    setCreateError('');
    const payload = createProjectPayload({topic, sourceUrlsText, instructions});
    if (!payload.topic) {
      setCreateError('Creator name or topic is required.');
      return;
    }
    setCreating(true);
    try {
      const created = await apiJson('/api/projects', {method: 'POST', body: JSON.stringify(payload)});
      setTopic('');
      setSourceUrlsText('');
      setInstructions('');
      setSelectedProjectId(created.project?.id || null);
      await loadProjects({quiet: true});
    } catch (error) {
      setCreateError(error.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="brand-mark">BRIGHT / PROFILE</p>
          <h1>Creator intelligence to video.</h1>
          <p className="lede">
            Enter a creator or topic. Bright researches public sources, builds a source-grounded draft,
            and stops for human review before voiceover and rendering.
          </p>
        </div>
        <div className="system-pill" aria-label="Application mode">
          <span className="system-pill__dot" /> Internal operator
        </div>
      </header>

      <section className="workspace" aria-label="Creator video workspace">
        <form className="composer" onSubmit={submit}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">New profile</p>
              <h2>Start with a creator</h2>
            </div>
            <span className="step">01</span>
          </div>

          <label>
            <span>Creator name or topic</span>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. Emma Chamberlain" autoComplete="off" required maxLength={500} />
          </label>

          <label>
            <span>Public URLs <small>optional, one per line</small></span>
            <textarea value={sourceUrlsText} onChange={(event) => setSourceUrlsText(event.target.value)} placeholder={'https://youtube.com/...\nhttps://www.tiktok.com/...\nhttps://x.com/...'} rows={4} />
          </label>

          <label>
            <span>Research direction <small>optional</small></span>
            <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Focus on career milestones, audience growth, and notable public moments." rows={3} maxLength={5000} />
          </label>

          {createError ? <p className="message message--error" role="alert">{createError}</p> : null}
          <button className="primary" type="submit" disabled={creating}>{creating ? 'Starting research…' : 'Research creator'}</button>
          <p className="form-note">Creation queues research immediately; closing this tab does not stop the durable worker.</p>
        </form>

        <section className="projects" aria-labelledby="projects-title">
          <div className="section-heading">
            <div><p className="eyebrow">Pipeline</p><h2 id="projects-title">Recent projects</h2></div>
            <button className="secondary" type="button" onClick={() => loadProjects()} disabled={loading}>Refresh</button>
          </div>

          <div aria-live="polite" aria-busy={loading}>
            {loadError ? <p className="message message--error" role="alert">{loadError}</p> : null}
            {loading && projects.length === 0 ? <p className="empty">Loading projects…</p> : null}
            {!loading && !loadError && projects.length === 0 ? (
              <div className="empty-state"><p className="eyebrow">Nothing queued</p><h3>Your first creator profile starts here.</h3><p>Add a topic on the left; the app will continue research and generation in the background.</p></div>
            ) : null}
            <div className="project-list">
              {projects.map((entry) => <ProjectCard key={entry.project.id} entry={entry} onOpen={setSelectedProjectId} />)}
            </div>
          </div>
        </section>
      </section>

      {selectedProjectId ? (
        <ReviewWorkspace projectId={selectedProjectId} onClose={() => setSelectedProjectId(null)} onChanged={() => loadProjects({quiet: true})} />
      ) : null}
    </main>
  );
}
