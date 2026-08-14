import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {createMediaIngestStageHandler} from '../../app/services/ingest-media.mjs';
import {ErrorCodes} from '../../domain/errors.mjs';
import {GenerationProviderError, GenerationProviderErrorCodes} from '../../providers/generation/index.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const hashDraft = (draft) => createHash('sha256').update(JSON.stringify(draft)).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
};
const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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

const validDraft = (summary = 'Creator profile summary.') => ({
  creatorName: 'Creator',
  summary,
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4, renderScale: 1, crf: 20},
});

const seedResearchReady = (db, repos, projectId = 'project-1') => {
  repos.projects.create({id: projectId, creator: 'Creator', topic: 'career', status: 'draft'});
  repos.sources.create({id: 'source-1', projectId, url: 'https://research.example/profile', status: 'available', payload: {title: 'Profile'}});
  db.prepare(`UPDATE projects SET status = 'research_ready', research_json = ? WHERE id = ?`).run(JSON.stringify({
    schemaVersion: '1.0',
    normalizerVersion: '1.0.0',
    subject: {name: 'Creator'},
    researchedAt: '2026-08-14T00:00:00.000Z',
    stats: {inputItems: 1, retainedEvidence: 1, exactDuplicatesRemoved: 0, nearDuplicatesMerged: 0, conflictGroups: 0, rejectedItems: 0},
    evidence: [{
      id: 'ev-1', claim: 'Creator reached 100 followers.', claimNormalized: 'creator reached 100 followers',
      fingerprint: 'sha256:x', qualityScore: 0.9, confidence: 'high', conflictGroupId: null,
      sources: [{url: 'https://research.example/profile', canonicalUrl: 'https://research.example/profile'}],
    }],
    conflicts: [], rejectedItems: [],
  }), projectId);
};

const createGenerationRuntime = async ({provider, leaseMs = 1000, heartbeatMs} = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'bright-standalone-controls-'));
  const databasePath = join(root, 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  seedResearchReady(db, repos);
  let revisionNo = 0;
  const jobs = createJobStore(db, {
    leaseMs,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    revisionIdFactory: () => `revision-${++revisionNo}`,
  });
  let nowMs = 1;
  let stageNo = 0;
  const server = createAppServer({
    db, repos, jobs, dataDir: root, nowMs: () => nowMs,
    projectIdFactory: () => 'unused-project', sourceIdFactory: () => 'unused-source',
    revisionIdFactory: () => `edit-revision-${++revisionNo}`, stageIdFactory: () => `stage-${++stageNo}`,
    requestIdFactory: () => 'standalone-e2e-request', generationMaxAttempts: 3,
  });
  const generationService = createGenerationService({provider});
  const generationHandler = createGenerationStageHandler({repos, generationService});
  const runner = createJobRunner({
    jobs, workerId: 'worker-a', leaseMs, ...(heartbeatMs ? {heartbeatMs} : {}), now: () => nowMs,
    handlers: {generation: generationHandler},
  });
  return {
    root, databasePath, db, repos, jobs, server, runner, generationHandler,
    base: await listen(server),
    now: () => nowMs,
    setNow: (value) => { nowMs = value; },
  };
};

test('final standalone E2E retries a retryable failed stage through HTTP exactly once and reaches review', async () => {
  let calls = 0;
  const ctx = await createGenerationRuntime({provider: {
    async generate() {
      calls += 1;
      if (calls === 1) throw new GenerationProviderError(GenerationProviderErrorCodes.FAILED, 'temporary provider failure', {retryable: true});
      return validDraft('retried draft');
    },
  }});
  try {
    assert.equal((await request(ctx.base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
    assert.equal(await ctx.runner.runOnce(), true);
    assert.equal(ctx.repos.projects.get('project-1').status, 'failed');
    assert.equal(ctx.repos.projects.get('project-1').failureRetryable, true);

    ctx.setNow(2);
    const retried = await request(ctx.base, '/api/projects/project-1/retry', {method: 'POST'});
    assert.equal(retried.response.status, 200);
    assert.equal(retried.json.changed, true);
    const repeated = await request(ctx.base, '/api/projects/project-1/retry', {method: 'POST'});
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.json.changed, false);

    ctx.setNow(3);
    assert.equal(await ctx.runner.runOnce(), true);
    assert.equal(calls, 2);
    assert.equal(ctx.repos.projects.get('project-1').status, 'review_required');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 1);
    assert.equal(ctx.jobs.listAttempts(ctx.jobs.getCurrentStage('project-1').id).length, 2);
  } finally {
    await close(ctx.server);
    ctx.db.close();
  }
});

test('final standalone E2E cancels blocked work through HTTP, repeated cancel is a no-op, and late completion is fenced', async () => {
  const started = deferred();
  const release = deferred();
  const ctx = await createGenerationRuntime({provider: {
    async generate() {
      started.resolve();
      await release.promise;
      return validDraft('must not publish');
    },
  }});
  try {
    assert.equal((await request(ctx.base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
    const running = ctx.runner.runOnce();
    await started.promise;

    ctx.setNow(2);
    const cancelled = await request(ctx.base, '/api/projects/project-1/cancel', {method: 'POST'});
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.json.changed, true);
    const repeated = await request(ctx.base, '/api/projects/project-1/cancel', {method: 'POST'});
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.json.changed, false);

    release.resolve();
    assert.equal(await running, true);
    assert.equal(ctx.repos.projects.get('project-1').status, 'cancelled');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 0);
    assert.equal(ctx.jobs.getCurrentStage('project-1').state, 'cancelled');
  } finally {
    await close(ctx.server);
    ctx.db.close();
  }
});

test('final standalone E2E reopens generation state after lease expiry and stale owner cannot create a duplicate draft', async () => {
  const ctx = await createGenerationRuntime({provider: {async generate() { return validDraft(); }}, leaseMs: 100});
  assert.equal((await request(ctx.base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
  const staleClaim = ctx.jobs.claimNext({workerId: 'stale-worker', nowMs: 1, allowedTypes: ['generation']});
  assert.ok(staleClaim);
  await close(ctx.server);
  ctx.db.close();

  const reopened = openDatabase(ctx.databasePath);
  migrateDatabase(reopened);
  const repos = createRepositories(reopened);
  let revisionNo = 0;
  const jobs = createJobStore(reopened, {
    leaseMs: 100, baseBackoffMs: 1, maxBackoffMs: 1,
    revisionIdFactory: () => `recovered-revision-${++revisionNo}`,
  });
  try {
    assert.deepEqual(jobs.recoverExpired({nowMs: 102}), {recovered: 1, exhausted: 0});
    const replacement = jobs.claimNext({workerId: 'replacement-worker', nowMs: 103, allowedTypes: ['generation']});
    assert.ok(replacement);
    assert.throws(
      () => jobs.commitGeneration({stageId: staleClaim.stageId, claimToken: staleClaim.claimToken, draft: validDraft('stale'), nowMs: 104}),
      (error) => error.code === ErrorCodes.STALE_CLAIM,
    );
    jobs.commitGeneration({stageId: replacement.stageId, claimToken: replacement.claimToken, draft: validDraft('recovered'), nowMs: 105});
    assert.equal(repos.projects.get('project-1').status, 'review_required');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 1);
    assert.equal(repos.revisions.get(repos.projects.get('project-1').currentRevisionId).payload.summary, 'recovered');
  } finally {
    reopened.close();
  }
});

const preparedMedia = (suffix) => ({
  mediaArtifacts: [{
    kind: 'media_input', relativePath: `projects/p/attempts/${suffix}/media/input.png`,
    mimeType: 'image/png', byteSize: 8, sha256: 'b'.repeat(64),
  }],
  manifestArtifact: {
    kind: 'media_manifest', relativePath: `projects/p/attempts/${suffix}/media/manifest.json`,
    mimeType: 'application/json', byteSize: 8, sha256: 'c'.repeat(64),
  },
});

const seedReviewRequired = (repos) => {
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', status: 'review_required'});
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: 'https://research.example/profile', status: 'available', payload: {title: 'Profile'}});
  const draft = validDraft();
  repos.revisions.create({id: 'revision-1', projectId: 'project-1', revisionNo: 1, payload: draft, payloadHash: hashDraft(draft)});
};

const createReviewServer = async ({databasePath, db, repos, jobs, root, suffix = 'a', nowMs = () => 1} = {}) => {
  let revisionNo = 0;
  let stageNo = 0;
  const server = createAppServer({
    db, repos, jobs, dataDir: root, nowMs,
    now: () => Date.parse('2026-08-14T10:00:00Z'),
    projectIdFactory: () => `unused-project-${suffix}`, sourceIdFactory: () => `unused-source-${suffix}`,
    revisionIdFactory: () => `${suffix}-revision-${++revisionNo}`, stageIdFactory: () => `${suffix}-stage-${++stageNo}`,
    requestIdFactory: () => `request-${suffix}`, mediaIngestMaxAttempts: 3,
  });
  return {databasePath, db, repos, jobs, server, base: await listen(server)};
};

test('final standalone E2E reclaims media ingest with exactly one authoritative artifact set and fences the late owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-media-final-e2e-'));
  const databasePath = join(root, 'app.sqlite');
  const dbA = openDatabase(databasePath);
  migrateDatabase(dbA);
  const reposA = createRepositories(dbA);
  seedReviewRequired(reposA);
  const jobsA = createJobStore(dbA, {leaseMs: 100000, baseBackoffMs: 1, maxBackoffMs: 1});
  const artifactsA = createArtifactStore(dbA);
  const app = await createReviewServer({databasePath, db: dbA, repos: reposA, jobs: jobsA, root});

  let call = 0;
  const staleStarted = deferred();
  const staleRelease = deferred();
  const service = {
    async ingest() {
      call += 1;
      if (call === 1) {
        staleStarted.resolve();
        await staleRelease.promise;
        return preparedMedia('stale');
      }
      return preparedMedia('replacement');
    },
  };

  try {
    assert.equal((await request(app.base, '/api/projects/project-1/approve', {method: 'POST'})).response.status, 200);
    assert.equal((await request(app.base, '/api/projects/project-1/render', {method: 'POST'})).response.status, 202);

    const staleHandler = createMediaIngestStageHandler({repos: reposA, artifactStore: artifactsA, service, nextMaxAttempts: 3});
    const staleRunner = createJobRunner({
      jobs: jobsA, workerId: 'stale-media-worker', leaseMs: 100000, heartbeatMs: 99999, now: () => 1,
      handlers: {media_ingest: staleHandler},
    });
    const staleRun = staleRunner.runOnce();
    await staleStarted.promise;

    const dbB = openDatabase(databasePath);
    const reposB = createRepositories(dbB);
    const jobsB = createJobStore(dbB, {leaseMs: 100000, baseBackoffMs: 1, maxBackoffMs: 1});
    const artifactsB = createArtifactStore(dbB);
    const replacementHandler = createMediaIngestStageHandler({repos: reposB, artifactStore: artifactsB, service, nextMaxAttempts: 3});
    const replacementRunner = createJobRunner({
      jobs: jobsB, workerId: 'replacement-media-worker', leaseMs: 100000, heartbeatMs: 99999, now: () => 100002,
      handlers: {media_ingest: replacementHandler},
    });
    try {
      assert.equal(await replacementRunner.runOnce(), true);
      staleRelease.resolve();
      assert.equal(await staleRun, true);
      const authoritative = artifactsB.getAuthoritative('project-1', 'revision-1', 'media_manifest');
      assert.equal(authoritative.relativePath.includes('/replacement/'), true);
      assert.equal(dbB.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND revision_id = ? AND kind = 'media_manifest'").get('project-1', 'revision-1').n, 1);
      assert.equal(dbB.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND stage_type = 'tts'").get('project-1').n, 1);
      assert.equal(reposB.projects.get('project-1').status, 'tts');
    } finally {
      dbB.close();
    }
  } finally {
    staleRelease.resolve();
    await close(app.server);
    dbA.close();
  }
});

test('final standalone E2E renews a long-running generation lease before completion so recovery cannot steal it', async () => {
  const firstGate = deferred();
  const heartbeatDone = deferred();
  const finishGate = deferred();
  const ctx = await createGenerationRuntime({provider: {async generate() { return validDraft('heartbeat protected'); }}, leaseMs: 1000, heartbeatMs: 999});
  const wrapped = async (claim, context) => {
    await firstGate.promise;
    context.heartbeat();
    heartbeatDone.resolve();
    await finishGate.promise;
    return ctx.generationHandler(claim, context);
  };
  const runner = createJobRunner({
    jobs: ctx.jobs, workerId: 'heartbeat-worker', leaseMs: 1000, heartbeatMs: 999, now: ctx.now,
    handlers: {generation: wrapped},
  });
  try {
    assert.equal((await request(ctx.base, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
    const running = runner.runOnce();
    ctx.setNow(800);
    firstGate.resolve();
    await heartbeatDone.promise;
    assert.deepEqual(ctx.jobs.recoverExpired({nowMs: 1200}), {recovered: 0, exhausted: 0});
    ctx.setNow(1300);
    finishGate.resolve();
    assert.equal(await running, true);
    assert.equal(ctx.repos.projects.get('project-1').status, 'review_required');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 1);
  } finally {
    firstGate.resolve();
    finishGate.resolve();
    await close(ctx.server);
    ctx.db.close();
  }
});

test('final standalone E2E serializes approval edit versus downstream start without mixed state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-approval-race-final-e2e-'));
  const databasePath = join(root, 'app.sqlite');
  const dbA = openDatabase(databasePath);
  migrateDatabase(dbA);
  const reposA = createRepositories(dbA);
  seedReviewRequired(reposA);
  const jobsA = createJobStore(dbA, {leaseMs: 1000});
  const appA = await createReviewServer({databasePath, db: dbA, repos: reposA, jobs: jobsA, root, suffix: 'a'});
  assert.equal((await request(appA.base, '/api/projects/project-1/approve', {method: 'POST'})).response.status, 200);

  const dbB = openDatabase(databasePath);
  const reposB = createRepositories(dbB);
  const jobsB = createJobStore(dbB, {leaseMs: 1000});
  const appB = await createReviewServer({databasePath, db: dbB, repos: reposB, jobs: jobsB, root, suffix: 'b'});
  const edited = validDraft('concurrent approval-relevant edit');

  try {
    const [renderResult, editResult] = await Promise.all([
      request(appA.base, '/api/projects/project-1/render', {method: 'POST'}),
      request(appB.base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: edited}}),
    ]);
    const renderWon = renderResult.response.status === 202;
    const editWon = editResult.response.status === 200;
    assert.notEqual(renderWon, editWon);

    const project = reposA.projects.get('project-1');
    const mediaCount = dbA.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND revision_id = ? AND stage_type = 'media_ingest'").get('project-1', 'revision-1').n;
    if (renderWon) {
      assert.equal(editResult.response.status, 409);
      assert.equal(editResult.json.error.code, ErrorCodes.DOWNSTREAM_WORK_STARTED);
      assert.equal(project.status, 'media_ingest');
      assert.equal(project.approvedRevisionId, 'revision-1');
      assert.equal(mediaCount, 1);
    } else {
      assert.equal(renderResult.response.status, 409);
      assert.equal(renderResult.json.error.code, ErrorCodes.INVALID_TRANSITION);
      assert.equal(project.status, 'review_required');
      assert.equal(project.approvedRevisionId, null);
      assert.equal(mediaCount, 0);
      assert.notEqual(project.currentRevisionId, 'revision-1');
    }
  } finally {
    await close(appB.server);
    await close(appA.server);
    dbB.close();
    dbA.close();
  }
});
