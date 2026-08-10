import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {retryDelayMs} from '../../domain/workflow.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const T0 = '2026-08-10T00:00:00.000Z';
const at = (milliseconds) => new Date(Date.parse(T0) + milliseconds);

function makeFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-jobs-'));
  const filename = path.join(directory, 'app.sqlite');
  const db = openDatabase({filename});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  repositories.projects.create({
    id: 'project-1',
    topic: 'Creator profile',
    status: 'draft',
    input: {topic: 'Creator profile'},
  });

  return {
    directory,
    filename,
    db,
    repositories,
    store: createJobStore(db),
    close() {
      if (db.open) db.close();
      rmSync(directory, {recursive: true, force: true});
    },
  };
}

function createJob(repositories, {id = 'job-1', maxAttempts = 3, stage = 'researching'} = {}) {
  return repositories.jobs.create({
    id,
    projectId: 'project-1',
    stage,
    status: 'queued',
    maxAttempts,
  });
}

test('only one claimant can acquire a runnable job across two SQLite connections', () => {
  const fixture = makeFixture();
  const secondDb = openDatabase({filename: fixture.filename});
  try {
    createJob(fixture.repositories);
    const secondStore = createJobStore(secondDb);

    const firstClaim = fixture.store.claimNext({workerId: 'worker-a', now: at(0), leaseMs: 60_000});
    const competingClaim = secondStore.claimNext({workerId: 'worker-b', now: at(0), leaseMs: 60_000});

    assert.equal(firstClaim.id, 'job-1');
    assert.equal(firstClaim.status, 'running');
    assert.equal(firstClaim.leaseOwner, 'worker-a');
    assert.equal(firstClaim.attempt, 1);
    assert.equal(competingClaim, null);
  } finally {
    secondDb.close();
    fixture.close();
  }
});

test('live lease cannot be stolen and an expired lease is recoverable by another worker', () => {
  const fixture = makeFixture();
  const secondDb = openDatabase({filename: fixture.filename});
  try {
    createJob(fixture.repositories);
    const secondStore = createJobStore(secondDb);

    fixture.store.claimNext({workerId: 'worker-a', now: at(0), leaseMs: 1_000});
    assert.equal(secondStore.claimNext({workerId: 'worker-b', now: at(500), leaseMs: 1_000}), null);

    const recovered = secondStore.claimNext({workerId: 'worker-b', now: at(1_001), leaseMs: 1_000});
    assert.equal(recovered.id, 'job-1');
    assert.equal(recovered.leaseOwner, 'worker-b');
    assert.equal(recovered.attempt, 2);
  } finally {
    secondDb.close();
    fixture.close();
  }
});

test('heartbeat extends a live lease but cannot revive an already expired lease', () => {
  const fixture = makeFixture();
  try {
    createJob(fixture.repositories);
    fixture.store.claimNext({workerId: 'worker-a', now: at(0), leaseMs: 1_000});

    const renewed = fixture.store.heartbeat({
      jobId: 'job-1',
      workerId: 'worker-a',
      now: at(500),
      leaseMs: 2_000,
    });
    assert.equal(renewed.leaseExpiresAt, at(2_500).toISOString());

    assert.throws(
      () => fixture.store.heartbeat({
        jobId: 'job-1',
        workerId: 'worker-a',
        now: at(2_501),
        leaseMs: 2_000,
      }),
      (error) => error instanceof AppError && error.code === 'JOB_LEASE_LOST',
    );
  } finally {
    fixture.close();
  }
});

test('retryable failure respects backoff and max attempts while non-retryable failure stops immediately', () => {
  const fixture = makeFixture();
  try {
    createJob(fixture.repositories, {id: 'retryable', maxAttempts: 2});
    fixture.store.claimNext({workerId: 'worker-a', now: at(0), leaseMs: 60_000});
    const queued = fixture.store.fail({
      jobId: 'retryable',
      workerId: 'worker-a',
      now: at(100),
      retryable: true,
      retryAt: at(5_000),
      errorCode: 'TEMPORARY_PROVIDER_ERROR',
      errorMessage: 'temporary failure',
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.runAfter, at(5_000).toISOString());
    assert.equal(fixture.store.claimNext({workerId: 'worker-b', now: at(4_999), leaseMs: 60_000}), null);

    const secondAttempt = fixture.store.claimNext({workerId: 'worker-b', now: at(5_000), leaseMs: 60_000});
    assert.equal(secondAttempt.attempt, 2);
    const exhausted = fixture.store.fail({
      jobId: 'retryable',
      workerId: 'worker-b',
      now: at(5_100),
      retryable: true,
      retryAt: at(10_000),
      errorCode: 'TEMPORARY_PROVIDER_ERROR',
      errorMessage: 'still failing',
    });
    assert.equal(exhausted.status, 'failed');
    assert.equal(fixture.store.claimNext({workerId: 'worker-c', now: at(20_000), leaseMs: 60_000}), null);

    createJob(fixture.repositories, {id: 'fatal', maxAttempts: 3});
    fixture.store.claimNext({workerId: 'worker-a', now: at(20_001), leaseMs: 60_000});
    const fatal = fixture.store.fail({
      jobId: 'fatal',
      workerId: 'worker-a',
      now: at(20_100),
      retryable: false,
      errorCode: 'INVALID_INPUT',
      errorMessage: 'not retryable',
    });
    assert.equal(fatal.status, 'failed');
    assert.equal(fatal.attempt, 1);
  } finally {
    fixture.close();
  }
});

test('retry delay is exponential and bounded', () => {
  assert.equal(retryDelayMs(1, {baseMs: 1_000, maxMs: 10_000}), 1_000);
  assert.equal(retryDelayMs(2, {baseMs: 1_000, maxMs: 10_000}), 2_000);
  assert.equal(retryDelayMs(8, {baseMs: 1_000, maxMs: 10_000}), 10_000);
});

test('job runner completes a stage once and does not re-run a succeeded job', async () => {
  const fixture = makeFixture();
  try {
    createJob(fixture.repositories);
    let handlerCalls = 0;
    const runner = createJobRunner({
      jobStore: fixture.store,
      workerId: 'worker-a',
      leaseMs: 60_000,
      clock: () => at(0),
      handlers: {
        researching: async ({job}) => {
          handlerCalls += 1;
          fixture.repositories.artifacts.create({
            id: `stage-result-${job.id}`,
            projectId: job.projectId,
            kind: 'stage-result',
            relativePath: `projects/${job.projectId}/stage-result.json`,
            contentHash: 'sha256:result',
          });
        },
      },
    });

    const completed = await runner.runOnce();
    const noWork = await runner.runOnce();

    assert.equal(completed.status, 'succeeded');
    assert.equal(noWork, null);
    assert.equal(handlerCalls, 1);
    assert.equal(fixture.repositories.artifacts.listByProject('project-1').length, 1);
    assert.equal(fixture.store.complete({jobId: 'job-1', workerId: 'worker-a', now: at(0)}).status, 'succeeded');
  } finally {
    fixture.close();
  }
});

test('job runner stops claiming new work during graceful shutdown', async () => {
  const fixture = makeFixture();
  try {
    createJob(fixture.repositories);
    const runner = createJobRunner({
      jobStore: fixture.store,
      workerId: 'worker-a',
      handlers: {researching: async () => {}},
      shouldStop: () => true,
      clock: () => at(0),
    });

    assert.equal(await runner.runOnce(), null);
    assert.equal(fixture.store.get('job-1').status, 'queued');
  } finally {
    fixture.close();
  }
});
