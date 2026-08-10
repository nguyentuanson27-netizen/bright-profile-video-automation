import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const T0 = Date.parse('2026-08-10T00:00:00.000Z');
const at = (milliseconds) => new Date(T0 + milliseconds);

test('recovered job can replay the same deterministic artifact after crash without duplication', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-idempotent-'));
  const filename = path.join(directory, 'app.sqlite');
  const firstDb = openDatabase({filename});
  const secondDb = openDatabase({filename});

  try {
    migrateDatabase(firstDb);
    const firstRepositories = createRepositories(firstDb);
    const secondRepositories = createRepositories(secondDb);
    const firstStore = createJobStore(firstDb);
    const secondStore = createJobStore(secondDb);

    firstRepositories.projects.create({
      id: 'project-1',
      topic: 'Creator profile',
      status: 'draft',
      input: {topic: 'Creator profile'},
    });
    firstRepositories.jobs.create({
      id: 'job-1',
      projectId: 'project-1',
      stage: 'researching',
      status: 'queued',
      maxAttempts: 3,
    });

    firstStore.claimNext({workerId: 'worker-a', now: at(0), leaseMs: 1_000});
    const artifact = {
      id: 'stage-result-job-1',
      projectId: 'project-1',
      kind: 'stage-result',
      relativePath: 'projects/project-1/stage-result.json',
      contentHash: 'sha256:stable-result',
    };
    firstRepositories.artifacts.create(artifact);

    // Simulate a worker crash here: the side effect is durable, but the job was not completed.
    const recovered = secondStore.claimNext({workerId: 'worker-b', now: at(1_001), leaseMs: 1_000});
    assert.equal(recovered.attempt, 2);

    const replayed = secondRepositories.artifacts.create(artifact);
    assert.equal(replayed.id, artifact.id);
    assert.equal(replayed.contentHash, artifact.contentHash);
    assert.equal(secondRepositories.artifacts.listByProject('project-1').length, 1);

    const completed = secondStore.complete({jobId: 'job-1', workerId: 'worker-b', now: at(1_002)});
    assert.equal(completed.status, 'succeeded');
  } finally {
    secondDb.close();
    firstDb.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
