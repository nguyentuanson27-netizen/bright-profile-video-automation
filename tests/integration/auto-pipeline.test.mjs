import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGenerationProjectService} from '../../app/services/generate-project.mjs';
import {createResearchProjectService} from '../../app/services/research-project.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createWorkerHandlers} from '../../worker/handlers.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

test('research completion replays after a crash and automatically enqueues generation exactly once', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-auto-pipeline-'));
  const db = openDatabase({filename: path.join(directory, 'app.sqlite')});
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const projectStateStore = createProjectStateStore(db);
    let researchCalls = 0;
    let generationCalls = 0;

    const researchService = createResearchProjectService({
      repositories,
      projectStateStore,
      researchProvider: {
        search: async () => {
          researchCalls += 1;
          return {candidates: [{
            url: 'https://example.com/creator',
            platform: 'example.com',
            sourceType: 'page',
            discoveryStatus: 'discovered',
          }]};
        },
      },
      fetchSource: async () => ({
        statusCode: 200,
        contentType: 'text/html',
        body: Buffer.from('<main>Verified creator facts.</main>'),
      }),
      projectIdGenerator: () => 'project-auto',
      jobIdGenerator: () => 'research-auto',
    });
    const generationService = createGenerationProjectService({
      repositories,
      projectStateStore,
      generationProvider: {
        generate: async ({sources}) => {
          generationCalls += 1;
          return {
            researchSummary: 'Verified summary.',
            claims: [{id: 'claim-1', text: 'Verified fact.', sourceIds: [sources[0].sourceId], status: 'supported'}],
            script: 'Short script.',
            voiceover: {chunks: [{id: 'voice-1', start: 0, duration: 3, text: 'Voice.'}]},
            project: {
              duration: 3,
              creatorName: 'Creator',
              scenes: [{id: 'hero', type: 'hero', start: 0, duration: 3}],
            },
          };
        },
      },
    });
    const handlers = createWorkerHandlers({
      researchService,
      generationService,
      renderService: {handleJob: async () => {}},
    });

    const project = researchService.createProject({topic: 'Creator'});
    const {job: researchJob} = researchService.enqueueResearch(project.id);
    const jobStore = createJobStore(db);
    const startedAt = new Date('2026-08-10T00:00:00.000Z');
    const abandoned = jobStore.claimNext({workerId: 'dead-worker', now: startedAt, leaseMs: 1_000});
    assert.equal(abandoned.id, researchJob.id);

    // Simulate a crash after research persisted sources/status but before the handler enqueues generation.
    await researchService.execute({job: abandoned});
    assert.equal(researchCalls, 1);
    assert.equal(repositories.projects.get(project.id).status, 'research_ready');

    const recoveredAt = new Date(startedAt.getTime() + 2_000);
    const runner = createJobRunner({
      jobStore,
      workerId: 'replacement-worker',
      handlers,
      leaseMs: 30_000,
      clock: () => recoveredAt,
    });
    const recoveredResearch = await runner.runOnce();
    assert.equal(recoveredResearch.status, 'succeeded');
    assert.equal(researchCalls, 1, 'research provider must not run again after persisted research completion');
    assert.equal(repositories.projects.get(project.id).status, 'generating');

    const generationJobId = `generation-${researchJob.id}`;
    const generationJob = repositories.jobs.get(generationJobId);
    assert.ok(generationJob);
    assert.equal(generationJob.stage, 'generating');

    // Replaying the generation enqueue path returns the same durable job instead of creating a duplicate.
    const replay = await generationService.enqueueGeneration(project.id, {jobId: generationJobId});
    assert.equal(replay.job.id, generationJobId);

    const completedGeneration = await runner.runOnce();
    assert.equal(completedGeneration.status, 'succeeded');
    assert.equal(generationCalls, 1);
    assert.equal(repositories.projects.get(project.id).status, 'review_required');
  } finally {
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
