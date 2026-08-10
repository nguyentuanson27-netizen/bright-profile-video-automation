import {createHash} from 'node:crypto';
import {AppError} from '../domain/errors.mjs';
import {assertProjectTransition} from '../domain/project.mjs';

const toIso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('INVALID_PROJECT_TIME', 'Project timestamp is invalid', {status: 500});
  }
  return date.toISOString();
};

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

const mapRevision = (row) => row ? {
  revisionId: row.revision_id,
  projectId: row.project_id,
  status: row.status,
  payload: JSON.parse(row.payload_json),
  payloadHash: row.payload_hash,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

export function createRevisionWorkflowStore(db) {
  const getProject = db.prepare('SELECT id, status FROM projects WHERE id = ?');
  const updateProject = db.prepare(`
    UPDATE projects SET status = @status, updated_at = @now
    WHERE id = @projectId AND status = @fromStatus
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, project_id, stage, status, attempt, max_attempts, run_after, created_at, updated_at
    ) VALUES (@id, @projectId, 'generating', 'queued', 0, @maxAttempts, NULL, @now, @now)
  `);
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const getRevision = db.prepare('SELECT * FROM revisions WHERE revision_id = ?');
  const approveRevision = db.prepare(`
    UPDATE revisions SET
      status = 'approved', payload_json = @payloadJson, payload_hash = @payloadHash,
      approved_at = @approvedAt, approved_by = @approvedBy, updated_at = @now
    WHERE revision_id = @revisionId AND project_id = @projectId AND status = 'draft'
  `);

  const enqueueGeneration = db.transaction(({projectId, jobId, maxAttempts, now}) => {
    const project = getProject.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
    assertProjectTransition(project.status, 'generating');
    if (updateProject.run({projectId, fromStatus: project.status, status: 'generating', now}).changes !== 1) {
      throw new AppError('PROJECT_STATE_CONFLICT', 'Project state changed concurrently', {status: 409});
    }
    insertJob.run({id: jobId, projectId, maxAttempts, now});
    return mapJob(getJob.get(jobId));
  });

  const approve = db.transaction(({projectId, revisionId, payload, approvedAt, approvedBy, now}) => {
    const project = getProject.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
    assertProjectTransition(project.status, 'approved');
    const revision = getRevision.get(revisionId);
    if (!revision || revision.project_id !== projectId) {
      throw new AppError('REVISION_NOT_FOUND', 'Revision was not found', {status: 404});
    }
    if (revision.status !== 'draft') {
      throw new AppError('APPROVED_REVISION_IMMUTABLE', 'Approved revision cannot be modified', {status: 409});
    }

    const payloadJson = JSON.stringify(payload);
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    if (approveRevision.run({projectId, revisionId, payloadJson, payloadHash, approvedAt, approvedBy, now}).changes !== 1) {
      throw new AppError('REVISION_APPROVAL_CONFLICT', 'Revision could not be approved', {status: 409});
    }
    if (updateProject.run({projectId, fromStatus: project.status, status: 'approved', now}).changes !== 1) {
      throw new AppError('PROJECT_STATE_CONFLICT', 'Project state changed concurrently', {status: 409});
    }
    return mapRevision(getRevision.get(revisionId));
  });

  return Object.freeze({
    enqueueGeneration({projectId, jobId, now = new Date(), maxAttempts = 3}) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new AppError('INVALID_JOB_ATTEMPTS', 'Job max attempts is invalid', {status: 500});
      }
      return enqueueGeneration.immediate({projectId, jobId, maxAttempts, now: toIso(now)});
    },

    approveRevision({projectId, revisionId, payload, approvedAt, approvedBy, now = new Date()}) {
      return approve.immediate({
        projectId,
        revisionId,
        payload,
        approvedAt: toIso(approvedAt),
        approvedBy,
        now: toIso(now),
      });
    },
  });
}
