import {createHash} from 'node:crypto';

const TRACKING_KEYS = new Set(['gclid', 'fbclid', 'mc_cid', 'mc_eid']);
const NEGATION_TOKENS = new Set(['not', 'no', 'never', 'without', 'không', 'chưa', 'chẳng']);

const normalizeTypography = (value) => value
  .normalize('NFKC')
  .replace(/[“”„‟]/g, '"')
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[‐‑‒–—―]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const decimalFromAbbreviation = (raw, multiplier) => {
  const value = Number(raw.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return value * multiplier;
};

export function sanitizeString(value) {
  return normalizeTypography(String(value ?? ''));
}

export function normalizeNumericText(value) {
  return sanitizeString(value)
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(?:million|m)\b/gi, (_, n) => String(decimalFromAbbreviation(n, 1_000_000)))
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(?:thousand|k)\b/gi, (_, n) => String(decimalFromAbbreviation(n, 1_000)))
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(?:billion|bn|b)\b/gi, (_, n) => String(decimalFromAbbreviation(n, 1_000_000_000)));
}

export function canonicalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('URL must use http or https');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  const entries = [];
  for (const [key, val] of url.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('utm_') || TRACKING_KEYS.has(lowerKey)) continue;
    entries.push([key, val]);
  }
  entries.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = '';
  for (const [key, val] of entries) url.searchParams.append(key, val);

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

export function publisherDomain(value) {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

export function normalizeTypedValue(value, unit) {
  if (value === undefined || value === null || value === '') return {value: undefined, unit: normalizeUnit(unit)};
  const normalizedUnit = normalizeUnit(unit);
  if (typeof value === 'number' || typeof value === 'boolean') return {value, unit: normalizedUnit};

  const text = sanitizeString(value);
  if (/^-?\d+(?:[.,]\d+)?%$/.test(text)) {
    return {value: Number(text.slice(0, -1).replace(',', '.')), unit: 'percent'};
  }
  const abbreviated = text.match(/^(-?\d+(?:[.,]\d+)?)\s*(k|m|b|thousand|million|billion)$/i);
  if (abbreviated) {
    const multipliers = {k: 1_000, thousand: 1_000, m: 1_000_000, million: 1_000_000, b: 1_000_000_000, billion: 1_000_000_000};
    return {
      value: decimalFromAbbreviation(abbreviated[1], multipliers[abbreviated[2].toLowerCase()]),
      unit: normalizedUnit,
    };
  }
  if (/^-?\d+(?:[.,]\d+)?$/.test(text)) return {value: Number(text.replace(',', '.')), unit: normalizedUnit};
  return {value: text, unit: normalizedUnit};
}

export function normalizeUnit(unit) {
  if (unit === undefined || unit === null || unit === '') return undefined;
  const value = sanitizeString(unit).toLowerCase();
  const aliases = new Map([
    ['%', 'percent'],
    ['percentage', 'percent'],
    ['followers', 'followers'],
    ['follower', 'followers'],
    ['subscribers', 'subscribers'],
    ['subscriber', 'subscribers'],
    ['views', 'views'],
    ['view', 'views'],
  ]);
  return aliases.get(value) ?? value;
}

export function normalizeIsoLikeDate(value) {
  if (!value) return undefined;
  const text = sanitizeString(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return text;
  return parsed.toISOString();
}

export function normalizeClaim(claim, subject) {
  let text = normalizeNumericText(claim).toLowerCase();
  const aliases = [subject?.name, ...(subject?.aliases ?? [])]
    .filter(Boolean)
    .map((item) => sanitizeString(item).toLowerCase())
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    text = text.replaceAll(alias, '__subject__');
  }
  return text
    .replace(/[^\p{L}\p{N}%_+.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokensFor(value) {
  const tokens = sanitizeString(value).toLowerCase().match(/[\p{L}\p{N}%_]+/gu) ?? [];
  return new Set(tokens);
}

export function tokenSetSimilarity(a, b) {
  const left = tokensFor(a);
  const right = tokensFor(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

export function hasNegation(value) {
  for (const token of tokensFor(value)) if (NEGATION_TOKENS.has(token)) return true;
  return false;
}

export function fingerprintEvidence({subjectCanonical, category, claimDate, value, unit, claimNormalized}) {
  const material = JSON.stringify([
    subjectCanonical ?? '',
    category ?? '',
    claimDate ?? '',
    value ?? '',
    unit ?? '',
    claimNormalized ?? '',
  ]);
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

export function deterministicId(prefix, material, length = 20) {
  return `${prefix}_${createHash('sha256').update(String(material)).digest('hex').slice(0, length)}`;
}

export function sameTypedValue(a, b) {
  if (a === undefined || b === undefined) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    const tolerance = Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 0.001);
    return Math.abs(a - b) <= tolerance;
  }
  return a === b;
}
