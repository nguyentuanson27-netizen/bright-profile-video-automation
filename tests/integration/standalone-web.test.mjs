import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStandaloneHandler} from '../../app/http/standalone.mjs';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-web-'));
  const webRoot = path.join(directory, 'dist', 'web');
  const assets = path.join(webRoot, 'assets');
  mkdirSync(assets, {recursive: true});
  writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><body>bright-shell</body></html>');
  writeFileSync(path.join(assets, 'index-abc123.js'), 'globalThis.__bright = true;');
  writeFileSync(path.join(assets, 'index-abc123.css'), 'body{background:#000}');
  writeFileSync(path.join(webRoot, '.secret'), 'must-not-be-served');
  return {directory, webRoot};
}

test('standalone handler delegates API and operations routes before serving the SPA', async () => {
  const state = fixture();
  let server;
  try {
    const delegated = [];
    const apiHandler = (req, res) => {
      delegated.push(req.url);
      res.writeHead(204, {'x-api-handler': 'yes'});
      res.end();
    };
    server = http.createServer(createStandaloneHandler({apiHandler, webRoot: state.webRoot}));
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;

    for (const route of ['/api/projects', '/health/live', '/health/ready', '/metrics']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('x-api-handler'), 'yes');
    }
    assert.deepEqual(delegated, ['/api/projects', '/health/live', '/health/ready', '/metrics']);
  } finally {
    if (server) await close(server);
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('standalone handler serves index for browser routes and immutable built assets for GET/HEAD', async () => {
  const state = fixture();
  let server;
  try {
    server = http.createServer(createStandaloneHandler({
      apiHandler: (_req, res) => { res.writeHead(404); res.end(); },
      webRoot: state.webRoot,
    }));
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;

    for (const route of ['/', '/projects/project-1']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(await response.text(), /bright-shell/);
    }

    const script = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(await script.text(), /__bright/);

    const cssHead = await fetch(`${base}/assets/index-abc123.css`, {method: 'HEAD'});
    assert.equal(cssHead.status, 200);
    assert.match(cssHead.headers.get('content-type'), /text\/css/);
    assert.equal(cssHead.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await cssHead.text(), '');
  } finally {
    if (server) await close(server);
    rmSync(state.directory, {recursive: true, force: true});
  }
});

test('standalone handler never serves dotfiles, arbitrary files, encoded traversal, or unsupported methods', async () => {
  const state = fixture();
  let server;
  try {
    server = http.createServer(createStandaloneHandler({
      apiHandler: (_req, res) => { res.writeHead(404); res.end(); },
      webRoot: state.webRoot,
    }));
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${base}/.secret`)).status, 404);
    assert.equal((await fetch(`${base}/assets/%2e%2e/.secret`)).status, 404);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/`, {method: 'POST'})).status, 404);
  } finally {
    if (server) await close(server);
    rmSync(state.directory, {recursive: true, force: true});
  }
});
