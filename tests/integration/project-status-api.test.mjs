import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHttpHandler} from '../../app/http/router.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const source = (sourceId, retrievalStatus) => ({
  sourceId,
  url: `https://example.com/${sourceId}`,
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus,
  excerpt: retrievalStatus === 'available' ? 'Available facts.' : '',
  ...(retrievalStatus === 'available' ? {contentHash: 'a'.repeat(64)} : {}),
  sourceType: 'page',
});

test('project list and status expose bounded persisted stage/source/job read models', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-status-api-'));
  const db = openDatabase({filename: path.join(directory, 'app.sqlite')});
  let server;
  try {
    migrateDatabase(db);
    const repositories = createRepositories(db);
    repositories.projects.create({id: 'project-a', topic: 'Alpha', status: 'researching', input: {topic: 'Alpha'}});
    repositories.projects.create({id: 'project-b', topic: 'Beta', status: 'review_required', input: {topic: 'Beta'}});
    repositories.sources.upsert({projectId: 'project-a', record: source('a1', 'available')});
    repositories.sources.upsert({projectId: 'project-a', record: source('a2', 'failed')});
    repositories.jobs.create({id: 'job-a1', projectId: 'project-a', stage: 'researching', status: 'failed', maxAttempts: 3});
    repositories.jobs.create({id: 'job-a2', projectId: 'project-a', stage: 'researching', status: 'queued', maxAttempts: 3});

    server = http.createServer(createHttpHandler({
      repositories,
      researchService: {createProject() {}, createAndEnqueueResearch() {}, enqueueResearch() {}},
      requestIdGenerator: () => 'status-request',
    }));
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/projects`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.projects.length, 2);
    const alpha = list.projects.find((entry) => entry.project.id === 'project-a');
    assert.ok(alpha);
    assert.equal(alpha.latestJob.id, 'job-a2');
    assert.deepEqual(alpha.sourceSummary, {total: 2, available: 1, unavailable: 0, failed: 1});

    const statusResponse = await fetch(`${baseUrl}/api/projects/project-a/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.project.topic, 'Alpha');
    assert.equal(status.latestJob.id, 'job-a2');
    assert.equal(status.sourceSummary.available, 1);

    const missing = await fetch(`${baseUrl}/api/projects/missing/status`);
    assert.equal(missing.status, 404);
  } finally {
    if (server) await close(server);
    if (db.open) db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
