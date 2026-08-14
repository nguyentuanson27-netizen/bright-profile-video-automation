import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createAppServer} from '../../app/server.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const listen = async (server) => {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
};
const closeServer = (server) => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));

test('standalone app serves the built web root and hashed assets without exposing arbitrary filesystem paths', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-web-static-'));
  const webDir = join(dataDir, 'dist');
  await mkdir(join(webDir, 'assets'), {recursive: true});
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Bright Profile</title><div id="root"></div>');
  await writeFile(join(webDir, 'assets', 'app-abc123.js'), 'window.__BRIGHT_WEB__=true;');
  const db = openDatabase(join(dataDir, 'app.sqlite'));
  migrateDatabase(db);
  const repos = createRepositories(db);
  const jobs = createJobStore(db);
  const server = createAppServer({db, repos, jobs, dataDir, webDir});
  const baseUrl = await listen(server);
  try {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(await root.text(), /Bright Profile/);

    const asset = await fetch(`${baseUrl}/assets/app-abc123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.match(await asset.text(), /__BRIGHT_WEB__/);

    const traversal = await fetch(`${baseUrl}/assets/%2e%2e/%2e%2e/server.mjs`);
    assert.equal(traversal.status, 404);
    const health = await fetch(`${baseUrl}/health/live`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).ok, true);
  } finally {
    await closeServer(server);
    db.close();
  }
});
