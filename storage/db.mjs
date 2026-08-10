import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {AppError} from '../domain/errors.mjs';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const json = (value) => JSON.stringify(value);
const parseJson = (value) => JSON.parse(value);
const hashPayload = (serialized) => createHash('sha256').update(serialized).digest('hex');
const timestamp = () => new Date().toISOString();

export function openDatabase({filename, timeoutMs = DEFAULT_TIMEOUT_MS}) {
  if (!filename) throw new AppError('DATABASE_PATH_REQUIRED', 'Database path is required', {status: 500});
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), {recursive: true});

  const db = new Database(filename, {timeout: timeoutMs});
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${timeoutMs}`);
  if (filename !== ':memory:') db.pragma('journal_mode = WAL');
  return db;
}

export function migrateDatabase(db, {migrationsDir = DEFAULT_MIGRATIONS_DIR} = {}) {
  const migrations = readdirSync(migrationsDir)
    .map((name) => {
      const match = /^(\d+)_.*\.sql$/.exec(name);
      return match ? {version: Number(match[1]), name} : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.version - right.version);

  let currentVersion = Number(db.pragma('user_version', {simple: true}));
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1) {
      throw new AppError(
        'DATABASE_MIGRATION_GAP',
        `Expected database migration ${currentVersion + 1}, found ${migration.version}`,
        {status: 500},
      );
    }

    const sql = readFileSync(path.join(migrationsDir, migration.name), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
    currentVersion = migration.version;
  }
  return currentVersion;
}

const mapProject = (row) => row ? {
  id: row.id,
  topic: row.topic,
  status: row.status,
  input: parseJson(row.input_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

const mapRevision = (row) => row ? {
  revisionId: row.revision_id,
  projectId: row.project_id,
  status: row.status,
  payload: parseJson(row.payload_json),
  payloadHash: row.payload_hash,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

const mapArtifact = (row) => row ? {
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  relativePath: row.relative_path,
  contentHash: row.content_hash,
  createdAt: row.created_at,
} : null;

const mapJob = (row) => row ? {
  id: row.id,
  projectId: row.project_id,
  stage: row.stage,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  runAfter: row.run_after,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

export function createRepositories(db) {
  const insertProject = db.prepare(`
    INSERT INTO projects (id, topic, status, input_json, created_at, updated_at)
    VALUES (@id, @topic, @status, @inputJson, @now, @now)
  `);
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const listProjects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC LIMIT ?');

  const upsertSource = db.prepare(`
    INSERT INTO sources (source_id, project_id, record_json, created_at, updated_at)
    VALUES (@sourceId, @projectId, @recordJson, @now, @now)
    ON CONFLICT(source_id) DO UPDATE SET
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
    WHERE sources.project_id = excluded.project_id
  `);
  const listSources = db.prepare('SELECT record_json FROM sources WHERE project_id = ? ORDER BY source_id');

  const getRevision = db.prepare('SELECT * FROM revisions WHERE revision_id = ?');
  const latestRevisionByProject = db.prepare(`
    SELECT * FROM revisions WHERE project_id = ? ORDER BY updated_at DESC, revision_id DESC LIMIT 1
  `);
  const insertDraft = db.prepare(`
    INSERT INTO revisions (
      revision_id, project_id, status, payload_json, payload_hash, created_at, updated_at
    ) VALUES (@revisionId, @projectId, 'draft', @payloadJson, @payloadHash, @now, @now)
    ON CONFLICT(revision_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      payload_hash = excluded.payload_hash,
      updated_at = excluded.updated_at
    WHERE revisions.status = 'draft' AND revisions.project_id = excluded.project_id
  `);
  const approveRevision = db.prepare(`
    UPDATE revisions SET
      status = 'approved',
      payload_json = @payloadJson,
      payload_hash = @payloadHash,
      approved_at = @approvedAt,
      approved_by = @approvedBy,
      updated_at = @now
    WHERE revision_id = @revisionId AND project_id = @projectId AND status = 'draft'
  `);

  const insertArtifact = db.prepare(`
    INSERT INTO artifacts (id, project_id, kind, relative_path, content_hash, created_at)
    VALUES (@id, @projectId, @kind, @relativePath, @contentHash, @now)
    ON CONFLICT(id) DO NOTHING
  `);
  const getArtifact = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  const listArtifacts = db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id');

  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, project_id, stage, status, attempt, max_attempts, run_after, created_at, updated_at
    ) VALUES (@id, @projectId, @stage, @status, 0, @maxAttempts, @runAfter, @now, @now)
  `);
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const latestJobByProject = db.prepare(`
    SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `);

  return Object.freeze({
    projects: Object.freeze({
      create({id, topic, status, input}) {
        const now = timestamp();
        insertProject.run({id, topic, status, inputJson: json(input), now});
        return mapProject(getProject.get(id));
      },
      get(id) {
        return mapProject(getProject.get(id));
      },
      list({limit = 100} = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new AppError('PROJECT_LIST_LIMIT_INVALID', 'Project list limit is invalid', {status: 400});
        }
        return listProjects.all(limit).map(mapProject);
      },
    }),

    sources: Object.freeze({
      upsert({projectId, record}) {
        const now = timestamp();
        const result = upsertSource.run({
          sourceId: record.sourceId,
          projectId,
          recordJson: json(record),
          now,
        });
        if (result.changes === 0) {
          throw new AppError('SOURCE_PROJECT_MISMATCH', 'Source belongs to another project', {status: 409});
        }
        return record;
      },
      listByProject(projectId) {
        return listSources.all(projectId).map((row) => parseJson(row.record_json));
      },
    }),

    revisions: Object.freeze({
      saveDraft({projectId, revisionId, payload}) {
        const existing = getRevision.get(revisionId);
        if (existing?.project_id !== undefined && existing.project_id !== projectId) {
          throw new AppError('REVISION_PROJECT_MISMATCH', 'Revision belongs to another project', {status: 409});
        }
        if (existing?.status === 'approved') {
          throw new AppError(
            'APPROVED_REVISION_IMMUTABLE',
            'Approved revision cannot be modified',
            {status: 409},
          );
        }

        const payloadJson = json(payload);
        insertDraft.run({
          revisionId,
          projectId,
          payloadJson,
          payloadHash: hashPayload(payloadJson),
          now: timestamp(),
        });
        return mapRevision(getRevision.get(revisionId));
      },
      get(revisionId) {
        return mapRevision(getRevision.get(revisionId));
      },
      latestByProject(projectId) {
        return mapRevision(latestRevisionByProject.get(projectId));
      },
      approve({projectId, revisionId, payload, approvedAt, approvedBy}) {
        const existing = getRevision.get(revisionId);
        if (!existing) {
          throw new AppError('REVISION_NOT_FOUND', 'Revision was not found', {status: 404});
        }
        if (existing.project_id !== projectId) {
          throw new AppError('REVISION_PROJECT_MISMATCH', 'Revision belongs to another project', {status: 409});
        }
        if (existing.status === 'approved') {
          throw new AppError(
            'APPROVED_REVISION_IMMUTABLE',
            'Approved revision cannot be modified',
            {status: 409},
          );
        }

        const payloadJson = json(payload);
        const result = approveRevision.run({
          revisionId,
          projectId,
          payloadJson,
          payloadHash: hashPayload(payloadJson),
          approvedAt,
          approvedBy,
          now: timestamp(),
        });
        if (result.changes !== 1) {
          throw new AppError('REVISION_APPROVAL_CONFLICT', 'Revision could not be approved', {status: 409});
        }
        return mapRevision(getRevision.get(revisionId));
      },
    }),

    artifacts: Object.freeze({
      create({id, projectId, kind, relativePath, contentHash = null}) {
        const now = timestamp();
        insertArtifact.run({id, projectId, kind, relativePath, contentHash, now});
        const stored = mapArtifact(getArtifact.get(id));
        const matches = stored
          && stored.projectId === projectId
          && stored.kind === kind
          && stored.relativePath === relativePath
          && stored.contentHash === contentHash;
        if (!matches) {
          throw new AppError(
            'ARTIFACT_ID_CONFLICT',
            'Artifact ID already exists with different immutable metadata',
            {status: 409},
          );
        }
        return stored;
      },
      listByProject(projectId) {
        return listArtifacts.all(projectId).map(mapArtifact);
      },
    }),

    jobs: Object.freeze({
      create({id, projectId, stage, status = 'queued', maxAttempts = 1, runAfter = null}) {
        const now = timestamp();
        insertJob.run({id, projectId, stage, status, maxAttempts, runAfter, now});
        return mapJob(getJob.get(id));
      },
      get(id) {
        return mapJob(getJob.get(id));
      },
      latestByProject(projectId) {
        return mapJob(latestJobByProject.get(projectId));
      },
    }),
  });
}
