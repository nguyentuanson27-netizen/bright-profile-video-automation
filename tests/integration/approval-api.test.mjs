import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createGenerationProjectService} from '../../app/services/generate-project.mjs';
import {createGenerationProvider} from '../../providers/generation/index.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const requestJson = (baseUrl, pathname, method, body) => fetch(`${baseUrl}${pathname}`, {
  method,
  headers: {'content-type': 'application/json'},
  body: body === undefined ? undefined : JSON.stringify(body),
});

const availableSource = {
  sourceId: 'source-available',
  url: 'https://example.com/creator',
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Verified creator profile facts.',
  contentHash: 'a'.repeat(64),
  sourceType: 'page',
};
const unavailableSource = {
  sourceId: 'source-unavailable',
  url: 'https://social.example/post',
  platform: 'social.example',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'unavailable',
  excerpt: '',
  sourceType: 'social',
};

const generationOutput = {
  researchSummary: 'Summary based on the available source.',
  claims: [
    {id: 'claim-supported', text: 'Supported fact.', sourceIds: ['source-available'], status: 'supported'},
    {id: 'claim-unverified', text: 'Needs operator verification.', sourceIds: [], status: 'unverified'},
  ],
  script: 'Original script.',
  voiceover: {chunks: [{id: 'hero', start: 0, duration: 6, text: 'Opening.'}]},
  project: {
    duration: 6,
    creatorName: 'Creator',
    scenes: [{id: 'hero', type: 'hero', start: 0, duration: 6}],
  },
};

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-approval-'));
  const db = openDatabase({filename: path.join(directory, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const projectStateStore = createProjectStateStore(db);
  repositories.projects.create({
    id: 'project-1',
    topic: 'Creator',
    status: 'research_ready',
    input: {topic: 'Creator', instructions: 'Keep it concise.', duration: 6},
  });
  repositories.sources.upsert({projectId: 'project-1', record: availableSource});
  repositories.sources.upsert({projectId: 'project-1', record: unavailableSource});
  return {directory, db, repositories, projectStateStore};
}

test('generate -> edit -> approval gate -> immutable approval -> post-approval edit creates new draft', async () => {
  const state = fixture();
  let server;
  try {
    let receivedSources;
    const generationProvider = createGenerationProvider({
      generate: async ({sources}) => {
        receivedSources = sources;
        return generationOutput;
      },
    });
    const generationService = createGenerationProjectService({
      repositories: state.repositories,
      projectStateStore: state.projectStateStore,
      generationProvider,
      jobIdGenerator: () => 'job-generate-1',
      revisionIdGenerator: ({job}) => `revision-${job.id}`,
      clock: () => new Date('2026-08-10T00:10:00.000Z'),
    });
    let editCounter = 0;
    const approvalService = createApprovalService({
      repositories: state.repositories,
      projectStateStore: state.projectStateStore,
      revisionIdGenerator: () => `revision-edit-${++editCounter}`,
      clock: () => new Date('2026-08-10T00:20:00.000Z'),
    });
    server = http.createServer(createHttpHandler({
      repositories: state.repositories,
      researchService: {createProject() {}, enqueueResearch() {}},
      generationService,
      approvalService,
      requestIdGenerator: () => 'request-approval',
    }));
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const generateResponse = await requestJson(baseUrl, '/api/projects/project-1/generate', 'POST', {});
    assert.equal(generateResponse.status, 202);
    const queued = await generateResponse.json();
    assert.equal(queued.job.id, 'job-generate-1');
    assert.equal(state.repositories.projects.get('project-1').status, 'generating');

    const runner = createJobRunner({
      jobStore: createJobStore(state.db),
      workerId: 'generation-worker',
      clock: () => new Date('2026-08-10T00:10:01.000Z'),
      handlers: {generating: ({job}) => generationService.execute({job})},
    });
    assert.equal((await runner.runOnce()).status, 'succeeded');
    assert.deepEqual(receivedSources, [availableSource]);
    assert.equal(state.repositories.projects.get('project-1').status, 'review_required');

    const revisionId = 'revision-job-generate-1';
    const revisionResponse = await fetch(`${baseUrl}/api/projects/project-1/revisions/${revisionId}`);
    assert.equal(revisionResponse.status, 200);
    const draft = await revisionResponse.json();
    assert.equal(draft.status, 'draft');
    assert.equal(draft.payload.generation.script, 'Original script.');

    const editedGeneration = structuredClone(generationOutput);
    editedGeneration.script = 'Operator edited script.';
    const editResponse = await requestJson(baseUrl, '/api/projects/project-1/draft', 'PATCH', {
      revisionId,
      generation: editedGeneration,
    });
    assert.equal(editResponse.status, 200);
    assert.equal((await editResponse.json()).payload.generation.script, 'Operator edited script.');

    const blockedApproval = await requestJson(baseUrl, '/api/projects/project-1/approve', 'POST', {
      revisionId,
      approvedBy: 'operator',
      claimOverrides: [],
    });
    assert.equal(blockedApproval.status, 409);
    assert.equal((await blockedApproval.json()).error.code, 'UNVERIFIED_CLAIMS');

    const approvedResponse = await requestJson(baseUrl, '/api/projects/project-1/approve', 'POST', {
      revisionId,
      approvedBy: 'operator',
      claimOverrides: [{claimId: 'claim-unverified', reason: 'Operator verified manually from public context.'}],
    });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json();
    assert.equal(approved.status, 'approved');
    assert.match(approved.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(approved.payload.generation.script, 'Operator edited script.');
    assert.equal(state.repositories.projects.get('project-1').status, 'approved');

    const postApprovalGeneration = structuredClone(editedGeneration);
    postApprovalGeneration.script = 'Edited after approval.';
    const postApprovalEdit = await requestJson(baseUrl, '/api/projects/project-1/draft', 'PATCH', {
      revisionId,
      generation: postApprovalGeneration,
    });
    assert.equal(postApprovalEdit.status, 200);
    const newDraft = await postApprovalEdit.json();
    assert.equal(newDraft.revisionId, 'revision-edit-1');
    assert.equal(newDraft.status, 'draft');
    assert.equal(state.repositories.projects.get('project-1').status, 'review_required');
    assert.equal(state.repositories.revisions.get(revisionId).status, 'approved');
    assert.equal(state.repositories.revisions.get(revisionId).payload.generation.script, 'Operator edited script.');

    assert.throws(
      () => approvalService.assertRenderAllowed({projectId: 'project-1', revisionId: newDraft.revisionId}),
      (error) => error instanceof AppError && error.code === 'APPROVED_REVISION_REQUIRED',
    );
  } finally {
    if (server) await close(server);
    if (state.db.open) state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('generation rejects provider claims that reference source IDs not supplied to the model', async () => {
  const state = fixture();
  try {
    const invalid = structuredClone(generationOutput);
    invalid.claims[0].sourceIds = ['source-unavailable'];
    const generationService = createGenerationProjectService({
      repositories: state.repositories,
      projectStateStore: state.projectStateStore,
      generationProvider: createGenerationProvider({generate: async () => invalid}),
      jobIdGenerator: () => 'job-generate-bad',
    });
    const {job} = generationService.enqueueGeneration('project-1');

    await assert.rejects(
      () => generationService.execute({job: {...job, stage: 'generating'}}),
      (error) => error instanceof AppError && error.code === 'UNKNOWN_SOURCE_REFERENCE',
    );
    assert.equal(state.repositories.revisions.get('revision-job-generate-bad'), null);
  } finally {
    if (state.db.open) state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});
