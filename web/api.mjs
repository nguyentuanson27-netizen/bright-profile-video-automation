const jsonRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed with status ${response.status}`);
    error.code = body?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return body;
};

const projectPath = (id, suffix = '') => `/api/projects/${encodeURIComponent(id)}${suffix}`;

export const api = Object.freeze({
  listProjects: async () => (await jsonRequest('/api/projects')).projects,
  createProject: async (input) => (await jsonRequest('/api/projects', {method: 'POST', body: JSON.stringify(input)})).project,
  getProject: async (id) => (await jsonRequest(projectPath(id))).project,
  getSources: async (id) => (await jsonRequest(projectPath(id, '/sources'))).sources,
  getDraft: async (id) => jsonRequest(projectPath(id, '/draft')),
  editDraft: async (id, draft) => jsonRequest(projectPath(id, '/draft'), {method: 'PUT', body: JSON.stringify({draft})}),
  research: async (id) => jsonRequest(projectPath(id, '/research'), {method: 'POST'}),
  generate: async (id) => jsonRequest(projectPath(id, '/generate'), {method: 'POST'}),
  approve: async (id) => jsonRequest(projectPath(id, '/approve'), {method: 'POST'}),
  render: async (id) => jsonRequest(projectPath(id, '/render'), {method: 'POST'}),
  retry: async (id) => jsonRequest(projectPath(id, '/retry'), {method: 'POST'}),
  cancel: async (id) => jsonRequest(projectPath(id, '/cancel'), {method: 'POST'}),
  outputUrl: (id) => projectPath(id, '/artifacts/output'),
});
