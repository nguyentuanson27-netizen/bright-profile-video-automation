import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const loadJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
export const evidenceInputSchema = loadJson('../../mcp/schemas/evidence-input.schema.json');
export const evidenceBundleSchema = loadJson('../../mcp/schemas/evidence-bundle.schema.json');
const ajv = new Ajv2020({allErrors: true, strict: true, allowUnionTypes: true});
const validateEnvelope = ajv.compile(evidenceInputSchema);
const validateItem = ajv.compile(evidenceInputSchema.$defs.evidenceItem);
const validateOutput = ajv.compile(evidenceBundleSchema);

const details = (errors = []) => errors.map(({instancePath, keyword, message}) => ({instancePath, keyword, message}));

const hasUrlUserinfo = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.username || url.password);
  } catch {
    return false;
  }
};

export function assertEvidenceEnvelope(input) {
  if (!validateEnvelope(input)) {
    const error = new TypeError('Invalid normalize_evidence envelope');
    error.code = 'EVIDENCE_INPUT_INVALID';
    error.details = details(validateEnvelope.errors);
    throw error;
  }
}

export function classifyInvalidItems(items) {
  const invalid = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const reasons = [];
    if (!validateItem(items[index])) reasons.push(...details(validateItem.errors).map((entry) => entry.message || entry.keyword));
    if (hasUrlUserinfo(items[index]?.url)) reasons.push('url must not include credentials/userinfo');
    if (reasons.length) invalid.set(index, reasons);
  }
  return invalid;
}

export function assertEvidenceBundle(bundle) {
  if (!validateOutput(bundle)) {
    const error = new TypeError('Normalizer produced an invalid EvidenceBundle');
    error.code = 'EVIDENCE_OUTPUT_INVALID';
    error.details = details(validateOutput.errors);
    throw error;
  }
  return bundle;
}
