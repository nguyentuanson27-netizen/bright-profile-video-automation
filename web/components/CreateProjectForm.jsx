import React, {useState} from 'react';

import {normalizePublicUrls} from '../state.mjs';

export function CreateProjectForm({onCreate, pending}) {
  const [creator, setCreator] = useState('');
  const [topic, setTopic] = useState('');
  const [instructions, setInstructions] = useState('');
  const [publicUrls, setPublicUrls] = useState('');
  const [validationError, setValidationError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setValidationError('');
    try {
      const urls = normalizePublicUrls(publicUrls);
      await onCreate({
        creator: creator.trim(),
        topic: topic.trim(),
        instructions: instructions.trim(),
        ...(urls.length ? {publicUrls: urls} : {}),
      });
      setCreator('');
      setTopic('');
      setInstructions('');
      setPublicUrls('');
    } catch (error) {
      setValidationError(error.message || 'Could not create project');
    }
  };

  return <section className="panel create-panel" aria-labelledby="create-project-title">
    <div className="section-heading">
      <div>
        <p className="eyebrow">New profile</p>
        <h2 id="create-project-title">Start a creator video</h2>
      </div>
      <span className="step-chip">01</span>
    </div>
    <form onSubmit={submit} className="stack-form">
      <label>
        Creator name
        <input value={creator} onChange={(event) => setCreator(event.target.value)} required maxLength={1000} disabled={pending} />
      </label>
      <label>
        Topic
        <input value={topic} onChange={(event) => setTopic(event.target.value)} required maxLength={1000} disabled={pending} placeholder="Career, product launch, founder story…" />
      </label>
      <label>
        Direction <span className="muted">optional</span>
        <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={10000} rows={3} disabled={pending} placeholder="Tone, audience, must-cover details" />
      </label>
      <label>
        Public source URLs <span className="muted">one per line, max 20</span>
        <textarea value={publicUrls} onChange={(event) => setPublicUrls(event.target.value)} rows={4} disabled={pending} spellCheck={false} placeholder="https://…" />
      </label>
      {validationError ? <p className="inline-error" role="alert">{validationError}</p> : null}
      <button className="button primary" type="submit" disabled={pending || !creator.trim() || !topic.trim()}>
        {pending ? 'Creating…' : 'Create project'}
      </button>
    </form>
  </section>;
}
