import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {ErrorCodes} from '../../domain/errors.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-approval-content-race-')), 'app.sqlite');

test('approval cannot commit a revision whose payload hash changed after validation', () => {
  const databasePath = tempDatabasePath();
  const seedDb = openDatabase(databasePath);
  migrateDatabase(seedDb);
  const seedRepos = createRepositories(seedDb);
  seedRepos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required'});
  seedRepos.revisions.create({
    id: 'revision-1',
    projectId: 'project-1',
    revisionNo: 1,
    payload: {version: 1},
    payloadHash: 'a'.repeat(64),
  });
  seedDb.close();

  const approveDb = openDatabase(databasePath);
  const editDb = openDatabase(databasePath);
  const approveRepos = createRepositories(approveDb);
  const editRepos = createRepositories(editDb);
  const validated = approveRepos.revisions.get('revision-1');

  editRepos.revisions.editCurrent({
    projectId: 'project-1',
    revisionId: 'unused-revision',
    payload: {version: 2},
    payloadHash: 'b'.repeat(64),
    updatedAt: '2026-08-14T05:30:00.000Z',
  });

  assert.throws(
    () => approveRepos.revisions.approve({
      projectId: 'project-1',
      revisionId: 'revision-1',
      expectedPayloadHash: validated.payloadHash,
      approvedAt: '2026-08-14T05:30:01.000Z',
    }),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );

  const project = approveRepos.projects.get('project-1');
  const revision = approveRepos.revisions.get('revision-1');
  assert.equal(project.status, 'review_required');
  assert.equal(project.approvedRevisionId, null);
  assert.deepEqual(revision.payload, {version: 2});
  assert.equal(revision.payloadHash, 'b'.repeat(64));
  assert.equal(revision.approvedAt, null);
  editDb.close();
  approveDb.close();
});
