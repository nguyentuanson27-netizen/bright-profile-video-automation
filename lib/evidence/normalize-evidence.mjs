import {
  canonicalizeUrl,
  deterministicId,
  fingerprintEvidence,
  hasNegation,
  normalizeClaim,
  normalizeIsoLikeDate,
  normalizeTypedValue,
  publisherDomain,
  sameTypedValue,
  sanitizeString,
  tokenSetSimilarity,
} from './primitives.mjs';

export const SCHEMA_VERSION = '1.0';
export const NORMALIZER_VERSION = '1.0.0';

const SOURCE_PRIOR = Object.freeze({
  official: 0.95,
  primary: 0.93,
  interview: 0.88,
  transcript: 0.86,
  news: 0.78,
  analytics: 0.72,
  social: 0.68,
  secondary: 0.62,
  aggregator: 0.45,
  repost: 0.4,
  other: 0.5,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const validHttpUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const validIsoDateLike = (value) => {
  if (typeof value !== 'string') return false;
  if (ISO_DATE_RE.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }
  return ISO_DATETIME_RE.test(value) && Number.isFinite(Date.parse(value));
};

const validateEnvelope = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Input must be an object');
  if (!input.subject || typeof input.subject !== 'object') throw new TypeError('subject is required');
  if (typeof input.subject.name !== 'string' || sanitizeString(input.subject.name).length < 1 || input.subject.name.length > 200) {
    throw new TypeError('subject.name must be 1-200 characters');
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200) {
    throw new TypeError('items must contain 1-200 evidence candidates');
  }
  if (input.researchedAt !== undefined && !validIsoDateLike(input.researchedAt)) {
    throw new TypeError('researchedAt must be an ISO date or date-time');
  }
  if (input.options !== undefined && (typeof input.options !== 'object' || Array.isArray(input.options))) {
    throw new TypeError('options must be an object');
  }
};

const validateItem = (item, index) => {
  const reasons = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) reasons.push('item must be an object');
  else {
    if (typeof item.claim !== 'string' || sanitizeString(item.claim).length < 3 || item.claim.length > 2000) reasons.push('claim must be 3-2000 characters');
    if (typeof item.url !== 'string' || item.url.length > 4096 || !validHttpUrl(item.url)) reasons.push('url must be an absolute http(s) URL');
    if (item.excerpt !== undefined && (typeof item.excerpt !== 'string' || item.excerpt.length > 1500)) reasons.push('excerpt must be <= 1500 characters');
    if (item.publishedAt !== undefined && !validIsoDateLike(item.publishedAt)) reasons.push('publishedAt must be an ISO date or date-time');
    if (item.claimDate !== undefined && !validIsoDateLike(item.claimDate)) reasons.push('claimDate must be an ISO date or date-time');
  }
  return reasons.length === 0 ? null : {index, reasons};
};

const normalizeSource = (item) => {
  const canonicalUrl = canonicalizeUrl(item.url);
  return {
    url: item.url,
    canonicalUrl,
    ...(item.title ? {title: sanitizeString(item.title)} : {}),
    ...(item.publisher ? {publisher: sanitizeString(item.publisher)} : {publisher: publisherDomain(canonicalUrl)}),
    ...(item.author ? {author: sanitizeString(item.author)} : {}),
    ...(item.publishedAt ? {publishedAt: normalizeIsoLikeDate(item.publishedAt)} : {}),
    ...(item.excerpt ? {excerpt: sanitizeString(item.excerpt).slice(0, 1500)} : {}),
    ...(item.sourceType ? {sourceType: sanitizeString(item.sourceType).toLowerCase()} : {sourceType: 'other'}),
    ...(item.sourceRelationship ? {sourceRelationship: sanitizeString(item.sourceRelationship).toLowerCase()} : {}),
  };
};

const normalizeItem = (item, subject) => {
  const typed = normalizeTypedValue(item.value, item.unit);
  const claim = sanitizeString(item.claim);
  const claimNormalized = normalizeClaim(claim, subject);
  const claimDate = normalizeIsoLikeDate(item.claimDate);
  const category = item.category ? sanitizeString(item.category).toLowerCase() : undefined;
  const subjectCanonical = sanitizeString(subject.name).toLowerCase();
  const fingerprint = fingerprintEvidence({
    subjectCanonical,
    category,
    claimDate,
    value: typed.value,
    unit: typed.unit,
    claimNormalized,
  });
  return {
    id: deterministicId('ev', fingerprint),
    claim,
    claimNormalized,
    ...(category ? {category} : {}),
    ...(claimDate ? {claimDate} : {}),
    ...(typed.value !== undefined ? {value: typed.value} : {}),
    ...(typed.unit ? {unit: typed.unit} : {}),
    fingerprint,
    sources: [normalizeSource(item)],
  };
};

const sourceKey = (source) => source.canonicalUrl;

const mergeSource = (left, right) => {
  if (sourceKey(left) !== sourceKey(right)) return left;
  const merged = {...left};
  for (const key of ['title', 'publisher', 'author', 'publishedAt', 'sourceType', 'sourceRelationship']) {
    if (!merged[key] && right[key]) merged[key] = right[key];
  }
  if ((right.excerpt?.length ?? 0) > (merged.excerpt?.length ?? 0)) merged.excerpt = right.excerpt;
  return merged;
};

const unionSources = (left, right) => {
  const byUrl = new Map(left.map((source) => [sourceKey(source), source]));
  for (const source of right) {
    const existing = byUrl.get(sourceKey(source));
    byUrl.set(sourceKey(source), existing ? mergeSource(existing, source) : source);
  }
  return [...byUrl.values()].slice(0, 20).sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
};

const compatibleCategory = (a, b) => !a.category || !b.category || a.category === b.category;
const compatibleDate = (a, b) => !a.claimDate || !b.claimDate || a.claimDate === b.claimDate;
const compatibleUnit = (a, b) => !a.unit || !b.unit || a.unit === b.unit;

const canNearMerge = (a, b, threshold) => {
  if (!compatibleCategory(a, b) || !compatibleDate(a, b) || !compatibleUnit(a, b)) return false;
  if (!sameTypedValue(a.value, b.value)) return false;
  if (hasNegation(a.claimNormalized) !== hasNegation(b.claimNormalized)) return false;
  return tokenSetSimilarity(a.claimNormalized, b.claimNormalized) >= threshold;
};

const independentSourceCount = (sources) => new Set(
  sources
    .filter((source) => !['syndicated', 'quotes_primary'].includes(source.sourceRelationship))
    .map((source) => publisherDomain(source.canonicalUrl)),
).size;

const scoreEvidence = (evidence, researchedAt) => {
  const sourceScores = evidence.sources.map((source) => SOURCE_PRIOR[source.sourceType] ?? SOURCE_PRIOR.other);
  const authority = sourceScores.length ? Math.max(...sourceScores) : 0.4;
  const directness = evidence.sources.some((source) => ['official', 'primary', 'interview', 'transcript'].includes(source.sourceType)) ? 1 : 0.65;
  const excerpt = evidence.sources.some((source) => (source.excerpt?.length ?? 0) >= Math.min(80, evidence.claim.length)) ? 1 : 0.45;
  const metadataFields = evidence.sources.flatMap((source) => [source.title, source.publisher, source.publishedAt, source.author]).filter(Boolean).length;
  const metadata = Math.min(1, metadataFields / Math.max(1, evidence.sources.length * 3));
  let freshness = 0.5;
  const published = evidence.sources.map((source) => source.publishedAt).filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  const researchedTime = new Date(researchedAt).getTime();
  if (published.length && Number.isFinite(researchedTime)) {
    const ageDays = Math.max(0, (researchedTime - Math.max(...published)) / 86_400_000);
    freshness = ageDays <= 30 ? 1 : ageDays <= 365 ? 0.7 : 0.4;
  }
  return Math.max(0, Math.min(1, Number((0.3 * directness + 0.25 * authority + 0.2 * excerpt + 0.15 * metadata + 0.1 * freshness).toFixed(3))));
};

const conflictComparable = (a, b) => Boolean(a.category && b.category && a.category === b.category)
  && compatibleUnit(a, b)
  && compatibleDate(a, b);

const conflictFactKey = (evidence, subjectName) => [
  sanitizeString(subjectName).toLowerCase(),
  evidence.category ?? 'uncategorized',
  evidence.unit ?? 'value',
  evidence.claimDate ?? 'undated',
].join(':');

const detectConflictPairs = (evidence) => {
  const pairs = [];
  for (let i = 0; i < evidence.length; i += 1) {
    for (let j = i + 1; j < evidence.length; j += 1) {
      const a = evidence[i];
      const b = evidence[j];
      if (!conflictComparable(a, b)) continue;
      const explicitValueConflict = a.value !== undefined && b.value !== undefined && !sameTypedValue(a.value, b.value);
      const negationConflict = hasNegation(a.claimNormalized) !== hasNegation(b.claimNormalized)
        && tokenSetSimilarity(a.claimNormalized.replace(/\b(not|no|never|without|không|chưa|chẳng)\b/g, ''), b.claimNormalized.replace(/\b(not|no|never|without|không|chưa|chẳng)\b/g, '')) >= 0.7;
      if (explicitValueConflict || negationConflict) pairs.push([i, j]);
    }
  }
  return pairs;
};

const assignConflicts = (evidence, subjectName) => {
  const groups = [];
  const pairs = detectConflictPairs(evidence);
  const adjacency = new Map();
  for (const [a, b] of pairs) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  const visited = new Set();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack = [start];
    const indexes = [];
    while (stack.length) {
      const index = stack.pop();
      if (visited.has(index)) continue;
      visited.add(index);
      indexes.push(index);
      for (const next of adjacency.get(index) ?? []) stack.push(next);
    }
    if (indexes.length < 2) continue;
    const ids = indexes.map((index) => evidence[index].id).sort();
    const factKey = conflictFactKey(evidence[indexes[0]], subjectName);
    const id = deterministicId('conf', `${factKey}:${ids.join(',')}`);
    for (const index of indexes) evidence[index].conflictGroupId = id;
    groups.push({id, factKey, evidenceIds: ids, status: 'unresolved'});
  }
  return groups;
};

const confidenceFor = (evidence) => {
  if (evidence.conflictGroupId) return 'low';
  if (evidence.sources.some((source) => ['official', 'primary'].includes(source.sourceType)) && evidence.qualityScore >= 0.75) return 'high';
  if (independentSourceCount(evidence.sources) >= 2 && evidence.qualityScore >= 0.68) return 'high';
  return evidence.qualityScore >= 0.55 ? 'medium' : 'low';
};

export function normalizeEvidence(input) {
  validateEnvelope(input);
  const threshold = Number(input.options?.nearDuplicateThreshold ?? 0.86);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new TypeError('nearDuplicateThreshold must be 0.5-0.99');
  const maxEvidence = Number(input.options?.maxEvidence ?? 80);
  if (!Number.isInteger(maxEvidence) || maxEvidence < 1 || maxEvidence > 200) throw new TypeError('maxEvidence must be an integer 1-200');

  const rejectedItems = [];
  const normalized = [];
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    const rejection = validateItem(item, index);
    if (rejection) {
      rejectedItems.push(rejection);
      continue;
    }
    normalized.push(normalizeItem(item, input.subject));
  }

  let exactDuplicatesRemoved = 0;
  const exact = [];
  const exactByKey = new Map();
  for (const candidate of normalized) {
    const keys = [candidate.fingerprint, `${candidate.sources[0].canonicalUrl}|${candidate.claimNormalized}`];
    const existingIndex = keys.map((key) => exactByKey.get(key)).find((value) => value !== undefined);
    if (existingIndex !== undefined) {
      exact[existingIndex].sources = unionSources(exact[existingIndex].sources, candidate.sources);
      exactDuplicatesRemoved += 1;
      for (const key of keys) exactByKey.set(key, existingIndex);
      continue;
    }
    const index = exact.length;
    exact.push(candidate);
    for (const key of keys) exactByKey.set(key, index);
  }

  let nearDuplicatesMerged = 0;
  const retained = [];
  for (const candidate of exact) {
    const existing = retained.find((item) => canNearMerge(item, candidate, threshold));
    if (existing) {
      existing.sources = unionSources(existing.sources, candidate.sources);
      nearDuplicatesMerged += 1;
    } else {
      retained.push(candidate);
    }
  }

  retained.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const truncated = retained.slice(0, maxEvidence);
  const researchedAt = input.researchedAt ? normalizeIsoLikeDate(input.researchedAt) : 'unknown';
  for (const item of truncated) item.qualityScore = scoreEvidence(item, researchedAt);
  const conflicts = assignConflicts(truncated, input.subject.name);
  for (const item of truncated) {
    item.confidence = confidenceFor(item);
    if (!item.conflictGroupId) item.conflictGroupId = null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    subject: {
      name: sanitizeString(input.subject.name),
      ...(Array.isArray(input.subject.aliases) && input.subject.aliases.length
        ? {aliases: input.subject.aliases.map(sanitizeString).filter(Boolean)}
        : {}),
    },
    ...(input.researchQuery ? {researchQuery: sanitizeString(input.researchQuery)} : {}),
    researchedAt,
    stats: {
      inputItems: input.items.length,
      retainedEvidence: truncated.length,
      exactDuplicatesRemoved,
      nearDuplicatesMerged,
      conflictGroups: conflicts.length,
      rejectedItems: rejectedItems.length,
    },
    evidence: truncated,
    conflicts,
    rejectedItems,
  };
}
