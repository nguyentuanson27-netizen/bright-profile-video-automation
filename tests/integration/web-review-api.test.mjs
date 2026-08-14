import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const hashDraft = (draft) => createHash('sha256').update(JSON.stringify(draft)).digest('hex');
const baseDraft = () => ({
  creatorName: 'Creator',
  summary: 'Original summary.',
  claims: [{id: 'claim-1', text: 'Supported fact.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Supported fact.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Supported fact.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1'], heading: 'Original'}],
  render: {duration: 5, renderScale: 1, crf: 20},
});

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

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), 'bright-web-review-api-'));
  const db = openDatabase(join(root, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db, {leaseMs: 1000});
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', status: 'review_required'});
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: 'https://example.test/source-1', status: 'available', payload: {title: 'Source 1'}});
  repos.sources.create({id: 'source-2', projectId: 'project-1', url: 'https://example.test/source-2', status: 'available', payload: {title: 'Source 2'}});
  const draft = baseDraft();
  repos.revisions.create({id: 'revision-1', projectId: 'project-1', revisionNo: 1, payload: draft, payloadHash: hashDraft(draft)});
  let revisionNo = 1;
  const server = createAppServer({
    db,
    repos,
    jobs,
    dataDir: root,
    now: () => Date.parse('2026-08-14T10:00:00Z'),
    nowMs: () => 1000,
    revisionIdFactory: () => `revision-${++revisionNo}`,
    projectIdFactory: () => 'unused-project',
    sourceIdFactory: () => 'unused-source',
    stageIdFactory: () => 'unused-stage',
    requestIdFactory: () => 'review-request',
  });
  return {db, repos, server, base: await listen(server)};
};

test('structured scene plan, timing, source linkage and render settings persist through the review API', async () => {
  const ctx = await fixture();
  try {
    const edited = baseDraft();
    edited.summary = 'Operator-reviewed summary.';
    edited.scenes[0] = {
      ...edited.scenes[0],
      type: 'stats',
      start: 0.5,
      duration: 3.5,
      sourceIds: ['source-2'],
      heading: 'Reviewed scene',
      stats: [{label: 'Followers', value: '100'}],
    };
    edited.render = {duration: 6, renderScale: 1.5, crf: 22};

    const saved = await request(ctx.base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: edited}});
    assert.equal(saved.response.status, 200);
    assert.equal(saved.json.project.status, 'review_required');

    const loaded = await request(ctx.base, '/api/projects/project-1/draft');
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.json.revision.payload.scenes[0].type, 'stats');
    assert.equal(loaded.json.revision.payload.scenes[0].start, 0.5);
    assert.equal(loaded.json.revision.payload.scenes[0].duration, 3.5);
    assert.deepEqual(loaded.json.revision.payload.scenes[0].sourceIds, ['source-2']);
    assert.deepEqual(loaded.json.revision.payload.scenes[0].stats, [{label: 'Followers', value: '100'}]);
    assert.deepEqual(loaded.json.revision.payload.render, {duration: 6, renderScale: 1.5, crf: 22});
  } finally {
    await close(ctx.server);
    ctx.db.close();
  }
});

test('structured review API rejects out-of-bounds render settings and unknown scene sources without mutating the current draft', async () => {
  const ctx = await fixture();
  try {
    const before = (await request(ctx.base, '/api/projects/project-1/draft')).json.revision;
    const badRender = baseDraft();
    badRender.render.duration = 1801;
    const renderRejected = await request(ctx.base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: badRender}});
    assert.equal(renderRejected.response.status, 400);
    assert.equal(renderRejected.json.error.code, 'INVALID_DOMAIN_DATA');

    const badSource = baseDraft();
    badSource.scenes[0].sourceIds = ['missing-source'];
    const sourceRejected = await request(ctx.base, '/api/projects/project-1/draft', {method: 'PUT', body: {draft: badSource}});
    assert.equal(sourceRejected.response.status, 400);
    assert.equal(sourceRejected.json.error.code, 'UNKNOWN_SOURCE_REFERENCE');

    const after = (await request(ctx.base, '/api/projects/project-1/draft')).json.revision;
    assert.equal(after.id, before.id);
    assert.deepEqual(after.payload, before.payload);
  } finally {
    await close(ctx.server);
    ctx.db.close();
  }
});
