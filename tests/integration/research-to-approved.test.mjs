import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {createResearchService, createResearchStageHandler} from '../../app/services/research-project.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const researchResult = {
  candidates: [{
    claim: 'Creator reached 100 followers.',
    url: 'https://research.example/profile',
    title: 'Creator profile',
    publisher: 'Research Example',
    sourceType: 'news',
    sourceRelationship: 'independent',
    category: 'followers',
    value: 100,
    unit: 'followers',
  }],
  sources: [{url: 'https://research.example/profile', title: 'Creator profile', publisher: 'Research Example'}],
  unavailableSources: [],
};

const generatedDraft = {
  creatorName: 'Creator',
  summary: 'Creator profile summary.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
};

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref?.();
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const request = async (base, path, {method = 'GET', body} = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {response, json: await response.json()};
};

test('project flows from research through human-reviewed immutable approval and survives reopen', async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'bright-research-to-approved-')), 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  let sourceNo = 0;
  let revisionNo = 0;
  const jobs = createJobStore(db, {
    leaseMs: 1000,
    sourceIdFactory: () => `source-${++sourceNo}`,
    revisionIdFactory: () => `revision-${++revisionNo}`,
  });

  const researchService = createResearchService({
    provider: {async research() { return researchResult; }},
    now: () => Date.parse('2026-08-14T05:00:00Z'),
  });
  let generationInput;
  const generationService = createGenerationService({
    provider: {async generate(input) { generationInput = input; return generatedDraft; }},
  });
  const runner = createJobRunner({
    jobs,
    workerId: 'pipeline-worker',
    leaseMs: 1000,
    now: () => 1000,
    handlers: {
      research: createResearchStageHandler({repos, researchService}),
      generation: createGenerationStageHandler({repos, generationService}),
    },
  });

  let stageNo = 0;
  const server = createAppServer({
    db,
    repos,
    jobs,
    dataDir: join(databasePath, '..'),
    now: () => Date.parse('2026-08-14T05:00:00Z'),
    nowMs: () => 1000,
    projectIdFactory: () => 'project-1',
    stageIdFactory: () => `stage-${++stageNo}`,
    sourceIdFactory: () => 'unused-input-source',
    revisionIdFactory: () => 'revision-edit',
    requestIdFactory: () => 'request-1',
  });
  const base = await listen(server);

  const created = await request(base, '/api/projects', {
    method: 'POST',
    body: {creator: 'Creator', topic: 'career', instructions: 'Keep claims factual.'},
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.project.status, 'draft');

  assert.equal((await request(base, '/api/projects/project-1/research', {method: 'POST'})).response.status, 202);
  assert.equal(await runner.runOnce(), true);
  assert.equal(repos.projects.get('project-1').status, 'research_ready');
  assert.deepEqual(repos.sources.list('project-1').map(({id}) => id), ['source-1']);

  assert.equal((await request(base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
  assert.equal(await runner.runOnce(), true);
  assert.deepEqual(generationInput.sources.map(({id}) => id), ['source-1']);
  let project = repos.projects.get('project-1');
  assert.equal(project.status, 'review_required');
  assert.equal(project.currentRevisionId, 'revision-1');
  let revision = repos.revisions.get('revision-1');
  assert.equal(revision.payload.claims[0].verified, false);

  const humanReviewed = structuredClone(revision.payload);
  humanReviewed.claims[0].verified = true;
  const edited = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: humanReviewed}});
  assert.equal(edited.response.status, 200);
  const approved = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(approved.response.status, 200);
  assert.equal(approved.json.project.status, 'approved');
  assert.equal(approved.json.project.currentRevisionId, 'revision-1');
  assert.equal(approved.json.project.approvedRevisionId, 'revision-1');
  assert.match(approved.json.revision.payloadHash, /^[a-f0-9]{64}$/);
  const approvedHash = approved.json.revision.payloadHash;
  const approvedAt = approved.json.revision.approvedAt;

  await close(server);
  db.close();

  const reopened = openDatabase(databasePath);
  migrateDatabase(reopened);
  const reopenedRepos = createRepositories(reopened);
  project = reopenedRepos.projects.get('project-1');
  revision = reopenedRepos.revisions.get('revision-1');
  assert.equal(project.status, 'approved');
  assert.equal(project.currentRevisionId, 'revision-1');
  assert.equal(project.approvedRevisionId, 'revision-1');
  assert.equal(revision.payloadHash, approvedHash);
  assert.equal(revision.approvedAt, approvedAt);
  assert.throws(
    () => reopenedRepos.revisions.updatePayload({
      revisionId: 'revision-1',
      payload: {...revision.payload, summary: 'late mutation'},
      payloadHash: '0'.repeat(64),
    }),
    /immutable/,
  );
  reopened.close();
});
