import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-approval-race-')), 'app.sqlite');

const setupApproved = () => {
  const databasePath = tempDatabasePath();
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required'});
  repos.revisions.create({
    id: 'revision-1', projectId: 'project-1', revisionNo: 1,
    payload: {version: 1}, payloadHash: 'a'.repeat(64),
  });
  repos.revisions.approve({
    projectId: 'project-1', revisionId: 'revision-1', approvedAt: '2026-08-13T00:00:00.000Z',
  });
  db.close();
  return databasePath;
};

const stageRecord = () => ({
  id: 'stage-1',
  logicalKey: 'project-1:revision-1:media_ingest',
  projectId: 'project-1',
  revisionId: 'revision-1',
  type: 'media_ingest',
  state: 'queued',
  maxAttempts: 3,
  availableAtMs: 0,
  createdAt: '2026-08-13T00:00:01.000Z',
});

test('approved edit wins before descendant creation and later descendant creation is rejected', () => {
  const databasePath = setupApproved();
  const dbEdit = openDatabase(databasePath);
  const dbDescendant = openDatabase(databasePath);
  const edit = createRepositories(dbEdit).approval.invalidateForEdit;
  const createDescendant = createRepositories(dbDescendant).approval.createFirstDescendant;

  const edited = edit({
    projectId: 'project-1',
    expectedRevisionId: 'revision-1',
    updatedAt: '2026-08-13T00:00:02.000Z',
  });
  assert.equal(edited.status, 'review_required');
  assert.equal(edited.approvedRevisionId, null);

  assert.throws(
    () => createDescendant(stageRecord()),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );
  assert.equal(createRepositories(dbDescendant).approval.getBarrier('project-1').hasDescendantStage, false);
  dbDescendant.close();
  dbEdit.close();
});

test('first descendant wins while the same revision is approved and later edit is rejected without mutation', () => {
  const databasePath = setupApproved();
  const dbDescendant = openDatabase(databasePath);
  const dbEdit = openDatabase(databasePath);
  const descendantRepos = createRepositories(dbDescendant);
  const editRepos = createRepositories(dbEdit);

  const stage = descendantRepos.approval.createFirstDescendant(stageRecord());
  assert.equal(stage.type, 'media_ingest');
  assert.equal(descendantRepos.approval.getBarrier('project-1').hasDescendantStage, true);

  const before = editRepos.approval.getBarrier('project-1');
  assert.throws(
    () => editRepos.approval.invalidateForEdit({
      projectId: 'project-1',
      expectedRevisionId: 'revision-1',
      updatedAt: '2026-08-13T00:00:02.000Z',
    }),
    (error) => error.code === ErrorCodes.DOWNSTREAM_WORK_STARTED,
  );
  assert.deepEqual(editRepos.approval.getBarrier('project-1'), before);
  dbEdit.close();
  dbDescendant.close();
});
