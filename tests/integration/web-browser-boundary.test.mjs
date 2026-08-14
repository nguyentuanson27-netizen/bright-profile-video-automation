import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const createFixture = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-browser-boundary-'));
  const db = openDatabase(join(dataDir, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const server = createAppServer({
    db,
    repos,
    jobs,
    dataDir,
    projectIdFactory: () => 'project-1',
    stageIdFactory: () => 'stage-1',
    sourceIdFactory: () => 'source-1',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {db, server, port: server.address().port};
};

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('standalone browser boundary rejects DNS-rebinding Host values', async () => {
  const fixture = await createFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/health/live`, {
      headers: {host: 'attacker.example'},
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'HOST_NOT_ALLOWED');
  } finally {
    await close(fixture.server);
    fixture.db.close();
  }
});

test('standalone browser boundary rejects cross-site mutation origins while allowing loopback same-site origins', async () => {
  const fixture = await createFixture();
  try {
    const malicious = await fetch(`http://127.0.0.1:${fixture.port}/api/projects`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: 'https://attacker.example'},
      body: JSON.stringify({creator: 'Creator', topic: 'Topic'}),
    });
    assert.equal(malicious.status, 403);
    assert.equal((await malicious.json()).error.code, 'ORIGIN_NOT_ALLOWED');

    const local = await fetch(`http://127.0.0.1:${fixture.port}/api/projects`, {
      method: 'POST',
      headers: {'content-type': 'application/json', origin: 'http://127.0.0.1:5173'},
      body: JSON.stringify({creator: 'Creator', topic: 'Topic'}),
    });
    assert.equal(local.status, 201);
  } finally {
    await close(fixture.server);
    fixture.db.close();
  }
});
