import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {ErrorCodes} from '../../domain/errors.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-generation-worker-')), 'app.sqlite');

const validDraft = (summary = 'Creator profile summary.') => ({
  creatorName: 'Creator',
  summary,
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
});

const seedResearchReady = (db) => {
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', instructions: 'Factual', status: 'draft'});
  repos.sources.create({
    id: 'source-1', projectId: 'project-1', url: 'https://research.example/profile', status: 'available',
    payload: {title: 'Profile'},
  });
  db.prepare(`UPDATE projects SET status = 'research_ready', research_json = ? WHERE id = ?`).run(JSON.stringify({
    schemaVersion: '1.0', normalizerVersion: '1.0.0', subject: {name: 'Creator'}, researchedAt: '2026-08-14T00:00:00.000Z',
    stats: {inputItems: 1, retainedEvidence: 1, exactDuplicatesRemoved: 0, nearDuplicatesMerged: 0, conflictGroups: 0, rejectedItems: 0},
    evidence: [{id: 'ev-1', claim: 'Creator reached 100 followers.', claimNormalized: 'creator reached 100 followers', fingerprint: 'sha256:x', qualityScore: 0.9, confidence: 'high', conflictGroupId: null, sources: [{url: 'https://research.example/profile', canonicalUrl: 'https://research.example/profile'}]}],
    conflicts: [], rejectedItems: [],
  }), 'project-1');
  return repos;
};

const jobStore = (db) => {
  let revisionNo = 0;
  return createJobStore(db, {
    leaseMs: 100,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    defaultMaxAttempts: 3,
    revisionIdFactory: () => `revision-${++revisionNo}`,
  });
};

test('durable generation commits exactly one locally validated review draft and survives reopen', async () => {
  const databasePath = tempDatabasePath();
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = seedResearchReady(db);
  const jobs = jobStore(db);
  let observed;
  const service = createGenerationService({provider: {async generate(input) { observed = input; return validDraft(); }}});
  const runner = createJobRunner({
    jobs, workerId: 'worker-a', leaseMs: 100, now: () => 1000,
    handlers: {generation: createGenerationStageHandler({repos, generationService: service})},
  });

  const started = jobs.startGeneration({projectId: 'project-1', stageId: 'generation-stage', nowMs: 1000, maxAttempts: 3});
  assert.equal(started.changed, true);
  assert.equal(repos.projects.get('project-1').status, 'generating');
  assert.equal(await runner.runOnce(), true);
  assert.deepEqual(observed.sources.map(({id}) => id), ['source-1']);
  assert.deepEqual(observed.evidence[0].sourceIds, ['source-1']);

  const project = repos.projects.get('project-1');
  assert.equal(project.status, 'review_required');
  assert.equal(project.currentRevisionId, 'revision-1');
  assert.equal(jobs.getStage('generation-stage').state, 'succeeded');
  assert.equal(repos.revisions.get('revision-1').payload.summary, 'Creator profile summary.');
  db.close();

  const reopened = openDatabase(databasePath);
  migrateDatabase(reopened);
  const reopenedRepos = createRepositories(reopened);
  assert.equal(reopenedRepos.projects.get('project-1').status, 'review_required');
  assert.equal(reopenedRepos.revisions.get('revision-1').payload.claims[0].sourceIds[0], 'source-1');
  reopened.close();
});

test('reclaimed generation fences stale owner so only the current claim can create the review draft', () => {
  const db = openDatabase(tempDatabasePath());
  migrateDatabase(db);
  const repos = seedResearchReady(db);
  const jobs = jobStore(db);
  jobs.startGeneration({projectId: 'project-1', stageId: 'generation-stage', nowMs: 1000, maxAttempts: 3});
  const attemptA = jobs.claimNext({workerId: 'worker-a', nowMs: 1000, allowedTypes: ['generation']});
  assert.deepEqual(jobs.recoverExpired({nowMs: 1101}), {recovered: 1, exhausted: 0});
  const attemptB = jobs.claimNext({workerId: 'worker-b', nowMs: 1111, allowedTypes: ['generation']});

  assert.throws(
    () => jobs.commitGeneration({stageId: 'generation-stage', claimToken: attemptA.claimToken, draft: validDraft('stale'), nowMs: 1112}),
    (error) => error.code === ErrorCodes.STALE_CLAIM,
  );
  assert.equal(repos.projects.get('project-1').currentRevisionId, null);

  jobs.commitGeneration({stageId: 'generation-stage', claimToken: attemptB.claimToken, draft: validDraft('current'), nowMs: 1113});
  const project = repos.projects.get('project-1');
  assert.equal(project.status, 'review_required');
  assert.equal(repos.revisions.get(project.currentRevisionId).payload.summary, 'current');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 1);
  db.close();
});

test('cancelling blocked generation returns immediately and late provider completion cannot create a draft', async () => {
  const db = openDatabase(tempDatabasePath());
  migrateDatabase(db);
  const repos = seedResearchReady(db);
  const jobs = jobStore(db);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedProvider = new Promise((resolve) => { entered = resolve; });
  const service = createGenerationService({provider: {async generate() { entered(); await gate; return validDraft(); }}});
  const runner = createJobRunner({
    jobs, workerId: 'worker-a', leaseMs: 1000, now: () => 1000,
    handlers: {generation: createGenerationStageHandler({repos, generationService: service})},
  });
  jobs.startGeneration({projectId: 'project-1', stageId: 'generation-stage', nowMs: 1000, maxAttempts: 3});
  const running = runner.runOnce();
  await startedProvider;
  const cancelled = jobs.cancel({stageId: 'generation-stage', nowMs: 1001});
  assert.equal(cancelled.changed, true);
  assert.equal(repos.projects.get('project-1').status, 'cancelled');
  release();
  assert.equal(await running, true);
  assert.equal(repos.projects.get('project-1').currentRevisionId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?').get('project-1').n, 0);
  db.close();
});
