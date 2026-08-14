import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createMediaIngestStageHandler} from '../../app/services/ingest-media.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const seedApprovedMediaStage = (repos) => {
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', status: 'review_required'});
  repos.revisions.create({
    id: 'revision-1', projectId: 'project-1', revisionNo: 1,
    payload: {creatorName: 'Creator'}, payloadHash: 'a'.repeat(64),
  });
  repos.revisions.approve({
    projectId: 'project-1', revisionId: 'revision-1', expectedPayloadHash: 'a'.repeat(64),
    approvedAt: '2026-08-14T00:00:00.000Z',
  });
  repos.approval.createFirstDescendant({
    id: 'media-stage', projectId: 'project-1', revisionId: 'revision-1', type: 'media_ingest',
    state: 'queued', maxAttempts: 3, availableAtMs: 1,
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
  });
};

const prepared = (suffix = 'current') => ({
  mediaArtifacts: [{
    kind: 'media_input', relativePath: `projects/p/attempts/${suffix}/media/input.png`,
    mimeType: 'image/png', byteSize: 8, sha256: 'b'.repeat(64),
  }],
  manifestArtifact: {
    kind: 'media_manifest', relativePath: `projects/p/attempts/${suffix}/media/manifest.json`,
    mimeType: 'application/json', byteSize: 8, sha256: 'c'.repeat(64),
  },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
};

test('cancelling blocked media ingest fences late publication and does not enqueue TTS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-media-cancel-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000, baseBackoffMs: 1, maxBackoffMs: 1});
  const artifacts = createArtifactStore(db);
  seedApprovedMediaStage(repos);

  const gate = deferred();
  const started = deferred();
  const service = {
    async ingest() {
      started.resolve();
      await gate.promise;
      return prepared('cancelled');
    },
  };
  const handler = createMediaIngestStageHandler({repos, artifactStore: artifacts, service, nextMaxAttempts: 3});
  const runner = createJobRunner({jobs, workerId: 'worker-a', handlers: {media_ingest: handler}, leaseMs: 1000, now: () => 1});

  const running = runner.runOnce();
  await started.promise;
  jobs.cancel({stageId: 'media-stage', nowMs: 2});
  gate.resolve();
  await running;

  assert.equal(jobs.getStage('media-stage').state, 'cancelled');
  assert.equal(repos.projects.get('project-1').status, 'cancelled');
  assert.equal(artifacts.getAuthoritative('project-1', 'revision-1', 'media_manifest'), undefined);
  assert.equal(db.prepare("SELECT count(*) AS count FROM stages WHERE stage_type = 'tts'").get().count, 0);
  db.close();
});

test('lease recovery lets one replacement media owner publish and fences the late stale owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-media-reclaim-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000, baseBackoffMs: 1, maxBackoffMs: 1});
  const artifacts = createArtifactStore(db);
  seedApprovedMediaStage(repos);

  let call = 0;
  const staleGate = deferred();
  const staleStarted = deferred();
  const service = {
    async ingest() {
      call += 1;
      if (call === 1) {
        staleStarted.resolve();
        await staleGate.promise;
        return prepared('stale');
      }
      return prepared('replacement');
    },
  };
  const handler = createMediaIngestStageHandler({repos, artifactStore: artifacts, service, nextMaxAttempts: 3});
  let nowMs = 1;
  const staleRunner = createJobRunner({jobs, workerId: 'worker-a', handlers: {media_ingest: handler}, leaseMs: 1000, now: () => nowMs});
  const staleRun = staleRunner.runOnce();
  await staleStarted.promise;

  jobs.recoverExpired({nowMs: 1001});
  nowMs = 1002;
  const replacementRunner = createJobRunner({jobs, workerId: 'worker-b', handlers: {media_ingest: handler}, leaseMs: 1000, now: () => nowMs});
  assert.equal(await replacementRunner.runOnce(), true);
  staleGate.resolve();
  await staleRun;

  const authoritative = artifacts.getAuthoritative('project-1', 'revision-1', 'media_manifest');
  assert.equal(authoritative.relativePath.includes('/replacement/'), true);
  assert.equal(db.prepare("SELECT count(*) AS count FROM artifacts WHERE kind = 'media_manifest'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM stages WHERE stage_type = 'tts'").get().count, 1);
  assert.equal(repos.projects.get('project-1').status, 'tts');
  db.close();
});
