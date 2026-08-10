export const apiJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
};

export const listProjects = () => apiJson('/api/projects');
export const getProjectStatus = (projectId) => apiJson(`/api/projects/${encodeURIComponent(projectId)}/status`);
export const getRevision = (projectId, revisionId) => apiJson(
  `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
);
export const saveDraft = (projectId, {revisionId, generation}) => apiJson(
  `/api/projects/${encodeURIComponent(projectId)}/draft`,
  {method: 'PATCH', body: JSON.stringify({revisionId, generation})},
);
export const approveRevision = (projectId, payload) => apiJson(
  `/api/projects/${encodeURIComponent(projectId)}/approve`,
  {method: 'POST', body: JSON.stringify(payload)},
);
export const requestRender = (projectId, revisionId) => apiJson(
  `/api/projects/${encodeURIComponent(projectId)}/render`,
  {method: 'POST', body: JSON.stringify({revisionId})},
);
export const videoUrl = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/video`;

export async function checkVideo(projectId) {
  const response = await fetch(videoUrl(projectId), {method: 'HEAD', cache: 'no-store'});
  return response.ok
    ? {state: 'ready', status: response.status}
    : {state: 'error', status: response.status};
}
