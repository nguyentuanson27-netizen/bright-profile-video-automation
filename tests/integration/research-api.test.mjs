import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createResearchService, createResearchStageHandler} from '../../app/services/research-project.mjs';
import {ResearchProviderError, ResearchProviderErrorCodes} from '../../providers/research/index.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';
import {createFakeResearchProvider} from '../fakes/research-provider.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-research-api-')), 'app.sqlite');
const successResult = {
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
  unavailableSources: [{url: 'https://missing.example/source', errorCode: 'SOURCE_UNAVAILABLE'}],
};

const fetchSource = async (url) => ({url, mimeType: 'text/html', content: '<p>operator public source</p>'});

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
};
const closeServer = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const request = async (base, path, {method = 'GET', body} = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return {response, json};
};

const createRuntime = ({databasePath = tempDatabasePath(), provider = createFakeResearchProvider({result: successResult}), nowMs = () => 1000} = {}) => {
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  let sourceNo = 0;
  const jobs = createJobStore(db, {
    leaseMs: 1000,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    defaultMaxAttempts: 4,
    sourceIdFactory: () => `source-${++sourceNo}`,
  });
  const researchService = createResearchService({provider, fetchSource, now: () => Date.parse('2026-08-14T02:00:00Z')});
  const handler = createResearchStageHandler({repos, researchService});
  const runner = createJobRunner({jobs, workerId: 'research-worker', handlers: {research: handler}, leaseMs: 1000, now: nowMs});
  let projectNo = 0;
  let stageNo = 0;
  let requestNo = 0;
  const server = createAppServer({
    db,
    repos,
    jobs,
    dataDir: join(databasePath, '..'),
    now: () => Date.parse('2026-08-14T02:00:00Z'),
    nowMs,
    projectIdFactory: () => `project-${++projectNo}`,
    stageIdFactory: () => `stage-${++stageNo}`,
    sourceIdFactory: () => `input-source-${++sourceNo}`,
    requestIdFactory: () => `request-${++requestNo}`,
  });
  return {databasePath, db, repos, jobs, runner, server};
};

const createProject = async (base) => request(base, '/api/projects', {
  method: 'POST',
  body: {
    creator: 'Creator',
    topic: 'career and audience',
    publicUrls: ['https://operator.example/about'],
    instructions: 'Prefer primary sources.',
  },
});

test('create -> research_ready persists evidence, app-owned provenance and restart-safe project input', async () => {
  const runtime = createRuntime();
  const base = await listen(runtime.server);
  const created = await createProject(base);
  assert.equal(created.response.status, 201);
  assert.equal(created.json.project.id, 'project-1');
  assert.equal(created.json.project.status, 'draft');
  assert.equal(created.json.project.instructions, 'Prefer primary sources.');

  const listed = await request(base, '/api/projects');
  assert.deepEqual(listed.json.projects.map((project) => project.id), ['project-1']);

  const started = await request(base, '/api/projects/project-1/research', {method: 'POST'});
  assert.equal(started.response.status, 202);
  assert.equal(started.json.project.status, 'researching');
  assert.equal(await runtime.runner.runOnce(), true);

  const ready = await request(base, '/api/projects/project-1');
  assert.equal(ready.response.status, 200);
  assert.equal(ready.json.project.status, 'research_ready');
  assert.equal(ready.json.project.research.schemaVersion, '1.0');
  assert.equal(ready.json.project.research.evidence.length, 1);

  const sources = await request(base, '/api/projects/project-1/sources');
  assert.equal(sources.response.status, 200);
  assert.ok(sources.json.sources.some((source) => source.url === 'https://research.example/profile' && source.status === 'available'));
  assert.ok(sources.json.sources.some((source) => source.url === 'https://missing.example/source' && source.status === 'unavailable'));
  assert.ok(sources.json.sources.every((source) => typeof source.id === 'string' && source.id.startsWith('source-')));

  await closeServer(runtime.server);
  runtime.db.close();

  const reopened = createRuntime({databasePath: runtime.databasePath});
  const reopenedBase = await listen(reopened.server);
  const persisted = await request(reopenedBase, '/api/projects/project-1');
  assert.equal(persisted.json.project.status, 'research_ready');
  assert.equal(persisted.json.project.instructions, 'Prefer primary sources.');
  assert.equal(persisted.json.project.research.evidence.length, 1);
  const persistedSources = await request(reopenedBase, '/api/projects/project-1/sources');
  assert.equal(persistedSources.json.sources.length, sources.json.sources.length);
  await closeServer(reopened.server);
  reopened.db.close();
});

test('retry reuses the same logical failed research stage and repeated retry while active is a no-op', async () => {
  let shouldFail = true;
  const success = createFakeResearchProvider({result: successResult});
  const provider = {
    async research(input) {
      if (shouldFail) throw new ResearchProviderError(ResearchProviderErrorCodes.FAILED, 'temporary', {retryable: true});
      return success.research(input);
    },
  };
  const runtime = createRuntime({provider});
  const base = await listen(runtime.server);
  await createProject(base);
  await request(base, '/api/projects/project-1/research', {method: 'POST'});
  assert.equal(await runtime.runner.runOnce(), true);

  const failed = await request(base, '/api/projects/project-1');
  assert.equal(failed.json.project.status, 'failed');
  assert.equal(failed.json.project.failureRetryable, true);
  assert.equal(failed.json.project.failureCode, ResearchProviderErrorCodes.FAILED);
  const attemptsBefore = runtime.jobs.listAttempts('stage-1');
  assert.equal(attemptsBefore.length, 1);

  shouldFail = false;
  const retried = await request(base, '/api/projects/project-1/retry', {method: 'POST'});
  assert.equal(retried.response.status, 202);
  assert.equal(retried.json.changed, true);
  assert.equal(retried.json.project.status, 'researching');
  const repeated = await request(base, '/api/projects/project-1/retry', {method: 'POST'});
  assert.equal(repeated.response.status, 202);
  assert.equal(repeated.json.changed, false);
  assert.equal(await runtime.runner.runOnce(), true);
  assert.equal(runtime.jobs.listAttempts('stage-1').length, 2);
  const ready = await request(base, '/api/projects/project-1');
  assert.equal(ready.json.project.status, 'research_ready');

  await closeServer(runtime.server);
  runtime.db.close();
});

test('cancel returns while provider is blocked, invalidates the fence, and repeated cancel is a no-op', async () => {
  let release;
  let startedResolve;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const provider = createFakeResearchProvider({
    result: successResult,
    gate,
    inspectInput() { startedResolve(); },
  });
  const runtime = createRuntime({provider});
  const base = await listen(runtime.server);
  await createProject(base);
  await request(base, '/api/projects/project-1/research', {method: 'POST'});
  const running = runtime.runner.runOnce();
  await started;

  const cancelled = await request(base, '/api/projects/project-1/cancel', {method: 'POST'});
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.json.changed, true);
  assert.equal(cancelled.json.project.status, 'cancelled');
  const repeated = await request(base, '/api/projects/project-1/cancel', {method: 'POST'});
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.json.changed, false);

  release();
  assert.equal(await running, true);
  const after = await request(base, '/api/projects/project-1');
  assert.equal(after.json.project.status, 'cancelled');
  assert.equal(after.json.project.research, null);
  assert.equal(runtime.jobs.getStage('stage-1').state, 'cancelled');
  assert.equal((await request(base, '/api/projects/project-1/sources')).json.sources.length, 1);

  await closeServer(runtime.server);
  runtime.db.close();
});

test('health is local-only and invalid API states return sanitized stable errors with request IDs', async () => {
  let providerCalls = 0;
  const provider = {async research() { providerCalls += 1; return successResult; }};
  const runtime = createRuntime({provider});
  const base = await listen(runtime.server);

  const live = await request(base, '/health/live');
  assert.equal(live.response.status, 200);
  assert.equal(live.json.ok, true);
  const ready = await request(base, '/health/ready');
  assert.equal(ready.response.status, 200);
  assert.equal(ready.json.ready, true);
  assert.equal(providerCalls, 0);

  const invalid = await request(base, '/api/projects', {method: 'POST', body: {creator: '', topic: 'x'}});
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_REQUEST');
  assert.equal(invalid.json.requestId, 'request-3');
  assert.equal(invalid.response.headers.get('x-request-id'), 'request-3');
  assert.equal(JSON.stringify(invalid.json).includes('stack'), false);

  await createProject(base);
  const retry = await request(base, '/api/projects/project-1/retry', {method: 'POST'});
  assert.equal(retry.response.status, 409);
  assert.equal(retry.json.error.code, 'STAGE_NOT_RETRYABLE');
  const cancel = await request(base, '/api/projects/project-1/cancel', {method: 'POST'});
  assert.equal(cancel.response.status, 409);
  assert.equal(cancel.json.error.code, 'STAGE_NOT_ACTIVE');

  await closeServer(runtime.server);
  runtime.db.close();
});
