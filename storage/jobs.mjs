import {AppError} from '../domain/errors.mjs';

const toIso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('INVALID_JOB_TIME', 'Job timestamp is invalid', {status: 500});
  }
  return date.toISOString();
};

const validateWorker = (workerId) => {
  if (typeof workerId !== 'string' || workerId.length === 0 || workerId.length > 256) {
    throw new AppError('INVALID_WORKER_ID', 'Worker ID is invalid', {status: 500});
  }
};

const validateLeaseMs = (leaseMs) => {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new AppError('INVALID_JOB_LEASE', 'Job lease duration is invalid', {status: 500});
  }
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

export function createJobStore(db) {
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const jobStats = db.prepare(`
    SELECT stage, status, COUNT(*) AS count
    FROM jobs
    GROUP BY stage, status
    ORDER BY stage, status
  `);
  const expireExhausted = db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        run_after = NULL,
        error_code = COALESCE(error_code, 'JOB_RETRY_EXHAUSTED'),
        error_message = COALESCE(error_message, 'Job lease expired after the final attempt'),
        updated_at = @now
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= @now
      AND attempt >= max_attempts
  `);
  const selectRunnable = db.prepare(`
    SELECT * FROM jobs
    WHERE attempt < max_attempts
      AND (
        (status = 'queued' AND (run_after IS NULL OR run_after <= @now))
        OR
        (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
      )
    ORDER BY
      CASE WHEN status = 'running' THEN 0 ELSE 1 END,
      COALESCE(run_after, lease_expires_at, created_at),
      created_at,
      id
    LIMIT 1
  `);
  const claimJob = db.prepare(`
    UPDATE jobs
    SET status = 'running',
        attempt = attempt + 1,
        lease_owner = @workerId,
        lease_expires_at = @leaseExpiresAt,
        run_after = NULL,
        error_code = NULL,
        error_message = NULL,
        updated_at = @now
    WHERE id = @id
  `);
  const heartbeatJob = db.prepare(`
    UPDATE jobs
    SET lease_expires_at = @leaseExpiresAt,
        updated_at = @now
    WHERE id = @id
      AND status = 'running'
      AND lease_owner = @workerId
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > @now
  `);
  const completeJob = db.prepare(`
    UPDATE jobs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_expires_at = NULL,
        run_after = NULL,
        error_code = NULL,
        error_message = NULL,
        updated_at = @now
    WHERE id = @id
      AND status = 'running'
      AND lease_owner = @workerId
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > @now
  `);
  const requeueJob = db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        run_after = @retryAt,
        error_code = @errorCode,
        error_message = @errorMessage,
        updated_at = @now
    WHERE id = @id
      AND status = 'running'
      AND lease_owner = @workerId
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > @now
  `);
  const failJob = db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        run_after = NULL,
        error_code = @errorCode,
        error_message = @errorMessage,
        updated_at = @now
    WHERE id = @id
      AND status = 'running'
      AND lease_owner = @workerId
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > @now
  `);

  const claimTransaction = db.transaction(({workerId, now, leaseMs}) => {
    const nowIso = toIso(now);
    expireExhausted.run({now: nowIso});
    const candidate = selectRunnable.get({now: nowIso});
    if (!candidate) return null;

    const leaseExpiresAt = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
    claimJob.run({id: candidate.id, workerId, leaseExpiresAt, now: nowIso});
    return mapJob(getJob.get(candidate.id));
  });

  const assertLiveLease = (jobId, workerId, now) => {
    const row = getJob.get(jobId);
    if (!row) throw new AppError('JOB_NOT_FOUND', 'Job was not found', {status: 404});
    const nowIso = toIso(now);
    if (row.status !== 'running'
      || row.lease_owner !== workerId
      || !row.lease_expires_at
      || row.lease_expires_at <= nowIso) {
      throw new AppError('JOB_LEASE_LOST', 'Job lease is no longer owned by this worker', {status: 409});
    }
    return {row, nowIso};
  };

  return Object.freeze({
    get(id) {
      return mapJob(getJob.get(id));
    },

    stats() {
      const byStage = new Map();
      for (const row of jobStats.all()) {
        const current = byStage.get(row.stage) || {stage: row.stage, queued: 0, active: 0, failed: 0};
        const count = Number(row.count) || 0;
        if (row.status === 'queued' || row.status === 'retry_wait') current.queued += count;
        else if (row.status === 'running') current.active += count;
        else if (row.status === 'failed') current.failed += count;
        byStage.set(row.stage, current);
      }
      return [...byStage.values()];
    },

    claimNext({workerId, now = new Date(), leaseMs = 30_000}) {
      validateWorker(workerId);
      validateLeaseMs(leaseMs);
      return claimTransaction.immediate({workerId, now, leaseMs});
    },

    heartbeat({jobId, workerId, now = new Date(), leaseMs = 30_000}) {
      validateWorker(workerId);
      validateLeaseMs(leaseMs);
      const nowIso = toIso(now);
      const leaseExpiresAt = new Date(new Date(nowIso).getTime() + leaseMs).toISOString();
      const result = heartbeatJob.run({id: jobId, workerId, leaseExpiresAt, now: nowIso});
      if (result.changes !== 1) {
        throw new AppError('JOB_LEASE_LOST', 'Job lease is no longer owned by this worker', {status: 409});
      }
      return mapJob(getJob.get(jobId));
    },

    complete({jobId, workerId, now = new Date()}) {
      validateWorker(workerId);
      const current = getJob.get(jobId);
      if (!current) throw new AppError('JOB_NOT_FOUND', 'Job was not found', {status: 404});
      if (current.status === 'succeeded') return mapJob(current);

      const nowIso = toIso(now);
      const result = completeJob.run({id: jobId, workerId, now: nowIso});
      if (result.changes !== 1) {
        throw new AppError('JOB_LEASE_LOST', 'Job lease is no longer owned by this worker', {status: 409});
      }
      return mapJob(getJob.get(jobId));
    },

    fail({
      jobId,
      workerId,
      now = new Date(),
      retryable,
      retryAt = null,
      errorCode = 'JOB_STAGE_FAILED',
      errorMessage = 'Job stage failed',
    }) {
      validateWorker(workerId);
      const {row, nowIso} = assertLiveLease(jobId, workerId, now);
      const shouldRetry = retryable === true && row.attempt < row.max_attempts;
      let result;

      if (shouldRetry) {
        if (!retryAt) {
          throw new AppError('JOB_RETRY_TIME_REQUIRED', 'Retryable failure requires a retry time', {status: 500});
        }
        result = requeueJob.run({
          id: jobId,
          workerId,
          retryAt: toIso(retryAt),
          errorCode,
          errorMessage,
          now: nowIso,
        });
      } else {
        result = failJob.run({id: jobId, workerId, errorCode, errorMessage, now: nowIso});
      }

      if (result.changes !== 1) {
        throw new AppError('JOB_LEASE_LOST', 'Job lease is no longer owned by this worker', {status: 409});
      }
      return mapJob(getJob.get(jobId));
    },
  });
}
