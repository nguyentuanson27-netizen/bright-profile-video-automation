import {isRetryableError, retryDelayMs} from '../domain/workflow.mjs';

const safeErrorCode = (error) => typeof error?.code === 'string' && error.code.length <= 128
  ? error.code
  : 'JOB_STAGE_FAILED';

const safeErrorMessage = (error) => String(error?.message || 'Job stage failed').slice(0, 2000);

export function createJobRunner({
  jobStore,
  workerId,
  handlers,
  leaseMs = 30_000,
  shouldStop = () => false,
  clock = () => new Date(),
  retryOptions,
}) {
  if (!jobStore || typeof jobStore.claimNext !== 'function') throw new TypeError('jobStore is required');
  if (!handlers || typeof handlers !== 'object') throw new TypeError('handlers are required');

  return Object.freeze({
    async runOnce() {
      if (shouldStop()) return null;

      const job = jobStore.claimNext({workerId, now: clock(), leaseMs});
      if (!job) return null;

      const handler = handlers[job.stage];
      if (typeof handler !== 'function') {
        return jobStore.fail({
          jobId: job.id,
          workerId,
          now: clock(),
          retryable: false,
          errorCode: 'JOB_HANDLER_NOT_FOUND',
          errorMessage: `No handler is registered for stage ${job.stage}`.slice(0, 2000),
        });
      }

      try {
        await handler({
          job,
          heartbeat: () => jobStore.heartbeat({jobId: job.id, workerId, now: clock(), leaseMs}),
        });
        return jobStore.complete({jobId: job.id, workerId, now: clock()});
      } catch (error) {
        const failedAt = clock();
        const retryable = isRetryableError(error);
        const delayMs = retryDelayMs(job.attempt, retryOptions);
        return jobStore.fail({
          jobId: job.id,
          workerId,
          now: failedAt,
          retryable,
          retryAt: retryable ? new Date(failedAt.getTime() + delayMs) : null,
          errorCode: safeErrorCode(error),
          errorMessage: safeErrorMessage(error),
        });
      }
    },
  });
}
