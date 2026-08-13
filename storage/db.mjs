import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import Database from 'better-sqlite3';

const LATEST_VERSION = 1;
const INITIAL_MIGRATION = readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
const nowIso = () => new Date().toISOString();
const parseJson = (value) => JSON.parse(value);

const assertBusyTimeout = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError('busyTimeoutMs must be an integer between 1 and 60000');
  }
};

export const openDatabase = (databasePath, {busyTimeoutMs = 5_000} = {}) => {
  assertBusyTimeout(busyTimeoutMs);
  const path = resolve(databasePath);
  mkdirSync(dirname(path), {recursive: true});
  const db = new Database(path, {timeout: busyTimeoutMs});
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
};

export const migrateDatabase = (db) => {
  const version = db.pragma('user_version', {simple: true});
  if (!Number.isInteger(version) || version < 0 || version > LATEST_VERSION) {
    throw new Error(`Unsupported database schema version: ${version}`);
  }
  if (version === LATEST_VERSION) return version;

  const migrate = db.transaction(() => {
    db.exec(INITIAL_MIGRATION);
    db.pragma(`user_version = ${LATEST_VERSION}`);
  });
  migrate.immediate();
  return LATEST_VERSION;
};

const projectFromRow = (row) => row && ({
  id: row.id,
  creator: row.creator,
  topic: row.topic,
  status: row.status,
  currentRevisionId: row.current_revision_id,
  approvedRevisionId: row.approved_revision_id,
  failedStage: row.failed_stage,
  failureRetryable: row.failure_retryable === null ? null : Boolean(row.failure_retryable),
  failureCode: row.failure_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sourceFromRow = (row) => row && ({
  id: row.id,
  projectId: row.project_id,
  url: row.url,
  status: row.status,
  payload: parseJson(row.payload_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const revisionFromRow = (row) => row && ({
  id: row.id,
  projectId: row.project_id,
  revisionNo: row.revision_no,
  payload: parseJson(row.payload_json),
  payloadHash: row.payload_hash,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
});

const stageFromRow = (row) => row && ({
  id: row.id,
  logicalKey: row.logical_key,
  projectId: row.project_id,
  revisionId: row.revision_id,
  type: row.stage_type,
  state: row.state,
  retryable: Boolean(row.retryable),
  maxAttempts: row.max_attempts,
  attemptCount: row.attempt_count,
  availableAtMs: row.available_at_ms,
  currentClaimToken: row.current_claim_token,
  leaseExpiresAtMs: row.lease_expires_at_ms,
  progress: parseJson(row.progress_json),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createRepositories = (db) => {
  const insertProject = db.prepare(`
    INSERT INTO projects (id, creator, topic, status, created_at, updated_at)
    VALUES (@id, @creator, @topic, @status, @createdAt, @updatedAt)
  `);
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const insertSource = db.prepare(`
    INSERT INTO sources (id, project_id, url, status, payload_json, created_at, updated_at)
    VALUES (@id, @projectId, @url, @status, @payloadJson, @createdAt, @updatedAt)
  `);
  const listSources = db.prepare('SELECT * FROM sources WHERE project_id = ? ORDER BY created_at, id');
  const insertRevision = db.prepare(`
    INSERT INTO revisions (id, project_id, revision_no, payload_json, payload_hash, created_at)
    VALUES (@id, @projectId, @revisionNo, @payloadJson, @payloadHash, @createdAt)
  `);
  const setCurrentRevision = db.prepare(`
    UPDATE projects SET current_revision_id = ?, updated_at = ? WHERE id = ?
  `);
  const getRevision = db.prepare('SELECT * FROM revisions WHERE id = ?');
  const updateRevisionPayload = db.prepare(`
    UPDATE revisions SET payload_json = @payloadJson, payload_hash = @payloadHash WHERE id = @revisionId
  `);
  const approveRevisionRow = db.prepare(`
    UPDATE revisions SET approved_at = @approvedAt
    WHERE id = @revisionId AND project_id = @projectId AND approved_at IS NULL
  `);
  const approveProject = db.prepare(`
    UPDATE projects
    SET status = 'approved', approved_revision_id = @revisionId, updated_at = @updatedAt
    WHERE id = @projectId AND current_revision_id = @revisionId
  `);
  const insertStage = db.prepare(`
    INSERT INTO stages (
      id, logical_key, project_id, revision_id, stage_type, state, retryable,
      max_attempts, available_at_ms, created_at, updated_at
    ) VALUES (
      @id, @logicalKey, @projectId, @revisionId, @type, @state, @retryable,
      @maxAttempts, @availableAtMs, @createdAt, @updatedAt
    )
  `);
  const getStage = db.prepare('SELECT * FROM stages WHERE id = ?');
  const getBarrierProject = db.prepare(`
    SELECT status, current_revision_id, approved_revision_id FROM projects WHERE id = ?
  `);
  const hasDescendant = db.prepare(`
    SELECT 1 FROM stages
    WHERE project_id = ? AND revision_id = ? AND stage_type IN ('media_ingest', 'tts', 'render')
    LIMIT 1
  `);

  const createRevisionTx = db.transaction((record) => {
    const createdAt = record.createdAt ?? nowIso();
    insertRevision.run({...record, payloadJson: JSON.stringify(record.payload), createdAt});
    setCurrentRevision.run(record.id, createdAt, record.projectId);
    return revisionFromRow(getRevision.get(record.id));
  });

  const approveRevisionTx = db.transaction(({projectId, revisionId, approvedAt}) => {
    const timestamp = approvedAt ?? nowIso();
    if (approveRevisionRow.run({projectId, revisionId, approvedAt: timestamp}).changes !== 1) {
      throw new Error('revision cannot be approved');
    }
    if (approveProject.run({projectId, revisionId, updatedAt: timestamp}).changes !== 1) {
      throw new Error('revision is not the current project revision');
    }
    return revisionFromRow(getRevision.get(revisionId));
  });

  const readBarrier = (projectId) => {
    const row = getBarrierProject.get(projectId);
    if (!row) return null;
    return {
      status: row.status,
      currentRevisionId: row.current_revision_id,
      approvedRevisionId: row.approved_revision_id,
      hasDescendantStage: Boolean(row.approved_revision_id && hasDescendant.get(projectId, row.approved_revision_id)),
    };
  };
  const readBarrierTx = db.transaction(readBarrier);
  const serializedBarrierTx = db.transaction((projectId, operation) => operation(readBarrier(projectId)));

  return Object.freeze({
    projects: Object.freeze({
      create(record) {
        const createdAt = record.createdAt ?? nowIso();
        const updatedAt = record.updatedAt ?? createdAt;
        insertProject.run({...record, createdAt, updatedAt});
        return projectFromRow(getProject.get(record.id));
      },
      get(id) {
        return projectFromRow(getProject.get(id));
      },
    }),
    sources: Object.freeze({
      create(record) {
        const createdAt = record.createdAt ?? nowIso();
        const updatedAt = record.updatedAt ?? createdAt;
        insertSource.run({...record, payloadJson: JSON.stringify(record.payload ?? {}), createdAt, updatedAt});
        return sourceFromRow(db.prepare('SELECT * FROM sources WHERE id = ?').get(record.id));
      },
      list(projectId) {
        return listSources.all(projectId).map(sourceFromRow);
      },
    }),
    revisions: Object.freeze({
      create(record) {
        return createRevisionTx.immediate(record);
      },
      get(id) {
        return revisionFromRow(getRevision.get(id));
      },
      updatePayload({revisionId, payload, payloadHash}) {
        if (updateRevisionPayload.run({revisionId, payloadJson: JSON.stringify(payload), payloadHash}).changes !== 1) {
          throw new Error('revision not found');
        }
        return revisionFromRow(getRevision.get(revisionId));
      },
      approve(record) {
        return approveRevisionTx.immediate(record);
      },
    }),
    stages: Object.freeze({
      create(record) {
        const createdAt = record.createdAt ?? nowIso();
        const updatedAt = record.updatedAt ?? createdAt;
        const logicalKey = record.logicalKey ?? `${record.projectId}:${record.revisionId ?? 'none'}:${record.type}`;
        insertStage.run({
          ...record,
          logicalKey,
          revisionId: record.revisionId ?? null,
          state: record.state ?? 'queued',
          retryable: record.retryable ? 1 : 0,
          maxAttempts: record.maxAttempts,
          availableAtMs: record.availableAtMs ?? 0,
          createdAt,
          updatedAt,
        });
        return stageFromRow(getStage.get(record.id));
      },
      get(id) {
        return stageFromRow(getStage.get(id));
      },
    }),
    approval: Object.freeze({
      getBarrier(projectId) {
        return readBarrierTx.deferred(projectId);
      },
      withSerializedBarrier(projectId, operation) {
        if (typeof operation !== 'function') throw new TypeError('operation must be a function');
        return serializedBarrierTx.immediate(projectId, operation);
      },
    }),
  });
};
