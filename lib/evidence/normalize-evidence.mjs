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
  tokensFor,
} from './primitives.mjs';
import {assertEvidenceEnvelope, classifyInvalidItems} from './schema-validator.mjs';

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

const METRIC_STOP_TOKENS = new Set([
  '__subject__', 'a', 'an', 'and', 'as', 'at', 'by', 'did', 'for', 'from', 'had', 'has', 'have', 'her', 'his',
  'in', 'is', 'its', 'of', 'on', 'reported', 'reports', 'said', 'says', 'the', 'their', 'to', 'was', 'were', 'with',
  'not', 'no', 'never', 'without', 'không', 'chưa', 'chẳng', 'có', 'của', 'đã', 'là', 'ngày', 'năm', 'tháng', 'trong', 'vào',
]);
const MONTH_TOKENS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

const validHttpUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const validCalendarDate = (year, month, day) => {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

const validIsoDateLike = (value) => {
  if (typeof value !== 'string') return false;
  const dateMatch = value.match(ISO_DATE_RE);
  if (dateMatch) {
    const [, year, month, day] = dateMatch.map(Number);
    return validCalendarDate(year, month, day);
  }

  const datetimeMatch = value.match(ISO_DATETIME_RE);
  if (!datetimeMatch) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = datetimeMatch;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
};

const validateEnvelope = (input) => {
  assertEvidenceEnvelope(input);
  if (input.researchedAt !== undefined && !validIsoDateLike(input.researchedAt)) {
    throw new TypeError('researchedAt must be an ISO date or date-time');
  }
};

const validateItemSemantics = (item, index) => {
  const reasons = [];
  if (!validHttpUrl(item.url)) reasons.push('url must be an absolute http(s) URL');
  if (item.publishedAt !== undefined && !validIsoDateLike(item.publishedAt)) reasons.push('publishedAt must be an ISO date or date-time');
  if (item.claimDate !== undefined && !validIsoDateLike(item.claimDate)) reasons.push('claimDate must be an ISO date or date-time');
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
const compatibleEvidenceMetadata = (a, b) => compatibleCategory(a, b)
  && compatibleDate(a, b)
  && compatibleUnit(a, b)
  && sameTypedValue(a.value, b.value);

const refreshEvidenceIdentity = (evidence, subjectCanonical) => {
  const fingerprint = fingerprintEvidence({
    subjectCanonical,
    category: evidence.category,
    claimDate: evidence.claimDate,
    value: evidence.value,
    unit: evidence.unit,
    claimNormalized: evidence.claimNormalized,
  });
  evidence.fingerprint = fingerprint;
  evidence.id = deterministicId('ev', fingerprint);
  return evidence;
};

const mergeEvidence = (left, right, subjectCanonical) => {
  left.sources = unionSources(left.sources, right.sources);
  if (compatibleEvidenceMetadata(left, right)) {
    if (!left.category && right.category) left.category = right.category;
    if (!left.claimDate && right.claimDate) left.claimDate = right.claimDate;
    if (left.value === undefined && right.value !== undefined) left.value = right.value;
    if (!left.unit && right.unit) left.unit = right.unit;
  }
  return refreshEvidenceIdentity(left, subjectCanonical);
};

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

const conflictMetricTokens = (evidence) => [...tokensFor(evidence.claimNormalized)]
  .filter((token) => !METRIC_STOP_TOKENS.has(token))
  .filter((token) => !MONTH_TOKENS.has(token))
  .filter((token) => !/^\d+(?:[.,]\d+)?$/.test(token))
  .sort();

const conflictMetricKey = (evidence) => conflictMetricTokens(evidence).join('-')
  || evidence.unit
  || evidence.category
  || 'fact';

const comparableMetric = (a, b) => {
  const left = conflictMetricKey(a);
  const right = conflictMetricKey(b);
  return left === right || tokenSetSimilarity(left.replaceAll('-', ' '), right.replaceAll('-', ' ')) >= 0.8;
};

const pairMetricKey = (a, b) => {
  const left = conflictMetricTokens(a);
  const rightSet = new Set(conflictMetricTokens(b));
  const shared = left.filter((token) => rightSet.has(token));
  if (shared.length) return [...new Set(shared)].sort().join('-');
  return [conflictMetricKey(a), conflictMetricKey(b)].sort().join('~');
};

const conflictFactKey = (a, b, subjectName, dateBucket) => [
  sanitizeString(subjectName).toLowerCase(),
  a.category ?? b.category ?? 'uncategorized',
  pairMetricKey(a, b),
  a.unit ?? b.unit ?? 'value',
  dateBucket,
].join(':');

const detectConflictPairs = (evidence, subjectName) => {
  const pairs = [];
  for (let i = 0; i < evidence.length; i += 1) {
    for (let j = i + 1; j < evidence.length; j += 1) {
      const a = evidence[i];
      const b = evidence[j];
      if (!a.category || !b.category || a.category !== b.category || !compatibleUnit(a, b) || !comparableMetric(a, b)) continue;

      const explicitValueConflict = compatibleDate(a, b)
        && a.value !== undefined
        && b.value !== undefined
        && !sameTypedValue(a.value, b.value);
      const eventDateConflict = a.value === undefined
        && b.value === undefined
        && Boolean(a.claimDate && b.claimDate)
        && a.claimDate !== b.claimDate;
      const negationConflict = compatibleDate(a, b)
        && hasNegation(a.claimNormalized) !== hasNegation(b.claimNormalized)
        && tokenSetSimilarity(
          a.claimNormalized.replace(/\b(not|no|never|without|không|chưa|chẳng)\b/g, ''),
          b.claimNormalized.replace(/\b(not|no|never|without|không|chưa|chẳng)\b/g, ''),
        ) >= 0.7;

      if (!explicitValueConflict && !eventDateConflict && !negationConflict) continue;
      const dateBucket = eventDateConflict
        ? 'event-date-disputed'
        : a.claimDate && a.claimDate === b.claimDate
          ? a.claimDate
          : a.claimDate ?? b.claimDate ?? 'undated';
      pairs.push({
        a: i,
        b: j,
        factKey: conflictFactKey(a, b, subjectName, dateBucket),
      });
    }
  }
  return pairs;
};

const assignConflicts = (evidence, subjectName) => {
  const groups = [];
  const pairs = detectConflictPairs(evidence, subjectName);
  const adjacency = new Map();
  for (const {a, b} of pairs) {
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
    const component = new Set(indexes);
    const factKeys = [...new Set(
      pairs
        .filter(({a, b}) => component.has(a) && component.has(b))
        .map(({factKey}) => factKey),
    )].sort();
    const factKey = factKeys.length === 1
      ? factKeys[0]
      : `${sanitizeString(subjectName).toLowerCase()}:mixed:${deterministicId('fact', factKeys.join('|'), 16)}`;
    const ids = indexes.map((index) => evidence[index].id).sort();
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

const compareEvidenceQuality = (a, b) => b.qualityScore - a.qualityScore
  || a.fingerprint.localeCompare(b.fingerprint);

const selectEvidence = (evidence, conflicts, maxEvidence) => {
  if (evidence.length <= maxEvidence) {
    return {
      evidence: [...evidence].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
      conflicts: [...conflicts].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  const byId = new Map(evidence.map((item) => [item.id, item]));
  const selectedIds = new Set();
  const conflictUnits = conflicts
    .map((conflict) => ({
      conflict,
      items: conflict.evidenceIds.map((id) => byId.get(id)).filter(Boolean),
    }))
    .filter(({items}) => items.length >= 2)
    .map((unit) => ({
      ...unit,
      score: Math.max(...unit.items.map((item) => item.qualityScore)),
    }))
    .sort((a, b) => b.score - a.score || a.conflict.id.localeCompare(b.conflict.id));

  for (const unit of conflictUnits) {
    for (const item of unit.items) selectedIds.add(item.id);
  }

  const remaining = Math.max(0, maxEvidence - selectedIds.size);
  if (remaining > 0) {
    const nonConflicts = evidence
      .filter((item) => !item.conflictGroupId)
      .sort(compareEvidenceQuality);
    for (const item of nonConflicts.slice(0, remaining)) selectedIds.add(item.id);
  }

  const selectedEvidence = evidence
    .filter((item) => selectedIds.has(item.id))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const selectedConflicts = conflicts
    .filter((conflict) => conflict.evidenceIds.every((id) => selectedIds.has(id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {evidence: selectedEvidence, conflicts: selectedConflicts};
};

const addAlternateExactIndex = (map, key, index) => {
  const indexes = map.get(key) ?? [];
  if (!indexes.includes(index)) indexes.push(index);
  map.set(key, indexes);
};

export function normalizeEvidence(input) {
  validateEnvelope(input);
  const threshold = Number(input.options?.nearDuplicateThreshold ?? 0.86);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) throw new TypeError('nearDuplicateThreshold must be 0.5-0.99');
  const maxEvidence = Number(input.options?.maxEvidence ?? 80);
  if (!Number.isInteger(maxEvidence) || maxEvidence < 1 || maxEvidence > 200) throw new TypeError('maxEvidence must be an integer 1-200');

  const schemaInvalidItems = classifyInvalidItems(input.items);
  const rejectedItems = [];
  const normalized = [];
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    const schemaReasons = schemaInvalidItems.get(index);
    if (schemaReasons) {
      rejectedItems.push({index, reasons: schemaReasons});
      continue;
    }
    const semanticRejection = validateItemSemantics(item, index);
    if (semanticRejection) {
      rejectedItems.push(semanticRejection);
      continue;
    }
    normalized.push(normalizeItem(item, input.subject));
  }

  const subjectCanonical = sanitizeString(input.subject.name).toLowerCase();
  let exactDuplicatesRemoved = 0;
  const exact = [];
  const exactByFingerprint = new Map();
  const exactByAlternate = new Map();
  for (const candidate of normalized) {
    const candidateFingerprint = candidate.fingerprint;
    const alternateKey = `${candidate.sources[0].canonicalUrl}|${candidate.claimNormalized}`;
    let existingIndex = exactByFingerprint.get(candidateFingerprint);
    if (existingIndex === undefined) {
      existingIndex = (exactByAlternate.get(alternateKey) ?? [])
        .find((index) => compatibleEvidenceMetadata(exact[index], candidate));
    }

    if (existingIndex !== undefined) {
      const previousFingerprint = exact[existingIndex].fingerprint;
      mergeEvidence(exact[existingIndex], candidate, subjectCanonical);
      exactDuplicatesRemoved += 1;
      exactByFingerprint.set(candidateFingerprint, existingIndex);
      exactByFingerprint.set(previousFingerprint, existingIndex);
      exactByFingerprint.set(exact[existingIndex].fingerprint, existingIndex);
      addAlternateExactIndex(exactByAlternate, alternateKey, existingIndex);
      continue;
    }

    const index = exact.length;
    exact.push(candidate);
    exactByFingerprint.set(candidateFingerprint, index);
    addAlternateExactIndex(exactByAlternate, alternateKey, index);
  }

  let nearDuplicatesMerged = 0;
  const retained = [];
  for (const candidate of exact) {
    const existing = retained.find((item) => canNearMerge(item, candidate, threshold));
    if (existing) {
      mergeEvidence(existing, candidate, subjectCanonical);
      nearDuplicatesMerged += 1;
    } else {
      retained.push(candidate);
    }
  }

  const researchedAt = input.researchedAt ? normalizeIsoLikeDate(input.researchedAt) : 'unknown';
  for (const item of retained) item.qualityScore = scoreEvidence(item, researchedAt);
  const allConflicts = assignConflicts(retained, input.subject.name);
  const selection = selectEvidence(retained, allConflicts, maxEvidence);
  for (const item of selection.evidence) {
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
      retainedEvidence: selection.evidence.length,
      exactDuplicatesRemoved,
      nearDuplicatesMerged,
      conflictGroups: selection.conflicts.length,
      rejectedItems: rejectedItems.length,
    },
    evidence: selection.evidence,
    conflicts: selection.conflicts,
    rejectedItems,
  };
}
