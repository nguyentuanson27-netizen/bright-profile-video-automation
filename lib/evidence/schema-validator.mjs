import {readFileSync} from 'node:fs';
import Ajv from 'ajv';

const loadJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
const inputSchema = loadJson('../../mcp/schemas/evidence-input.schema.json');
const outputSchema = loadJson('../../mcp/schemas/evidence-bundle.schema.json');
const ajv = new Ajv({allErrors: true, strict: true});
const validateEnvelope = ajv.compile(inputSchema);
const validateItem = ajv.compile(inputSchema.$defs.evidenceItem);
const validateOutput = ajv.compile(outputSchema);

const details = (errors = []) => errors.map(({instancePath, keyword, message}) => ({instancePath, keyword, message}));

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
    if (!validateItem(items[index])) invalid.set(index, details(validateItem.errors).map((entry) => entry.message || entry.keyword));
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
