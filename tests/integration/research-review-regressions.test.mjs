import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createResearchService, createResearchStageHandler} from '../../app/services/research-project.mjs';
import {ResearchProviderErrorCodes} from '../../providers/research/index.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';
import {createFakeResearchProvider} from '../fakes/research-provider.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-research-review-')), 'app.sqlite');

const createRuntime = ({databasePath = tempDatabasePath(), provider, fetchSource} = {}) => {
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  let sourceNo = 0;
  const jobs = createJobStore(db, {
    leaseMs: 1000,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    defaultMaxAttempts: 3,
    sourceIdFactory: () => `result-source-${++sourceNo}`,
  });
  const researchService = createResearchService({
    provider,
    fetchSource,
    now: () => Date.parse('2026-08-14T02:00:00Z'),
  });
  const handler = createResearchStageHandler({repos, researchService});
  const runner = createJobRunner({
    jobs,
    workerId: 'research-review-worker',
    handlers: {research: handler},
    leaseMs: 1000,
    now: () => 1000,
  });
  return {databasePath, db, repos, jobs, runner};
};

const createProjectAndQueueResearch = (runtime, {url} = {}) => {
  runtime.repos.projects.createWithSources({
    id: 'project-1',
    creator: 'Creator',
    topic: 'career and audience',
    instructions: '',
    status: 'draft',
    createdAt: '2026-08-14T02:00:00.000Z',
    updatedAt: '2026-08-14T02:00:00.000Z',
  }, url ? [{
    id: 'input-source-1',
    projectId: 'project-1',
    url,
    status: 'pending',
    payload: {operatorInput: true, requestedUrl: url},
  }] : []);
  runtime.jobs.startResearch({projectId: 'project-1', stageId: 'stage-1', nowMs: 1000});
};

test('all candidates rejected by canonical normalization cannot transition the project to research_ready', async () => {
  const provider = createFakeResearchProvider({
    result: {
      candidates: [{
        claim: 'Creator reached 100 followers.',
        url: 'https://research.example/profile',
        sourceRelationship: 'independent',
        claimDate: '2026-99-99',
        value: 100,
        unit: 'followers',
      }],
      sources: [{url: 'https://research.example/profile'}],
      unavailableSources: [],
    },
  });
  const runtime = createRuntime({
    provider,
    fetchSource: async (url) => ({url, mimeType: 'text/plain', content: 'source'}),
  });
  createProjectAndQueueResearch(runtime);

  assert.equal(await runtime.runner.runOnce(), true);
  const project = runtime.repos.projects.get('project-1');
  assert.equal(project.status, 'failed');
  assert.equal(project.failureCode, ResearchProviderErrorCodes.NO_EVIDENCE);
  assert.equal(project.research, null);
  assert.equal(runtime.jobs.getStage('stage-1').state, 'failed');

  runtime.db.close();
});

test('redirected operator provenance persists requested and resolved URLs with an operator marker across reopen', async () => {
  const requestedUrl = 'https://operator.example/old';
  const resolvedUrl = 'https://operator.example/current';
  const provider = createFakeResearchProvider({
    result: {
      candidates: [{
        claim: 'Creator has an operator-supplied public profile.',
        url: resolvedUrl,
        sourceType: 'primary',
        sourceRelationship: 'primary',
      }],
      sources: [],
      unavailableSources: [],
    },
  });
  const runtime = createRuntime({
    provider,
    fetchSource: async (url) => ({
      requestedUrl: url,
      url: resolvedUrl,
      mimeType: 'text/html',
      content: '<p>operator source</p>',
    }),
  });
  createProjectAndQueueResearch(runtime, {url: requestedUrl});

  assert.equal(await runtime.runner.runOnce(), true);
  assert.equal(runtime.repos.projects.get('project-1').status, 'research_ready');
  runtime.db.close();

  const reopenedDb = openDatabase(runtime.databasePath);
  migrateDatabase(reopenedDb);
  const reopenedRepos = createRepositories(reopenedDb);
  const sources = reopenedRepos.sources.list('project-1');
  const operatorSource = sources.find((source) => source.url === resolvedUrl);
  assert.ok(operatorSource);
  assert.equal(operatorSource.status, 'available');
  assert.equal(operatorSource.payload.operatorInput, true);
  assert.deepEqual(operatorSource.payload.requestedUrls, [requestedUrl]);
  assert.equal(operatorSource.payload.url, resolvedUrl);
  reopenedDb.close();
});
