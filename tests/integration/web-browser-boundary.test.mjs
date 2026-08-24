import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const createFixture = async ({allowedBrowserHosts} = {}) => {
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
    allowedBrowserHosts,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {db, server, port: server.address().port};
};

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const rawRequest = ({port, path, method = 'GET', headers, body}) => new Promise((resolveRequest, rejectRequest) => {
  const request = http.request({hostname: '127.0.0.1', port, path, method, headers}, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.once('end', () => resolveRequest({status: response.statusCode, body: JSON.parse(body)}));
  });
  request.once('error', rejectRequest);
  if (body) request.write(body);
  request.end();
});

test('standalone browser boundary rejects DNS-rebinding Host values', async () => {
  const fixture = await createFixture();
  try {
    const response = await rawRequest({port: fixture.port, path: '/health/live', headers: {host: 'attacker.example'}});
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'HOST_NOT_ALLOWED');
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

test('allowlisted public browser host serves same-origin UI requests while foreign origins remain blocked', async () => {
  const fixture = await createFixture({allowedBrowserHosts: ['video.lanadesign.tech']});
  try {
    const body = JSON.stringify({creator: 'Creator', topic: 'Topic'});
    const allowed = await rawRequest({
      port: fixture.port,
      path: '/api/projects',
      method: 'POST',
      headers: {
        host: 'video.lanadesign.tech',
        origin: 'https://video.lanadesign.tech',
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(allowed.status, 201);

    const foreignOrigin = await rawRequest({
      port: fixture.port,
      path: '/api/projects',
      method: 'POST',
      headers: {
        host: 'video.lanadesign.tech',
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.body.error.code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await close(fixture.server);
    fixture.db.close();
  }
});
