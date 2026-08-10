import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createApprovalService} from '../../app/services/approve-project.mjs';
import {createGenerationProjectService} from '../../app/services/generate-project.mjs';
import {createResearchProjectService} from '../../app/services/research-project.mjs';
import {createFakeGenerationProvider, createFakeResearchProvider} from '../fakes/providers.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const clock = () => new Date('2026-08-10T00:00:00.000Z');

test('Checkpoint B: deterministic topic to approved immutable revision', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-checkpoint-b-'));
  const db = openDatabase({filename: path.join(directory, 'app.sqlite')});
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const projectStateStore = createProjectStateStore(db);
    const researchService = createResearchProjectService({
      repositories,
      projectStateStore,
      researchProvider: createFakeResearchProvider({mode: 'success'}),
      fetchSource: async () => ({
        statusCode: 200,
        contentType: 'text/html',
        body: Buffer.from('<html><body>Public creator evidence.</body></html>'),
      }),
      projectIdGenerator: () => 'project-1',
      jobIdGenerator: () => 'job-research',
      clock,
    });

    const project = researchService.createProject({topic: 'Creator'});
    assert.equal(project.status, 'draft');
    researchService.enqueueResearch(project.id);

    const jobStore = createJobStore(db);
    const researchRunner = createJobRunner({
      jobStore,
      workerId: 'worker-research',
      clock,
      handlers: {researching: ({job}) => researchService.execute({job})},
    });
    assert.equal((await researchRunner.runOnce()).status, 'succeeded');
    assert.equal(repositories.projects.get(project.id).status, 'research_ready');
    const sources = repositories.sources.listByProject(project.id);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].retrievalStatus, 'available');

    const generationService = createGenerationProjectService({
      repositories,
      projectStateStore,
      generationProvider: createFakeGenerationProvider({mode: 'success'}),
      jobIdGenerator: () => 'job-generate',
      clock,
    });
    generationService.enqueueGeneration(project.id);
    const generationRunner = createJobRunner({
      jobStore,
      workerId: 'worker-generation',
      clock,
      handlers: {generating: ({job}) => generationService.execute({job})},
    });
    assert.equal((await generationRunner.runOnce()).status, 'succeeded');
    assert.equal(repositories.projects.get(project.id).status, 'review_required');

    const revisionId = 'revision-job-generate';
    const draft = repositories.revisions.get(revisionId);
    assert.equal(draft.status, 'draft');
    assert.deepEqual(draft.payload.generation.claims[0].sourceIds, [sources[0].sourceId]);

    const approvalService = createApprovalService({repositories, projectStateStore, clock});
    const draftWithUnverified = structuredClone(draft.payload.generation);
    draftWithUnverified.claims.push({
      id: 'claim-unverified',
      text: 'Needs operator confirmation.',
      sourceIds: [],
      status: 'unverified',
    });
    approvalService.editDraft({projectId: project.id, revisionId, generation: draftWithUnverified});

    assert.throws(
      () => approvalService.approve({projectId: project.id, revisionId, approvedBy: 'operator'}),
      (error) => error instanceof AppError && error.code === 'UNVERIFIED_CLAIMS',
    );

    const inventedCitation = structuredClone(draftWithUnverified);
    inventedCitation.claims[0].sourceIds = ['source-invented'];
    assert.throws(
      () => approvalService.editDraft({projectId: project.id, revisionId, generation: inventedCitation}),
      (error) => error instanceof AppError && error.code === 'UNKNOWN_SOURCE_REFERENCE',
    );

    const approved = approvalService.approve({
      projectId: project.id,
      revisionId,
      approvedBy: 'operator',
      claimOverrides: [{claimId: 'claim-unverified', reason: 'Reviewed by operator.'}],
    });
    assert.equal(approved.status, 'approved');
    assert.equal(repositories.projects.get(project.id).status, 'approved');
    assert.match(approved.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(approvalService.assertRenderAllowed({projectId: project.id, revisionId}).status, 'approved');
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
