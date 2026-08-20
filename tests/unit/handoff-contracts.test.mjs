import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_MODES,
  PROJECT_ORIGINS,
  validateApproveProjectInput,
  validateEditDraftInput,
  validateImportProjectInput,
} from '../../domain/schemas.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

import {normalizeEvidence} from '../../lib/evidence/normalize-evidence.mjs';

const validBundle = normalizeEvidence({
  researchedAt: '2026-08-20T00:00:00.000Z',
  subject: {name: 'Marques Brownlee'},
  items: [
    {
      url: 'https://en.wikipedia.org/wiki/MKBHD',
      claim: 'Marques Keith Brownlee is an American YouTuber.',
      category: 'identity',
      value: 'Marques Keith Brownlee',
    },
  ],
});

test('APPROVAL_MODES and PROJECT_ORIGINS define the exact vocabulary', () => {
  assert.deepEqual(APPROVAL_MODES, {
    USER_REVIEWED: 'user_reviewed',
    DELEGATED_E2E: 'delegated_e2e',
  });
  assert.deepEqual(PROJECT_ORIGINS, {
    STANDALONE: 'standalone',
    CHATGPT_MCP: 'chatgpt_mcp',
  });
});

test('validateImportProjectInput validates valid handoff input', () => {
  const valid = {
    creator: 'Marques Brownlee',
    topic: 'Career milestones',
    instructions: 'Create a factual profile',
    evidenceBundle: validBundle,
    idempotencyKey: 'chatgpt-run-12345',
  };
  const validated = validateImportProjectInput(valid);
  assert.equal(validated.creator, 'Marques Brownlee');
  assert.equal(validated.idempotencyKey, 'chatgpt-run-12345');
});

test('validateImportProjectInput rejects missing or malformed fields and invalid EvidenceBundle', () => {
  assert.throws(
    () => validateImportProjectInput({
      creator: '',
      topic: 'Topic',
      evidenceBundle: validBundle,
      idempotencyKey: 'key',
    }),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );

  assert.throws(
    () => validateImportProjectInput({
      creator: 'Creator',
      topic: 'Topic',
      evidenceBundle: {invalid: true},
      idempotencyKey: 'key',
    }),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );

  assert.throws(
    () => validateImportProjectInput({
      creator: 'Creator',
      topic: 'Topic',
      evidenceBundle: validBundle,
      idempotencyKey: '',
    }),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );
});

test('validateApproveProjectInput enforces approval mode and expected hash', () => {
  const validUser = {
    projectId: 'proj-1',
    revisionId: 'rev-1',
    expectedPayloadHash: 'a'.repeat(64),
    mode: APPROVAL_MODES.USER_REVIEWED,
  };
  assert.doesNotThrow(() => validateApproveProjectInput(validUser));

  const validDelegated = {
    projectId: 'proj-1',
    revisionId: 'rev-1',
    expectedPayloadHash: 'a'.repeat(64),
    mode: APPROVAL_MODES.DELEGATED_E2E,
    delegatedContext: {
      userExplicitIntent: 'Create full video end to end',
      authorizedAt: '2026-08-20T00:00:00.000Z',
    },
  };
  assert.doesNotThrow(() => validateApproveProjectInput(validDelegated));

  assert.throws(
    () => validateApproveProjectInput({
      ...validUser,
      mode: 'auto_approve',
    }),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );

  assert.throws(
    () => validateApproveProjectInput({
      ...validUser,
      expectedPayloadHash: 'invalid-hash',
    }),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );
});

test('validateEditDraftInput requires projectId, revisionId, expectedPayloadHash, and valid draft', () => {
  const validEdit = {
    projectId: 'proj-1',
    revisionId: 'rev-1',
    expectedPayloadHash: 'b'.repeat(64),
    draft: {
      creatorName: 'Marques Brownlee',
      summary: 'Summary text',
      claims: [
        {id: 'c-1', text: 'Marques is a YouTuber', sourceIds: ['src-1'], verified: true},
      ],
      script: [
        {id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: ['src-1']},
      ],
      voiceover: {
        chunks: [
          {id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: ['src-1']},
        ],
      },
      scenes: [
        {id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: ['src-1']},
      ],
      render: {duration: 5, renderScale: 1, crf: 20},
    },
  };
  assert.doesNotThrow(() => validateEditDraftInput(validEdit, {knownSourceIds: ['src-1']}));

  assert.throws(
    () => validateEditDraftInput({
      ...validEdit,
      expectedPayloadHash: 'short',
    }, {knownSourceIds: ['src-1']}),
    (error) => error.code === ErrorCodes.INVALID_DOMAIN_DATA,
  );
});