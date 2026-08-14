import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-current-stage-')), 'app.sqlite');

test('generic project controls select the most recently inserted stage when timestamps tie', () => {
  const db = openDatabase(tempDatabasePath());
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required'});
  const jobs = createJobStore(db);
  const createdAt = '2026-08-14T02:00:00.000Z';

  jobs.enqueue({
    id: 'z-old-stage',
    logicalKey: 'project-1:old',
    projectId: 'project-1',
    type: 'generation',
    maxAttempts: 3,
    availableAtMs: 1000,
    createdAt,
  });
  jobs.enqueue({
    id: 'a-new-stage',
    logicalKey: 'project-1:new',
    projectId: 'project-1',
    type: 'tts',
    maxAttempts: 3,
    availableAtMs: 1000,
    createdAt,
  });

  assert.equal(jobs.getCurrentStage('project-1').id, 'a-new-stage');
  db.close();
});
