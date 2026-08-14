import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {ErrorCodes} from '../../domain/errors.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-research-fence-')), 'app.sqlite');

const result = (label) => ({
  bundle: {schemaVersion: '1.0', label},
  sources: [{url: `https://${label}.example/source`, title: `${label} source`}],
  unavailableSources: [],
});

test('reclaimed research stage rejects stale result commit and only current attempt publishes', () => {
  const db = openDatabase(tempDatabasePath());
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.createWithSources({
    id: 'project-1',
    creator: 'Creator',
    topic: 'Profile',
    status: 'draft',
  }, [{
    id: 'input-source',
    projectId: 'project-1',
    url: 'https://operator.example/source',
    status: 'pending',
    payload: {operatorInput: true},
  }]);
  let sourceNo = 0;
  const jobs = createJobStore(db, {
    leaseMs: 100,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    sourceIdFactory: () => `source-${++sourceNo}`,
  });

  jobs.startResearch({projectId: 'project-1', stageId: 'research-stage', nowMs: 1000, maxAttempts: 3});
  const attemptA = jobs.claimNext({workerId: 'worker-a', nowMs: 1000, allowedTypes: ['research']});
  assert.ok(attemptA);
  assert.deepEqual(jobs.recoverExpired({nowMs: 1101}), {recovered: 1, exhausted: 0});
  const attemptB = jobs.claimNext({workerId: 'worker-b', nowMs: 1111, allowedTypes: ['research']});
  assert.ok(attemptB);
  assert.notEqual(attemptA.claimToken, attemptB.claimToken);

  assert.throws(
    () => jobs.commitResearch({
      stageId: 'research-stage',
      claimToken: attemptA.claimToken,
      result: result('stale'),
      nowMs: 1112,
    }),
    (error) => error.code === ErrorCodes.STALE_CLAIM,
  );
  assert.equal(repos.projects.get('project-1').research, null);
  assert.deepEqual(repos.sources.list('project-1').map((source) => source.id), ['input-source']);

  jobs.commitResearch({
    stageId: 'research-stage',
    claimToken: attemptB.claimToken,
    result: result('current'),
    nowMs: 1113,
  });
  assert.equal(jobs.getStage('research-stage').state, 'succeeded');
  assert.equal(repos.projects.get('project-1').status, 'research_ready');
  assert.equal(repos.projects.get('project-1').research.label, 'current');
  assert.deepEqual(repos.sources.list('project-1').map((source) => source.url), ['https://current.example/source']);
  db.close();
});
