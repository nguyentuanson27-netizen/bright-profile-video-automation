import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';

const seedApproved = (repos) => {
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', status: 'review_required'});
  repos.revisions.create({
    id: 'revision-1',
    projectId: 'project-1',
    revisionNo: 1,
    payload: {creatorName: 'Creator'},
    payloadHash: 'a'.repeat(64),
  });
  repos.revisions.approve({
    projectId: 'project-1',
    revisionId: 'revision-1',
    expectedPayloadHash: 'a'.repeat(64),
    approvedAt: '2026-08-14T00:00:00.000Z',
  });
  repos.approval.createFirstDescendant({
    id: 'media-stage',
    projectId: 'project-1',
    revisionId: 'revision-1',
    type: 'media_ingest',
    state: 'queued',
    maxAttempts: 3,
    availableAtMs: 1,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  });
};

const artifact = (kind, relativePath) => ({
  kind,
  relativePath,
  mimeType: kind === 'output_mp4' ? 'video/mp4' : 'application/json',
  byteSize: 8,
  sha256: 'b'.repeat(64),
});

test('media -> tts -> render commits are fenced, atomic, and publish one authoritative chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-pipeline-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000, baseBackoffMs: 1, maxBackoffMs: 1});
  const ids = ['artifact-media', 'tts-stage', 'artifact-tts', 'render-stage', 'artifact-output'];
  const artifacts = createArtifactStore(db, {idFactory: () => ids.shift()});
  seedApproved(repos);

  const mediaClaim = jobs.claimNext({workerId: 'worker-a', nowMs: 1, allowedTypes: ['media_ingest']});
  const mediaResult = artifacts.commitMediaIngest({
    stageId: mediaClaim.stageId,
    claimToken: mediaClaim.claimToken,
    nowMs: 2,
    manifestArtifact: artifact('media_manifest', 'projects/p/attempts/a/media/manifest.json'),
    mediaArtifacts: [artifact('media_input', 'projects/p/attempts/a/media/media-000.png')],
    nextMaxAttempts: 3,
  });
  assert.equal(mediaResult.nextStage.type, 'tts');
  assert.equal(repos.projects.get('project-1').status, 'tts');
  assert.equal(artifacts.getAuthoritative('project-1', 'revision-1', 'media_manifest').relativePath.endsWith('manifest.json'), true);

  const ttsClaim = jobs.claimNext({workerId: 'worker-a', nowMs: 3, allowedTypes: ['tts']});
  const ttsResult = artifacts.commitTts({
    stageId: ttsClaim.stageId,
    claimToken: ttsClaim.claimToken,
    nowMs: 4,
    audioArtifact: artifact('tts_audio', 'projects/p/attempts/b/tts/voice.mp3'),
    nextMaxAttempts: 3,
  });
  assert.equal(ttsResult.nextStage.type, 'render');
  assert.equal(repos.projects.get('project-1').status, 'render_queued');

  const renderClaim = jobs.claimNext({workerId: 'worker-a', nowMs: 5, allowedTypes: ['render']});
  artifacts.markRendering({stageId: renderClaim.stageId, claimToken: renderClaim.claimToken, nowMs: 6});
  artifacts.commitRender({
    stageId: renderClaim.stageId,
    claimToken: renderClaim.claimToken,
    nowMs: 7,
    outputArtifact: artifact('output_mp4', 'projects/p/attempts/c/render/output.mp4'),
  });
  assert.equal(repos.projects.get('project-1').status, 'completed');
  assert.equal(artifacts.getAuthoritative('project-1', 'revision-1', 'output_mp4').isAuthoritative, true);
  db.close();
});

test('a reclaimed or cancelled media owner cannot publish artifacts or enqueue TTS', () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-pipeline-stale-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 10, baseBackoffMs: 1, maxBackoffMs: 1});
  const artifacts = createArtifactStore(db, {idFactory: (() => { let i = 0; return () => `id-${++i}`; })()});
  seedApproved(repos);

  const stale = jobs.claimNext({workerId: 'worker-a', nowMs: 1, allowedTypes: ['media_ingest']});
  jobs.recoverExpired({nowMs: 12});
  const current = jobs.claimNext({workerId: 'worker-b', nowMs: 13, allowedTypes: ['media_ingest']});
  assert.throws(() => artifacts.commitMediaIngest({
    stageId: stale.stageId,
    claimToken: stale.claimToken,
    nowMs: 14,
    manifestArtifact: artifact('media_manifest', 'projects/p/attempts/stale/manifest.json'),
    mediaArtifacts: [],
    nextMaxAttempts: 3,
  }), (error) => error?.code === 'STALE_CLAIM');

  jobs.cancel({stageId: current.stageId, nowMs: 14});
  assert.throws(() => artifacts.commitMediaIngest({
    stageId: current.stageId,
    claimToken: current.claimToken,
    nowMs: 15,
    manifestArtifact: artifact('media_manifest', 'projects/p/attempts/cancelled/manifest.json'),
    mediaArtifacts: [],
    nextMaxAttempts: 3,
  }), (error) => error?.code === 'STALE_CLAIM');
  assert.equal(artifacts.getAuthoritative('project-1', 'revision-1', 'media_manifest'), null);
  assert.equal(jobs.getCurrentStage('project-1').type, 'media_ingest');
  db.close();
});
