import React, {useEffect, useState} from 'react';

const clone = (value) => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const replaceAt = (items, index, next) => items.map((item, itemIndex) => itemIndex === index ? next : item);

export function DraftEditor({draft, onSave, onDirtyChange, pending}) {
  const [working, setWorking] = useState(() => draft ? clone(draft) : null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setWorking(draft ? clone(draft) : null);
    setDirty(false);
  }, [draft]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  if (!working) return <p className="empty-state">Draft is loading…</p>;

  const mutate = (updater) => {
    setWorking(updater);
    setDirty(true);
  };
  const updateClaim = (index, patch) => mutate((current) => ({
    ...current,
    claims: replaceAt(current.claims, index, {...current.claims[index], ...patch}),
  }));
  const updateTimedText = (key, index, text) => mutate((current) => ({
    ...current,
    [key]: replaceAt(current[key], index, {...current[key][index], text}),
  }));
  const updateVoiceover = (index, text) => mutate((current) => ({
    ...current,
    voiceover: {
      ...current.voiceover,
      chunks: replaceAt(current.voiceover.chunks, index, {...current.voiceover.chunks[index], text}),
    },
  }));
  const updateScene = (index, key, value) => mutate((current) => ({
    ...current,
    scenes: replaceAt(current.scenes, index, {...current.scenes[index], [key]: value}),
  }));

  const submit = async (event) => {
    event.preventDefault();
    const sanitized = clone(working);
    for (const claim of sanitized.claims) {
      if (!claim.overrideReason?.trim()) delete claim.overrideReason;
      else claim.overrideReason = claim.overrideReason.trim();
    }
    await onSave(sanitized);
    setDirty(false);
  };

  return <form className="draft-editor" onSubmit={submit}>
    <div className="draft-section">
      <label>
        Profile summary
        <textarea rows={4} value={working.summary} maxLength={20000} disabled={pending}
          onChange={(event) => mutate((current) => ({...current, summary: event.target.value}))} />
      </label>
    </div>

    <fieldset className="draft-section">
      <legend>Claims requiring human review</legend>
      <div className="claim-list">
        {working.claims.length === 0 ? <p className="empty-state small">No claims in this draft.</p> : working.claims.map((claim, index) => <div className="claim-card" key={claim.id}>
          <label>
            Claim
            <textarea rows={2} value={claim.text} maxLength={10000} disabled={pending}
              onChange={(event) => updateClaim(index, {text: event.target.value})} />
          </label>
          <p className="meta-line">Sources: {claim.sourceIds.join(', ') || 'none'}</p>
          <label className="check-line">
            <input type="checkbox" checked={claim.verified} disabled={pending}
              onChange={(event) => updateClaim(index, {verified: event.target.checked})} />
            Human verified
          </label>
          {!claim.verified ? <label>
            Override reason <span className="muted">required if approving an unverified claim</span>
            <input value={claim.overrideReason || ''} maxLength={1000} disabled={pending}
              onChange={(event) => updateClaim(index, {overrideReason: event.target.value})} />
          </label> : null}
        </div>)}
      </div>
    </fieldset>

    <fieldset className="draft-section">
      <legend>Script</legend>
      {working.script.map((item, index) => <label key={item.id} className="timed-row">
        <span>{item.start.toFixed(1)}s · {item.duration.toFixed(1)}s</span>
        <textarea rows={2} value={item.text} maxLength={20000} disabled={pending}
          onChange={(event) => updateTimedText('script', index, event.target.value)} />
      </label>)}
    </fieldset>

    <fieldset className="draft-section">
      <legend>Voiceover</legend>
      {working.voiceover.chunks.map((item, index) => <label key={item.id} className="timed-row">
        <span>{item.start.toFixed(1)}s · {item.duration.toFixed(1)}s</span>
        <textarea rows={2} value={item.text} maxLength={20000} disabled={pending}
          onChange={(event) => updateVoiceover(index, event.target.value)} />
      </label>)}
    </fieldset>

    <fieldset className="draft-section">
      <legend>Scene copy</legend>
      {working.scenes.map((scene, index) => <div className="scene-row" key={scene.id}>
        <div className="scene-heading"><strong>{scene.type}</strong><span>{scene.start.toFixed(1)}s · {scene.duration.toFixed(1)}s</span></div>
        {['chapter', 'subtitle', 'heading', 'quote', 'label', 'source'].filter((key) => key in scene).map((key) => <label key={key}>
          {key}
          <input value={scene[key] || ''} maxLength={key === 'quote' ? 20000 : 10000} disabled={pending}
            onChange={(event) => updateScene(index, key, event.target.value)} />
        </label>)}
      </div>)}
    </fieldset>

    <div className="draft-footer">
      <p className="meta-line">Render: {working.render.duration}s · scale {working.render.renderScale ?? 1} · CRF {working.render.crf ?? 20}</p>
      <button className="button secondary" type="submit" disabled={pending || !dirty}>{pending ? 'Saving…' : dirty ? 'Save review changes' : 'Review changes saved'}</button>
    </div>
  </form>;
}
