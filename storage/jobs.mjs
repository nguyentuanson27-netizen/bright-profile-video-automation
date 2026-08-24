import {createHash, randomUUID} from 'node:crypto';
import {AppError, ErrorCodes} from '../domain/errors.mjs';

const MAX_PROGRESS_BYTES = 1024 * 1024;
const MAX_RESEARCH_BYTES = 8 * 1024 * 1024;
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const nowIso = (nowMs) => new Date(nowMs).toISOString();
const staleClaimError = () => new AppError(ErrorCodes.STALE_CLAIM, 'Job claim is stale or lease has expired');
const stageNotRetryableError = () => new AppError(ErrorCodes.STAGE_NOT_RETRYABLE, 'Stage is not retryable');
const stageNotActiveError = () => new AppError(ErrorCodes.STAGE_NOT_ACTIVE, 'Stage is not active');
const transitionError = (message) => new AppError(ErrorCodes.INVALID_TRANSITION, message);

const assertPositiveInteger = (value, name, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be an integer between 1 and ${max}`);
  }
};

const assertNow = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('nowMs must be a non-negative safe integer');
};

const serializeBoundedJson = (value, name, maxBytes) => {
  const json = JSON.stringify(value ?? {});
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new TypeError(`${name} is too large`);
  return json;
};
const serializeJson = (value, name) => serializeBoundedJson(value, name, MAX_PROGRESS_BYTES);
const hashJson = (json) => createHash('sha256').update(json).digest('hex');

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
  progress: JSON.parse(row.progress_json),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const attemptFromRow = (row) => row && ({
  id: row.id,
  stageId: row.stage_id,
  attemptNo: row.attempt_no,
  claimToken: row.claim_token,
  workerId: row.worker_id,
  status: row.status,
  startedAtMs: row.started_at_ms,
  leaseExpiresAtMs: row.lease_expires_at_ms,
  completedAtMs: row.completed_at_ms,
  errorCode: row.error_code,
  errorMessage: row.error_message,
});

const artifactFromRow = (row) => row && ({
  id: row.id,
  projectId: row.project_id,
  revisionId: row.revision_id,
  stageId: row.stage_id,
  attemptId: row.attempt_id,
  kind: row.kind,
  relativePath: row.relative_path,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  sha256: row.sha256,
  isAuthoritative: Boolean(row.is_authoritative),
  createdAt: row.created_at,
});

const activeProjectStatus = (stageType) => ({
  research: 'researching',
  generation: 'generating',
  media_ingest: 'media_ingest',
  tts: 'tts',
  render: 'rendering',
}[stageType] ?? stageType);

export const createJobStore = (db, {
  leaseMs = 30_000,
  baseBackoffMs = 1_000,
  maxBackoffMs = 60_000,
  defaultMaxAttempts = 3,
  tokenFactory = randomUUID,
  attemptIdFactory = randomUUID,
  sourceIdFactory = randomUUID,
  revisionIdFactory = randomUUID,
} = {}) => {
  assertPositiveInteger(leaseMs, 'leaseMs', 10 * 60 * 1000);
  assertPositiveInteger(baseBackoffMs, 'baseBackoffMs', 10 * 60 * 1000);
  assertPositiveInteger(maxBackoffMs, 'maxBackoffMs', 10 * 60 * 1000);
  assertPositiveInteger(defaultMaxAttempts, 'defaultMaxAttempts', 100);
  if (baseBackoffMs > maxBackoffMs) throw new TypeError('baseBackoffMs must not exceed maxBackoffMs');
  for (const [factory, name] of [
    [tokenFactory, 'tokenFactory'],
    [attemptIdFactory, 'attemptIdFactory'],
    [sourceIdFactory, 'sourceIdFactory'],
    [revisionIdFactory, 'revisionIdFactory'],
  ]) {
    if (typeof factory !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const insertStage = db.prepare(`
    INSERT INTO stages (
      id, logical_key, project_id, revision_id, stage_type, state, retryable,
      max_attempts, available_at_ms, created_at, updated_at
    ) VALUES (
      @id, @logicalKey, @projectId, @revisionId, @type, 'queued', 0,
      @maxAttempts, @availableAtMs, @createdAt, @updatedAt
    )
  `);
  const getStageRow = db.prepare('SELECT * FROM stages WHERE id = ?');
  const getLatestProjectStageRow = db.prepare(`
    SELECT * FROM stages WHERE project_id = ? ORDER BY rowid DESC LIMIT 1
  `);
  const listAttemptRows = db.prepare('SELECT * FROM attempts WHERE stage_id = ? ORDER BY attempt_no');
  const insertAttempt = db.prepare(`
    INSERT INTO attempts (
      id, stage_id, attempt_no, claim_token, worker_id, status,
      started_at_ms, lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `);
  const setClaim = db.prepare(`
    UPDATE stages
    SET state = 'running', attempt_count = attempt_count + 1,
        current_claim_token = ?, lease_expires_at_ms = ?, retryable = 0,
        error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND state = 'queued' AND available_at_ms <= ?
      AND attempt_count = ? AND attempt_count < max_attempts
  `);
  const currentClaim = db.prepare(`
    SELECT s.*, a.id AS active_attempt_id
    FROM stages s
    JOIN attempts a ON a.stage_id = s.id AND a.claim_token = ? AND a.status = 'running'
    WHERE s.id = ? AND s.state = 'running' AND s.current_claim_token = ?
      AND s.lease_expires_at_ms > ? AND a.lease_expires_at_ms > ?
  `);
  const setStageLease = db.prepare(`
    UPDATE stages SET lease_expires_at_ms = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const setAttemptLease = db.prepare(`
    UPDATE attempts SET lease_expires_at_ms = ? WHERE stage_id = ? AND claim_token = ? AND status = 'running'
  `);
  const setProgress = db.prepare(`
    UPDATE stages SET progress_json = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const finishAttempt = db.prepare(`
    UPDATE attempts
    SET status = ?, completed_at_ms = ?, error_code = ?, error_message = ?
    WHERE stage_id = ? AND claim_token = ? AND status = 'running'
  `);
  const finishStage = db.prepare(`
    UPDATE stages
    SET state = ?, retryable = ?, current_claim_token = NULL, lease_expires_at_ms = NULL,
        error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const expiredRows = db.prepare(`
    SELECT * FROM stages WHERE state = 'running' AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, id
  `);
  const recoverStage = db.prepare(`
    UPDATE stages
    SET state = 'queued', available_at_ms = ?, current_claim_token = NULL,
        lease_expires_at_ms = NULL, updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const exhaustStage = db.prepare(`
    UPDATE stages
    SET state = 'failed', retryable = 0, current_claim_token = NULL,
        lease_expires_at_ms = NULL, error_code = 'ATTEMPTS_EXHAUSTED',
        error_message = 'Automatic attempts exhausted', updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const queueRetry = db.prepare(`
    UPDATE stages
    SET state = 'queued', retryable = 0, available_at_ms = ?, current_claim_token = NULL,
        lease_expires_at_ms = NULL, error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND state = 'failed' AND retryable = 1 AND attempt_count < max_attempts
  `);
  const cancelStage = db.prepare(`
    UPDATE stages
    SET state = 'cancelled', current_claim_token = NULL, lease_expires_at_ms = NULL, updated_at = ?
    WHERE id = ? AND state IN ('queued', 'running')
  `);
  const updateRevisionPayload = db.prepare(`
    UPDATE revisions SET payload_json = ?, payload_hash = ? WHERE id = ?
  `);
  const insertRevision = db.prepare(`
    INSERT INTO revisions (id, project_id, revision_no, payload_json, payload_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const nextRevisionNo = db.prepare('SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM revisions WHERE project_id = ?');
  const getProjectRow = db.prepare('SELECT * FROM projects WHERE id = ?');
  const startProjectResearch = db.prepare(`
    UPDATE projects
    SET status = 'researching', failed_stage = NULL, failure_retryable = NULL,
        failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'draft'
  `);
  const startProjectGeneration = db.prepare(`
    UPDATE projects
    SET status = 'generating', failed_stage = NULL, failure_retryable = NULL,
        failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'research_ready'
  `);
  const markProjectActive = db.prepare(`
    UPDATE projects
    SET status = ?, failed_stage = NULL, failure_retryable = NULL,
        failure_code = NULL, updated_at = ?
    WHERE id = ?
  `);
  const markProjectFailed = db.prepare(`
    UPDATE projects
    SET status = 'failed', failed_stage = ?, failure_retryable = ?,
        failure_code = ?, updated_at = ?
    WHERE id = ?
  `);
  const markProjectResearchReady = db.prepare(`
    UPDATE projects
    SET status = 'research_ready', research_json = ?, failed_stage = NULL,
        failure_retryable = NULL, failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'researching'
  `);
  const markProjectReviewRequired = db.prepare(`
    UPDATE projects
    SET status = 'review_required', current_revision_id = ?, approved_revision_id = NULL,
        failed_stage = NULL, failure_retryable = NULL, failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'generating'
  `);
  const countOtherActiveChatGptProjects = db.prepare(`
    SELECT COUNT(*) AS count FROM projects
    WHERE origin = 'chatgpt_mcp'
      AND id != ?
      AND status NOT IN ('completed', 'failed', 'cancelled')
  `);
  const deleteProjectSources = db.prepare('DELETE FROM sources WHERE project_id = ?');
  const insertSource = db.prepare(`
    INSERT INTO sources (id, project_id, url, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertArtifact = db.prepare(`
    INSERT INTO artifacts (
      id, project_id, revision_id, stage_id, attempt_id, kind, relative_path,
      mime_type, byte_size, sha256, is_authoritative, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const getArtifact = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  const listArtifactRows = db.prepare('SELECT * FROM artifacts WHERE stage_id = ? ORDER BY created_at, id');
  const clearAuthority = db.prepare(`
    UPDATE artifacts SET is_authoritative = 0
    WHERE project_id = ? AND revision_id IS ? AND kind = ? AND is_authoritative = 1
  `);
  const setAuthority = db.prepare('UPDATE artifacts SET is_authoritative = 1 WHERE id = ?');
  const candidateStatements = new Map();

  const requireCurrentClaim = (stageId, claimToken, nowMs) => {
    assertNow(nowMs);
    const row = currentClaim.get(claimToken, stageId, claimToken, nowMs, nowMs);
    if (!row) throw staleClaimError();
    return row;
  };

  const candidateStatement = (allowedTypes) => {
    const types = [...new Set(allowedTypes)].filter((value) => typeof value === 'string' && value.length > 0);
    if (types.length === 0) return {types, statement: null};
    if (types.length > 32) throw new TypeError('allowedTypes cannot exceed 32 entries');
    const key = types.length;
    let statement = candidateStatements.get(key);
    if (!statement) {
      const placeholders = Array.from({length: key}, () => '?').join(', ');
      statement = db.prepare(`
        SELECT * FROM stages
        WHERE state = 'queued' AND available_at_ms <= ? AND attempt_count < max_attempts
          AND stage_type IN (${placeholders})
        ORDER BY available_at_ms, created_at, id
        LIMIT 1
      `);
      candidateStatements.set(key, statement);
    }
    return {types, statement};
  };

  const startResearchTx = db.transaction(({projectId, stageId, nowMs, maxAttempts = defaultMaxAttempts}) => {
    assertNow(nowMs);
    assertPositiveInteger(maxAttempts, 'maxAttempts', 100);
    const project = getProjectRow.get(projectId);
    if (!project) throw transitionError('Project does not exist');
    const currentStage = getLatestProjectStageRow.get(projectId);
    if (project.status === 'researching' && currentStage && ['queued', 'running'].includes(currentStage.state)) {
      return {changed: false, stage: stageFromRow(currentStage)};
    }
    if (project.status !== 'draft') throw transitionError('Research can only start from draft');
    const timestamp = nowIso(nowMs);
    insertStage.run({
      id: stageId,
      logicalKey: `${projectId}:research`,
      projectId,
      revisionId: null,
      type: 'research',
      maxAttempts,
      availableAtMs: nowMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (startProjectResearch.run(timestamp, projectId).changes !== 1) throw transitionError('Project state changed while starting research');
    return {changed: true, stage: stageFromRow(getStageRow.get(stageId))};
  });

  const startGenerationTx = db.transaction(({projectId, stageId, nowMs, maxAttempts = defaultMaxAttempts}) => {
    assertNow(nowMs);
    assertPositiveInteger(maxAttempts, 'maxAttempts', 100);
    const project = getProjectRow.get(projectId);
    if (!project) throw transitionError('Project does not exist');
    const currentStage = getLatestProjectStageRow.get(projectId);
    if (project.status === 'generating' && currentStage?.stage_type === 'generation' && ['queued', 'running'].includes(currentStage.state)) {
      return {changed: false, stage: stageFromRow(currentStage)};
    }
    if (project.status !== 'research_ready') throw transitionError('Generation can only start from research_ready');
    const timestamp = nowIso(nowMs);
    insertStage.run({
      id: stageId,
      logicalKey: `${projectId}:generation`,
      projectId,
      revisionId: null,
      type: 'generation',
      maxAttempts,
      availableAtMs: nowMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (startProjectGeneration.run(timestamp, projectId).changes !== 1) throw transitionError('Project state changed while starting generation');
    return {changed: true, stage: stageFromRow(getStageRow.get(stageId))};
  });

  const claimTx = db.transaction(({workerId, nowMs, allowedTypes}) => {
    assertNow(nowMs);
    if (typeof workerId !== 'string' || workerId.length === 0) throw new TypeError('workerId is required');
    const {types, statement} = candidateStatement(allowedTypes ?? []);
    if (!statement) return null;
    const row = statement.get(nowMs, ...types);
    if (!row) return null;

    const claimToken = tokenFactory();
    const attemptId = attemptIdFactory();
    const attemptNo = row.attempt_count + 1;
    const leaseExpiresAtMs = nowMs + leaseMs;
    const updatedAt = nowIso(nowMs);
    if (setClaim.run(claimToken, leaseExpiresAtMs, updatedAt, row.id, nowMs, row.attempt_count).changes !== 1) {
      return null;
    }
    insertAttempt.run(attemptId, row.id, attemptNo, claimToken, workerId, nowMs, leaseExpiresAtMs);
    return {
      stageId: row.id,
      projectId: row.project_id,
      revisionId: row.revision_id,
      type: row.stage_type,
      claimToken,
      attemptId,
      attemptNo,
      leaseExpiresAtMs,
    };
  });

  const heartbeatTx = db.transaction(({stageId, claimToken, nowMs}) => {
    requireCurrentClaim(stageId, claimToken, nowMs);
    const leaseExpiresAtMs = nowMs + leaseMs;
    const updatedAt = nowIso(nowMs);
    if (setStageLease.run(leaseExpiresAtMs, updatedAt, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (setAttemptLease.run(leaseExpiresAtMs, stageId, claimToken).changes !== 1) throw staleClaimError();
    return stageFromRow(getStageRow.get(stageId));
  });

  const progressTx = db.transaction(({stageId, claimToken, progress, nowMs}) => {
    requireCurrentClaim(stageId, claimToken, nowMs);
    if (setProgress.run(serializeJson(progress, 'progress'), nowIso(nowMs), stageId, claimToken).changes !== 1) {
      throw staleClaimError();
    }
    return stageFromRow(getStageRow.get(stageId));
  });

  const completeTx = db.transaction(({stageId, claimToken, nowMs}) => {
    requireCurrentClaim(stageId, claimToken, nowMs);
    if (finishAttempt.run('succeeded', nowMs, null, null, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (finishStage.run('succeeded', 0, null, null, nowIso(nowMs), stageId, claimToken).changes !== 1) throw staleClaimError();
    return stageFromRow(getStageRow.get(stageId));
  });

  const failTx = db.transaction(({stageId, claimToken, nowMs, retryable, errorCode, errorMessage = null}) => {
    const current = requireCurrentClaim(stageId, claimToken, nowMs);
    const canRetry = Boolean(retryable && current.attempt_count < current.max_attempts);
    const code = typeof errorCode === 'string' && errorCode.length > 0 ? errorCode : 'STAGE_FAILED';
    const timestamp = nowIso(nowMs);
    if (finishAttempt.run('failed', nowMs, code, errorMessage, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (finishStage.run('failed', canRetry ? 1 : 0, code, errorMessage, timestamp, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (markProjectFailed.run(current.stage_type, canRetry ? 1 : 0, code, timestamp, current.project_id).changes !== 1) {
      throw transitionError('Project disappeared while recording stage failure');
    }
    return stageFromRow(getStageRow.get(stageId));
  });

  const recoverTx = db.transaction(({nowMs}) => {
    assertNow(nowMs);
    let recovered = 0;
    let exhausted = 0;
    for (const row of expiredRows.all(nowMs)) {
      const token = row.current_claim_token;
      if (!token) continue;
      finishAttempt.run('lost', nowMs, 'LEASE_EXPIRED', 'Worker lease expired', row.id, token);
      if (row.attempt_count >= row.max_attempts) {
        const timestamp = nowIso(nowMs);
        if (exhaustStage.run(timestamp, row.id, token).changes === 1) {
          markProjectFailed.run(row.stage_type, 0, 'ATTEMPTS_EXHAUSTED', timestamp, row.project_id);
          exhausted += 1;
        }
        continue;
      }
      const exponent = Math.max(0, row.attempt_count - 1);
      const backoffMs = Math.min(maxBackoffMs, baseBackoffMs * (2 ** exponent));
      if (recoverStage.run(nowMs + backoffMs, nowIso(nowMs), row.id, token).changes === 1) recovered += 1;
    }
    return {recovered, exhausted};
  });

  const retryTx = db.transaction(({stageId, nowMs, maxActiveProjects = null}) => {
    assertNow(nowMs);
    const row = getStageRow.get(stageId);
    if (!row) throw stageNotRetryableError();
    if (row.state === 'queued' || row.state === 'running') return {changed: false, stage: stageFromRow(row)};
    if (row.state !== 'failed' || !row.retryable || row.attempt_count >= row.max_attempts) throw stageNotRetryableError();

    const project = getProjectRow.get(row.project_id);
    if (!project) throw transitionError('Project disappeared while retrying stage');

    if (project.origin === 'chatgpt_mcp' && maxActiveProjects !== null && Number.isInteger(maxActiveProjects)) {
      if (['failed', 'cancelled', 'completed'].includes(project.status)) {
        const activeCount = countOtherActiveChatGptProjects.get(row.project_id).count;
        if (activeCount >= maxActiveProjects) {
          throw new AppError(
            ErrorCodes.NOAUTH_CAPACITY_REACHED,
            'Anonymous active project capacity reached',
            {status: 429},
          );
        }
      }
    }

    const timestamp = nowIso(nowMs);
    if (queueRetry.run(nowMs, timestamp, stageId).changes !== 1) throw stageNotRetryableError();
    if (markProjectActive.run(activeProjectStatus(row.stage_type), timestamp, row.project_id).changes !== 1) throw transitionError('Project disappeared while retrying stage');
    return {changed: true, stage: stageFromRow(getStageRow.get(stageId))};
  });

  const cancelTx = db.transaction(({stageId, nowMs}) => {
    assertNow(nowMs);
    const row = getStageRow.get(stageId);
    if (!row) throw stageNotActiveError();
    if (row.state === 'cancelled') return {changed: false, stage: stageFromRow(row)};
    if (!['queued', 'running'].includes(row.state)) throw stageNotActiveError();
    if (row.state === 'running' && row.current_claim_token) {
      finishAttempt.run('cancelled', nowMs, 'CANCELLED', 'Stage cancelled', stageId, row.current_claim_token);
    }
    if (cancelStage.run(nowIso(nowMs), stageId).changes !== 1) throw stageNotActiveError();
    return {changed: true, stage: stageFromRow(getStageRow.get(stageId))};
  });

  const persistDraftTx = db.transaction(({stageId, claimToken, revisionId, payload, payloadHash, nowMs}) => {
    const current = requireCurrentClaim(stageId, claimToken, nowMs);
    if (current.revision_id !== revisionId) throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Claim does not own this revision');
    if (updateRevisionPayload.run(serializeJson(payload, 'draft'), payloadHash, revisionId).changes !== 1) {
      throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Revision not found');
    }
    return true;
  });

  const commitResearchTx = db.transaction(({stageId, claimToken, result, nowMs}) => {
    const current = requireCurrentClaim(stageId, claimToken, nowMs);
    if (current.stage_type !== 'research') throw transitionError('Claim is not a research stage');
    if (!result || typeof result !== 'object' || Array.isArray(result) || !result.bundle) throw new TypeError('research result is required');
    if (!Array.isArray(result.sources) || !Array.isArray(result.unavailableSources)) throw new TypeError('research sources and unavailableSources must be arrays');
    const researchJson = serializeBoundedJson(result.bundle, 'research result', MAX_RESEARCH_BYTES);
    const timestamp = nowIso(nowMs);
    const records = new Map();
    for (const source of result.sources) {
      if (!source || typeof source.url !== 'string' || Object.hasOwn(source, 'id')) throw new TypeError('research source is invalid');
      records.set(source.url, {status: 'available', payload: {...source}});
    }
    for (const source of result.unavailableSources) {
      if (!source || typeof source.url !== 'string' || Object.hasOwn(source, 'id')) throw new TypeError('unavailable research source is invalid');
      if (!records.has(source.url)) records.set(source.url, {status: 'unavailable', payload: {...source}});
    }
    deleteProjectSources.run(current.project_id);
    for (const [url, record] of [...records.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const id = sourceIdFactory();
      if (typeof id !== 'string' || id.length === 0) throw new TypeError('sourceIdFactory must return a non-empty string');
      insertSource.run(id, current.project_id, url, record.status, JSON.stringify(record.payload), timestamp, timestamp);
    }
    if (finishAttempt.run('succeeded', nowMs, null, null, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (finishStage.run('succeeded', 0, null, null, timestamp, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (markProjectResearchReady.run(researchJson, timestamp, current.project_id).changes !== 1) throw transitionError('Project state changed while committing research');
    return true;
  });

  const commitGenerationTx = db.transaction(({stageId, claimToken, draft, nowMs}) => {
    const current = requireCurrentClaim(stageId, claimToken, nowMs);
    if (current.stage_type !== 'generation') throw transitionError('Claim is not a generation stage');
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new TypeError('generation draft is required');
    const draftJson = serializeBoundedJson(draft, 'generation draft', MAX_DRAFT_BYTES);
    const revisionId = revisionIdFactory();
    if (typeof revisionId !== 'string' || revisionId.length === 0 || revisionId.length > 200) {
      throw new TypeError('revisionIdFactory must return a non-empty bounded string');
    }
    const timestamp = nowIso(nowMs);
    const revisionNo = nextRevisionNo.get(current.project_id).revision_no;
    insertRevision.run(revisionId, current.project_id, revisionNo, draftJson, hashJson(draftJson), timestamp);
    if (finishAttempt.run('succeeded', nowMs, null, null, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (finishStage.run('succeeded', 0, null, null, timestamp, stageId, claimToken).changes !== 1) throw staleClaimError();
    if (markProjectReviewRequired.run(revisionId, timestamp, current.project_id).changes !== 1) {
      throw transitionError('Project state changed while committing generation');
    }
    return {revisionId};
  });

  const registerArtifactTx = db.transaction((record) => {
    const current = requireCurrentClaim(record.stageId, record.claimToken, record.nowMs);
    insertArtifact.run(
      record.id,
      current.project_id,
      current.revision_id,
      current.id,
      current.active_attempt_id,
      record.kind,
      record.relativePath,
      record.mimeType ?? null,
      record.byteSize ?? null,
      record.sha256 ?? null,
      nowIso(record.nowMs),
    );
    return artifactFromRow(getArtifact.get(record.id));
  });

  const promoteArtifactTx = db.transaction(({stageId, claimToken, artifactId, nowMs}) => {
    const current = requireCurrentClaim(stageId, claimToken, nowMs);
    const artifact = getArtifact.get(artifactId);
    if (!artifact || artifact.stage_id !== stageId || artifact.attempt_id !== current.active_attempt_id) {
      throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Artifact is not owned by the current stage attempt');
    }
    clearAuthority.run(current.project_id, current.revision_id, artifact.kind);
    if (setAuthority.run(artifactId).changes !== 1) throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Artifact not found');
    return artifactFromRow(getArtifact.get(artifactId));
  });

  return Object.freeze({
    enqueue(record) {
      const createdAt = record.createdAt ?? nowIso(record.availableAtMs ?? Date.now());
      insertStage.run({
        ...record,
        revisionId: record.revisionId ?? null,
        logicalKey: record.logicalKey,
        maxAttempts: record.maxAttempts ?? defaultMaxAttempts,
        availableAtMs: record.availableAtMs ?? 0,
        createdAt,
        updatedAt: createdAt,
      });
      return stageFromRow(getStageRow.get(record.id));
    },
    startResearch(record) { return startResearchTx.immediate(record); },
    startGeneration(record) { return startGenerationTx.immediate(record); },
    claimNext(record) { return claimTx.immediate(record); },
    heartbeat(record) { return heartbeatTx.immediate(record); },
    updateProgress(record) { return progressTx.immediate(record); },
    complete(record) { return completeTx.immediate(record); },
    fail(record) { return failTx.immediate(record); },
    recoverExpired(record) { return recoverTx.immediate(record); },
    retry(record) { return retryTx.immediate(record); },
    cancel(record) { return cancelTx.immediate(record); },
    persistDraft(record) { return persistDraftTx.immediate(record); },
    commitResearch(record) { return commitResearchTx.immediate(record); },
    commitGeneration(record) { return commitGenerationTx.immediate(record); },
    registerArtifact(record) { return registerArtifactTx.immediate(record); },
    promoteArtifact(record) { return promoteArtifactTx.immediate(record); },
    getStage(stageId) { return stageFromRow(getStageRow.get(stageId)); },
    getCurrentStage(projectId) { return stageFromRow(getLatestProjectStageRow.get(projectId)); },
    listAttempts(stageId) { return listAttemptRows.all(stageId).map(attemptFromRow); },
    listArtifacts(stageId) { return listArtifactRows.all(stageId).map(artifactFromRow); },
  });
};
