import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createResearchProjectService} from '../../app/services/research-project.mjs';
import {createResearchProvider} from '../../providers/research/index.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createProjectStateStore} from '../../storage/project-state.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const postJson = (baseUrl, pathname, body) => fetch(`${baseUrl}${pathname}`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body),
});

const createFixture = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-research-api-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const db = openDatabase({filename: databasePath});
  migrateDatabase(db);
  return {
    directory,
    databasePath,
    db,
    repositories: createRepositories(db),
    projectStateStore: createProjectStateStore(db),
  };
};

const startApi = async ({repositories, researchService, requestIds}) => {
  const server = http.createServer(createHttpHandler({
    repositories,
    researchService,
    requestIdGenerator: () => requestIds.shift() || 'request-fallback',
  }));
  const address = await listen(server);
  return {server, baseUrl: `http://127.0.0.1:${address.port}`};
};

test('topic project creation atomically queues research, normalizes sources, and persists after restart', async () => {
  const fixture = createFixture();
  let api;
  let restarted;
  let reopenedDb;
  try {
    const researchProvider = createResearchProvider({
      search: async () => ({
        candidates: [
          {
            url: 'https://example.com/creator-profile',
            platform: 'example.com',
            title: 'Creator profile',
            sourceType: 'search-result',
            discoveryStatus: 'discovered',
          },
          {
            url: 'https://social.example/unavailable',
            platform: 'social.example',
            title: 'Unavailable public post',
            sourceType: 'search-result',
            discoveryStatus: 'unavailable',
          },
        ],
      }),
    });
    const fetchedUrls = [];
    const researchService = createResearchProjectService({
      repositories: fixture.repositories,
      projectStateStore: fixture.projectStateStore,
      researchProvider,
      fetchSource: async (url) => {
        fetchedUrls.push(url);
        if (url === 'https://operator.example/public') {
          throw new AppError('FETCH_NETWORK_ERROR', 'Remote fetch failed', {status: 502, retryable: true});
        }
        return {
          statusCode: 200,
          contentType: 'text/html',
          body: Buffer.from('<html><body>Creator public profile facts.</body></html>'),
        };
      },
      projectIdGenerator: () => 'project-1',
      jobIdGenerator: () => 'job-research-1',
      clock: () => new Date('2026-08-10T00:00:00.000Z'),
    });
    api = await startApi({
      repositories: fixture.repositories,
      researchService,
      requestIds: ['request-create', 'request-sources'],
    });

    const createdResponse = await postJson(api.baseUrl, '/api/projects', {
      topic: 'Creator profile',
      sourceUrls: ['https://operator.example/public'],
      instructions: 'Focus on public career milestones.',
      duration: 30,
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.project.id, 'project-1');
    assert.equal(created.project.status, 'researching');
    assert.equal(created.job.id, 'job-research-1');
    assert.equal(created.job.status, 'queued');

    const runner = createJobRunner({
      jobStore: createJobStore(fixture.db),
      workerId: 'research-worker',
      clock: () => new Date('2026-08-10T00:00:01.000Z'),
      handlers: {
        researching: ({job}) => researchService.execute({job}),
      },
    });
    const completed = await runner.runOnce();
    assert.equal(completed.status, 'succeeded');
    assert.equal(fixture.repositories.projects.get('project-1').status, 'research_ready');

    assert.deepEqual(fetchedUrls.sort(), [
      'https://example.com/creator-profile',
      'https://operator.example/public',
    ]);

    const sourcesResponse = await fetch(`${api.baseUrl}/api/projects/project-1/sources`);
    assert.equal(sourcesResponse.status, 200);
    const {sources} = await sourcesResponse.json();
    assert.equal(sources.length, 3);
    const available = sources.find((source) => source.url === 'https://example.com/creator-profile');
    const discoveryUnavailable = sources.find((source) => source.url === 'https://social.example/unavailable');
    const operatorUnavailable = sources.find((source) => source.url === 'https://operator.example/public');
    assert.equal(available.retrievalStatus, 'available');
    assert.match(available.sourceId, /^source-[a-f0-9]{24}$/);
    assert.match(available.contentHash, /^[a-f0-9]{64}$/);
    assert.match(available.excerpt, /Creator public profile facts/);
    assert.equal(discoveryUnavailable.retrievalStatus, 'unavailable');
    assert.equal(operatorUnavailable.retrievalStatus, 'failed');
    assert.equal(operatorUnavailable.sourceType, 'operator-url');

    await close(api.server);
    api = null;
    fixture.db.close();

    reopenedDb = openDatabase({filename: fixture.databasePath});
    const reopenedRepositories = createRepositories(reopenedDb);
    restarted = await startApi({
      repositories: reopenedRepositories,
      researchService: {createProject() {}, createAndEnqueueResearch() {}, enqueueResearch() {}},
      requestIds: ['request-restart-get'],
    });
    const projectResponse = await fetch(`${restarted.baseUrl}/api/projects/project-1`);
    assert.equal(projectResponse.status, 200);
    const persisted = await projectResponse.json();
    assert.equal(persisted.id, 'project-1');
    assert.equal(persisted.status, 'research_ready');
    assert.equal(persisted.input.sourceUrls[0], 'https://operator.example/public');
  } finally {
    if (api) await close(api.server);
    if (restarted) await close(restarted.server);
    if (reopenedDb?.open) reopenedDb.close();
    if (fixture.db.open) fixture.db.close();
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});

test('API returns stable JSON errors with request ID for invalid project input and missing resources', async () => {
  const fixture = createFixture();
  let api;
  try {
    const researchService = createResearchProjectService({
      repositories: fixture.repositories,
      projectStateStore: fixture.projectStateStore,
      researchProvider: createResearchProvider({search: async () => ({candidates: []})}),
      fetchSource: async () => { throw new Error('not used'); },
      projectIdGenerator: () => 'project-1',
      jobIdGenerator: () => 'job-1',
    });
    api = await startApi({
      repositories: fixture.repositories,
      researchService,
      requestIds: ['request-invalid', 'request-missing'],
    });

    const invalidResponse = await postJson(api.baseUrl, '/api/projects', {topic: ''});
    assert.equal(invalidResponse.status, 400);
    assert.deepEqual(await invalidResponse.json(), {
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        message: 'Invalid projectInput payload',
        retryable: false,
        requestId: 'request-invalid',
      },
    });

    const missingResponse = await fetch(`${api.baseUrl}/api/projects/missing`);
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'Project was not found',
        retryable: false,
        requestId: 'request-missing',
      },
    });
  } finally {
    if (api) await close(api.server);
    if (fixture.db.open) fixture.db.close();
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});
