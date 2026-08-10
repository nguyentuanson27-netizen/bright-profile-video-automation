import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createMediaIngestService} from '../../app/services/media-ingest.mjs';
import {createRenderExecutionService} from '../../app/services/execute-render.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const generation = {
  researchSummary: 'Approved render fixture.',
  claims: [{id: 'claim-1', text: 'Supported.', sourceIds: ['source-1'], status: 'supported'}],
  script: 'Short script.',
  voiceover: {chunks: [{id: 'hero', start: 0, duration: 3, text: 'Voice over.'}]},
  project: {
    duration: 3,
    creatorName: 'Creator',
    scenes: [{id: 'hero', type: 'hero', start: 0, duration: 3}],
  },
};

const source = {
  sourceId: 'source-1',
  url: 'https://example.com/creator',
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Creator facts.',
  contentHash: 'c'.repeat(64),
  sourceType: 'page',
};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-render-worker-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const projectStateStore = createProjectStateStore(db);
  const approvalService = createApprovalService({repositories, projectStateStore});
  repositories.projects.create({id: 'project-1', topic: 'Creator', status: 'review_required', input: {topic: 'Creator'}});
  repositories.sources.upsert({projectId: 'project-1', record: source});
  repositories.revisions.saveDraft({
    projectId: 'project-1',
    revisionId: 'revision-1',
    payload: {revisionId: 'revision-1', projectId: 'project-1', topic: 'Creator', sources: [source], generation},
  });
  approvalService.approve({projectId: 'project-1', revisionId: 'revision-1', approvedBy: 'operator'});
  const artifactStore = createArtifactStore({dataDir, repositories});
  const mediaIngestService = createMediaIngestService({repositories, approvalService, artifactStore});
  return {directory, dataDir, db, repositories, projectStateStore, approvalService, artifactStore, mediaIngestService};
}

const createFakeRenderService = (state, calls = []) => createRenderExecutionService({
  repositories: state.repositories,
  projectStateStore: state.projectStateStore,
  approvalService: state.approvalService,
  mediaIngestService: state.mediaIngestService,
  artifactStore: state.artifactStore,
  dataDir: state.dataDir,
  generateTts: async ({output}) => {
    calls.push('tts');
    writeFileSync(output, Buffer.from('fake-audio'));
    return {output, duration: 3};
  },
  renderProfile: async ({outputLocation, inputProps}) => {
    calls.push('render');
    assert.match(inputProps.audioUrl, /^file:\/\//);
    writeFileSync(outputLocation, Buffer.from('fake-mp4'));
  },
  probeDuration: async () => 3,
});

test('approved revision is ingested, voiced, rendered, validated and completed by durable worker', async () => {
  const state = fixture();
  try {
    const calls = [];
    const renderService = createFakeRenderService(state, calls);

    const queued = await renderService.enqueue({projectId: 'project-1', revisionId: 'revision-1', maxAttempts: 2});
    assert.equal(queued.job.status, 'queued');
    assert.equal(state.repositories.projects.get('project-1').status, 'tts');

    const jobStore = createJobStore(state.db);
    const runner = createJobRunner({
      jobStore,
      workerId: 'worker-1',
      handlers: {rendering: renderService.handleJob},
      leaseMs: 60_000,
    });
    const completedJob = await runner.runOnce();

    assert.equal(completedJob.status, 'succeeded');
    assert.deepEqual(calls, ['tts', 'render']);
    assert.equal(state.repositories.projects.get('project-1').status, 'completed');
    const artifacts = state.repositories.artifacts.listByProject('project-1');
    const audio = artifacts.find((artifact) => artifact.kind === 'tts-audio');
    const video = artifacts.find((artifact) => artifact.kind === 'rendered-video');
    assert.ok(audio);
    assert.ok(video);
    assert.equal(existsSync(path.join(state.dataDir, video.relativePath)), true);
  } finally {
    state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('expired render lease is reclaimed after worker crash without duplicate completed artifacts', async () => {
  const state = fixture();
  try {
    const calls = [];
    const renderService = createFakeRenderService(state, calls);
    const queued = await renderService.enqueue({projectId: 'project-1', revisionId: 'revision-1', maxAttempts: 2});
    const jobStore = createJobStore(state.db);
    const startedAt = new Date('2026-08-10T00:00:00.000Z');

    const abandoned = jobStore.claimNext({workerId: 'dead-worker', now: startedAt, leaseMs: 1_000});
    assert.equal(abandoned.id, queued.job.id);
    assert.equal(abandoned.attempt, 1);

    const recoveredAt = new Date(startedAt.getTime() + 2_000);
    const runner = createJobRunner({
      jobStore,
      workerId: 'replacement-worker',
      handlers: {rendering: renderService.handleJob},
      leaseMs: 60_000,
      clock: () => recoveredAt,
    });
    const completedJob = await runner.runOnce();

    assert.equal(completedJob.status, 'succeeded');
    assert.equal(completedJob.attempt, 2);
    assert.deepEqual(calls, ['tts', 'render']);
    const artifacts = state.repositories.artifacts.listByProject('project-1');
    assert.equal(artifacts.filter((artifact) => artifact.kind === 'tts-audio').length, 1);
    assert.equal(artifacts.filter((artifact) => artifact.kind === 'rendered-video').length, 1);
    assert.equal(state.repositories.projects.get('project-1').status, 'completed');
  } finally {
    state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('render request and worker reject mutable or mismatched approval state', async () => {
  const state = fixture();
  try {
    const renderService = createRenderExecutionService({
      repositories: state.repositories,
      projectStateStore: state.projectStateStore,
      approvalService: state.approvalService,
      mediaIngestService: state.mediaIngestService,
      artifactStore: state.artifactStore,
      dataDir: state.dataDir,
      generateTts: async () => { throw new Error('should not run'); },
      renderProfile: async () => { throw new Error('should not run'); },
      probeDuration: async () => 3,
    });

    state.projectStateStore.setStatus({projectId: 'project-1', status: 'review_required'});
    await assert.rejects(
      () => renderService.enqueue({projectId: 'project-1', revisionId: 'revision-1'}),
      (error) => error instanceof AppError && error.code === 'APPROVED_REVISION_REQUIRED',
    );
  } finally {
    state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});
