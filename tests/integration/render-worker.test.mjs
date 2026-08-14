import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createRenderStageHandler, createTtsStageHandler} from '../../app/services/execute-render.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return {promise, resolve: resolvePromise};
};

const listen = async (server) => {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
};
const closeServer = (server) => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));

const approvedDraft = {
  creatorName: 'Creator',
  claims: [],
  script: [{id: 'script-1', text: 'Hello', start: 0, duration: 1, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Hello', start: 0, duration: 1}]},
  scenes: [{id: 'scene-1', type: 'hero', start: 0, duration: 1, sourceIds: ['source-1']}],
  render: {duration: 1, renderScale: 1, crf: 20},
};

const createFixture = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-render-worker-'));
  const databasePath = join(dataDir, 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000, baseBackoffMs: 1, maxBackoffMs: 1});
  const artifacts = createArtifactStore(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', status: 'review_required'});
  repos.sources.create({
    id: 'source-1', projectId: 'project-1', url: 'https://example.test/media.png',
    status: 'available', payload: {title: 'Media'},
  });
  repos.revisions.create({
    id: 'revision-1', projectId: 'project-1', revisionNo: 1,
    payload: approvedDraft, payloadHash: 'a'.repeat(64),
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

  const mediaRelative = 'projects/seed/media/input.png';
  const manifestRelative = 'projects/seed/media/manifest.json';
  const mediaBytes = Buffer.from('safe-image');
  const mediaAbsolute = resolve(dataDir, mediaRelative);
  await mkdir(resolve(dataDir, 'projects/seed/media'), {recursive: true});
  await writeFile(mediaAbsolute, mediaBytes);
  const mediaSelectionId = 'media-selection-111111111111111111111111';
  const mediaUrl = 'https://example.test/media.png';
  const manifest = {
    version: 2,
    projectId: 'project-1',
    revisionId: 'revision-1',
    scenes: {'scene-1': mediaSelectionId},
    media: [{
      mediaSelectionId,
      sourceId: 'source-1',
      sourceUrl: mediaUrl,
      selectedMediaUrl: mediaUrl,
      resolvedMediaUrl: mediaUrl,
      relativePath: mediaRelative,
      mimeType: 'image/png',
      byteSize: mediaBytes.length,
      sha256: sha256(mediaBytes),
    }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(resolve(dataDir, manifestRelative), manifestBytes);
  const mediaClaim = jobs.claimNext({workerId: 'seed', nowMs: 1, allowedTypes: ['media_ingest']});
  artifacts.commitMediaIngest({
    stageId: mediaClaim.stageId,
    claimToken: mediaClaim.claimToken,
    nowMs: 2,
    mediaArtifacts: [{
      kind: 'media_input', relativePath: mediaRelative, mimeType: 'image/png',
      byteSize: mediaBytes.length, sha256: sha256(mediaBytes),
    }],
    manifestArtifact: {
      kind: 'media_manifest', relativePath: manifestRelative, mimeType: 'application/json',
      byteSize: manifestBytes.length, sha256: sha256(manifestBytes),
    },
    nextMaxAttempts: 3,
  });
  return {dataDir, databasePath, db, repos, jobs, artifacts, mediaAbsolute};
};

const runTts = async (fixture, now = () => 3) => {
  const handler = createTtsStageHandler({
    repos: fixture.repos,
    artifactStore: fixture.artifacts,
    dataDir: fixture.dataDir,
    nextMaxAttempts: 3,
    generateTts: async ({output}) => writeFile(output, Buffer.from('fake-mp3')),
  });
  const runner = createJobRunner({
    jobs: fixture.jobs, workerId: 'tts-worker', handlers: {tts: handler}, leaseMs: 1000, now,
  });
  assert.equal(await runner.runOnce(), true);
  assert.equal(fixture.repos.projects.get('project-1').status, 'render_queued');
};

test('TTS and render worker complete durably and output API serves only the verified authoritative MP4 after reopen', async () => {
  const fixture = await createFixture();
  await runTts(fixture);
  let nowMs = 4;
  const renderHandler = createRenderStageHandler({
    repos: fixture.repos,
    artifactStore: fixture.artifacts,
    dataDir: fixture.dataDir,
    renderer: async ({inputProps, outputLocation, publicDir}) => {
      assert.equal(inputProps.audioUrl, 'audio/voice.mp3');
      assert.equal(inputProps.scenes[0].mediaUrl, 'media/media-000.png');
      assert.equal(typeof publicDir, 'string');
      await writeFile(outputLocation, Buffer.from('fake-mp4'));
    },
    probe: async () => 1,
  });
  const renderRunner = createJobRunner({
    jobs: fixture.jobs, workerId: 'render-worker', handlers: {render: renderHandler}, leaseMs: 1000, now: () => nowMs,
  });
  assert.equal(await renderRunner.runOnce(), true);
  assert.equal(fixture.repos.projects.get('project-1').status, 'completed');
  const output = fixture.artifacts.getAuthoritative('project-1', 'revision-1', 'output_mp4');
  assert.equal(output.isAuthoritative, true);
  const outputPath = resolve(fixture.dataDir, output.relativePath);
  assert.equal((await readFile(outputPath)).toString(), 'fake-mp4');

  fixture.db.close();
  const reopenedDb = openDatabase(fixture.databasePath);
  migrateDatabase(reopenedDb);
  const reopenedRepos = createRepositories(reopenedDb);
  const reopenedJobs = createJobStore(reopenedDb);
  const reopenedArtifacts = createArtifactStore(reopenedDb);
  const server = createAppServer({
    db: reopenedDb, repos: reopenedRepos, jobs: reopenedJobs,
    artifactStore: reopenedArtifacts, dataDir: fixture.dataDir,
  });
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/api/projects/project-1/artifacts/output`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'fake-mp4');

  await writeFile(outputPath, Buffer.from('corrupt'));
  const corrupt = await fetch(`${baseUrl}/api/projects/project-1/artifacts/output`);
  assert.equal(corrupt.status, 409);
  assert.equal((await corrupt.json()).error.code, 'OUTPUT_UNAVAILABLE');
  await closeServer(server);
  reopenedDb.close();
});

test('cancelling a blocked render prevents late output promotion and completed transition', async () => {
  const fixture = await createFixture();
  await runTts(fixture);
  const gate = deferred();
  const started = deferred();
  let nowMs = 4;
  const handler = createRenderStageHandler({
    repos: fixture.repos,
    artifactStore: fixture.artifacts,
    dataDir: fixture.dataDir,
    renderer: async ({outputLocation}) => {
      started.resolve();
      await gate.promise;
      await writeFile(outputLocation, Buffer.from('late-mp4'));
    },
    probe: async () => 1,
  });
  const runner = createJobRunner({
    jobs: fixture.jobs, workerId: 'render-worker', handlers: {render: handler}, leaseMs: 1000, now: () => nowMs,
  });
  const running = runner.runOnce();
  await started.promise;
  const stage = fixture.jobs.getCurrentStage('project-1');
  nowMs = 5;
  fixture.jobs.cancel({stageId: stage.id, nowMs});
  gate.resolve();
  await running;

  assert.equal(fixture.repos.projects.get('project-1').status, 'cancelled');
  assert.equal(fixture.artifacts.getAuthoritative('project-1', 'revision-1', 'output_mp4'), undefined);
  fixture.db.close();
});

test('retryable render failure can be operator-retried from the same authoritative upstream artifacts', async () => {
  const fixture = await createFixture();
  await runTts(fixture);
  let nowMs = 4;
  let calls = 0;
  const handler = createRenderStageHandler({
    repos: fixture.repos,
    artifactStore: fixture.artifacts,
    dataDir: fixture.dataDir,
    renderer: async ({outputLocation}) => {
      calls += 1;
      if (calls === 1) throw new Error('renderer unavailable');
      await writeFile(outputLocation, Buffer.from('retry-mp4'));
    },
    probe: async () => 1,
  });
  const runner = createJobRunner({
    jobs: fixture.jobs, workerId: 'render-worker', handlers: {render: handler}, leaseMs: 1000, now: () => nowMs,
  });
  assert.equal(await runner.runOnce(), true);
  const failed = fixture.jobs.getCurrentStage('project-1');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, true);
  assert.equal(fixture.repos.projects.get('project-1').status, 'failed');

  nowMs = 5;
  fixture.jobs.retry({stageId: failed.id, nowMs});
  nowMs = 6;
  assert.equal(await runner.runOnce(), true);
  assert.equal(calls, 2);
  assert.equal(fixture.repos.projects.get('project-1').status, 'completed');
  assert.equal(fixture.artifacts.getAuthoritative('project-1', 'revision-1', 'output_mp4').isAuthoritative, true);
  fixture.db.close();
});

test('render rejects corrupted approved media before invoking Remotion', async () => {
  const fixture = await createFixture();
  await runTts(fixture);
  await writeFile(fixture.mediaAbsolute, Buffer.from('tampered'));
  let invoked = false;
  const handler = createRenderStageHandler({
    repos: fixture.repos,
    artifactStore: fixture.artifacts,
    dataDir: fixture.dataDir,
    renderer: async () => { invoked = true; },
    probe: async () => 1,
  });
  const runner = createJobRunner({
    jobs: fixture.jobs, workerId: 'render-worker', handlers: {render: handler}, leaseMs: 1000, now: () => 4,
  });
  assert.equal(await runner.runOnce(), true);
  assert.equal(invoked, false);
  assert.equal(fixture.repos.projects.get('project-1').status, 'failed');
  assert.equal(fixture.artifacts.getAuthoritative('project-1', 'revision-1', 'output_mp4'), undefined);
  fixture.db.close();
});
