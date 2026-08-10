import {AppError} from '../../domain/errors.mjs';

const CANDIDATE_KEYS = new Set([
  'url',
  'platform',
  'title',
  'sourceType',
  'discoveryStatus',
  'citation',
]);
const SOURCE_TYPES = new Set(['search-result', 'operator-url']);
const DISCOVERY_STATUSES = new Set(['discovered', 'unavailable']);

const providerOutputError = () => new AppError(
  'PROVIDER_OUTPUT_INVALID',
  'Research provider returned invalid discovery data',
  {status: 502},
);

const parsePublicHttpUrl = (value) => {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw providerOutputError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw providerOutputError();
  }
  return url.href;
};

const validateCitation = (citation) => {
  if (citation === undefined) return undefined;
  if (!citation || typeof citation !== 'object' || Array.isArray(citation)) throw providerOutputError();
  const allowed = new Set(['title', 'startIndex', 'endIndex']);
  if (Object.keys(citation).some((key) => !allowed.has(key))) throw providerOutputError();
  const normalized = {};
  if (citation.title !== undefined) {
    if (typeof citation.title !== 'string' || citation.title.length > 1000) throw providerOutputError();
    normalized.title = citation.title;
  }
  for (const key of ['startIndex', 'endIndex']) {
    if (citation[key] !== undefined) {
      if (!Number.isSafeInteger(citation[key]) || citation[key] < 0) throw providerOutputError();
      normalized[key] = citation[key];
    }
  }
  return normalized;
};

export function normalizeResearchCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw providerOutputError();
  if (Object.keys(candidate).some((key) => !CANDIDATE_KEYS.has(key))) throw providerOutputError();
  if (typeof candidate.platform !== 'string' || candidate.platform.length < 1 || candidate.platform.length > 128) {
    throw providerOutputError();
  }
  if (!SOURCE_TYPES.has(candidate.sourceType) || !DISCOVERY_STATUSES.has(candidate.discoveryStatus)) {
    throw providerOutputError();
  }
  if (candidate.title !== undefined && (typeof candidate.title !== 'string' || candidate.title.length > 1000)) {
    throw providerOutputError();
  }

  const result = {
    url: parsePublicHttpUrl(candidate.url),
    platform: candidate.platform,
    sourceType: candidate.sourceType,
    discoveryStatus: candidate.discoveryStatus,
  };
  if (candidate.title !== undefined) result.title = candidate.title;
  const citation = validateCitation(candidate.citation);
  if (citation !== undefined) result.citation = citation;
  return Object.freeze(result);
}

const assertSearchInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('PROVIDER_INPUT_INVALID', 'Research provider input is invalid', {status: 400});
  }
  const allowed = new Set(['topic', 'sourceUrls']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AppError('PROVIDER_INPUT_INVALID', 'Research provider input is invalid', {status: 400});
  }
  if (typeof input.topic !== 'string' || input.topic.trim().length === 0 || input.topic.length > 500) {
    throw new AppError('PROVIDER_INPUT_INVALID', 'Research provider topic is invalid', {status: 400});
  }
  if (input.sourceUrls !== undefined) {
    if (!Array.isArray(input.sourceUrls) || input.sourceUrls.length > 50) {
      throw new AppError('PROVIDER_INPUT_INVALID', 'Research provider source URLs are invalid', {status: 400});
    }
    for (const value of input.sourceUrls) parsePublicHttpUrl(value);
  }
};

export function createResearchProvider({search}) {
  if (typeof search !== 'function') throw new TypeError('research provider search function is required');

  return Object.freeze({
    async search(input) {
      assertSearchInput(input);
      const output = await search({
        topic: input.topic.trim(),
        sourceUrls: input.sourceUrls ? [...input.sourceUrls] : [],
      });
      if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some((key) => key !== 'candidates')) {
        throw providerOutputError();
      }
      if (!Array.isArray(output.candidates) || output.candidates.length > 200) throw providerOutputError();
      return Object.freeze({candidates: output.candidates.map(normalizeResearchCandidate)});
    },
  });
}
