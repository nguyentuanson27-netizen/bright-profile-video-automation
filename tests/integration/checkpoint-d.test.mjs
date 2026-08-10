import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createGenerationProjectService} from '../../app/services/generate-project.mjs';
import {createMediaIngestService} from '../../app/services/media-ingest.mjs';
import {createRenderExecutionService} from '../../app/services/execute-render.mjs';
import {createResearchProjectService} from '../../app/services/research-project.mjs';
import {probeVideoDuration} from '../../lib/media-probe.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createWorkerHandlers} from '../../worker/handlers.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const postJson = (baseUrl, pathname, body) => fetch(`${baseUrl}${pathname}`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body),
});
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

test('Checkpoint D: topic -> automatic research/generation -> review approval -> real render -> validated download', {timeout: 180_000}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-checkpoint-d-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  let server;
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const projectStateStore = createProjectStateStore(db);
    const researchService = createResearchProjectService({
      repositories,
      projectStateStore,
      projectIdGenerator: () => 'project-d',
      jobIdGenerator: () => 'research-d',
      researchProvider: {
        search: async () => ({candidates: [{
          url: 'https://example.com/creator',
          platform: 'example.com',
          title: 'Controlled public creator source',
          sourceType: 'page',
          discoveryStatus: 'discovered',
        }]}),
      },
      fetchSource: async () => ({
        statusCode: 200,
        contentType: 'text/html',
        body: Buffer.from('<main>Controlled public creator facts.</main>'),
      }),
    });
    const generationService = createGenerationProjectService({
      repositories,
      projectStateStore,
      generationProvider: {
        generate: async ({sources}) => ({
          researchSummary: 'Controlled source-grounded summary.',
          claims: [{id: 'claim-d', text: 'Controlled creator fact.', sourceIds: [sources[0].sourceId], status: 'supported'}],
          script: 'Controlled approved operator script.',
          voiceover: {chunks: [{id: 'voice-d', start: 0, duration: 2, text: 'Controlled voice.'}]},
          project: {
            duration: 2,
            creatorName: 'CHECKPOINT D',
            heroImage: 'asset://demo/hero.png',
            renderScale: 0.25,
            crf: 28,
            scenes: [{id: 'hero', type: 'hero', start: 0, duration: 2, subtitle: 'Operator workflow smoke'}],
          },
        }),
      },
    });
    const approvalService = createApprovalService({repositories, projectStateStore});
    const artifactStore = createArtifactStore({dataDir, repositories});
    const mediaIngestService = createMediaIngestService({repositories, approvalService, artifactStore});
    const renderService = createRenderExecutionService({
      repositories,
      projectStateStore,
      approvalService,
      mediaIngestService,
      artifactStore,
      dataDir,
      generateTts: fakeTts,
    });
    const jobStore = createJobStore(db);
    const runner = createJobRunner({
      jobStore,
      workerId: 'checkpoint-d-worker',
      handlers: createWorkerHandlers({researchService, generationService, renderService}),
      leaseMs: 120_000,
    });

    server = http.createServer(createHttpHandler({
      repositories,
      researchService,
      generationService,
      approvalService,
      renderService,
      artifactStore,
      videoProbe: probeVideoDuration,
      requestIdGenerator: () => 'checkpoint-d-request',
    }));
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createResponse = await postJson(baseUrl, '/api/projects', {topic: 'Checkpoint D Creator'});
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.project.status, 'researching');
    assert.equal(created.job.stage, 'researching');

    assert.equal((await runner.runOnce()).status, 'succeeded');
    assert.equal(repositories.projects.get('project-d').status, 'generating');
    assert.equal((await runner.runOnce()).status, 'succeeded');
    assert.equal(repositories.projects.get('project-d').status, 'review_required');

    const statusResponse = await fetch(`${baseUrl}/api/projects/project-d/status`);
    const status = await statusResponse.json();
    assert.equal(status.project.status, 'review_required');
    assert.ok(status.latestRevision?.revisionId);

    const revisionResponse = await fetch(`${baseUrl}/api/projects/project-d/revisions/${encodeURIComponent(status.latestRevision.revisionId)}`);
    const revision = await revisionResponse.json();
    assert.equal(revision.payload.generation.script, 'Controlled approved operator script.');
    assert.equal(revision.payload.sources[0].retrievalStatus, 'available');

    const approveResponse = await postJson(baseUrl, '/api/projects/project-d/approve', {
      revisionId: revision.revisionId,
      approvedBy: 'checkpoint-operator',
      claimOverrides: [],
    });
    assert.equal(approveResponse.status, 200);
    assert.equal(repositories.projects.get('project-d').status, 'approved');

    const renderResponse = await postJson(baseUrl, '/api/projects/project-d/render', {revisionId: revision.revisionId});
    assert.equal(renderResponse.status, 202);
    assert.equal(repositories.projects.get('project-d').status, 'tts');

    const renderJob = await runner.runOnce();
    assert.equal(renderJob.status, 'succeeded');
    assert.equal(repositories.projects.get('project-d').status, 'completed');

    const videoResponse = await fetch(`${baseUrl}/api/projects/project-d/video`);
    assert.equal(videoResponse.status, 200);
    assert.equal(videoResponse.headers.get('content-type'), 'video/mp4');
    assert.match(videoResponse.headers.get('content-disposition'), /attachment/);
    const video = Buffer.from(await videoResponse.arrayBuffer());
    assert.ok(video.length > 1000);
  } finally {
    if (server) await close(server);
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
