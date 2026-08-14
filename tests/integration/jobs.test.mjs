import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-jobs-')), 'app.sqlite');
const setup = (databasePath = tempDatabasePath()) => {
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required'});
  repos.revisions.create({id: 'revision-1', projectId: 'project-1', revisionNo: 1, payload: {version: 1}, payloadHash: 'a'.repeat(64)});
  return {db, repos, databasePath};
};
const enqueue = (jobs, overrides = {}) => jobs.enqueue({
  id: overrides.id ?? 'stage-1',
  logicalKey: overrides.logicalKey ?? 'project-1:revision-1:media_ingest',
  projectId: 'project-1', revisionId: 'revision-1', type: 'media_ingest',
  maxAttempts: overrides.maxAttempts ?? 3, availableAtMs: overrides.availableAtMs ?? 0,
});
const claim = (jobs, workerId, nowMs) => jobs.claimNext({workerId, nowMs, allowedTypes: ['media_ingest']});
const staleClaim = (fn) => assert.throws(fn, (error) => error.code === ErrorCodes.STALE_CLAIM);

test('only one worker claims a queued stage and a live lease cannot be stolen', () => {
  const {db, databasePath} = setup();
  const db2 = openDatabase(databasePath);
  const jobsA = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  const jobsB = createJobStore(db2, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobsA);
  const first = claim(jobsA, 'worker-a', 1000);
  assert.ok(first?.claimToken);
  assert.equal(first.attemptNo, 1);
  assert.equal(claim(jobsB, 'worker-b', 1050), null);
  assert.equal(jobsB.getStage('stage-1').state, 'running');
  db2.close();
  db.close();
});

test('heartbeat renews only a current live claim', () => {
  const {db} = setup();
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs);
  const current = claim(jobs, 'worker-a', 1000);
  assert.equal(jobs.heartbeat({stageId: 'stage-1', claimToken: current.claimToken, nowMs: 1050}).leaseExpiresAtMs, 1150);
  staleClaim(() => jobs.heartbeat({stageId: 'stage-1', claimToken: 'wrong-token', nowMs: 1060}));
  staleClaim(() => jobs.heartbeat({stageId: 'stage-1', claimToken: current.claimToken, nowMs: 1150}));
  db.close();
});

test('expired recovery fences stale ownership and reclaims with bounded backoff', () => {
  const {db, databasePath} = setup();
  const db2 = openDatabase(databasePath);
  const jobsA = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  const jobsB = createJobStore(db2, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobsA);
  const oldClaim = claim(jobsA, 'worker-a', 1000);
  assert.deepEqual(jobsB.recoverExpired({nowMs: 1101}), {recovered: 1, exhausted: 0});
  assert.equal(jobsB.getStage('stage-1').availableAtMs, 1111);
  staleClaim(() => jobsA.updateProgress({stageId: 'stage-1', claimToken: oldClaim.claimToken, progress: {pct: 50}, nowMs: 1102}));
  staleClaim(() => jobsA.complete({stageId: 'stage-1', claimToken: oldClaim.claimToken, nowMs: 1102}));
  assert.equal(claim(jobsB, 'worker-b', 1110), null);
  const newClaim = claim(jobsB, 'worker-b', 1111);
  assert.notEqual(newClaim.claimToken, oldClaim.claimToken);
  staleClaim(() => jobsA.fail({stageId: 'stage-1', claimToken: oldClaim.claimToken, nowMs: 1112, retryable: true, errorCode: 'OLD'}));
  jobsB.complete({stageId: 'stage-1', claimToken: newClaim.claimToken, nowMs: 1120});
  assert.equal(jobsB.getStage('stage-1').state, 'succeeded');
  assert.equal(jobsB.listAttempts('stage-1').filter((entry) => entry.status === 'succeeded').length, 1);
  db2.close();
  db.close();
});

test('exhausted automatic attempts record a terminal failed stage', () => {
  const {db} = setup();
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs, {maxAttempts: 1});
  claim(jobs, 'worker-a', 1000);
  assert.deepEqual(jobs.recoverExpired({nowMs: 1101}), {recovered: 0, exhausted: 1});
  const stage = jobs.getStage('stage-1');
  assert.equal(stage.state, 'failed');
  assert.equal(stage.retryable, false);
  assert.equal(stage.errorCode, 'ATTEMPTS_EXHAUSTED');
  db.close();
});

test('operator retry is restricted and idempotent while a retry is active', () => {
  const {db, repos} = setup();
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs);
  const first = claim(jobs, 'worker-a', 1000);
  jobs.fail({stageId: 'stage-1', claimToken: first.claimToken, nowMs: 1020, retryable: true, errorCode: 'TEMP'});
  assert.equal(jobs.retry({stageId: 'stage-1', nowMs: 1030}).changed, true);
  assert.equal(jobs.retry({stageId: 'stage-1', nowMs: 1031}).changed, false);
  const second = claim(jobs, 'worker-b', 1040);
  assert.equal(second.attemptNo, 2);
  assert.equal(jobs.retry({stageId: 'stage-1', nowMs: 1041}).changed, false);
  assert.equal(repos.projects.get('project-1').currentRevisionId, 'revision-1');
  jobs.fail({stageId: 'stage-1', claimToken: second.claimToken, nowMs: 1050, retryable: false, errorCode: 'BAD'});
  assert.throws(() => jobs.retry({stageId: 'stage-1', nowMs: 1060}), (error) => error.code === ErrorCodes.STAGE_NOT_RETRYABLE);
  db.close();
});

test('cancel invalidates ownership and repeated cancel is a zero-mutation no-op', () => {
  const {db} = setup();
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs);
  const current = claim(jobs, 'worker-a', 1000);
  const beforeAttempts = jobs.listAttempts('stage-1');
  assert.equal(jobs.cancel({stageId: 'stage-1', nowMs: 1010}).changed, true);
  const cancelled = jobs.getStage('stage-1');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.currentClaimToken, null);
  staleClaim(() => jobs.complete({stageId: 'stage-1', claimToken: current.claimToken, nowMs: 1011}));
  staleClaim(() => jobs.updateProgress({stageId: 'stage-1', claimToken: current.claimToken, progress: {pct: 99}, nowMs: 1011}));
  const repeated = jobs.cancel({stageId: 'stage-1', nowMs: 1020});
  assert.equal(repeated.changed, false);
  assert.equal(repeated.stage.updatedAt, cancelled.updatedAt);
  assert.equal(jobs.listAttempts('stage-1').length, beforeAttempts.length);
  assert.equal(claim(jobs, 'worker-b', 2000), null);
  db.close();
});

test('draft and artifact writes are fenced by the current claim token', () => {
  const {db, repos} = setup();
  const jobs = createJobStore(db, {leaseMs: 100, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs);
  const current = claim(jobs, 'worker-a', 1000);
  jobs.persistDraft({stageId: 'stage-1', claimToken: current.claimToken, revisionId: 'revision-1', payload: {version: 2}, payloadHash: 'b'.repeat(64), nowMs: 1010});
  assert.deepEqual(repos.revisions.get('revision-1').payload, {version: 2});
  staleClaim(() => jobs.persistDraft({stageId: 'stage-1', claimToken: 'wrong', revisionId: 'revision-1', payload: {version: 3}, payloadHash: 'c'.repeat(64), nowMs: 1011}));
  jobs.registerArtifact({id: 'artifact-1', stageId: 'stage-1', claimToken: current.claimToken, kind: 'media', relativePath: 'artifacts/a.bin', sha256: 'd'.repeat(64), byteSize: 10, nowMs: 1012});
  jobs.registerArtifact({id: 'artifact-2', stageId: 'stage-1', claimToken: current.claimToken, kind: 'media', relativePath: 'artifacts/b.bin', sha256: 'e'.repeat(64), byteSize: 11, nowMs: 1013});
  staleClaim(() => jobs.promoteArtifact({stageId: 'stage-1', claimToken: 'wrong', artifactId: 'artifact-2', nowMs: 1014}));
  jobs.promoteArtifact({stageId: 'stage-1', claimToken: current.claimToken, artifactId: 'artifact-2', nowMs: 1015});
  const artifacts = jobs.listArtifacts('stage-1');
  assert.equal(artifacts.find((entry) => entry.id === 'artifact-1').isAuthoritative, false);
  assert.equal(artifacts.find((entry) => entry.id === 'artifact-2').isAuthoritative, true);
  db.close();
});

test('graceful runner stop prevents new claims while current work finishes durably', async () => {
  const {db} = setup();
  const jobs = createJobStore(db, {leaseMs: 1000, baseBackoffMs: 10, maxBackoffMs: 100});
  enqueue(jobs);
  enqueue(jobs, {id: 'stage-2', logicalKey: 'project-1:revision-1:media_ingest:second'});
  let release;
  let startedResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const runner = createJobRunner({
    jobs, workerId: 'worker-runner', leaseMs: 1000, heartbeatMs: 500, now: () => 1000,
    handlers: {media_ingest: async () => { startedResolve(); await gate; }},
  });
  const running = runner.runOnce();
  await started;
  runner.stop();
  release();
  assert.equal(await running, true);
  assert.equal(await runner.runOnce(), false);
  assert.equal(jobs.getStage('stage-1').state, 'succeeded');
  assert.equal(jobs.getStage('stage-2').state, 'queued');
  db.close();
});
