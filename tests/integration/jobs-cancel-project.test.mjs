import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const databasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-cancel-')), 'app.sqlite');

test('cancelling active durable work transactionally cancels both stage and project', () => {
  const db = openDatabase(databasePath());
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'media_ingest'});
  repos.revisions.create({
    id: 'revision-1', projectId: 'project-1', revisionNo: 1,
    payload: {version: 1}, payloadHash: 'a'.repeat(64),
  });
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  jobs.enqueue({
    id: 'stage-1', logicalKey: 'project-1:revision-1:media_ingest', projectId: 'project-1',
    revisionId: 'revision-1', type: 'media_ingest', maxAttempts: 3, availableAtMs: 0,
  });
  jobs.claimNext({workerId: 'worker-a', nowMs: 1000, allowedTypes: ['media_ingest']});

  const first = jobs.cancel({stageId: 'stage-1', nowMs: 1010});
  assert.equal(first.changed, true);
  assert.equal(jobs.getStage('stage-1').state, 'cancelled');
  assert.equal(repos.projects.get('project-1').status, 'cancelled');

  const projectBefore = repos.projects.get('project-1');
  const second = jobs.cancel({stageId: 'stage-1', nowMs: 1020});
  assert.equal(second.changed, false);
  assert.equal(repos.projects.get('project-1').updatedAt, projectBefore.updatedAt);
  db.close();
});
