import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  openDatabase,
  migrateDatabase,
  createRepositories,
} from '../../storage/db.mjs';
import {APPROVAL_MODES, PROJECT_ORIGINS} from '../../domain/schemas.mjs';

const tempDbPath = () => join(mkdtempSync(join(tmpdir(), 'bright-db-test-')), 'test.sqlite');

test('schema v2 upgrades to v4 and supports ChatGPT handoff persistence', () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  const version = migrateDatabase(db);
  assert.equal(version, 4);
  db.close();
});

test('project origin and idempotency_key survive database reopen', () => {
  const dbPath = tempDbPath();
  let db = openDatabase(dbPath);
  migrateDatabase(db);
  let repos = createRepositories(db);

  repos.projects.create({
    id: 'proj-chatgpt-1',
    creator: 'Marques Brownlee',
    topic: 'Career milestones',
    origin: PROJECT_ORIGINS.CHATGPT_MCP,
    idempotencyKey: 'chatgpt-run-999',
    handoffFingerprint: 'a'.repeat(64),
    status: 'research_ready',
  });

  db.close();
  db = openDatabase(dbPath);
  repos = createRepositories(db);

  const project = repos.projects.get('proj-chatgpt-1');
  assert.equal(project.origin, PROJECT_ORIGINS.CHATGPT_MCP);
  assert.equal(project.idempotencyKey, 'chatgpt-run-999');
  assert.equal(project.handoffFingerprint, 'a'.repeat(64));

  const byKey = repos.projects.getByIdempotencyKey('chatgpt-run-999');
  assert.equal(byKey?.id, 'proj-chatgpt-1');

  db.close();
});

test('duplicate idempotency_key violates unique constraint and prevents duplicate projects', () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  const repos = createRepositories(db);

  repos.projects.create({
    id: 'proj-1',
    creator: 'Creator',
    topic: 'Topic',
    origin: PROJECT_ORIGINS.CHATGPT_MCP,
    idempotencyKey: 'key-duplicate',
  });

  assert.throws(
    () => repos.projects.create({
      id: 'proj-2',
      creator: 'Creator',
      topic: 'Topic',
      origin: PROJECT_ORIGINS.CHATGPT_MCP,
      idempotencyKey: 'key-duplicate',
    }),
    /UNIQUE constraint failed/i,
  );

  db.close();
});

test('approval provenance (mode, actor, context) is stored and survives database reopen', () => {
  const dbPath = tempDbPath();
  let db = openDatabase(dbPath);
  migrateDatabase(db);
  let repos = createRepositories(db);

  repos.projects.create({
    id: 'proj-appr-1',
    creator: 'Creator',
    topic: 'Topic',
    status: 'review_required',
  });

  const payload = {
    creatorName: 'Creator',
    summary: 'Summary',
    claims: [{id: 'c-1', text: 'Text', sourceIds: ['src-1'], verified: true}],
    script: [{id: 's-1', text: 'Opening', start: 0, duration: 5, sourceIds: ['src-1']}],
    voiceover: {chunks: [{id: 'v-1', text: 'Opening', start: 0, duration: 5, sourceIds: ['src-1']}]},
    scenes: [{id: 'sc-1', type: 'hero', start: 0, duration: 5, sourceIds: ['src-1']}],
    render: {duration: 5},
  };
  const payloadHash = 'c'.repeat(64);

  repos.revisions.create({
    id: 'rev-1',
    projectId: 'proj-appr-1',
    revisionNo: 1,
    payload,
    payloadHash,
  });

  repos.revisions.approve({
    projectId: 'proj-appr-1',
    revisionId: 'rev-1',
    expectedPayloadHash: payloadHash,
    approvalMode: APPROVAL_MODES.USER_REVIEWED,
    approvalActor: 'chatgpt_mcp_noauth',
    approvalContext: {semantic: 'external_review_acknowledged'},
  });

  db.close();
  db = openDatabase(dbPath);
  repos = createRepositories(db);

  const rev = repos.revisions.get('rev-1');
  assert.equal(rev.approvalMode, APPROVAL_MODES.USER_REVIEWED);
  assert.equal(rev.approvalActor, 'chatgpt_mcp_noauth');
  assert.deepEqual(rev.approvalContext, {semantic: 'external_review_acknowledged'});

  db.close();
});
