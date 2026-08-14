import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';
import {createSafeFetcher} from '../../security/safe-fetch.mjs';
import {assertSafePublicUrl} from '../../security/url-policy.mjs';
import {
  ResearchProviderError,
  ResearchProviderErrorCodes,
  assertResearchProvider,
  validateResearchProviderResult,
} from '../../providers/research/index.mjs';

const DEFAULT_FETCH_OPTIONS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 1024 * 1024,
  maxRedirects: 5,
  allowedMimeTypes: ['text/html', 'text/plain', 'application/json', 'application/xhtml+xml'],
});
const MAX_PUBLIC_URLS = 20;
const MAX_CREATOR_LENGTH = 200;
const MAX_TOPIC_LENGTH = 2000;
const MAX_INSTRUCTIONS_LENGTH = 4000;

const cleanText = (value, name, max, {required = false} = {}) => {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw new TypeError(`${name} is outside the supported length`);
  }
  return normalized;
};

const validateInput = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('research input must be an object');
  const creator = cleanText(value.creator, 'creator', MAX_CREATOR_LENGTH, {required: true});
  const topic = cleanText(value.topic, 'topic', MAX_TOPIC_LENGTH, {required: true});
  const instructions = cleanText(value.instructions, 'instructions', MAX_INSTRUCTIONS_LENGTH);
  const rawUrls = value.publicUrls ?? [];
  if (!Array.isArray(rawUrls) || rawUrls.length > MAX_PUBLIC_URLS) {
    throw new TypeError(`publicUrls must contain at most ${MAX_PUBLIC_URLS} entries`);
  }
  const publicUrls = rawUrls.map((entry) => {
    if (typeof entry !== 'string') throw new TypeError('publicUrls entries must be strings');
    return assertSafePublicUrl(entry).href;
  });
  return {creator, topic, instructions, publicUrls};
};

const safeFailureCode = (error) => {
  const code = error?.errorCode ?? error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,128}$/.test(code)
    ? code
    : 'SOURCE_UNAVAILABLE';
};

const defaultFetchSource = (fetcher, fetchOptions) => async (url) => {
  const response = await fetcher.fetchBuffer(url, fetchOptions);
  return {
    requestedUrl: url,
    url: response.url,
    mimeType: response.mimeType,
    content: response.body.toString('utf8'),
  };
};

const sourceFromCandidate = (item) => ({
  url: item.url,
  ...(item.title ? {title: item.title} : {}),
  ...(item.publisher ? {publisher: item.publisher} : {}),
  ...(item.author ? {author: item.author} : {}),
  ...(item.publishedAt ? {publishedAt: item.publishedAt} : {}),
  ...(item.sourceType ? {sourceType: item.sourceType} : {}),
  ...(item.sourceRelationship ? {sourceRelationship: item.sourceRelationship} : {}),
});

const sourceScore = (source) => [
  source.title,
  source.publisher,
  source.author,
  source.publishedAt,
  source.sourceType,
  source.sourceRelationship,
].filter(Boolean).length;

const requestedUrlsOf = (source) => Array.isArray(source?.requestedUrls)
  ? source.requestedUrls.filter((value) => typeof value === 'string')
  : [];

const mergeSourceMetadata = (left, right) => {
  const preferred = sourceScore(right) > sourceScore(left) ? {...right} : {...left};
  const requestedUrls = [...new Set([...requestedUrlsOf(left), ...requestedUrlsOf(right)])]
    .sort((a, b) => a.localeCompare(b));
  if (left.operatorInput === true || right.operatorInput === true) preferred.operatorInput = true;
  if (requestedUrls.length > 0) preferred.requestedUrls = requestedUrls;
  return preferred;
};

const mergeSources = (...groups) => {
  const byUrl = new Map();
  for (const group of groups) {
    for (const source of group) {
      if (!source?.url) continue;
      const existing = byUrl.get(source.url);
      byUrl.set(source.url, existing ? mergeSourceMetadata(existing, source) : {...source});
    }
  }
  return [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
};

const mergeUnavailable = (...groups) => {
  const byUrl = new Map();
  for (const group of groups) {
    for (const source of group) {
      if (!source?.url || byUrl.has(source.url)) continue;
      byUrl.set(source.url, {url: source.url, errorCode: safeFailureCode(source)});
    }
  }
  return [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
};

export const createResearchService = ({
  provider,
  safeFetcher = createSafeFetcher(),
  fetchSource,
  fetchOptions = DEFAULT_FETCH_OPTIONS,
  now = Date.now,
} = {}) => {
  const researchProvider = assertResearchProvider(provider);
  const resolvedFetchOptions = {...DEFAULT_FETCH_OPTIONS, ...fetchOptions};
  const readSource = fetchSource ?? defaultFetchSource(safeFetcher, resolvedFetchOptions);
  if (typeof readSource !== 'function') throw new TypeError('fetchSource must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  return Object.freeze({
    async research(rawInput) {
      const input = validateInput(rawInput);
      const operatorSources = [];
      const operatorUnavailable = [];

      for (const requestedUrl of input.publicUrls) {
        try {
          const fetched = await readSource(requestedUrl);
          const finalUrl = assertSafePublicUrl(fetched?.url ?? requestedUrl).href;
          const mimeType = cleanText(fetched?.mimeType ?? 'text/plain', 'source mimeType', 200, {required: true});
          const content = cleanText(fetched?.content ?? '', 'source content', resolvedFetchOptions.maxBytes);
          operatorSources.push({requestedUrl, url: finalUrl, mimeType, content});
        } catch (error) {
          operatorUnavailable.push({url: requestedUrl, errorCode: safeFailureCode(error)});
        }
      }

      let providerResult;
      try {
        providerResult = await researchProvider.research({
          subject: {name: input.creator},
          topic: input.topic,
          instructions: input.instructions,
          operatorSources,
        });
      } catch (error) {
        if (error instanceof ResearchProviderError) throw error;
        throw new ResearchProviderError(
          ResearchProviderErrorCodes.FAILED,
          'Research provider failed',
          {retryable: false},
        );
      }

      const validated = validateResearchProviderResult(providerResult);
      if (validated.candidates.length === 0) {
        throw new ResearchProviderError(
          ResearchProviderErrorCodes.NO_EVIDENCE,
          'Research provider returned no evidence candidates',
          {retryable: false},
        );
      }

      const nowMs = now();
      if (!Number.isFinite(nowMs)) throw new TypeError('now() must return a finite number');
      const bundle = normalizeEvidence({
        subject: {name: input.creator},
        researchQuery: input.topic,
        researchedAt: new Date(nowMs).toISOString(),
        items: validated.candidates,
      });
      if (!Array.isArray(bundle.evidence) || bundle.evidence.length === 0) {
        throw new ResearchProviderError(
          ResearchProviderErrorCodes.NO_EVIDENCE,
          'Research normalization retained no usable evidence',
          {retryable: false},
        );
      }

      const operatorSourceMetadata = operatorSources.map(({requestedUrl, url}) => ({
        url,
        operatorInput: true,
        requestedUrls: [requestedUrl],
      }));
      const candidateSources = validated.candidates.map(sourceFromCandidate);
      return {
        bundle,
        sources: mergeSources(validated.sources, candidateSources, operatorSourceMetadata),
        unavailableSources: mergeUnavailable(validated.unavailableSources, operatorUnavailable),
      };
    },
  });
};

export const createResearchStageHandler = ({repos, researchService} = {}) => {
  if (!repos?.projects || !repos?.sources) throw new TypeError('repositories are required');
  if (!researchService || typeof researchService.research !== 'function') throw new TypeError('researchService is required');

  return async (claim, context) => {
    if (!claim?.projectId) throw new TypeError('research claim projectId is required');
    if (!context || typeof context.commitResearch !== 'function') throw new TypeError('fenced research commit is required');
    const project = repos.projects.get(claim.projectId);
    if (!project) throw new ResearchProviderError(ResearchProviderErrorCodes.FAILED, 'Research project no longer exists', {retryable: false});
    const publicUrls = repos.sources.list(claim.projectId)
      .filter((source) => source.status === 'pending')
      .map((source) => source.url);
    const result = await researchService.research({
      creator: project.creator,
      topic: project.topic,
      instructions: project.instructions,
      publicUrls,
    });
    context.commitResearch(result);
  };
};
