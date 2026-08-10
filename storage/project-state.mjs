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

export function createProjectStateStore(db) {
  const getProject = db.prepare('SELECT id, status FROM projects WHERE id = ?');
  const updateStatus = db.prepare(`
    UPDATE projects
    SET status = @status, updated_at = @now
    WHERE id = @projectId AND status = @fromStatus
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, project_id, stage, status, attempt, max_attempts, run_after, created_at, updated_at
    ) VALUES (@id, @projectId, @stage, 'queued', 0, @maxAttempts, NULL, @now, @now)
  `);
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');

  const enqueueResearchTransaction = db.transaction(({projectId, jobId, maxAttempts, now}) => {
    const project = getProject.get(projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
    assertProjectTransition(project.status, 'researching');

    const changed = updateStatus.run({
      projectId,
      fromStatus: project.status,
      status: 'researching',
      now,
    });
    if (changed.changes !== 1) {
      throw new AppError('PROJECT_STATE_CONFLICT', 'Project state changed concurrently', {status: 409});
    }
    insertJob.run({
      id: jobId,
      projectId,
      stage: 'researching',
      maxAttempts,
      now,
    });
    return mapJob(getJob.get(jobId));
  });

  return Object.freeze({
    enqueueResearch({projectId, jobId, now = new Date(), maxAttempts = 3}) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new AppError('INVALID_JOB_ATTEMPTS', 'Job max attempts is invalid', {status: 500});
      }
      return enqueueResearchTransaction.immediate({
        projectId,
        jobId,
        maxAttempts,
        now: toIso(now),
      });
    },

    setStatus({projectId, status, now = new Date()}) {
      const project = getProject.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project was not found', {status: 404});
      assertProjectTransition(project.status, status);
      const result = updateStatus.run({
        projectId,
        fromStatus: project.status,
        status,
        now: toIso(now),
      });
      if (result.changes !== 1) {
        throw new AppError('PROJECT_STATE_CONFLICT', 'Project state changed concurrently', {status: 409});
      }
      return status;
    },
  });
}
