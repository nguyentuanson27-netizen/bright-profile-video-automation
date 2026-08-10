import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AppError} from '../../domain/errors.mjs';
import {
  createRepositories,
  migrateDatabase,
  openDatabase,
} from '../../storage/db.mjs';

const makeDatabasePath = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bright-profile-storage-'));
  return {
    directory,
    filename: path.join(directory, 'app.sqlite'),
    cleanup: () => rmSync(directory, {recursive: true, force: true}),
  };
};

const sourceRecord = {
  sourceId: 'source-1',
  url: 'https://example.com/creator-profile',
  platform: 'example.com',
  retrievedAt: '2026-08-10T00:00:00.000Z',
  retrievalStatus: 'available',
  excerpt: 'Public source excerpt.',
  sourceType: 'page',
};

const draftPayload = {
  revisionId: 'revision-1',
  projectId: 'project-1',
  topic: 'Creator profile',
  sources: [sourceRecord],
  generation: {
    researchSummary: 'Summary',
    claims: [{id: 'claim-1', text: 'Claim', sourceIds: ['source-1'], status: 'supported'}],
    script: 'Script',
    voiceover: {chunks: [{id: 'hero', start: 0, duration: 6, text: 'Voice'}]},
    project: {
      duration: 6,
      creatorName: 'Creator',
      scenes: [{id: 'hero', type: 'hero', start: 0, duration: 6}],
    },
  },
};

function seedProject(repositories) {
  repositories.projects.create({
    id: 'project-1',
    topic: 'Creator profile',
    status: 'draft',
    input: {topic: 'Creator profile'},
  });
}

test('fresh database migrates to version 1 with WAL and foreign keys enabled', () => {
  const fixture = makeDatabasePath();
  try {
    const db = openDatabase({filename: fixture.filename});
    const version = migrateDatabase(db);

    assert.equal(version, 1);
    assert.equal(db.pragma('user_version', {simple: true}), 1);
    assert.equal(db.pragma('journal_mode', {simple: true}), 'wal');
    assert.equal(db.pragma('foreign_keys', {simple: true}), 1);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get());
    db.close();
  } finally {
    fixture.cleanup();
  }
});

test('project, source, revision, artifact, and job metadata survive close and reopen', () => {
  const fixture = makeDatabasePath();
  try {
    let db = openDatabase({filename: fixture.filename});
    migrateDatabase(db);
    let repositories = createRepositories(db);
    seedProject(repositories);
    repositories.sources.upsert({projectId: 'project-1', record: sourceRecord});
    repositories.revisions.saveDraft({
      projectId: 'project-1',
      revisionId: 'revision-1',
      payload: draftPayload,
    });
    repositories.artifacts.create({
      id: 'artifact-1',
      projectId: 'project-1',
      kind: 'source-snapshot',
      relativePath: 'projects/project-1/sources/source-1.html',
      contentHash: 'sha256:artifact',
    });
    repositories.jobs.create({
      id: 'job-1',
      projectId: 'project-1',
      stage: 'researching',
      status: 'queued',
      maxAttempts: 3,
    });
    db.close();

    db = openDatabase({filename: fixture.filename});
    repositories = createRepositories(db);
    assert.equal(repositories.projects.get('project-1').topic, 'Creator profile');
    assert.deepEqual(repositories.sources.listByProject('project-1'), [sourceRecord]);
    assert.deepEqual(repositories.revisions.get('revision-1').payload, draftPayload);
    assert.equal(repositories.artifacts.listByProject('project-1')[0].relativePath, 'projects/project-1/sources/source-1.html');
    assert.equal(repositories.jobs.get('job-1').stage, 'researching');
    db.close();
  } finally {
    fixture.cleanup();
  }
});

test('foreign keys reject metadata for a missing project', () => {
  const fixture = makeDatabasePath();
  try {
    const db = openDatabase({filename: fixture.filename});
    migrateDatabase(db);
    const repositories = createRepositories(db);

    assert.throws(
      () => repositories.sources.upsert({projectId: 'missing-project', record: sourceRecord}),
      (error) => error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY',
    );
    db.close();
  } finally {
    fixture.cleanup();
  }
});

test('approved revision snapshot is immutable through repository APIs', () => {
  const fixture = makeDatabasePath();
  try {
    const db = openDatabase({filename: fixture.filename});
    migrateDatabase(db);
    const repositories = createRepositories(db);
    seedProject(repositories);
    repositories.revisions.saveDraft({
      projectId: 'project-1',
      revisionId: 'revision-1',
      payload: draftPayload,
    });

    const approvedPayload = {
      ...draftPayload,
      approvedAt: '2026-08-10T00:10:00.000Z',
      approvedBy: 'operator',
      claimOverrides: [],
      media: [],
      renderSettings: {renderScale: 1, crf: 20},
    };
    const approved = repositories.revisions.approve({
      projectId: 'project-1',
      revisionId: 'revision-1',
      payload: approvedPayload,
      approvedAt: approvedPayload.approvedAt,
      approvedBy: approvedPayload.approvedBy,
    });

    assert.equal(approved.status, 'approved');
    assert.match(approved.payloadHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(approved.payload, approvedPayload);
    assert.throws(
      () => repositories.revisions.saveDraft({
        projectId: 'project-1',
        revisionId: 'revision-1',
        payload: {...draftPayload, topic: 'Changed after approval'},
      }),
      (error) => error instanceof AppError
        && error.code === 'APPROVED_REVISION_IMMUTABLE'
        && error.status === 409,
    );
    assert.deepEqual(repositories.revisions.get('revision-1').payload, approvedPayload);
    db.close();
  } finally {
    fixture.cleanup();
  }
});
