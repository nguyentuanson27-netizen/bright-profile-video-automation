import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {assertSafePublicUrl} from '../../security/url-policy.mjs';

const MAX_CREATOR_LENGTH = 200;
const MAX_TOPIC_LENGTH = 2000;
const MAX_INSTRUCTIONS_LENGTH = 4000;
const MAX_PUBLIC_URLS = 20;

const invalidRequest = (message) => new AppError('INVALID_REQUEST', message, {status: 400});
const projectNotFound = () => new AppError('PROJECT_NOT_FOUND', 'Project not found', {status: 404});

const text = (value, name, max, {required = false} = {}) => {
  if (value === undefined || value === null) {
    if (required) throw invalidRequest(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw invalidRequest(`${name} must be a string`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) throw invalidRequest(`${name} is invalid`);
  return normalized;
};

const validateCreate = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest('JSON object body is required');
  const creator = text(value.creator, 'creator', MAX_CREATOR_LENGTH, {required: true});
  const topic = text(value.topic, 'topic', MAX_TOPIC_LENGTH, {required: true});
  const instructions = text(value.instructions, 'instructions', MAX_INSTRUCTIONS_LENGTH);
  const rawUrls = value.publicUrls ?? [];
  if (!Array.isArray(rawUrls) || rawUrls.length > MAX_PUBLIC_URLS) {
    throw invalidRequest(`publicUrls must contain at most ${MAX_PUBLIC_URLS} entries`);
  }
  const publicUrls = [];
  const seen = new Set();
  for (const entry of rawUrls) {
    if (typeof entry !== 'string') throw invalidRequest('publicUrls entries must be strings');
    let url;
    try {
      url = assertSafePublicUrl(entry).href;
    } catch {
      throw invalidRequest('publicUrls entries must be public HTTP(S) URLs');
    }
    if (!seen.has(url)) {
      seen.add(url);
      publicUrls.push(url);
    }
  }
  return {creator, topic, instructions, publicUrls};
};

const generatedId = (factory, name) => {
  const value = factory();
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError(`${name} must return a non-empty bounded string`);
  }
  return value;
};

export const createProjectsApi = ({
  repos,
  jobs,
  now = Date.now,
  nowMs = Date.now,
  projectIdFactory,
  stageIdFactory,
  sourceIdFactory,
  researchMaxAttempts = 4,
} = {}) => {
  if (!repos?.projects || !repos?.sources) throw new TypeError('repositories are required');
  if (!jobs || typeof jobs.startResearch !== 'function') throw new TypeError('jobs store is required');
  for (const [factory, name] of [
    [projectIdFactory, 'projectIdFactory'],
    [stageIdFactory, 'stageIdFactory'],
    [sourceIdFactory, 'sourceIdFactory'],
  ]) {
    if (typeof factory !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!Number.isSafeInteger(researchMaxAttempts) || researchMaxAttempts < 1 || researchMaxAttempts > 100) {
    throw new TypeError('researchMaxAttempts must be an integer between 1 and 100');
  }

  const requireProject = (id) => {
    const project = repos.projects.get(id);
    if (!project) throw projectNotFound();
    return project;
  };

  return Object.freeze({
    create(body) {
      const input = validateCreate(body);
      const projectId = generatedId(projectIdFactory, 'projectIdFactory');
      const timestamp = new Date(now()).toISOString();
      const sources = input.publicUrls.map((url) => ({
        id: generatedId(sourceIdFactory, 'sourceIdFactory'),
        projectId,
        url,
        status: 'pending',
        payload: {operatorInput: true},
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      return repos.projects.createWithSources({
        id: projectId,
        creator: input.creator,
        topic: input.topic,
        instructions: input.instructions,
        status: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
      }, sources);
    },

    list() {
      return repos.projects.list();
    },

    get(id) {
      return requireProject(id);
    },

    sources(id) {
      requireProject(id);
      return repos.sources.list(id);
    },

    startResearch(id) {
      requireProject(id);
      const started = jobs.startResearch({
        projectId: id,
        stageId: generatedId(stageIdFactory, 'stageIdFactory'),
        nowMs: nowMs(),
        maxAttempts: researchMaxAttempts,
      });
      return {changed: started.changed, project: requireProject(id), stage: started.stage};
    },

    retry(id) {
      requireProject(id);
      const stage = jobs.getCurrentStage(id);
      if (!stage) throw new AppError(ErrorCodes.STAGE_NOT_RETRYABLE, 'Stage is not retryable');
      const result = jobs.retry({stageId: stage.id, nowMs: nowMs()});
      return {changed: result.changed, project: requireProject(id), stage: result.stage};
    },

    cancel(id) {
      requireProject(id);
      const stage = jobs.getCurrentStage(id);
      if (!stage) throw new AppError(ErrorCodes.STAGE_NOT_ACTIVE, 'Stage is not active');
      const result = jobs.cancel({stageId: stage.id, nowMs: nowMs()});
      return {changed: result.changed, project: requireProject(id), stage: result.stage};
    },
  });
};
