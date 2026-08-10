import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  approveRevision,
  checkVideo,
  getProjectStatus,
  getRevision,
  requestRender,
  saveDraft,
  videoUrl,
} from './api.mjs';
import {approvalReadiness, buildApprovalPayload, projectWorkflowActions} from './review-model.mjs';
import './review.css';

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fieldValue = (value) => value ?? '';

function SourceList({sources = []}) {
  return (
    <div className="review-grid review-grid--sources">
      {sources.map((source) => (
        <article className="source-card" key={source.sourceId}>
          <div className="source-card__head">
            <span className={`source-state source-state--${source.retrievalStatus}`}>{source.retrievalStatus}</span>
            <span>{source.platform}</span>
          </div>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>
          {source.excerpt ? <p>{source.excerpt}</p> : <p className="muted">No normalized excerpt available.</p>}
          <code>{source.sourceId}</code>
        </article>
      ))}
    </div>
  );
}

function ClaimsEditor({generation, overrideReasons, onGeneration, onOverride, disabled}) {
  const claims = generation?.claims || [];
  return (
    <div className="review-stack">
      {claims.map((claim, index) => (
        <article className={`claim-card ${claim.status === 'unverified' ? 'claim-card--warning' : ''}`} key={claim.id}>
          <div className="claim-card__head">
            <strong>{claim.status === 'unverified' ? 'Needs verification' : 'Source-grounded'}</strong>
            <code>{claim.id}</code>
          </div>
          <label>
            <span>Claim</span>
            <textarea
              value={claim.text}
              disabled={disabled}
              rows={2}
              onChange={(event) => {
                const claimsNext = structuredClone(claims);
                claimsNext[index].text = event.target.value;
                onGeneration({...generation, claims: claimsNext});
              }}
            />
          </label>
          <p className="claim-sources">
            Sources: {claim.sourceIds?.length ? claim.sourceIds.join(', ') : 'none supplied'}
          </p>
          {claim.status === 'unverified' ? (
            <label>
              <span>Operator verification reason <small>required before approval</small></span>
              <textarea
                value={overrideReasons[claim.id] || ''}
                disabled={disabled}
                rows={2}
                maxLength={5000}
                onChange={(event) => onOverride(claim.id, event.target.value)}
                placeholder="Describe what you checked and why this claim is acceptable."
              />
            </label>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function VoiceEditor({generation, onGeneration, disabled}) {
  const chunks = generation?.voiceover?.chunks || [];
  const update = (index, key, value) => {
    const next = structuredClone(generation);
    next.voiceover = next.voiceover || {chunks: []};
    next.voiceover.chunks[index][key] = key === 'text' ? value : numberValue(value);
    onGeneration(next);
  };
  return (
    <div className="review-stack">
      {chunks.map((chunk, index) => (
        <div className="voice-row" key={chunk.id}>
          <div className="voice-row__timing">
            <label><span>Start</span><input type="number" min="0" step="0.1" disabled={disabled} value={chunk.start} onChange={(event) => update(index, 'start', event.target.value)} /></label>
            <label><span>Duration</span><input type="number" min="0.1" step="0.1" disabled={disabled} value={chunk.duration} onChange={(event) => update(index, 'duration', event.target.value)} /></label>
          </div>
          <label>
            <span>Voice text</span>
            <textarea disabled={disabled} rows={2} value={chunk.text} onChange={(event) => update(index, 'text', event.target.value)} />
          </label>
        </div>
      ))}
    </div>
  );
}

const SCENE_TEXT_FIELDS = ['chapter', 'heading', 'subtitle', 'source', 'label', 'quote', 'mediaUrl'];

function SceneEditor({scene, index, generation, onGeneration, disabled}) {
  const project = generation.project;
  const update = (key, value) => {
    const next = structuredClone(generation);
    next.project.scenes[index][key] = ['start', 'duration'].includes(key) ? numberValue(value) : value;
    onGeneration(next);
  };
  const updateWords = (value) => update('words', value.split(/\r?\n/).map((word) => word.trim()).filter(Boolean));
  const updateStat = (statIndex, key, value) => {
    const next = structuredClone(generation);
    next.project.scenes[index].stats[statIndex][key] = value;
    onGeneration(next);
  };

  return (
    <article className="scene-card">
      <div className="scene-card__head">
        <div><span className="eyebrow">Scene {index + 1}</span><h4>{scene.type}</h4></div>
        <code>{scene.id}</code>
      </div>
      <div className="field-pair">
        <label><span>Start</span><input type="number" min="0" step="0.1" disabled={disabled} value={scene.start} onChange={(event) => update('start', event.target.value)} /></label>
        <label><span>Duration</span><input type="number" min="0.1" step="0.1" disabled={disabled} value={scene.duration} onChange={(event) => update('duration', event.target.value)} /></label>
      </div>
      {SCENE_TEXT_FIELDS.filter((field) => Object.hasOwn(scene, field)).map((field) => (
        <label key={field}>
          <span>{field}</span>
          <input disabled={disabled} value={fieldValue(scene[field])} onChange={(event) => update(field, event.target.value)} />
        </label>
      ))}
      {Array.isArray(scene.words) ? (
        <label>
          <span>Words <small>one line per beat</small></span>
          <textarea disabled={disabled} rows={Math.max(3, scene.words.length)} value={scene.words.join('\n')} onChange={(event) => updateWords(event.target.value)} />
        </label>
      ) : null}
      {Array.isArray(scene.stats) ? (
        <div className="stats-editor">
          {scene.stats.map((statItem, statIndex) => (
            <div className="field-pair" key={`${scene.id}-stat-${statIndex}`}>
              <label><span>Stat value</span><input disabled={disabled} value={statItem.value} onChange={(event) => updateStat(statIndex, 'value', event.target.value)} /></label>
              <label><span>Stat label</span><input disabled={disabled} value={statItem.label} onChange={(event) => updateStat(statIndex, 'label', event.target.value)} /></label>
            </div>
          ))}
        </div>
      ) : null}
      <p className="muted">Scene type and provenance IDs are fixed by the generated contract.</p>
      <input type="hidden" value={project.creatorName || ''} readOnly />
    </article>
  );
}

function ProjectEditor({generation, onGeneration, disabled}) {
  const project = generation.project || {scenes: []};
  const updateProject = (key, value) => {
    const next = structuredClone(generation);
    next.project[key] = ['duration', 'renderScale', 'crf'].includes(key) ? numberValue(value) : value;
    onGeneration(next);
  };
  return (
    <div className="review-stack">
      <div className="field-pair">
        <label><span>Creator name</span><input disabled={disabled} value={fieldValue(project.creatorName)} onChange={(event) => updateProject('creatorName', event.target.value)} /></label>
        <label><span>Total duration</span><input type="number" min="1" step="0.1" disabled={disabled} value={project.duration} onChange={(event) => updateProject('duration', event.target.value)} /></label>
      </div>
      {Object.hasOwn(project, 'heroImage') ? (
        <label><span>Hero media reference</span><input disabled={disabled} value={fieldValue(project.heroImage)} onChange={(event) => updateProject('heroImage', event.target.value)} /></label>
      ) : null}
      <div className="field-pair">
        {Object.hasOwn(project, 'renderScale') ? <label><span>Render scale</span><input type="number" min="0.25" max="2" step="0.05" disabled={disabled} value={project.renderScale} onChange={(event) => updateProject('renderScale', event.target.value)} /></label> : <span />}
        {Object.hasOwn(project, 'crf') ? <label><span>CRF</span><input type="number" min="16" max="35" step="1" disabled={disabled} value={project.crf} onChange={(event) => updateProject('crf', event.target.value)} /></label> : <span />}
      </div>
      <div className="scene-list">
        {(project.scenes || []).map((scene, index) => (
          <SceneEditor key={scene.id} scene={scene} index={index} generation={generation} onGeneration={onGeneration} disabled={disabled} />
        ))}
      </div>
    </div>
  );
}

export function ReviewWorkspace({projectId, onClose, onChanged}) {
  const [statusModel, setStatusModel] = useState(null);
  const [revision, setRevision] = useState(null);
  const [generation, setGeneration] = useState(null);
  const [overrideReasons, setOverrideReasons] = useState({});
  const [approvedBy, setApprovedBy] = useState('operator');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [videoState, setVideoState] = useState('unknown');

  const load = useCallback(async ({quiet = false} = {}) => {
    if (!quiet) setError('');
    try {
      const status = await getProjectStatus(projectId);
      setStatusModel(status);
      if (status.latestRevision) {
        const fullRevision = await getRevision(projectId, status.latestRevision.revisionId);
        setRevision((current) => {
          if (dirty && current?.revisionId === fullRevision.revisionId) return current;
          return fullRevision;
        });
        if (!dirty || revision?.revisionId !== fullRevision.revisionId) {
          setGeneration(structuredClone(fullRevision.payload.generation));
        }
      } else {
        setRevision(null);
        setGeneration(null);
      }
      if (status.project.status === 'completed') {
        const checked = await checkVideo(projectId);
        setVideoState(checked.state);
      } else {
        setVideoState('unknown');
      }
      return status;
    } catch (loadError) {
      setError(loadError.message);
      return null;
    }
  }, [dirty, projectId, revision?.revisionId]);

  useEffect(() => {
    load();
  }, [load]);

  const pending = statusModel && ['media_ingest', 'tts', 'render_queued', 'rendering'].includes(statusModel.project.status);
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => load({quiet: true}), 3000);
    return () => clearInterval(timer);
  }, [load, pending]);

  const actions = useMemo(() => statusModel ? projectWorkflowActions({
    project: statusModel.project,
    latestRevision: statusModel.latestRevision,
    videoState,
  }) : {canEdit: false, canApprove: false, canRender: false, canDownload: false}, [statusModel, videoState]);
  const readiness = useMemo(() => approvalReadiness(generation, overrideReasons), [generation, overrideReasons]);

  const changeGeneration = (next) => {
    setGeneration(next);
    setDirty(true);
  };

  const save = async () => {
    if (!revision || !generation) return;
    setBusy('save');
    setError('');
    try {
      const saved = await saveDraft(projectId, {revisionId: revision.revisionId, generation});
      setRevision(saved);
      setGeneration(structuredClone(saved.payload.generation));
      setDirty(false);
      await load({quiet: true});
      await onChanged?.();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy('');
    }
  };

  const approve = async () => {
    if (!revision || !generation) return;
    setBusy('approve');
    setError('');
    try {
      const payload = buildApprovalPayload({revisionId: revision.revisionId, approvedBy, generation, overrideReasons});
      const approved = await approveRevision(projectId, payload);
      setRevision(approved);
      setGeneration(structuredClone(approved.payload.generation));
      setDirty(false);
      await load({quiet: true});
      await onChanged?.();
    } catch (approveError) {
      setError(approveError.message);
    } finally {
      setBusy('');
    }
  };

  const render = async () => {
    if (!revision) return;
    setBusy('render');
    setError('');
    try {
      await requestRender(projectId, revision.revisionId);
      await load({quiet: true});
      await onChanged?.();
    } catch (renderError) {
      setError(renderError.message);
    } finally {
      setBusy('');
    }
  };

  if (!statusModel) {
    return (
      <section className="review-shell" aria-live="polite">
        <div className="review-shell__bar"><button className="secondary" type="button" onClick={onClose}>Close</button></div>
        {error ? <p className="message message--error" role="alert">{error}</p> : <p className="empty">Loading review workspace…</p>}
      </section>
    );
  }

  const disabled = !actions.canEdit || busy !== '';
  const sources = revision?.payload?.sources || [];
  return (
    <section className="review-shell" aria-labelledby="review-title">
      <header className="review-shell__bar">
        <div>
          <p className="eyebrow">Human checkpoint</p>
          <h2 id="review-title">{statusModel.project.topic}</h2>
          <p className="review-subtitle">Revision {revision?.revisionId || 'not generated yet'} · {statusModel.project.status}</p>
        </div>
        <button className="secondary" type="button" onClick={onClose}>Close review</button>
      </header>

      {error ? <p className="message message--error" role="alert">{error}</p> : null}
      {!revision || !generation ? (
        <div className="empty-state"><p className="eyebrow">Pipeline running</p><h3>No review revision yet.</h3><p>The durable worker will surface the generated draft here when research and generation finish.</p></div>
      ) : (
        <>
          <nav className="review-index" aria-label="Review sections">
            <a href="#review-sources">Sources</a><a href="#review-claims">Claims</a><a href="#review-script">Script</a><a href="#review-voice">Voice</a><a href="#review-scenes">Scenes</a>
          </nav>

          <section className="review-section" id="review-sources">
            <div className="review-section__title"><div><p className="eyebrow">Evidence</p><h3>Public sources</h3></div><span>{sources.length} records</span></div>
            <SourceList sources={sources} />
          </section>

          <section className="review-section" id="review-claims">
            <div className="review-section__title"><div><p className="eyebrow">Facts</p><h3>Claims & verification</h3></div><span>{readiness.ready ? 'Approval-ready' : `${readiness.missingClaimIds.length} need reason`}</span></div>
            <ClaimsEditor generation={generation} overrideReasons={overrideReasons} onGeneration={changeGeneration} onOverride={(claimId, value) => setOverrideReasons((current) => ({...current, [claimId]: value}))} disabled={disabled} />
          </section>

          <section className="review-section" id="review-script">
            <div className="review-section__title"><div><p className="eyebrow">Narrative</p><h3>Summary & script</h3></div></div>
            <label><span>Research summary</span><textarea rows={5} disabled={disabled} value={generation.researchSummary} onChange={(event) => changeGeneration({...generation, researchSummary: event.target.value})} /></label>
            <label><span>Script</span><textarea rows={9} disabled={disabled} value={generation.script} onChange={(event) => changeGeneration({...generation, script: event.target.value})} /></label>
          </section>

          <section className="review-section" id="review-voice">
            <div className="review-section__title"><div><p className="eyebrow">Audio plan</p><h3>Voiceover timeline</h3></div></div>
            <VoiceEditor generation={generation} onGeneration={changeGeneration} disabled={disabled} />
          </section>

          <section className="review-section" id="review-scenes">
            <div className="review-section__title"><div><p className="eyebrow">Visual plan</p><h3>Scenes & media</h3></div><span>{generation.project?.scenes?.length || 0} scenes</span></div>
            <ProjectEditor generation={generation} onGeneration={changeGeneration} disabled={disabled} />
          </section>

          <footer className="review-actions">
            <div className="review-actions__state">
              {dirty ? <strong>Unsaved changes</strong> : <span>No unsaved changes</span>}
              {statusModel.latestJob ? <small>Latest job: {statusModel.latestJob.stage} · {statusModel.latestJob.status}</small> : null}
            </div>
            <div className="review-actions__buttons">
              {actions.canEdit ? <button className="secondary" type="button" onClick={save} disabled={!dirty || busy !== ''}>{busy === 'save' ? 'Saving…' : revision.status === 'approved' ? 'Save as new draft' : 'Save draft'}</button> : null}
              {actions.canApprove ? (
                <div className="approve-cluster">
                  <input aria-label="Approver name" value={approvedBy} disabled={busy !== ''} onChange={(event) => setApprovedBy(event.target.value)} placeholder="Approver" />
                  <button className="primary primary--compact" type="button" onClick={approve} disabled={dirty || !readiness.ready || !approvedBy.trim() || busy !== ''}>{busy === 'approve' ? 'Approving…' : 'Approve revision'}</button>
                </div>
              ) : null}
              {actions.canRender ? <button className="primary primary--compact" type="button" onClick={render} disabled={dirty || busy !== ''}>{busy === 'render' ? 'Queueing…' : 'Render approved video'}</button> : null}
              {actions.canDownload ? <a className="download-link" href={videoUrl(projectId)} download>Download MP4</a> : null}
              {statusModel.project.status === 'completed' && videoState === 'error' ? <span className="message message--error">Completed output failed validation. Rendering/download is blocked.</span> : null}
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
