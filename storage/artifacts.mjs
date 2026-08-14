import {createHash, randomUUID} from 'node:crypto';

import {AppError, ErrorCodes} from '../domain/errors.mjs';

const staleClaimError = () => new AppError(ErrorCodes.STALE_CLAIM, 'Job claim is stale or lease has expired');
const transitionError = (message) => new AppError(ErrorCodes.INVALID_TRANSITION, message);

const nowIso = (nowMs) => new Date(nowMs).toISOString();

const assertNow = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('nowMs must be a non-negative safe integer');
};

const assertAttempts = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('nextMaxAttempts must be an integer between 1 and 100');
  }
};

export const assertRelativeArtifactPath = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('artifact relativePath must be a non-empty bounded string');
  }
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('\0')) {
    throw new TypeError('artifact relativePath must be a normalized relative path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new TypeError('artifact relativePath must not contain traversal segments');
  }
  return value;
};

const validateArtifactRecord = (record, expectedKind) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('artifact record is required');
  if (record.kind !== expectedKind) throw new TypeError(`artifact kind must be ${expectedKind}`);
  assertRelativeArtifactPath(record.relativePath);
  if (typeof record.mimeType !== 'string' || record.mimeType.length === 0 || record.mimeType.length > 200) {
    throw new TypeError('artifact mimeType is required');
  }
  if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 1) throw new TypeError('artifact byteSize must be positive');
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new TypeError('artifact sha256 must be a lowercase SHA-256 digest');
  }
  return record;
};

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

const stageIdFor = (projectId, revisionId, type) => {
  const digest = createHash('sha256').update(`${projectId}\0${revisionId}\0${type}`).digest('hex').slice(0, 32);
  return `stage-${type}-${digest}`;
};

export const createArtifactStore = (db, {idFactory = randomUUID} = {}) => {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('database is required');
  if (typeof idFactory !== 'function') throw new TypeError('idFactory is required');

  const currentClaim = db.prepare(`
    SELECT s.*, a.id AS active_attempt_id
    FROM stages s
    JOIN attempts a ON a.stage_id = s.id AND a.claim_token = ? AND a.status = 'running'
    WHERE s.id = ? AND s.state = 'running' AND s.current_claim_token = ?
      AND s.lease_expires_at_ms > ? AND a.lease_expires_at_ms > ?
  `);
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const getRevision = db.prepare('SELECT * FROM revisions WHERE id = ?');
  const getStage = db.prepare('SELECT * FROM stages WHERE id = ?');
  const getArtifact = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  const getAuthoritative = db.prepare(`
    SELECT * FROM artifacts
    WHERE project_id = ? AND revision_id = ? AND kind = ? AND is_authoritative = 1
    LIMIT 1
  `);
  const listRevisionArtifacts = db.prepare(`
    SELECT * FROM artifacts WHERE project_id = ? AND revision_id = ? ORDER BY created_at, id
  `);
  const insertArtifact = db.prepare(`
    INSERT INTO artifacts (
      id, project_id, revision_id, stage_id, attempt_id, kind, relative_path,
      mime_type, byte_size, sha256, is_authoritative, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const clearAuthority = db.prepare(`
    UPDATE artifacts SET is_authoritative = 0
    WHERE project_id = ? AND revision_id = ? AND kind = ? AND is_authoritative = 1
  `);
  const setAuthority = db.prepare('UPDATE artifacts SET is_authoritative = 1 WHERE id = ?');
  const finishAttempt = db.prepare(`
    UPDATE attempts
    SET status = 'succeeded', completed_at_ms = ?, error_code = NULL, error_message = NULL
    WHERE stage_id = ? AND claim_token = ? AND status = 'running'
  `);
  const finishStage = db.prepare(`
    UPDATE stages
    SET state = 'succeeded', retryable = 0, current_claim_token = NULL,
        lease_expires_at_ms = NULL, error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND state = 'running' AND current_claim_token = ?
  `);
  const insertStage = db.prepare(`
    INSERT INTO stages (
      id, logical_key, project_id, revision_id, stage_type, state, retryable,
      max_attempts, available_at_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `);
  const projectToTts = db.prepare(`
    UPDATE projects SET status = 'tts', failed_stage = NULL, failure_retryable = NULL,
      failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'media_ingest'
      AND current_revision_id = ? AND approved_revision_id = ?
  `);
  const projectToRenderQueued = db.prepare(`
    UPDATE projects SET status = 'render_queued', failed_stage = NULL, failure_retryable = NULL,
      failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'tts'
      AND current_revision_id = ? AND approved_revision_id = ?
  `);
  const projectToRendering = db.prepare(`
    UPDATE projects SET status = 'rendering', updated_at = ?
    WHERE id = ? AND status = 'render_queued'
      AND current_revision_id = ? AND approved_revision_id = ?
  `);
  const projectToCompleted = db.prepare(`
    UPDATE projects SET status = 'completed', failed_stage = NULL, failure_retryable = NULL,
      failure_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'rendering'
      AND current_revision_id = ? AND approved_revision_id = ?
  `);

  const requireClaim = (stageId, claimToken, nowMs, expectedType) => {
    assertNow(nowMs);
    const row = currentClaim.get(claimToken, stageId, claimToken, nowMs, nowMs);
    if (!row) throw staleClaimError();
    if (row.stage_type !== expectedType) throw transitionError(`Claim is not a ${expectedType} stage`);
    if (!row.revision_id) throw transitionError('Pipeline stage is missing its immutable revision');
    const project = getProject.get(row.project_id);
    const revision = getRevision.get(row.revision_id);
    if (!project || !revision || revision.project_id !== row.project_id || revision.approved_at === null) {
      throw transitionError('Pipeline stage requires an approved revision');
    }
    if (project.current_revision_id !== row.revision_id || project.approved_revision_id !== row.revision_id) {
      throw transitionError('Pipeline stage revision is no longer the current approved revision');
    }
    return {...row, project, revision};
  };

  const generatedId = () => {
    const value = idFactory();
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      throw new TypeError('idFactory must return a non-empty bounded string');
    }
    return value;
  };

  const addArtifact = (claim, record, expectedKind, timestamp, authoritative = false) => {
    validateArtifactRecord(record, expectedKind);
    const id = generatedId();
    insertArtifact.run(
      id,
      claim.project_id,
      claim.revision_id,
      claim.id,
      claim.active_attempt_id,
      expectedKind,
      record.relativePath,
      record.mimeType,
      record.byteSize,
      record.sha256,
      timestamp,
    );
    if (authoritative) {
      clearAuthority.run(claim.project_id, claim.revision_id, expectedKind);
      if (setAuthority.run(id).changes !== 1) throw transitionError('Artifact promotion failed');
    }
    return artifactFromRow(getArtifact.get(id));
  };

  const finishClaim = (claim, claimToken, nowMs, timestamp) => {
    if (finishAttempt.run(nowMs, claim.id, claimToken).changes !== 1) throw staleClaimError();
    if (finishStage.run(timestamp, claim.id, claimToken).changes !== 1) throw staleClaimError();
  };

  const createNextStage = (claim, type, maxAttempts, nowMs, timestamp) => {
    assertAttempts(maxAttempts);
    const id = stageIdFor(claim.project_id, claim.revision_id, type);
    const logicalKey = `${claim.project_id}:${claim.revision_id}:${type}`;
    insertStage.run(id, logicalKey, claim.project_id, claim.revision_id, type, maxAttempts, nowMs, timestamp, timestamp);
    return stageFromRow(getStage.get(id));
  };

  const commitMediaIngestTx = db.transaction((record) => {
    const claim = requireClaim(record.stageId, record.claimToken, record.nowMs, 'media_ingest');
    if (claim.project.status !== 'media_ingest') throw transitionError('Media ingest project state is no longer current');
    const timestamp = nowIso(record.nowMs);
    const mediaArtifacts = Array.isArray(record.mediaArtifacts) ? record.mediaArtifacts : [];
    for (const item of mediaArtifacts) addArtifact(claim, item, 'media_input', timestamp, false);
    const manifest = addArtifact(claim, record.manifestArtifact, 'media_manifest', timestamp, true);
    finishClaim(claim, record.claimToken, record.nowMs, timestamp);
    const nextStage = createNextStage(claim, 'tts', record.nextMaxAttempts, record.nowMs, timestamp);
    if (projectToTts.run(timestamp, claim.project_id, claim.revision_id, claim.revision_id).changes !== 1) {
      throw transitionError('Project state changed while committing media ingest');
    }
    return {artifact: manifest, nextStage};
  });

  const commitTtsTx = db.transaction((record) => {
    const claim = requireClaim(record.stageId, record.claimToken, record.nowMs, 'tts');
    if (claim.project.status !== 'tts') throw transitionError('TTS project state is no longer current');
    if (!getAuthoritative.get(claim.project_id, claim.revision_id, 'media_manifest')) {
      throw transitionError('TTS requires an authoritative media manifest');
    }
    const timestamp = nowIso(record.nowMs);
    const audio = addArtifact(claim, record.audioArtifact, 'tts_audio', timestamp, true);
    finishClaim(claim, record.claimToken, record.nowMs, timestamp);
    const nextStage = createNextStage(claim, 'render', record.nextMaxAttempts, record.nowMs, timestamp);
    if (projectToRenderQueued.run(timestamp, claim.project_id, claim.revision_id, claim.revision_id).changes !== 1) {
      throw transitionError('Project state changed while committing TTS');
    }
    return {artifact: audio, nextStage};
  });

  const markRenderingTx = db.transaction((record) => {
    const claim = requireClaim(record.stageId, record.claimToken, record.nowMs, 'render');
    if (claim.project.status === 'rendering') return true;
    if (claim.project.status !== 'render_queued') throw transitionError('Render is not queued for the current approved revision');
    if (!getAuthoritative.get(claim.project_id, claim.revision_id, 'media_manifest')) {
      throw transitionError('Render requires authoritative media');
    }
    if (!getAuthoritative.get(claim.project_id, claim.revision_id, 'tts_audio')) {
      throw transitionError('Render requires authoritative TTS audio');
    }
    if (projectToRendering.run(nowIso(record.nowMs), claim.project_id, claim.revision_id, claim.revision_id).changes !== 1) {
      throw transitionError('Project state changed before render execution');
    }
    return true;
  });

  const commitRenderTx = db.transaction((record) => {
    const claim = requireClaim(record.stageId, record.claimToken, record.nowMs, 'render');
    if (claim.project.status !== 'rendering') throw transitionError('Render project state is no longer current');
    const timestamp = nowIso(record.nowMs);
    const output = addArtifact(claim, record.outputArtifact, 'output_mp4', timestamp, true);
    finishClaim(claim, record.claimToken, record.nowMs, timestamp);
    if (projectToCompleted.run(timestamp, claim.project_id, claim.revision_id, claim.revision_id).changes !== 1) {
      throw transitionError('Project state changed while committing render output');
    }
    return {artifact: output};
  });

  return Object.freeze({
    commitMediaIngest(record) { return commitMediaIngestTx.immediate(record); },
    commitTts(record) { return commitTtsTx.immediate(record); },
    markRendering(record) { return markRenderingTx.immediate(record); },
    commitRender(record) { return commitRenderTx.immediate(record); },
    getAuthoritative(projectId, revisionId, kind) {
      return artifactFromRow(getAuthoritative.get(projectId, revisionId, kind));
    },
    listRevision(projectId, revisionId) {
      return listRevisionArtifacts.all(projectId, revisionId).map(artifactFromRow);
    },
  });
};
