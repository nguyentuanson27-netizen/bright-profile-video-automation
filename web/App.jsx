import React, {useCallback, useEffect, useMemo, useState} from 'react';

import {api} from './api.mjs';
import {CreateProjectForm} from './components/CreateProjectForm.jsx';
import {ProjectList} from './components/ProjectList.jsx';
import {ProjectWorkspace} from './components/ProjectWorkspace.jsx';
import {shouldPollProject} from './state.mjs';

const actionCalls = {
  research: api.research,
  generate: api.generate,
  approve: api.approve,
  render: api.render,
  retry: api.retry,
  cancel: api.cancel,
};

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [project, setProject] = useState(null);
  const [sources, setSources] = useState([]);
  const [draft, setDraft] = useState(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [pendingAction, setPendingAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshList = useCallback(async () => {
    const next = await api.listProjects();
    setProjects(next);
    setSelectedId((current) => current ?? next[0]?.id ?? null);
    return next;
  }, []);

  const refreshProject = useCallback(async (id) => {
    if (!id) {
      setProject(null);
      setSources([]);
      setDraft(null);
      return;
    }
    const nextProject = await api.getProject(id);
    setProject(nextProject);
    const nextSources = await api.getSources(id);
    setSources(nextSources);
    if (nextProject.status === 'review_required') {
      setDraft(await api.getDraft(id));
    } else {
      setDraft(null);
    }
  }, []);

  const refreshAll = useCallback(async (id = selectedId) => {
    await Promise.all([refreshList(), refreshProject(id)]);
  }, [refreshList, refreshProject, selectedId]);

  useEffect(() => {
    let active = true;
    refreshList()
      .catch((nextError) => active && setError(nextError.message))
      .finally(() => active && setLoadingProjects(false));
    return () => { active = false; };
  }, [refreshList]);

  useEffect(() => {
    let active = true;
    if (!selectedId) {
      setProject(null);
      return () => { active = false; };
    }
    setError('');
    refreshProject(selectedId).catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [selectedId, refreshProject]);

  useEffect(() => {
    if (!project || !shouldPollProject(project.status)) return undefined;
    const timer = setInterval(() => {
      refreshAll(project.id).catch((nextError) => setError(nextError.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [project, refreshAll]);

  const createProject = async (input) => {
    setPendingAction('create');
    setError('');
    setNotice('');
    try {
      const created = await api.createProject(input);
      await refreshList();
      setSelectedId(created.id);
      setNotice('Project created. Start research when the inputs are ready.');
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    } finally {
      setPendingAction('');
    }
  };

  const runAction = async (action) => {
    if (!project || !actionCalls[action]) return;
    setPendingAction(action);
    setError('');
    setNotice('');
    try {
      await actionCalls[action](project.id);
      await refreshAll(project.id);
      setNotice(`${action[0].toUpperCase()}${action.slice(1)} accepted by the durable workflow.`);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setPendingAction('');
    }
  };

  const saveDraft = async (nextDraft) => {
    if (!project) return;
    setPendingAction('save');
    setError('');
    setNotice('');
    try {
      await api.editDraft(project.id, nextDraft);
      await refreshAll(project.id);
      setNotice('Structured review changes saved.');
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    } finally {
      setPendingAction('');
    }
  };

  const selectedSummary = useMemo(() => project ? `${project.creator} · ${project.topic}` : 'No project selected', [project]);

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#main" aria-label="Bright Profile home">
        <span className="brand-mark">BP</span>
        <span><strong>Bright Profile</strong><small>Creator video automation</small></span>
      </a>
      <div className="topbar-status" aria-label="Current selection">
        <span className="signal-dot" aria-hidden="true" />
        <span>{selectedSummary}</span>
      </div>
    </header>

    <main id="main" className="page-grid">
      <aside className="left-rail">
        <CreateProjectForm onCreate={createProject} pending={pendingAction === 'create'} />
        <ProjectList
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loadingProjects}
        />
      </aside>
      <div className="main-column">
        {error ? <div className="global-message error" role="alert"><strong>Action failed</strong><span>{error}</span></div> : null}
        {notice ? <div className="global-message success" role="status" aria-live="polite"><strong>Updated</strong><span>{notice}</span></div> : null}
        <ProjectWorkspace
          project={project}
          sources={sources}
          draft={draft}
          pendingAction={pendingAction}
          onAction={runAction}
          onSaveDraft={saveDraft}
        />
      </div>
    </main>
  </div>;
}
