const projectActionPattern = /^\/api\/projects\/([^/]+)\/(research|generate|retry|cancel|sources|draft|approve)$/;
const projectPattern = /^\/api\/projects\/([^/]+)$/;

const decodeId = (value) => {
  try { return decodeURIComponent(value); } catch { return null; }
};

export const matchRoute = (method, pathname) => {
  if (method === 'GET' && pathname === '/health/live') return {name: 'health.live'};
  if (method === 'GET' && pathname === '/health/ready') return {name: 'health.ready'};
  if (pathname === '/api/projects') {
    if (method === 'POST') return {name: 'projects.create'};
    if (method === 'GET') return {name: 'projects.list'};
  }

  const action = pathname.match(projectActionPattern);
  if (action) {
    const id = decodeId(action[1]);
    const name = action[2];
    if (!id) return null;
    if (method === 'GET' && name === 'sources') return {name: 'projects.sources', id};
    if (method === 'GET' && name === 'draft') return {name: 'projects.draft.get', id};
    if (method === 'PUT' && name === 'draft') return {name: 'projects.draft.edit', id};
    if (method === 'POST' && ['research', 'generate', 'retry', 'cancel', 'approve'].includes(name)) {
      return {name: name === 'approve' ? 'projects.approve' : `projects.${name}`, id};
    }
    return null;
  }

  const project = pathname.match(projectPattern);
  if (project && method === 'GET') {
    const id = decodeId(project[1]);
    return id ? {name: 'projects.get', id} : null;
  }
  return null;
};
