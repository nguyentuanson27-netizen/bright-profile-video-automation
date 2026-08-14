import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {createMediaIngestService, createMediaIngestStageHandler} from '../../app/services/ingest-media.mjs';
import {createRenderStageHandler, createTtsStageHandler} from '../../app/services/execute-render.mjs';
import {createResearchService, createResearchStageHandler} from '../../app/services/research-project.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = async (server) => {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
const jsonRequest = async (base, path, {method = 'GET', body} = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return {response, json};
};

const researchResult = {
  candidates: [{
    claim: 'Creator reached 100 followers.',
    url: 'https://media.example.test/creator.png',
    title: 'Creator profile image and milestone',
    publisher: 'Example Publisher',
    sourceType: 'news',
    sourceRelationship: 'independent',
    category: 'followers',
    value: 100,
    unit: 'followers',
  }],
  sources: [{
    url: 'https://media.example.test/creator.png',
    title: 'Creator profile image and milestone',
    publisher: 'Example Publisher',
  }],
  unavailableSources: [],
};

const generatedDraft = {
  creatorName: 'Creator',
  summary: 'A concise creator profile.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 2, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 2}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 2, sourceIds: ['source-1']}],
  render: {duration: 2, renderScale: 1, crf: 20},
};

test('deterministic standalone flow reaches verified downloadable completed output without n8n or remote provider calls', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-full-e2e-'));
  const db = openDatabase(join(dataDir, 'bright-profile.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  let sourceNo = 0;
  let revisionNo = 0;
  let stageNo = 0;
  const jobs = createJobStore(db, {
    leaseMs: 1000,
    sourceIdFactory: () => `source-${++sourceNo}`,
    revisionIdFactory: () => `revision-${++revisionNo}`,
  });
  const artifactStore = createArtifactStore(db, {idFactory: (() => { let value = 0; return () => `artifact-${++value}`; })()});

  const researchService = createResearchService({
    provider: {async research() { return researchResult; }},
    now: () => Date.parse('2026-08-14T08:00:00Z'),
  });
  const generationService = createGenerationService({
    provider: {async generate() { return generatedDraft; }},
  });
  const mediaService = createMediaIngestService({
    dataDir,
    fetchOptions: {timeoutMs: 1000, maxBytes: 1024 * 1024, maxRedirects: 2},
    fetcher: {
      async fetchToFile(url, destination) {
        assert.equal(url, 'https://media.example.test/creator.png');
        await mkdir(dirname(destination), {recursive: true});
        const bytes = Buffer.from('deterministic-image');
        await writeFile(destination, bytes);
        return {url, mimeType: 'image/png', bytes: bytes.length, path: destination};
      },
    },
  });

  let nowMs = 1000;
  const runner = createJobRunner({
    jobs,
    workerId: 'deterministic-worker',
    leaseMs: 1000,
    now: () => nowMs,
    handlers: {
      research: createResearchStageHandler({repos, researchService}),
      generation: createGenerationStageHandler({repos, generationService}),
      media_ingest: createMediaIngestStageHandler({repos, artifactStore, service: mediaService, nextMaxAttempts: 3}),
      tts: createTtsStageHandler({
        repos,
        artifactStore,
        dataDir,
        nextMaxAttempts: 3,
        generateTts: async ({output}) => writeFile(output, Buffer.from('deterministic-mp3')),
      }),
      render: createRenderStageHandler({
        repos,
        artifactStore,
        dataDir,
        renderer: async ({inputProps, outputLocation}) => {
          assert.equal(inputProps.scenes[0].mediaUrl, 'media/media-000.png');
          assert.equal(inputProps.audioUrl, 'audio/voice.mp3');
          await writeFile(outputLocation, Buffer.from('deterministic-mp4'));
        },
        probe: async () => 2,
      }),
    },
  });

  const server = createAppServer({
    db,
    repos,
    jobs,
    artifactStore,
    dataDir,
    now: () => Date.parse('2026-08-14T08:00:00Z'),
    nowMs: () => nowMs,
    projectIdFactory: () => 'project-1',
    stageIdFactory: () => `stage-${++stageNo}`,
    sourceIdFactory: () => 'unused-input-source',
    revisionIdFactory: () => 'revision-edit',
    requestIdFactory: () => 'request-e2e',
  });
  const base = await listen(server);

  try {
    const created = await jsonRequest(base, '/api/projects', {
      method: 'POST',
      body: {creator: 'Creator', topic: 'career', instructions: 'Keep it factual.'},
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.json.project.status, 'draft');

    assert.equal((await jsonRequest(base, '/api/projects/project-1/research', {method: 'POST'})).response.status, 202);
    nowMs += 1;
    assert.equal(await runner.runOnce(), true);
    assert.equal(repos.projects.get('project-1').status, 'research_ready');

    assert.equal((await jsonRequest(base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
    nowMs += 1;
    assert.equal(await runner.runOnce(), true);
    let revision = repos.revisions.get('revision-1');
    assert.equal(repos.projects.get('project-1').status, 'review_required');
    assert.equal(revision.payload.claims[0].verified, false);

    const reviewed = structuredClone(revision.payload);
    reviewed.claims[0].verified = true;
    assert.equal((await jsonRequest(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: reviewed}})).response.status, 200);
    assert.equal((await jsonRequest(base, '/api/projects/project-1/approve', {method: 'POST'})).json.project.status, 'approved');
    assert.equal((await jsonRequest(base, '/api/projects/project-1/render', {method: 'POST'})).response.status, 202);

    for (const expected of ['media_ingest', 'tts', 'render_queued']) {
      assert.equal(repos.projects.get('project-1').status, expected);
      nowMs += 1;
      assert.equal(await runner.runOnce(), true);
    }
    assert.equal(repos.projects.get('project-1').status, 'completed');

    const outputResponse = await fetch(`${base}/api/projects/project-1/artifacts/output`);
    assert.equal(outputResponse.status, 200);
    assert.equal(outputResponse.headers.get('content-type'), 'video/mp4');
    assert.equal(Buffer.from(await outputResponse.arrayBuffer()).toString(), 'deterministic-mp4');

    revision = repos.revisions.get('revision-1');
    assert.ok(revision.approvedAt);
    assert.equal(artifactStore.getAuthoritative('project-1', 'revision-1', 'output_mp4').isAuthoritative, true);
  } finally {
    await close(server);
    db.close();
  }
});
