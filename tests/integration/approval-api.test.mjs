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
  server.unref?.();
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

const peerRuntime = (databasePath, suffix) => {
  const db = openDatabase(databasePath);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000});
  let stageNo = 0;
  let revisionNo = 100;
  const server = createAppServer({
    db, repos, jobs, dataDir: join(databasePath, '..'), now: () => Date.parse('2026-08-14T04:00:01Z'), nowMs: () => 1001,
    projectIdFactory: () => `unused-project-${suffix}`, stageIdFactory: () => `${suffix}-stage-${++stageNo}`, sourceIdFactory: () => `unused-source-${suffix}`,
    revisionIdFactory: () => `${suffix}-revision-${++revisionNo}`, requestIdFactory: () => `request-${suffix}`, generationMaxAttempts: 3,
  });
  return {db, repos, jobs, server};
};

const generateDraft = async (ctx, base) => {
  const started = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(started.response.status, 202);
  assert.equal(await ctx.runner.runOnce(), true);
  const project = ctx.repos.projects.get('project-1');
  assert.equal(project.status, 'review_required');
  assert.equal(ctx.repos.revisions.get(project.currentRevisionId).payload.claims[0].verified, false);
  return project.currentRevisionId;
};

const verifyDraftAndApprove = async (base) => {
  const verified = validDraft();
  assert.equal((await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: verified}})).response.status, 200);
  const approved = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(approved.response.status, 200);
  return approved;
};

test('generate HTTP action is nonblocking and repeated active request does not create duplicate generation stages', async () => {
  const ctx = runtime(); const base = await listen(ctx.server);
  const first = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(first.response.status, 202); assert.equal(first.json.changed, true); assert.equal(first.json.project.status, 'generating');
  const second = await request(base, '/api/projects/project-1/generate', {method: 'POST'});
  assert.equal(second.response.status, 202); assert.equal(second.json.changed, false);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND stage_type = 'generation'").get('project-1').n, 1);
  await close(ctx.server); ctx.db.close();
});

test('draft editing is schema-checked and approval requires verified claims or explicit stored override reasons', async () => {
  const ctx = runtime(); const base = await listen(ctx.server); const revisionId = await generateDraft(ctx, base);
  const generatedBlocked = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(generatedBlocked.response.status, 409); assert.equal(generatedBlocked.json.error.code, 'APPROVAL_BLOCKED');
  const unknown = validDraft(); unknown.claims[0].sourceIds = ['missing-source'];
  const rejectedEdit = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unknown}});
  assert.equal(rejectedEdit.response.status, 400); assert.equal(rejectedEdit.json.error.code, 'UNKNOWN_SOURCE_REFERENCE');
  const unverified = validDraft(); unverified.claims[0].verified = false;
  assert.equal((await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unverified}})).response.status, 200);
  const blocked = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(blocked.response.status, 409); assert.equal(blocked.json.error.code, 'APPROVAL_BLOCKED');
  unverified.claims[0].overrideReason = 'Reviewed against the stored source by the operator.';
  assert.equal((await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: unverified}})).response.status, 200);
  const approved = await request(base, '/api/projects/project-1/approve', {method: 'POST'});
  assert.equal(approved.response.status, 200); assert.equal(approved.json.project.status, 'approved'); assert.equal(approved.json.revision.id, revisionId);
  assert.match(approved.json.revision.payloadHash, /^[a-f0-9]{64}$/); assert.ok(approved.json.revision.approvedAt);
  assert.throws(() => ctx.repos.revisions.updatePayload({revisionId, payload: validDraft(), payloadHash: 'b'.repeat(64)}), /immutable/);
  await close(ctx.server); ctx.db.close();
});

test('post-approval edit before downstream clones a new review revision and leaves the approved snapshot immutable', async () => {
  const ctx = runtime(); const base = await listen(ctx.server); const approvedRevisionId = await generateDraft(ctx, base);
  await verifyDraftAndApprove(base);
  const approvedBefore = structuredClone(ctx.repos.revisions.get(approvedRevisionId));
  const editedDraft = validDraft(); editedDraft.summary = 'Edited after approval, before downstream work.';
  const edited = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}});
  assert.equal(edited.response.status, 200); assert.equal(edited.json.project.status, 'review_required'); assert.equal(edited.json.project.approvedRevisionId, null);
  assert.notEqual(edited.json.project.currentRevisionId, approvedRevisionId); assert.deepEqual(ctx.repos.revisions.get(approvedRevisionId), approvedBefore);
  assert.equal(ctx.repos.revisions.get(edited.json.project.currentRevisionId).payload.summary, editedDraft.summary);
  assert.throws(() => ctx.repos.approval.createFirstDescendant({id: 'media-stage', projectId: 'project-1', revisionId: approvedRevisionId, type: 'media_ingest', maxAttempts: 3, availableAtMs: 1000}), (error) => error.code === 'INVALID_TRANSITION');
  await close(ctx.server); ctx.db.close();
});

test('once downstream stage creation wins, approval-relevant edit is rejected without mixed state', async () => {
  const ctx = runtime(); const base = await listen(ctx.server); const revisionId = await generateDraft(ctx, base);
  await verifyDraftAndApprove(base);
  ctx.repos.approval.createFirstDescendant({id: 'media-stage', projectId: 'project-1', revisionId, type: 'media_ingest', maxAttempts: 3, availableAtMs: 1000});
  const before = ctx.repos.projects.get('project-1'); const editedDraft = validDraft(); editedDraft.summary = 'Forbidden late edit.';
  const edited = await request(base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}});
  assert.equal(edited.response.status, 409); assert.equal(edited.json.error.code, 'DOWNSTREAM_WORK_STARTED'); assert.deepEqual(ctx.repos.projects.get('project-1'), before);
  assert.equal(ctx.repos.revisions.get(revisionId).payload.summary, 'Creator profile summary.');
  await close(ctx.server); ctx.db.close();
});

test('render-start HTTP creates exactly one queued media_ingest stage and repeated active request is idempotent', async () => {
  const ctx = runtime(); const base = await listen(ctx.server); const revisionId = await generateDraft(ctx, base);
  await verifyDraftAndApprove(base);
  const first = await request(base, '/api/projects/project-1/render', {method: 'POST'});
  assert.equal(first.response.status, 202); assert.equal(first.json.changed, true);
  assert.equal(first.json.project.status, 'media_ingest'); assert.equal(first.json.project.approvedRevisionId, revisionId);
  assert.equal(first.json.stage.type, 'media_ingest'); assert.equal(first.json.stage.state, 'queued'); assert.equal(first.json.stage.revisionId, revisionId);
  const second = await request(base, '/api/projects/project-1/render', {method: 'POST'});
  assert.equal(second.response.status, 202); assert.equal(second.json.changed, false); assert.equal(second.json.stage.id, first.json.stage.id);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND revision_id = ? AND stage_type = 'media_ingest'").get('project-1', revisionId).n, 1);
  await close(ctx.server); ctx.db.close();
});

test('render-start rejects unapproved, superseded and cancelled project states with stable transitions', async () => {
  const unapproved = runtime(); const unapprovedBase = await listen(unapproved.server);
  await generateDraft(unapproved, unapprovedBase);
  const unapprovedResult = await request(unapprovedBase, '/api/projects/project-1/render', {method: 'POST'});
  assert.equal(unapprovedResult.response.status, 409); assert.equal(unapprovedResult.json.error.code, 'INVALID_TRANSITION');
  await close(unapproved.server); unapproved.db.close();

  const superseded = runtime(); const supersededBase = await listen(superseded.server);
  await generateDraft(superseded, supersededBase); await verifyDraftAndApprove(supersededBase);
  const editedDraft = validDraft(); editedDraft.summary = 'Superseding review revision.';
  assert.equal((await request(supersededBase, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}})).response.status, 200);
  const supersededResult = await request(supersededBase, '/api/projects/project-1/render', {method: 'POST'});
  assert.equal(supersededResult.response.status, 409); assert.equal(supersededResult.json.error.code, 'INVALID_TRANSITION');
  await close(superseded.server); superseded.db.close();

  const cancelled = runtime(); const cancelledBase = await listen(cancelled.server);
  assert.equal((await request(cancelledBase, '/api/projects/project-1/generate', {method: 'POST'})).response.status, 202);
  assert.equal((await request(cancelledBase, '/api/projects/project-1/cancel', {method: 'POST'})).response.status, 200);
  assert.equal(cancelled.repos.projects.get('project-1').status, 'cancelled');
  const cancelledResult = await request(cancelledBase, '/api/projects/project-1/render', {method: 'POST'});
  assert.equal(cancelledResult.response.status, 409); assert.equal(cancelledResult.json.error.code, 'INVALID_TRANSITION');
  await close(cancelled.server); cancelled.db.close();
});

test('edit and render-start contention through HTTP serializes to exactly one valid winner', async () => {
  const primary = runtime(); const primaryBase = await listen(primary.server); const approvedRevisionId = await generateDraft(primary, primaryBase);
  await verifyDraftAndApprove(primaryBase);
  const peer = peerRuntime(primary.databasePath, 'peer'); const peerBase = await listen(peer.server);
  const editedDraft = validDraft(); editedDraft.summary = 'Contending approval-relevant edit.';
  const [renderResult, editResult] = await Promise.all([
    request(primaryBase, '/api/projects/project-1/render', {method: 'POST'}),
    request(peerBase, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: editedDraft}}),
  ]);
  const renderWon = renderResult.response.status === 202;
  const editWon = editResult.response.status === 200;
  assert.notEqual(renderWon, editWon);
  const project = primary.repos.projects.get('project-1');
  const mediaCount = primary.db.prepare("SELECT COUNT(*) AS n FROM stages WHERE project_id = ? AND revision_id = ? AND stage_type = 'media_ingest'").get('project-1', approvedRevisionId).n;
  if (renderWon) {
    assert.equal(renderResult.json.changed, true); assert.equal(editResult.response.status, 409); assert.equal(editResult.json.error.code, 'DOWNSTREAM_WORK_STARTED');
    assert.equal(project.status, 'media_ingest'); assert.equal(project.currentRevisionId, approvedRevisionId); assert.equal(project.approvedRevisionId, approvedRevisionId); assert.equal(mediaCount, 1);
  } else {
    assert.equal(renderResult.response.status, 409); assert.equal(renderResult.json.error.code, 'INVALID_TRANSITION'); assert.equal(editResult.json.project.status, 'review_required');
    assert.equal(project.status, 'review_required'); assert.notEqual(project.currentRevisionId, approvedRevisionId); assert.equal(project.approvedRevisionId, null); assert.equal(mediaCount, 0);
  }
  await close(peer.server); peer.db.close(); await close(primary.server); primary.db.close();
});
