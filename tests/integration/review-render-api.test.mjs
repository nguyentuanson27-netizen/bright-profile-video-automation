import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';

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

const source = {
  sourceId: 'source-1',
  url: 'https://example.com/creator',
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Verified creator facts.',
  contentHash: 'a'.repeat(64),
  sourceType: 'page',
};
const generation = {
  researchSummary: 'Verified summary.',
  claims: [{id: 'claim-1', text: 'Verified fact.', sourceIds: ['source-1'], status: 'supported'}],
  script: 'Approved script.',
  voiceover: {chunks: [{id: 'voice-1', start: 0, duration: 3, text: 'Voice.'}]},
  project: {duration: 3, creatorName: 'Creator', scenes: [{id: 'hero', type: 'hero', start: 0, duration: 3}]},
};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-review-render-api-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const projectStateStore = createProjectStateStore(db);
  repositories.projects.create({id: 'project-review', topic: 'Creator', status: 'review_required', input: {topic: 'Creator'}});
  repositories.sources.upsert({projectId: 'project-review', record: source});
  repositories.revisions.saveDraft({
    projectId: 'project-review',
    revisionId: 'revision-review',
    payload: {revisionId: 'revision-review', projectId: 'project-review', topic: 'Creator', sources: [source], generation},
  });
  repositories.projects.create({id: 'project-complete', topic: 'Complete', status: 'completed', input: {topic: 'Complete'}});
  const artifactStore = createArtifactStore({dataDir, repositories});
  const video = artifactStore.writeGenerated({
    projectId: 'project-complete',
    id: 'video-complete',
    kind: 'rendered-video',
    directory: 'output',
    extension: 'mp4',
    buffer: Buffer.from('valid-video-fixture'),
  });
  return {directory, dataDir, db, repositories, projectStateStore, artifactStore, video};
}

test('review status discovers latest revision and approved project can request render through API', async () => {
  const state = fixture();
  let server;
  try {
    const approvalService = createApprovalService({repositories: state.repositories, projectStateStore: state.projectStateStore});
    const renderCalls = [];
    const renderService = {
      enqueue: async (input) => {
        renderCalls.push(input);
        return {job: {id: 'render-job', projectId: input.projectId, stage: 'rendering', status: 'queued'}};
      },
    };
    server = http.createServer(createHttpHandler({
      repositories: state.repositories,
      researchService: {createAndEnqueueResearch() {}, enqueueResearch() {}},
      approvalService,
      renderService,
      artifactStore: state.artifactStore,
      videoProbe: async () => 3,
      requestIdGenerator: () => 'review-render-request',
    }));
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const statusResponse = await fetch(`${baseUrl}/api/projects/project-review/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.deepEqual(status.latestRevision, {
      revisionId: 'revision-review',
      status: 'draft',
      payloadHash: state.repositories.revisions.get('revision-review').payloadHash,
      approvedAt: null,
      approvedBy: null,
    });

    const approved = await postJson(baseUrl, '/api/projects/project-review/approve', {
      revisionId: 'revision-review',
      approvedBy: 'operator',
      claimOverrides: [],
    });
    assert.equal(approved.status, 200);

    const render = await postJson(baseUrl, '/api/projects/project-review/render', {revisionId: 'revision-review'});
    assert.equal(render.status, 202);
    assert.equal((await render.json()).job.id, 'render-job');
    assert.deepEqual(renderCalls, [{projectId: 'project-review', revisionId: 'revision-review'}]);
  } finally {
    if (server) await close(server);
    if (state.db.open) state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('completed video GET/HEAD validates output and returns a download; corrupt output is a stable API error', async () => {
  const state = fixture();
  let server;
  try {
    let shouldFailProbe = false;
    server = http.createServer(createHttpHandler({
      repositories: state.repositories,
      researchService: {createAndEnqueueResearch() {}, enqueueResearch() {}},
      renderService: {enqueue() {}},
      artifactStore: state.artifactStore,
      videoProbe: async () => {
        if (shouldFailProbe) throw new AppError('RENDER_OUTPUT_INVALID', 'Rendered video is corrupt', {status: 409});
        return 3;
      },
      requestIdGenerator: () => 'video-request',
    }));
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const head = await fetch(`${baseUrl}/api/projects/project-complete/video`, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    assert.match(head.headers.get('content-disposition'), /attachment/);

    const video = await fetch(`${baseUrl}/api/projects/project-complete/video`);
    assert.equal(video.status, 200);
    assert.equal(Buffer.from(await video.arrayBuffer()).toString(), 'valid-video-fixture');

    shouldFailProbe = true;
    const corrupt = await fetch(`${baseUrl}/api/projects/project-complete/video`);
    assert.equal(corrupt.status, 409);
    assert.equal((await corrupt.json()).error.code, 'RENDER_OUTPUT_INVALID');

    writeFileSync(state.artifactStore.absolutePath(state.video), Buffer.alloc(0));
    shouldFailProbe = false;
    const empty = await fetch(`${baseUrl}/api/projects/project-complete/video`);
    assert.equal(empty.status, 409);
    assert.equal((await empty.json()).error.code, 'RENDER_OUTPUT_INVALID');
  } finally {
    if (server) await close(server);
    if (state.db.open) state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});
