import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {ErrorCodes} from '../../domain/errors.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-artifact-fence-')), 'app.sqlite');

const setup = () => {
  const databasePath = tempDatabasePath();
  const dbA = openDatabase(databasePath);
  migrateDatabase(dbA);
  const repos = createRepositories(dbA);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required'});
  repos.revisions.create({
    id: 'revision-1',
    projectId: 'project-1',
    revisionNo: 1,
    payload: {version: 1},
    payloadHash: 'a'.repeat(64),
  });
  const dbB = openDatabase(databasePath);
  const options = {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100};
  return {
    dbA,
    dbB,
    jobsA: createJobStore(dbA, options),
    jobsB: createJobStore(dbB, options),
  };
};

test('reclaimed attempt cannot promote an artifact registered by the stale attempt', () => {
  const {dbA, dbB, jobsA, jobsB} = setup();
  jobsA.enqueue({
    id: 'stage-1',
    logicalKey: 'project-1:revision-1:media_ingest',
    projectId: 'project-1',
    revisionId: 'revision-1',
    type: 'media_ingest',
    maxAttempts: 3,
    availableAtMs: 0,
  });

  const attemptA = jobsA.claimNext({workerId: 'worker-a', nowMs: 1000, allowedTypes: ['media_ingest']});
  const artifactA = jobsA.registerArtifact({
    id: 'artifact-a',
    stageId: 'stage-1',
    claimToken: attemptA.claimToken,
    kind: 'media',
    relativePath: 'artifacts/a.bin',
    sha256: 'b'.repeat(64),
    byteSize: 10,
    nowMs: 1010,
  });
  assert.equal(artifactA.attemptId, attemptA.attemptId);

  assert.deepEqual(jobsB.recoverExpired({nowMs: 1101}), {recovered: 1, exhausted: 0});
  const attemptB = jobsB.claimNext({workerId: 'worker-b', nowMs: 1111, allowedTypes: ['media_ingest']});
  assert.notEqual(attemptB.attemptId, attemptA.attemptId);

  assert.throws(
    () => jobsB.promoteArtifact({
      stageId: 'stage-1',
      claimToken: attemptB.claimToken,
      artifactId: 'artifact-a',
      nowMs: 1112,
    }),
    (error) => error.code === ErrorCodes.INVALID_TRANSITION,
  );
  assert.equal(jobsB.listArtifacts('stage-1').find((entry) => entry.id === 'artifact-a').isAuthoritative, false);

  jobsB.registerArtifact({
    id: 'artifact-b',
    stageId: 'stage-1',
    claimToken: attemptB.claimToken,
    kind: 'media',
    relativePath: 'artifacts/b.bin',
    sha256: 'c'.repeat(64),
    byteSize: 11,
    nowMs: 1113,
  });
  jobsB.promoteArtifact({
    stageId: 'stage-1',
    claimToken: attemptB.claimToken,
    artifactId: 'artifact-b',
    nowMs: 1114,
  });
  assert.equal(jobsB.listArtifacts('stage-1').find((entry) => entry.id === 'artifact-b').isAuthoritative, true);

  dbB.close();
  dbA.close();
});
