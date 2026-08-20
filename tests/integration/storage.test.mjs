import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase, migrateDatabase, createRepositories} from '../../storage/db.mjs';

const tempDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'bright-storage-')), 'app.sqlite');

const seedProject = (repos) => repos.projects.create({
  id: 'project-1', creator: 'Creator', topic: 'Profile', status: 'review_required',
});

const seedRevision = (repos) => repos.revisions.create({
  id: 'revision-1', projectId: 'project-1', revisionNo: 1,
  payload: {draft: true}, payloadHash: 'a'.repeat(64),
});

const approveSeedRevision = (repos) => repos.revisions.approve({
  projectId: 'project-1',
  revisionId: 'revision-1',
  expectedPayloadHash: 'a'.repeat(64),
  approvedAt: '2026-08-13T00:00:00.000Z',
});

test('fresh database migrates explicitly from user_version 0', () => {
  const db = openDatabase(tempDatabasePath());
  assert.equal(db.pragma('user_version', {simple: true}), 0);
  assert.equal(migrateDatabase(db), 3);
  assert.equal(db.pragma('user_version', {simple: true}), 3);
  assert.equal(migrateDatabase(db), 3);
  db.close();
});

test('schema v1 upgrades to v3 without losing existing projects', () => {
  const db = openDatabase(tempDatabasePath());
  const initialSql = readFileSync(new URL('../../storage/migrations/001_initial.sql', import.meta.url), 'utf8');
  db.exec(initialSql);
  db.pragma('user_version = 1');
  db.prepare(`
    INSERT INTO projects (id, creator, topic, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('project-old', 'Old Creator', 'Old topic', 'draft', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z');

  assert.equal(migrateDatabase(db), 3);
  const project = createRepositories(db).projects.get('project-old');
  assert.equal(project.creator, 'Old Creator');
  assert.equal(project.instructions, '');
  assert.equal(project.research, null);
  assert.equal(project.origin, 'standalone');
  db.close();
});

test('project, source and revision records survive close/reopen with foreign keys enabled', () => {
  const databasePath = tempDatabasePath();
  let db = openDatabase(databasePath);
  migrateDatabase(db);
  let repos = createRepositories(db);
  seedProject(repos);
  repos.sources.create({id: 'source-1', projectId: 'project-1', url: 'https://example.com', status: 'available', payload: {title: 'Example'}});
  seedRevision(repos);
  db.close();

  db = openDatabase(databasePath);
  repos = createRepositories(db);
  assert.equal(repos.projects.get('project-1').creator, 'Creator');
  assert.equal(repos.sources.list('project-1')[0].payload.title, 'Example');
  assert.deepEqual(repos.revisions.get('revision-1').payload, {draft: true});
  assert.throws(() => repos.sources.create({id: 'source-bad', projectId: 'missing', url: 'https://example.com/bad', status: 'available', payload: {}}), /foreign key/i);
  db.close();
});

test('approved revision payload and hash are immutable', () => {
  const db = openDatabase(tempDatabasePath());
  migrateDatabase(db);
  const repos = createRepositories(db);
  seedProject(repos);
  seedRevision(repos);
  approveSeedRevision(repos);
  assert.throws(() => repos.revisions.updatePayload({revisionId: 'revision-1', payload: {draft: false}, payloadHash: 'b'.repeat(64)}), /immutable/i);
  assert.deepEqual(repos.revisions.get('revision-1').payload, {draft: true});
  assert.equal(repos.revisions.get('revision-1').payloadHash, 'a'.repeat(64));
  db.close();
});

test('approval barrier query survives reopen and reports descendant durable-stage existence', () => {
  const databasePath = tempDatabasePath();
  let db = openDatabase(databasePath);
  migrateDatabase(db);
  let repos = createRepositories(db);
  seedProject(repos);
  seedRevision(repos);
  approveSeedRevision(repos);
  assert.deepEqual(repos.approval.getBarrier('project-1'), {status: 'approved', currentRevisionId: 'revision-1', approvedRevisionId: 'revision-1', hasDescendantStage: false});
  repos.stages.create({id: 'stage-1', projectId: 'project-1', revisionId: 'revision-1', type: 'media_ingest', state: 'queued', maxAttempts: 3});
  db.close();

  db = openDatabase(databasePath);
  repos = createRepositories(db);
  assert.equal(repos.approval.getBarrier('project-1').hasDescendantStage, true);
  assert.equal(repos.revisions.get('revision-1').approvedAt, '2026-08-13T00:00:00.000Z');
  db.close();
});
