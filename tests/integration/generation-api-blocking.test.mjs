import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {createAppServer} from '../../app/server.mjs';
import {createGenerationService, createGenerationStageHandler} from '../../app/services/generate-project.mjs';
import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';
import {createJobRunner} from '../../worker/job-runner.mjs';

const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref?.();
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const post = async (base, path) => {
  const response = await fetch(`${base}${path}`, {method: 'POST'});
  return {response, json: await response.json()};
};

const draft = {
  creatorName: 'Creator',
  summary: 'Creator profile summary.',
  claims: [{id: 'claim-1', text: 'Creator reached 100 followers.', sourceIds: ['source-1'], verified: true}],
  script: [{id: 'script-1', text: 'Creator reached 100 followers.', start: 0, duration: 4, sourceIds: ['source-1']}],
  voiceover: {chunks: [{id: 'voice-1', text: 'Creator reached 100 followers.', start: 0, duration: 4}]},
  scenes: [{id: 'scene-1', type: 'claim', start: 0, duration: 4, sourceIds: ['source-1']}],
  render: {duration: 4},
};

test('generate request returns while durable worker provider remains blocked', async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'bright-generation-api-blocked-')), 'app.sqlite');
  const db = openDatabase(databasePath);
  migrateDatabase(db);
  const repos = createRepositories(db);
  repos.projects.create({id: 'project-1', creator: 'Creator', topic: 'career', instructions: '', status: 'draft'});
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: 'https://research.example/profile', status: 'available', payload: {title: 'Profile'}});
  db.prepare(`UPDATE projects SET status = 'research_ready', research_json = ? WHERE id = ?`).run(JSON.stringify({
    schemaVersion: '1.0',
    evidence: [{id: 'ev-1', claim: 'Creator reached 100 followers.', confidence: 'high', conflictGroupId: null, sources: [{url: 'https://research.example/profile', canonicalUrl: 'https://research.example/profile'}]}],
    conflicts: [],
  }), 'project-1');

  const jobs = createJobStore(db, {leaseMs: 1000, revisionIdFactory: () => 'revision-1'});
  let releaseProvider;
  let markProviderStarted;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const generationService = createGenerationService({provider: {
    async generate() {
      markProviderStarted();
      await providerGate;
      return draft;
    },
  }});
  const runner = createJobRunner({
    jobs,
    workerId: 'generation-worker',
    handlers: {generation: createGenerationStageHandler({repos, generationService})},
    leaseMs: 1000,
  });
  const controller = new AbortController();
  const runningLoop = runner.run({pollMs: 1, signal: controller.signal});

  let stageNo = 0;
  const server = createAppServer({
    db, repos, jobs, dataDir: join(databasePath, '..'),
    stageIdFactory: () => `stage-${++stageNo}`,
    projectIdFactory: () => 'unused-project', sourceIdFactory: () => 'unused-source', revisionIdFactory: () => 'unused-revision',
  });
  const base = await listen(server);

  const generated = await post(base, '/api/projects/project-1/generate');
  assert.equal(generated.response.status, 202);
  assert.equal(generated.json.project.status, 'generating');
  await Promise.race([
    providerStarted,
    delay(1000).then(() => { throw new Error('generation provider was not claimed by the worker'); }),
  ]);
  assert.equal(repos.projects.get('project-1').status, 'generating');
  assert.equal(repos.projects.get('project-1').currentRevisionId, null);

  const cancelled = await post(base, '/api/projects/project-1/cancel');
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.json.project.status, 'cancelled');
  releaseProvider();
  controller.abort();
  await runningLoop;
  assert.equal(repos.projects.get('project-1').currentRevisionId, null);

  await close(server);
  db.close();
});
