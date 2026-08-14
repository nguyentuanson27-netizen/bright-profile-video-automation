import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-approval-api-')), 'app.sqlite');
const validDraft = () => ({
  creatorName: 'Creator',
  summary: 'Creator profile summary.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
});

const seedResearchReady = (db) => {
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', instructions: '', status: 'draft'});
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: 'https://research.example/profile', status: 'available', payload: {title: 'Profile'}});
  db.prepare(`UPDATE projects SET status = 'research_ready', research_json = ? WHERE id = ?`).run(JSON.stringify({
    schemaVersion: '1.0', evidence: [{id: 'ev-1', claim: 'Creator reached 100 followers.', confidence: 'high', conflictGroupId: null, sources: [{url: 'https://research.example/profile', canonicalUrl: 'https://research.example/profile'}]}], conflicts: [],
  }), 'project-1');
  return repos;
};

const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const {port} = server.address();
  return `http://127.0.0.1:${port}`;
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

const runtime = () => {
  const databasePath = tempDatabasePath();
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = seedResearchReady(db);
  let revisionNo = 0;
  const jobs = createJobStore(db, {leaseMs: 1000, revisionIdFactory: () => `revision-${++revisionNo}`});
  let stageNo = 0;
  let editRevisionNo = 1;
  const server = createAppServer({
    db, repos, jobs, dataDir: join(databasePath, '..'), now: () => Date.parse('2026-08-14T04:00:00Z'), nowMs: () => 1000,
    projectIdFactory: () => 'unused-project', stageIdFactory: () => `stage-${++stageNo}`, sourceIdFactory: () => 'unused-source',
    revisionIdFactory: () => `revision-${++editRevisionNo}`, requestIdFactory: () => 'request-1', generationMaxAttempts: 3,
  });
  const generationService = createGenerationService({provider: {async generate() { return validDraft(); }}});
  const runner = createJobRunner({jobs, workerId: 'generation-worker', leaseMs: 1000, now: () => 1000, handlers: {generation: createGenerationStageHandler({repos, generationService})}});
  return {databasePath, db, repos, jobs, server, runner};
};

const generateDraft = async (ctx, base) => {
  const started = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(started.response.status, 202);
  assert.equal(await ctx.runner.runOnce(), true);
  const project = ctx.repos.projects.get('project-1');
  assert.equal(project.status, 'review_required');
  return project.currentRevisionId;
};

test('generate HTTP action is nonblocking and repeated active request does not create duplicate generation stages', async () => {
  const ctx = runtime();
  const base = await listen(ctx.server);
  const first = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(first.response.status, 202);
  assert.equal(first.json.changed, true);
  assert.equal(first.json.project.status, 'generating');
  const second = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(second.response.status, 202);
  assert.equal(second.json.changed, false);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND stage_type = 'generation'").get('project-1').n, 1);
  await close(ctx.server); ctx.db.close();
});

test('draft editing is schema-checked and approval requires verified claims or explicit stored override reasons', async () => {
  const ctx = runtime();
  const base = await listen(ctx.server);
  const revisionId = await generateDraft(ctx, base);

  const unknown = validDraft();
  unknown.claims[0].sourceIds = ['missing-source'];
  const rejectedEdit = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unknown}});
  assert.equal(rejectedEdit.response.status, 400);
  assert.equal(rejectedEdit.json.error.code, 'UNKNOWN_SOURCE_REFERENCE');

  const unverified = validDraft();
  unverified.claims[0].verified = false;
  const saved = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unverified}});
  assert.equal(saved.response.status, 200);
  const blocked = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.json.error.code, 'APPROVAL_BLOCKED');

  unverified.claims[0].overrideReason = 'Reviewed against the stored source by the operator.';
  const overridden = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unverified}});
  assert.equal(overridden.response.status, 200);
  const approved = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(approved.response.status, 200);
  assert.equal(approved.json.project.status, 'approved');
  assert.equal(approved.json.revision.id, revisionId);
  assert.match(approved.json.revision.payloadHash, /^[a-f0-9]{64}$/);
  assert.ok(approved.json.revision.approvedAt);
  assert.throws(() => ctx.repos.revisions.updatePayload({revisionId, payload: validDraft(), payloadHash: 'b'.repeat(64)}), /immutable/);

  await close(ctx.server); ctx.db.close();
});

test('post-approval edit before downstream clones a new review revision and leaves the approved snapshot immutable', async () => {
  const ctx = runtime();
  const base = await listen(ctx.server);
  const approvedRevisionId = await generateDraft(ctx, base);
  const approved = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(approved.response.status, 200);
  const approvedBefore = structuredClone(ctx.repos.revisions.get(approvedRevisionId));

  const editedDraft = validDraft();
  editedDraft.summary = 'Edited after approval, before downstream work.';
  const edited = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}});
  assert.equal(edited.response.status, 200);
  assert.equal(edited.json.project.status, 'review_required');
  assert.equal(edited.json.project.approvedRevisionId, null);
  assert.notEqual(edited.json.project.currentRevisionId, approvedRevisionId);
  assert.deepEqual(ctx.repos.revisions.get(approvedRevisionId), approvedBefore);
  assert.equal(ctx.repos.revisions.get(edited.json.project.currentRevisionId).payload.summary, editedDraft.summary);

  assert.throws(() => ctx.repos.approval.createFirstDescendant({
    id: 'media-stage', projectId: 'project-1', revisionId: approvedRevisionId, type: 'media_ingest', maxAttempts: 3, availableAtMs: 1000,
  }), (error) => error.code === 'INVALID_TRANSITION');
  await close(ctx.server); ctx.db.close();
});

test('once downstream stage creation wins, approval-relevant edit is rejected without mixed state', async () => {
  const ctx = runtime();
  const base = await listen(ctx.server);
  const revisionId = await generateDraft(ctx, base);
  await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  ctx.repos.approval.createFirstDescendant({
    id: 'media-stage', projectId: 'project-1', revisionId, type: 'media_ingest', maxAttempts: 3, availableAtMs: 1000,
  });
  const before = ctx.repos.projects.get('project-1');
  const editedDraft = validDraft(); editedDraft.summary = 'Forbidden late edit.';
  const edited = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}});
  assert.equal(edited.response.status, 409);
  assert.equal(edited.json.error.code, 'DOWNSTREAM_WORK_STARTED');
  assert.deepEqual(ctx.repos.projects.get('project-1'), before);
  assert.equal(ctx.repos.revisions.get(revisionId).payload.summary, 'Creator profile summary.');
  await close(ctx.server); ctx.db.close();
});
