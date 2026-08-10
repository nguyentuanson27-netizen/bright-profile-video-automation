import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createHealthService, createOperationsHandler} from '../../app/operations.mjs';
import {createObservability} from '../../app/observability.mjs';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('worker failure emits correlated structured events and bounded queue/stage/provider metrics without secret payloads', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-observability-'));
  const db = openDatabase({filename: path.join(directory, 'app.sqlite')});
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    repositories.projects.create({id: 'project-observe', topic: 'Observe', status: 'researching', input: {topic: 'Observe'}});
    repositories.jobs.create({id: 'job-observe', projectId: 'project-observe', stage: 'researching', status: 'queued', maxAttempts: 1});
    const jobStore = createJobStore(db);
    const events = [];
    const observability = createObservability({
      queueStats: () => jobStore.stats(),
      logger: (event) => events.push(event),
      clock: () => new Date('2026-08-10T00:00:00.000Z'),
    });
    const runner = createJobRunner({
      jobStore,
      workerId: 'worker-observe',
      observability,
      handlers: {
        researching: async () => {
          throw new AppError('CONTROLLED_FAILURE', 'secret-token-should-not-appear', {status: 502});
        },
      },
      clock: () => new Date('2026-08-10T00:00:00.000Z'),
    });

    const failed = await runner.runOnce();
    assert.equal(failed.status, 'failed');
    const started = events.find((event) => event.event === 'job.started');
    const failedEvent = events.find((event) => event.event === 'job.failed');
    assert.equal(started.projectId, 'project-observe');
    assert.equal(started.jobId, 'job-observe');
    assert.equal(started.stage, 'researching');
    assert.equal(failedEvent.projectId, 'project-observe');
    assert.equal(failedEvent.jobId, 'job-observe');
    assert.equal(failedEvent.errorCode, 'CONTROLLED_FAILURE');
    assert.equal(JSON.stringify(events).includes('secret-token-should-not-appear'), false);

    await assert.rejects(
      () => observability.observeProvider({
        provider: 'openai',
        operation: 'research',
        run: async () => { throw new Error('provider-secret-response'); },
      }),
      /provider-secret-response/,
    );
    await observability.observeProvider({provider: 'openai', operation: 'generation', run: async () => 'ok'});

    const metrics = await observability.metrics();
    assert.match(metrics, /bright_queue_depth\{stage="researching"\} 0/);
    assert.match(metrics, /bright_active_jobs\{stage="researching"\} 0/);
    assert.match(metrics, /bright_failed_jobs\{stage="researching"\} 1/);
    assert.match(metrics, /bright_job_stage_duration_seconds_count\{stage="researching",outcome="error"\} 1/);
    assert.match(metrics, /bright_provider_errors_total\{provider="openai",operation="research"\} 1/);
    assert.match(metrics, /bright_provider_duration_seconds_count\{provider="openai",operation="generation",outcome="success"\} 1/);
    assert.equal(metrics.includes('project-observe'), false);
    assert.equal(metrics.includes('job-observe'), false);
    assert.equal(metrics.includes('provider-secret-response'), false);
  } finally {
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('liveness is provider-independent, readiness checks SQLite/data dir, and ops endpoints expose stable status/metrics', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-health-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  let apiServer;
  let opsServer;
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const jobStore = createJobStore(db);
    const events = [];
    const observability = createObservability({queueStats: () => jobStore.stats(), logger: (event) => events.push(event)});
    const healthService = createHealthService({db, dataDir});

    assert.deepEqual(healthService.live(), {ok: true, service: 'bright-profile'});
    const ready = await healthService.ready();
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.checks, {database: 'ok', dataDir: 'ok'});

    const missingDataHealth = createHealthService({db, dataDir: path.join(directory, 'missing')});
    const notReady = await missingDataHealth.ready();
    assert.equal(notReady.ok, false);
    assert.equal(notReady.checks.dataDir, 'error');

    apiServer = http.createServer(createHttpHandler({
      repositories,
      researchService: {createAndEnqueueResearch() {}, enqueueResearch() {}},
      healthService,
      observability,
      requestIdGenerator: () => 'request-observe',
    }));
    const apiAddress = await listen(apiServer);
    const apiBase = `http://127.0.0.1:${apiAddress.port}`;

    assert.equal((await fetch(`${apiBase}/health/live`)).status, 200);
    assert.equal((await fetch(`${apiBase}/health/ready`)).status, 200);
    const metricsResponse = await fetch(`${apiBase}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(metricsResponse.headers.get('content-type'), /text\/plain/);
    assert.match(await metricsResponse.text(), /bright_queue_depth/);
    assert.equal((await fetch(`${apiBase}/api/projects/missing`)).status, 404);

    await new Promise((resolve) => setImmediate(resolve));
    const requestEvent = events.find((event) => event.event === 'http.request');
    assert.equal(requestEvent.requestId, 'request-observe');
    assert.equal(requestEvent.method, 'GET');
    assert.equal(typeof requestEvent.status, 'number');
    assert.equal(Object.hasOwn(requestEvent, 'headers'), false);
    assert.equal(Object.hasOwn(requestEvent, 'body'), false);

    opsServer = http.createServer(createOperationsHandler({healthService, observability}));
    const opsAddress = await listen(opsServer);
    const opsBase = `http://127.0.0.1:${opsAddress.port}`;
    assert.equal((await fetch(`${opsBase}/health/live`)).status, 200);
    assert.equal((await fetch(`${opsBase}/health/ready`)).status, 200);
    assert.equal((await fetch(`${opsBase}/metrics`)).status, 200);
    assert.equal((await fetch(`${opsBase}/api/projects`)).status, 404);
  } finally {
    if (apiServer) await close(apiServer);
    if (opsServer) await close(opsServer);
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
