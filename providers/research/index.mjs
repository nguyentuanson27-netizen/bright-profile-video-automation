import {assertSafePublicUrl} from '../../security/url-policy.mjs';

export const ResearchProviderErrorCodes = Object.freeze({
  TIMEOUT: 'RESEARCH_PROVIDER_TIMEOUT',
  RATE_LIMIT: 'RESEARCH_PROVIDER_RATE_LIMIT',
  FAILED: 'RESEARCH_PROVIDER_FAILED',
  INCOMPLETE: 'RESEARCH_PROVIDER_INCOMPLETE',
  INVALID_RESULT: 'RESEARCH_PROVIDER_INVALID_RESULT',
  NO_EVIDENCE: 'RESEARCH_NO_EVIDENCE',
});

export class ResearchProviderError extends Error {
  constructor(code, message, {retryable = false} = {}) {
    super(message);
    this.name = 'ResearchProviderError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

const MAX_CANDIDATES = 200;
const MAX_SOURCES = 200;
const MAX_UNAVAILABLE_SOURCES = 100;
const APP_OWNED_ID_FIELDS = new Set(['id', 'sourceId', 'evidenceId', 'applicationSourceId']);

const invalidResult = (message) => new ResearchProviderError(
  ResearchProviderErrorCodes.INVALID_RESULT,
  message,
  {retryable: false},
);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const text = (value, name, {min = 0, max}) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidResult(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw invalidResult(`${name} length is outside the provider contract`);
  }
  return normalized;
};

const publicUrl = (value, name) => {
  if (typeof value !== 'string') throw invalidResult(`${name} must be a public HTTP(S) URL`);
  try {
    return assertSafePublicUrl(value).href;
  } catch {
    throw invalidResult(`${name} must be a public HTTP(S) URL`);
  }
};

const rejectApplicationIds = (value, name) => {
  for (const key of APP_OWNED_ID_FIELDS) {
    if (own(value, key)) throw invalidResult(`${name} must not contain application-owned IDs`);
  }
};

const candidate = (value, index) => {
  if (!isObject(value)) throw invalidResult(`candidates[${index}] must be an object`);
  rejectApplicationIds(value, `candidates[${index}]`);
  const normalized = {
    ...value,
    claim: text(value.claim, `candidates[${index}].claim`, {min: 3, max: 2000}),
    url: publicUrl(value.url, `candidates[${index}].url`),
  };
  const boundedFields = {
    title: 1000,
    publisher: 500,
    author: 500,
    publishedAt: 64,
    excerpt: 1500,
    category: 128,
    sourceType: 64,
    sourceRelationship: 64,
    claimDate: 64,
    unit: 128,
  };
  for (const [key, max] of Object.entries(boundedFields)) {
    if (value[key] !== undefined) normalized[key] = text(value[key], `candidates[${index}].${key}`, {max});
  }
  if (value.value !== undefined && !['string', 'number', 'boolean'].includes(typeof value.value)) {
    throw invalidResult(`candidates[${index}].value has an unsupported type`);
  }
  return normalized;
};

const source = (value, index) => {
  if (!isObject(value)) throw invalidResult(`sources[${index}] must be an object`);
  rejectApplicationIds(value, `sources[${index}]`);
  const normalized = {url: publicUrl(value.url, `sources[${index}].url`)};
  const boundedFields = {
    title: 1000,
    publisher: 500,
    author: 500,
    publishedAt: 64,
    sourceType: 64,
    sourceRelationship: 64,
  };
  for (const [key, max] of Object.entries(boundedFields)) {
    if (value[key] !== undefined) normalized[key] = text(value[key], `sources[${index}].${key}`, {max});
  }
  return normalized;
};

const unavailableSource = (value, index) => {
  if (!isObject(value)) throw invalidResult(`unavailableSources[${index}] must be an object`);
  rejectApplicationIds(value, `unavailableSources[${index}]`);
  return {
    url: publicUrl(value.url, `unavailableSources[${index}].url`),
    errorCode: text(value.errorCode, `unavailableSources[${index}].errorCode`, {min: 1, max: 128}),
  };
};

export const assertResearchProvider = (provider) => {
  if (!provider || typeof provider.research !== 'function') {
    throw new TypeError('research provider with a research() method is required');
  }
  return provider;
};

export const validateResearchProviderResult = (value) => {
  if (!isObject(value)) throw invalidResult('research provider result must be an object');
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) {
    throw invalidResult(`candidates must be an array with at most ${MAX_CANDIDATES} items`);
  }
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) {
    throw invalidResult(`sources must be an array with at most ${MAX_SOURCES} items`);
  }
  if (!Array.isArray(value.unavailableSources) || value.unavailableSources.length > MAX_UNAVAILABLE_SOURCES) {
    throw invalidResult(`unavailableSources must be an array with at most ${MAX_UNAVAILABLE_SOURCES} items`);
  }
  return Object.freeze({
    candidates: value.candidates.map(candidate),
    sources: value.sources.map(source),
    unavailableSources: value.unavailableSources.map(unavailableSource),
  });
};
