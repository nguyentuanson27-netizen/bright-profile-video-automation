import {createHash, randomUUID} from 'node:crypto';
import {AppError} from '../../domain/errors.mjs';
import {assertSchema} from '../../domain/schemas.mjs';
import {safeFetchBuffer} from '../../security/safe-fetch.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_EXCERPT_CHARS = 100_000;
const SOURCE_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
];

const canonicalUrl = (value) => new URL(value).href;
const sourceIdFor = (url) => `source-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
const contentHashFor = (body) => createHash('sha256').update(body).digest('hex');
const platformFor = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '') || 'web';

const excerptFrom = (body) => body
  .toString('utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_EXCERPT_CHARS);

const defaultFetchSource = (url) => safeFetchBuffer(url, {
  maxBytes: MAX_SOURCE_BYTES,
  allowedContentTypes: SOURCE_CONTENT_TYPES,
  accept: SOURCE_CONTENT_TYPES.join(', '),
});

const normalizedCandidate = (candidate, sourceType = candidate.sourceType) => ({
  url: canonicalUrl(candidate.url),
  platform: candidate.platform || platformFor(candidate.url),
  ...(candidate.title ? {title: candidate.title} : {}),
  sourceType,
  discoveryStatus: candidate.discoveryStatus || 'discovered',
});

const mergeCandidates = (providerCandidates, operatorUrls) => {
  const byUrl = new Map();
  for (const candidate of providerCandidates) {
    const normalized = normalizedCandidate(candidate);
    byUrl.set(normalized.url, normalized);
  }
  for (const value of operatorUrls) {
    const url = canonicalUrl(value);
    const existing = byUrl.get(url);
    byUrl.set(url, normalizedCandidate({
      url,
      platform: existing?.platform || platformFor(url),
      title: existing?.title,
      discoveryStatus: 'discovered',
      sourceType: 'operator-url',
    }, 'operator-url'));
  }
  return [...byUrl.values()];
};

export function createResearchProjectService({
  repositories,
  projectStateStore,
  researchProvider,
  fetchSource = defaultFetchSource,
  projectIdGenerator = randomUUID,
  jobIdGenerator = randomUUID,
  clock = () => new Date(),
}) {
  if (!repositories?.projects || !repositories?.sources || !projectStateStore) {
    throw new TypeError('research service storage dependencies are required');
  }
  if (!researchProvider || typeof researchProvider.search !== 'function') {
    throw new TypeError('research provider is required');
  }
  if (typeof fetchSource !== 'function') throw new TypeError('fetchSource must be a function');

  return Object.freeze({
    createProject(input) {
      assertSchema('projectInput', input);
      const id = projectIdGenerator();
      return repositories.projects.create({
        id,
        topic: input.topic,
        status: 'draft',
        input: structuredClone(input),
      });
    },

    enqueueResearch(projectId) {
      const project = repositories.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      const job = projectStateStore.enqueueResearch({
        projectId,
        jobId: jobIdGenerator(),
        now: clock(),
        maxAttempts: 3,
      });
      return {project: repositories.projects.get(projectId), job};
    },

    async execute({job}) {
      if (!job || job.stage !== 'researching') {
        throw new AppError('INVALID_RESEARCH_JOB', 'Research job is invalid', {status: 500});
      }
      const project = repositories.projects.get(job.projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});

      const operatorUrls = Array.isArray(project.input.sourceUrls) ? project.input.sourceUrls : [];
      const discovery = await researchProvider.search({topic: project.topic, sourceUrls: operatorUrls});
      const candidates = mergeCandidates(discovery.candidates, operatorUrls);
      const retrievedAt = clock().toISOString();
      const stored = [];

      for (const candidate of candidates) {
        const baseRecord = {
          sourceId: sourceIdFor(candidate.url),
          url: candidate.url,
          platform: candidate.platform,
          ...(candidate.title ? {title: candidate.title} : {}),
          retrievedAt,
          excerpt: '',
          sourceType: candidate.sourceType,
        };

        let record;
        if (candidate.discoveryStatus === 'unavailable') {
          record = {...baseRecord, retrievalStatus: 'unavailable'};
        } else {
          try {
            const response = await fetchSource(candidate.url);
            if (!response || !Buffer.isBuffer(response.body)) {
              throw new AppError('FETCH_RESPONSE_INVALID', 'Remote fetch returned an invalid body', {status: 502});
            }
            if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
              record = {...baseRecord, retrievalStatus: 'unavailable'};
            } else {
              record = {
                ...baseRecord,
                retrievalStatus: 'available',
                excerpt: excerptFrom(response.body),
                contentHash: contentHashFor(response.body),
              };
            }
          } catch {
            record = {...baseRecord, retrievalStatus: 'failed'};
          }
        }

        assertSchema('sourceRecord', record);
        repositories.sources.upsert({projectId: project.id, record});
        stored.push(record);
      }

      projectStateStore.setStatus({projectId: project.id, status: 'research_ready', now: clock()});
      return stored;
    },
  });
}
