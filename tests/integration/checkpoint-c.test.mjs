import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createMediaIngestService} from '../../app/services/media-ingest.mjs';
import {createRenderExecutionService} from '../../app/services/execute-render.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const MEDIA_URL = 'https://public.example/approved-image.png';
const source = {
  sourceId: 'source-media',
  url: MEDIA_URL,
  platform: 'public.example',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Approved controlled media fixture.',
  contentHash: 'd'.repeat(64),
  sourceType: 'page',
};

const generation = {
  researchSummary: 'Approved controlled Checkpoint C fixture.',
  claims: [{id: 'claim-1', text: 'Supported fixture claim.', sourceIds: ['source-media'], status: 'supported'}],
  script: 'Short approved script.',
  voiceover: {chunks: [{id: 'voice-1', start: 0, duration: 2, text: 'Controlled voice fixture.'}]},
  project: {
    duration: 2,
    creatorName: 'CHECKPOINT C',
    heroImage: 'asset://demo/hero.png',
    renderScale: 0.25,
    crf: 28,
    scenes: [
      {id: 'hero', type: 'hero', start: 0, duration: 1, subtitle: 'Approved local asset'},
      {id: 'source', type: 'source', start: 1, duration: 1, mediaUrl: MEDIA_URL, source: 'CONTROLLED FIXTURE'},
    ],
  },
};

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.slice(-1000)}`)));
});

const fakeTts = async ({output, manifest}) => {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(manifest.duration),
    '-codec:a', 'libmp3lame', '-q:a', '9',
    output,
  ]);
  return {output, duration: manifest.duration};
};

test('Checkpoint C: approved ingest -> deterministic TTS -> trusted-assets real Remotion render -> validated MP4', {timeout: 180_000}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-checkpoint-c-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const projectStateStore = createProjectStateStore(db);
    const approvalService = createApprovalService({repositories, projectStateStore});
    repositories.projects.create({id: 'project-c', topic: 'Checkpoint C', status: 'review_required', input: {topic: 'Checkpoint C'}});
    repositories.sources.upsert({projectId: 'project-c', record: source});
    repositories.revisions.saveDraft({
      projectId: 'project-c',
      revisionId: 'revision-c',
      payload: {revisionId: 'revision-c', projectId: 'project-c', topic: 'Checkpoint C', sources: [source], generation},
    });
    approvalService.approve({projectId: 'project-c', revisionId: 'revision-c', approvedBy: 'checkpoint'});

    const artifactStore = createArtifactStore({dataDir, repositories});
    const image = readFileSync(path.resolve('assets', 'demo', 'hero.png'));
    const mediaIngestService = createMediaIngestService({
      repositories,
      approvalService,
      artifactStore,
      fetchMedia: async (url) => {
        assert.equal(url, MEDIA_URL);
        return {statusCode: 200, contentType: 'image/png', body: image};
      },
    });
    const renderService = createRenderExecutionService({
      repositories,
      projectStateStore,
      approvalService,
      mediaIngestService,
      artifactStore,
      dataDir,
      generateTts: fakeTts,
    });

    const queued = await renderService.enqueue({projectId: 'project-c', revisionId: 'revision-c', maxAttempts: 2});
    assert.equal(queued.job.status, 'queued');
    const manifest = JSON.parse(readFileSync(artifactStore.absolutePath(queued.manifestArtifact), 'utf8'));
    assert.match(manifest.renderProject.scenes[1].mediaUrl, /^artifact:\/\/media-/);
    assert.equal(manifest.renderProject.heroImage, 'asset://demo/hero.png');

    const runner = createJobRunner({
      jobStore: createJobStore(db),
      workerId: 'checkpoint-c-worker',
      handlers: {rendering: renderService.handleJob},
      leaseMs: 120_000,
    });
    const job = await runner.runOnce();
    assert.equal(job.status, 'succeeded');
    assert.equal(repositories.projects.get('project-c').status, 'completed');

    const artifacts = repositories.artifacts.listByProject('project-c');
    const media = artifacts.find((artifact) => artifact.kind === 'approved-media');
    const audio = artifacts.find((artifact) => artifact.kind === 'tts-audio');
    const video = artifacts.find((artifact) => artifact.kind === 'rendered-video');
    assert.ok(media);
    assert.ok(audio);
    assert.ok(video);
    const videoPath = artifactStore.absolutePath(video);
    assert.equal(existsSync(videoPath), true);
    assert.ok(statSync(videoPath).size > 0);
  } finally {
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
