import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {createDiskGuard, createStorageLifecycle} from '../../storage/lifecycle.mjs';
import {createArtifactStore} from '../../storage/artifacts.mjs';
import {createRepositories, migrateDatabase, openDatabase} from '../../storage/db.mjs';
import {createJobStore} from '../../storage/jobs.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const NOW = new Date('2026-08-10T00:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-storage-ops-'));
  const dataDir = path.join(directory, 'data');
  const db = openDatabase({filename: path.join(dataDir, 'app.sqlite')});
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const artifactStore = createArtifactStore({dataDir, repositories});
  return {
    directory,
    dataDir,
    db,
    repositories,
    artifactStore,
    close() {
      if (db.open) db.close();
      rmSync(directory, {recursive: true, force: true});
    },
  };
}

const sourceRecord = (id) => ({
  sourceId: `source-${id}`,
  url: `https://example.com/${id}`,
  platform: 'example.com',
  retrievedAt: NOW.toISOString(),
  retrievalStatus: 'available',
  excerpt: 'Source metadata retained by backup.',
  contentHash: 'a'.repeat(64),
  sourceType: 'page',
});

function createProject(state, id, status) {
  state.repositories.projects.create({id, topic: id, status, input: {topic: id}});
  state.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, ago(40), id);
}

function createApprovedManifest(state, projectId, revisionId = `revision-${projectId}`) {
  const source = sourceRecord(projectId);
  state.repositories.sources.upsert({projectId, record: source});
  state.repositories.revisions.saveDraft({
    projectId,
    revisionId,
    payload: {projectId, revisionId, topic: projectId, sources: [source], generation: {script: 'Approved'}},
  });
  state.repositories.revisions.approve({
    projectId,
    revisionId,
    payload: {projectId, revisionId, topic: projectId, sources: [source], generation: {script: 'Approved'}},
    approvedAt: ago(40),
    approvedBy: 'operator',
  });
  return state.artifactStore.writeManifest({
    projectId,
    revisionId,
    id: `manifest-${projectId}`,
    value: {projectId, approvedRevisionId: revisionId, approvedPayloadHash: 'b'.repeat(64), renderProject: {duration: 1}, media: []},
  });
}

function ageArtifact(state, id, days) {
  state.db.prepare('UPDATE artifacts SET created_at = ? WHERE id = ?').run(ago(days), id);
}

function generatedArtifact(state, {projectId, id, kind, directory = 'output', extension = 'bin', days}) {
  const artifact = state.artifactStore.writeGenerated({
    projectId,
    id,
    kind,
    directory,
    extension,
    buffer: Buffer.from(id),
  });
  ageArtifact(state, id, days);
  return state.artifactStore.get(projectId, artifact.id);
}

test('disk guard warns below 25% and blocks below either 15% or 20 GiB free', async () => {
  const usage = async ({totalGiB, freeGiB}) => ({
    bsize: 1n,
    blocks: BigInt(totalGiB) * BigInt(GIB),
    bavail: BigInt(freeGiB) * BigInt(GIB),
  });

  const healthy = createDiskGuard({dataDir: '/data', statfsImpl: () => usage({totalGiB: 100, freeGiB: 30})});
  assert.deepEqual(await healthy.inspect(), {
    totalBytes: 100 * GIB,
    freeBytes: 30 * GIB,
    freePercent: 30,
    warning: false,
    blocked: false,
  });

  const warning = createDiskGuard({dataDir: '/data', statfsImpl: () => usage({totalGiB: 100, freeGiB: 20})});
  assert.equal((await warning.inspect()).warning, true);
  assert.equal((await warning.inspect()).blocked, false);

  const byteBlocked = createDiskGuard({dataDir: '/data', statfsImpl: () => usage({totalGiB: 100, freeGiB: 19})});
  await assert.rejects(
    () => byteBlocked.assertExpensiveWorkAllowed('media_ingest'),
    (error) => error instanceof AppError && error.code === 'DISK_SPACE_LOW' && error.retryable === true,
  );

  const percentBlocked = createDiskGuard({dataDir: '/data', statfsImpl: () => usage({totalGiB: 1024, freeGiB: 100})});
  assert.equal((await percentBlocked.inspect()).blocked, true);
});

test('cleanup applies 30/7 day retention, removes artifact rows, and protects manifests plus active-job files', async () => {
  const state = fixture();
  try {
    createProject(state, 'completed-old', 'completed');
    const completedVideo = generatedArtifact(state, {
      projectId: 'completed-old', id: 'video-old', kind: 'rendered-video', extension: 'mp4', days: 31,
    });
    const manifest = createApprovedManifest(state, 'completed-old');
    ageArtifact(state, manifest.id, 40);

    createProject(state, 'failed-old', 'failed');
    const failedAudio = generatedArtifact(state, {
      projectId: 'failed-old', id: 'tts-old', kind: 'tts-audio', directory: 'audio', extension: 'mp3', days: 8,
    });

    createProject(state, 'failed-recent', 'failed');
    const recentVideo = generatedArtifact(state, {
      projectId: 'failed-recent', id: 'video-recent', kind: 'rendered-video', extension: 'mp4', days: 6,
    });

    createProject(state, 'active-old', 'rendering');
    const activeAudio = generatedArtifact(state, {
      projectId: 'active-old', id: 'tts-active', kind: 'tts-audio', directory: 'audio', extension: 'mp3', days: 40,
    });
    state.repositories.jobs.create({
      id: 'job-active', projectId: 'active-old', stage: 'rendering', status: 'queued', maxAttempts: 2,
    });
    createJobStore(state.db).claimNext({workerId: 'worker-active', now: NOW, leaseMs: 60_000});
    const activeWork = path.join(state.dataDir, 'work', 'job-active', 'attempt-1');
    mkdirSync(activeWork, {recursive: true});
    writeFileSync(path.join(activeWork, 'partial.mp4'), 'partial');
    utimesSync(path.join(state.dataDir, 'work', 'job-active'), new Date(ago(40)), new Date(ago(40)));

    createProject(state, 'dead-work', 'failed');
    state.repositories.jobs.create({
      id: 'job-dead', projectId: 'dead-work', stage: 'rendering', status: 'failed', maxAttempts: 1,
    });
    state.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(ago(8), 'job-dead');
    const deadWork = path.join(state.dataDir, 'work', 'job-dead');
    mkdirSync(deadWork, {recursive: true});
    writeFileSync(path.join(deadWork, 'partial.mp4'), 'partial');
    utimesSync(deadWork, new Date(ago(8)), new Date(ago(8)));

    const lifecycle = createStorageLifecycle({db: state.db, dataDir: state.dataDir, clock: () => NOW});
    const dryRun = await lifecycle.cleanup({dryRun: true});
    assert.equal(dryRun.deleted.length, 0);
    assert.ok(dryRun.candidates.some((candidate) => candidate.path === completedVideo.relativePath));
    assert.ok(dryRun.candidates.some((candidate) => candidate.path === failedAudio.relativePath));
    assert.ok(dryRun.candidates.some((candidate) => candidate.path === path.relative(state.dataDir, deadWork)));
    assert.equal(existsSync(completedVideo.absolutePath), true);

    const result = await lifecycle.cleanup();
    assert.ok(result.deleted.length >= 3);
    assert.equal(existsSync(completedVideo.absolutePath), false);
    assert.equal(existsSync(failedAudio.absolutePath), false);
    assert.equal(existsSync(recentVideo.absolutePath), true);
    assert.equal(existsSync(activeAudio.absolutePath), true);
    assert.equal(existsSync(activeWork), true);
    assert.equal(existsSync(deadWork), false);
    assert.equal(state.repositories.artifacts.listByProject('completed-old').some((row) => row.id === 'video-old'), false);
    assert.equal(state.repositories.artifacts.listByProject('failed-old').some((row) => row.id === 'tts-old'), false);
    assert.equal(state.artifactStore.get('completed-old', manifest.id) !== null, true);
    assert.equal(state.repositories.revisions.get('revision-completed-old').status, 'approved');
    assert.equal(state.repositories.sources.listByProject('completed-old').length, 1);
  } finally {
    state.close();
  }
});

test('backup creates a restorable SQLite snapshot plus approved manifests under the data root', async () => {
  const state = fixture();
  let restored;
  try {
    createProject(state, 'backup-project', 'completed');
    const manifest = createApprovedManifest(state, 'backup-project');
    const lifecycle = createStorageLifecycle({db: state.db, dataDir: state.dataDir, clock: () => NOW});

    const result = await lifecycle.backup({name: 'backup-20260810'});
    assert.equal(result.status, 'completed');
    assert.equal(result.destination, path.join(state.dataDir, 'backups', 'backup-20260810'));
    assert.equal(existsSync(result.databasePath), true);
    const copiedManifest = path.join(result.destination, manifest.relativePath);
    assert.equal(existsSync(copiedManifest), true);

    restored = openDatabase({filename: result.databasePath});
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM sources WHERE project_id = ?').get('backup-project').count, 1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM revisions WHERE project_id = ? AND status = 'approved'").get('backup-project').count, 1);

    await assert.rejects(
      () => lifecycle.backup({name: '../../escape'}),
      (error) => error instanceof AppError && error.code === 'BACKUP_NAME_INVALID',
    );
  } finally {
    if (restored?.open) restored.close();
    state.close();
  }
});

test('cleanup rejects tampered artifact metadata that would escape the configured data root', async () => {
  const state = fixture();
  try {
    createProject(state, 'tampered', 'completed');
    const outside = path.join(state.directory, 'outside.mp4');
    writeFileSync(outside, 'do-not-delete');
    state.db.prepare(`
      INSERT INTO artifacts (id, project_id, kind, relative_path, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('tampered-artifact', 'tampered', 'rendered-video', '../outside.mp4', null, ago(31));
    const lifecycle = createStorageLifecycle({db: state.db, dataDir: state.dataDir, clock: () => NOW});

    await assert.rejects(
      () => lifecycle.cleanup(),
      (error) => error instanceof AppError && error.code === 'STORAGE_PATH_INVALID',
    );
    assert.equal(existsSync(outside), true);
  } finally {
    state.close();
  }
});
