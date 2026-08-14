import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const reservePort = async () => {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const {port} = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
};

const waitForReady = async (baseUrl, child) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`standalone server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Server may still be binding the loopback socket.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('standalone server did not become ready');
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('standalone server did not stop after SIGTERM'));
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
};

test('root bootstrap applies WORKER_MAX_RETRIES to durable generation maxAttempts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bright-bootstrap-retry-'));
  const databasePath = join(dataDir, 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({
    id: 'project-1',
    creator: 'Creator',
    topic: 'career',
    instructions: '',
    status: 'research_ready',
  });
  db.close();

  const port = await reservePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BRIGHT_DATA_DIR: dataDir,
      BRIGHT_DATABASE_PATH: databasePath,
      PORT: String(port),
      WORKER_MAX_RETRIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForReady(baseUrl, child);
    const response = await fetch(`${baseUrl}/api/projects/project-1/generate`, {method: 'POST'});
    const body = await response.json();

    assert.equal(response.status, 202, stderr);
    assert.equal(body.stage.type, 'generation');
    assert.equal(body.stage.maxAttempts, 1);
  } finally {
    await stopChild(child);
  }
});
