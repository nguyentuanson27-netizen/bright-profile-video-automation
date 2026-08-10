import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTrustedAssetServer} from '../../worker/trusted-assets.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-trusted-assets-'));
  const dataDir = path.join(directory, 'data');
  const assetsDir = path.join(directory, 'assets');
  mkdirSync(path.join(assetsDir, 'demo'), {recursive: true});
  writeFileSync(path.join(assetsDir, 'demo', 'hero.png'), Buffer.from('bundled-image'));
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  repositories.projects.create({id: 'project-1', topic: 'Creator', status: 'approved', input: {topic: 'Creator'}});
  const artifactStore = createArtifactStore({dataDir, repositories});
  const media = artifactStore.writeMedia({
    projectId: 'project-1', id: 'media-123', extension: 'mp4', buffer: Buffer.from('0123456789'),
  });
  return {directory, dataDir, assetsDir, db, repositories, artifactStore, media};
}

test('trusted asset server binds loopback and serves only registered bundled/artifact assets with range support', async () => {
  const state = fixture();
  const server = createTrustedAssetServer({
    projectId: 'project-1', artifactStore: state.artifactStore, assetsDir: state.assetsDir,
  });
  try {
    await server.start();
    const bundledUrl = server.resolve('asset://demo/hero.png');
    const artifactUrl = server.resolve('artifact://media-123');
    assert.match(bundledUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(artifactUrl, /^http:\/\/127\.0\.0\.1:\d+\/.*\.mp4$/);

    const bundled = await fetch(bundledUrl);
    assert.equal(bundled.status, 200);
    assert.equal(Buffer.from(await bundled.arrayBuffer()).toString(), 'bundled-image');

    const ranged = await fetch(artifactUrl, {headers: {range: 'bytes=2-5'}});
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '2345');

    assert.throws(() => server.resolve('https://example.com/image.png'), /trusted asset/i);
    assert.throws(() => server.resolve('file:///etc/passwd'), /trusted asset/i);
    assert.throws(() => server.resolve('asset://../secret'), /asset/i);
  } finally {
    await server.close();
    state.db.close();
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('renderer wrapper never opts out of Chromium web security', () => {
  const source = readFileSync(path.resolve('lib', 'remotion-renderer.mjs'), 'utf8');
  assert.equal(source.includes('disableWebSecurity'), false);
});
