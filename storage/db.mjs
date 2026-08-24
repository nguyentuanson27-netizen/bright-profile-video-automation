import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import Database from 'better-sqlite3';

import {AppError, ErrorCodes} from '../domain/errors.mjs';

const LATEST_VERSION = 4;
const MIGRATIONS = Object.freeze({
  1: readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'),
  2: readFileSync(new URL('./migrations/002_research_api.sql', import.meta.url), 'utf8'),
  3: readFileSync(new URL('./migrations/003_chatgpt_handoff.sql', import.meta.url), 'utf8'),
  4: readFileSync(new URL('./migrations/004_chatgpt_imported_draft.sql', import.meta.url), 'utf8'),
});
const nowIso = () => new Date().toISOString();
const parseJson = (value) => JSON.parse(value);
const hashPayload = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
    for (let next = version + 1; next <= LATEST_VERSION; next += 1) {
      const sql = MIGRATIONS[next];
      if (!sql) throw new Error(`Missing database migration ${next}`);
      db.exec(sql);
      db.pragma(`user_version = ${next}`);
    }
  });
  migrate.immediate();
  return LATEST_VERSION;
};

const projectFromRow = (row) => row && ({
  id: row.id,
  creator: row.creator,
  topic: row.topic,
  instructions: row.instructions ?? '',
  status: row.status,
  origin: row.origin ?? 'standalone',
  idempotencyKey: row.idempotency_key ?? null,
  handoffFingerprint: row.handoff_fingerprint ?? null,
  currentRevisionId: row.current_revision_id,
  approvedRevisionId: row.approved_revision_id,
  failedStage: row.failed_stage,
  failureRetryable: row.failure_retryable === null ? null : Boolean(row.failure_retryable),
  failureCode: row.failure_code,
  research: row.research_json ? parseJson(row.research_json) : null,
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
  approvalMode: row.approval_mode ?? null,
  approvalActor: row.approval_actor ?? null,
  approvalContext: row.approval_context_json ? parseJson(row.approval_context_json) : null,
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

const transitionError = (message) => new AppError(ErrorCodes.INVALID_TRANSITION, message);
const downstreamStartedError = () => new AppError(
  ErrorCodes.DOWNSTREAM_WORK_STARTED,
  'Approval-relevant edit is blocked after downstream work starts',
);

export const createRepositories = (db) => {
  const insertProject = db.prepare(`
    INSERT INTO projects (id, creator, topic, instructions, status, origin, idempotency_key, handoff_fingerprint, research_json, created_at, updated_at)
    VALUES (@id, @creator, @topic, @instructions, @status, @origin, @idempotencyKey, @handoffFingerprint, @researchJson, @createdAt, @updatedAt)
  `);
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const getProjectByIdempotencyKey = db.prepare('SELECT * FROM projects WHERE idempotency_key = ?');
  const listProjects = db.prepare('SELECT * FROM projects ORDER BY created_at, id');
  const insertSource = db.prepare(`
    INSERT INTO sources (id, project_id, url, status, payload_json, created_at, updated_at)
    VALUES (@id, @projectId, @url, @status, @payloadJson, @createdAt, @updatedAt)
  `);
  const getSource = db.prepare('SELECT * FROM sources WHERE id = ?');
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
  const updateUnapprovedRevisionPayload = db.prepare(`
    UPDATE revisions SET payload_json = @payloadJson, payload_hash = @payloadHash
    WHERE id = @revisionId AND project_id = @projectId AND approved_at IS NULL
  `);
  const cloneReviewProject = db.prepare(`
    UPDATE projects
    SET status = 'review_required', current_revision_id = @revisionId,
        approved_revision_id = NULL, updated_at = @updatedAt
    WHERE id = @projectId
      AND status = 'approved'
      AND current_revision_id = @expectedRevisionId
      AND approved_revision_id = @expectedRevisionId
  `);
  const approveRevisionRow = db.prepare(`
    UPDATE revisions
    SET approved_at = @approvedAt,
        approval_mode = @approvalMode,
        approval_actor = @approvalActor,
        approval_context_json = @approvalContextJson
    WHERE id = @revisionId
      AND project_id = @projectId
      AND approved_at IS NULL
      AND payload_hash = @expectedPayloadHash
  `);
  const approveProject = db.prepare(`
    UPDATE projects
    SET status = 'approved', approved_revision_id = @revisionId, updated_at = @updatedAt
    WHERE id = @projectId
      AND status = 'review_required'
      AND current_revision_id = @revisionId
  `);
  const invalidateApprovalProject = db.prepare(`
    UPDATE projects
    SET status = 'review_required', approved_revision_id = NULL, updated_at = @updatedAt
    WHERE id = @projectId
      AND current_revision_id = @expectedRevisionId
      AND approved_revision_id = @expectedRevisionId
  `);
  const enterMediaIngest = db.prepare(`
    UPDATE projects
    SET status = 'media_ingest', updated_at = @updatedAt
    WHERE id = @projectId
      AND status = 'approved'
      AND current_revision_id = @revisionId
      AND approved_revision_id = @revisionId
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
  const getLatestProjectStage = db.prepare('SELECT * FROM stages WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
  const getActiveMediaIngest = db.prepare(`
    SELECT * FROM stages
    WHERE project_id = ? AND revision_id = ? AND stage_type = 'media_ingest'
      AND state IN ('queued', 'running')
    ORDER BY rowid
    LIMIT 1
  `);
  const getBarrierProject = db.prepare(`
    SELECT status, current_revision_id, approved_revision_id FROM projects WHERE id = ?
  `);
  const hasDescendant = db.prepare(`
    SELECT 1 FROM stages
    WHERE project_id = ? AND revision_id = ? AND stage_type IN ('media_ingest', 'tts', 'render')
    LIMIT 1
  `);
  const countActiveChatGptProjects = db.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE origin = 'chatgpt_mcp'
      AND status NOT IN ('completed', 'failed', 'cancelled')
  `);
  const countOtherActiveChatGptProjects = db.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE origin = 'chatgpt_mcp'
      AND id != ?
      AND status NOT IN ('completed', 'failed', 'cancelled')
  `);

  const importProjectTx = db.transaction(({
    project,
    sources = [],
    initialStage = null,
    initialDraft = null,
    maxActiveProjects = null,
    incomingFingerprint,
  }) => {
    if (project.idempotencyKey) {
      const existingRow = getProjectByIdempotencyKey.get(project.idempotencyKey);
      if (existingRow) {
        const existing = projectFromRow(existingRow);
        const existingFingerprint = existing.handoffFingerprint ?? hashPayload({
          creator: existing.creator,
          topic: existing.topic,
          instructions: existing.instructions ?? '',
          evidenceBundle: existing.research,
        });
        if (existingFingerprint !== incomingFingerprint) {
          throw new AppError(
            ErrorCodes.IDEMPOTENCY_CONFLICT,
            'Idempotency key was used with different project parameters',
            {status: 409},
          );
        }
        const stageRow = getLatestProjectStage.get(existing.id);
        return {
          project: existing,
          stage: stageFromRow(stageRow),
          isExisting: true,
        };
      }
    }

    if (project.origin === 'chatgpt_mcp' && maxActiveProjects !== null && Number.isInteger(maxActiveProjects)) {
      const activeCount = countActiveChatGptProjects.get().count;
      if (activeCount >= maxActiveProjects) {
        throw new AppError(
          ErrorCodes.NOAUTH_CAPACITY_REACHED,
          'Anonymous active project capacity reached',
          {status: 429},
        );
      }
    }

    const createdAt = project.createdAt ?? nowIso();
    const updatedAt = project.updatedAt ?? createdAt;
    insertProject.run({
      ...project,
      instructions: project.instructions ?? '',
      status: project.status ?? (initialDraft ? 'review_required' : 'generating'),
      origin: project.origin ?? 'chatgpt_mcp',
      idempotencyKey: project.idempotencyKey ?? null,
      handoffFingerprint: incomingFingerprint ?? null,
      researchJson: project.research ? JSON.stringify(project.research) : null,
      createdAt,
      updatedAt,
    });
    for (const source of sources) {
      const sourceCreatedAt = source.createdAt ?? createdAt;
      insertSource.run({
        ...source,
        status: source.status ?? 'available',
        payloadJson: JSON.stringify(source.payload ?? {}),
        createdAt: sourceCreatedAt,
        updatedAt: source.updatedAt ?? sourceCreatedAt,
      });
    }

    if (initialDraft) {
      insertRevision.run({
        id: initialDraft.id,
        projectId: project.id,
        revisionNo: 1,
        payloadJson: JSON.stringify(initialDraft.payload),
        payloadHash: initialDraft.payloadHash,
        createdAt: initialDraft.createdAt ?? createdAt,
      });
      setCurrentRevision.run(initialDraft.id, updatedAt, project.id);
      return {
        project: projectFromRow(getProject.get(project.id)),
        stage: null,
        isExisting: false,
      };
    }

    if (!initialStage?.id) throw new TypeError('initialStage is required when no imported draft is provided');
    const stageId = initialStage.id;
    const stageCreatedAt = initialStage.createdAt ?? createdAt;
    const logicalKey = `${project.id}:initial:generation`;
    insertStage.run({
      id: stageId,
      logicalKey,
      projectId: project.id,
      revisionId: null,
      type: 'generation',
      state: 'queued',
      retryable: 1,
      maxAttempts: initialStage.maxAttempts ?? 4,
      availableAtMs: initialStage.availableAtMs ?? 0,
      createdAt: stageCreatedAt,
      updatedAt: stageCreatedAt,
    });

    return {
      project: projectFromRow(getProject.get(project.id)),
      stage: stageFromRow(getStage.get(stageId)),
      isExisting: false,
    };
  });

  const createProjectTx = db.transaction(({project, sources = [], maxActiveProjects = null}) => {
    if (project.origin === 'chatgpt_mcp' && maxActiveProjects !== null && Number.isInteger(maxActiveProjects)) {
      const activeCount = countActiveChatGptProjects.get().count;
      if (activeCount >= maxActiveProjects) {
        throw new AppError(
          ErrorCodes.NOAUTH_CAPACITY_REACHED,
          'Anonymous active project capacity reached',
          {status: 429},
        );
      }
    }
    const createdAt = project.createdAt ?? nowIso();
    const updatedAt = project.updatedAt ?? createdAt;
    insertProject.run({
      ...project,
      instructions: project.instructions ?? '',
      status: project.status ?? 'draft',
      origin: project.origin ?? 'standalone',
      idempotencyKey: project.idempotencyKey ?? null,
      handoffFingerprint: project.handoffFingerprint ?? null,
      researchJson: project.research ? JSON.stringify(project.research) : null,
      createdAt,
      updatedAt,
    });
    for (const source of sources) {
      const sourceCreatedAt = source.createdAt ?? createdAt;
      insertSource.run({
        ...source,
        status: source.status ?? 'pending',
        payloadJson: JSON.stringify(source.payload ?? {}),
        createdAt: sourceCreatedAt,
        updatedAt: source.updatedAt ?? sourceCreatedAt,
      });
    }
    return projectFromRow(getProject.get(project.id));
  });

  const createRevisionTx = db.transaction((record) => {
    const createdAt = record.createdAt ?? nowIso();
    insertRevision.run({...record, payloadJson: JSON.stringify(record.payload), createdAt});
    setCurrentRevision.run(record.id, createdAt, record.projectId);
    return revisionFromRow(getRevision.get(record.id));
  });

  const approveRevisionTx = db.transaction(({
    projectId,
    revisionId,
    expectedPayloadHash,
    approvedAt,
    approvalMode = 'user_reviewed',
    approvalActor = 'user',
    approvalContext = null,
  }) => {
    if (typeof expectedPayloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPayloadHash)) {
      throw transitionError('Expected revision hash is required for approval');
    }
    const timestamp = approvedAt ?? nowIso();
    const approvalContextJson = approvalContext ? JSON.stringify(approvalContext) : null;
    if (approveRevisionRow.run({
      projectId,
      revisionId,
      expectedPayloadHash,
      approvedAt: timestamp,
      approvalMode,
      approvalActor,
      approvalContextJson,
    }).changes !== 1) {
      throw transitionError('Revision changed before approval');
    }
    if (approveProject.run({projectId, revisionId, updatedAt: timestamp}).changes !== 1) {
      throw transitionError('Revision is not the current review revision');
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

  const editCurrentRevisionTx = db.transaction(({projectId, revisionId, payload, payloadHash, updatedAt}) => {
    const project = getProject.get(projectId);
    if (!project?.current_revision_id) throw transitionError('Project has no review draft');
    const current = getRevision.get(project.current_revision_id);
    if (!current || current.project_id !== projectId) throw transitionError('Current revision is unavailable');
    const timestamp = updatedAt ?? nowIso();
    const payloadJson = JSON.stringify(payload);

    if (project.status === 'review_required') {
      if (updateUnapprovedRevisionPayload.run({
        projectId,
        revisionId: current.id,
        payloadJson,
        payloadHash,
      }).changes !== 1) {
        throw transitionError('Current review revision is not editable');
      }
      return {
        project: projectFromRow(getProject.get(projectId)),
        revision: revisionFromRow(getRevision.get(current.id)),
      };
    }

    if (project.approved_revision_id === current.id) {
      const barrier = readBarrier(projectId);
      if (barrier.hasDescendantStage) throw downstreamStartedError();
      if (project.status !== 'approved') throw transitionError('Approved draft is no longer editable');
      if (
        typeof revisionId !== 'string'
        || revisionId.length === 0
        || revisionId.length > 200
        || revisionId === current.id
      ) {
        throw new TypeError('new revision id is invalid');
      }
      insertRevision.run({
        id: revisionId,
        projectId,
        revisionNo: current.revision_no + 1,
        payloadJson,
        payloadHash,
        createdAt: timestamp,
      });
      if (cloneReviewProject.run({
        projectId,
        revisionId,
        expectedRevisionId: current.id,
        updatedAt: timestamp,
      }).changes !== 1) {
        throw transitionError('Approval changed while applying the edit');
      }
      return {
        project: projectFromRow(getProject.get(projectId)),
        revision: revisionFromRow(getRevision.get(revisionId)),
      };
    }

    throw transitionError('Draft can only be edited from review_required or approved');
  });

  const invalidateForEditTx = db.transaction(({projectId, expectedRevisionId, updatedAt}) => {
    const barrier = readBarrier(projectId);
    if (!barrier || barrier.currentRevisionId !== expectedRevisionId || barrier.approvedRevisionId !== expectedRevisionId) {
      throw transitionError('The expected approved revision is no longer current');
    }
    if (barrier.hasDescendantStage) throw downstreamStartedError();
    if (barrier.status !== 'approved') throw transitionError('Project is not in the approved state');
    const timestamp = updatedAt ?? nowIso();
    if (invalidateApprovalProject.run({projectId, expectedRevisionId, updatedAt: timestamp}).changes !== 1) {
      throw transitionError('Approval changed while applying the edit barrier');
    }
    return projectFromRow(getProject.get(projectId));
  });

  const createFirstDescendantTx = db.transaction((record) => {
    if (record.type !== 'media_ingest') throw transitionError('The first downstream stage must be media_ingest');
    const barrier = readBarrier(record.projectId);
    const active = getActiveMediaIngest.get(record.projectId, record.revisionId);
    if (
      barrier
      && barrier.status === 'media_ingest'
      && barrier.currentRevisionId === record.revisionId
      && barrier.approvedRevisionId === record.revisionId
      && active
    ) {
      return stageFromRow(active);
    }
    if (
      !barrier
      || barrier.status !== 'approved'
      || barrier.currentRevisionId !== record.revisionId
      || barrier.approvedRevisionId !== record.revisionId
      || barrier.hasDescendantStage
    ) {
      throw transitionError('Downstream stage requires the same current approved revision and no existing descendant stage');
    }
    const createdAt = record.createdAt ?? nowIso();
    const updatedAt = record.updatedAt ?? createdAt;
    const logicalKey = record.logicalKey ?? `${record.projectId}:${record.revisionId}:media_ingest`;
    insertStage.run({
      ...record,
      logicalKey,
      state: record.state ?? 'queued',
      retryable: record.retryable ? 1 : 0,
      maxAttempts: record.maxAttempts,
      availableAtMs: record.availableAtMs ?? 0,
      createdAt,
      updatedAt,
    });
    if (enterMediaIngest.run({projectId: record.projectId, revisionId: record.revisionId, updatedAt}).changes !== 1) {
      throw transitionError('Approval changed while creating the first downstream stage');
    }
    return stageFromRow(getStage.get(record.id));
  });

  return Object.freeze({
    projects: Object.freeze({
      importProject(record) {
        return importProjectTx.immediate(record);
      },
      create(record, options = {}) {
        return createProjectTx.immediate({project: record, maxActiveProjects: options.maxActiveProjects ?? null});
      },
      createWithSources(project, sources, options = {}) {
        return createProjectTx.immediate({project, sources, maxActiveProjects: options.maxActiveProjects ?? null});
      },
      countActiveChatGptProjects() {
        return countActiveChatGptProjects.get().count;
      },
      countOtherActiveChatGptProjects(projectId) {
        return countOtherActiveChatGptProjects.get(projectId).count;
      },
      assertCapacityForReactivation(projectId, maxActiveProjects) {
        if (maxActiveProjects !== null && maxActiveProjects !== undefined && Number.isInteger(maxActiveProjects)) {
          const count = countOtherActiveChatGptProjects.get(projectId).count;
          if (count >= maxActiveProjects) {
            throw new AppError(
              ErrorCodes.NOAUTH_CAPACITY_REACHED,
              'Anonymous active project capacity reached',
              {status: 429},
            );
          }
        }
      },
      get(id) {
        return projectFromRow(getProject.get(id));
      },
      getByIdempotencyKey(key) {
        if (typeof key !== 'string' || !key) return null;
        const row = getProjectByIdempotencyKey.get(key);
        return row ? projectFromRow(row) : null;
      },
      list() {
        return listProjects.all().map(projectFromRow);
      },
    }),
    sources: Object.freeze({
      create(record) {
        const createdAt = record.createdAt ?? nowIso();
        const updatedAt = record.updatedAt ?? createdAt;
        insertSource.run({...record, payloadJson: JSON.stringify(record.payload ?? {}), createdAt, updatedAt});
        return sourceFromRow(getSource.get(record.id));
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
      editCurrent(record) {
        return editCurrentRevisionTx.immediate(record);
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
      invalidateForEdit(record) {
        return invalidateForEditTx.immediate(record);
      },
      createFirstDescendant(record) {
        return createFirstDescendantTx.immediate(record);
      },
    }),
  });
};
