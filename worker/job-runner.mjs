import {setTimeout as delay} from 'node:timers/promises';
import {ErrorCodes} from '../domain/errors.mjs';

const safeErrorMessage = (error) => {
  const value = typeof error?.message === 'string' ? error.message : 'Stage handler failed';
  return value.slice(0, 2000);
};

export const createJobRunner = ({
  jobs,
  workerId,
  handlers,
  leaseMs,
  heartbeatMs = Math.max(250, Math.floor(leaseMs / 3)),
  now = Date.now,
}) => {
  if (!jobs || typeof jobs.claimNext !== 'function') throw new TypeError('jobs store is required');
  if (!workerId) throw new TypeError('workerId is required');
  if (!handlers || typeof handlers !== 'object') throw new TypeError('handlers map is required');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs) {
    throw new TypeError('heartbeatMs must be a positive integer below leaseMs');
  }

  const allowedTypes = Object.keys(handlers);
  let stopping = false;

  const runOnce = async () => {
    if (stopping || allowedTypes.length === 0) return false;
    const claimTime = now();
    jobs.recoverExpired({nowMs: claimTime});
    const claim = jobs.claimNext({workerId, nowMs: claimTime, allowedTypes});
    if (!claim) return false;

    let heartbeatError = null;
    const heartbeat = () => jobs.heartbeat({
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      nowMs: now(),
    });
    const timer = setInterval(() => {
      if (heartbeatError) return;
      try {
        heartbeat();
      } catch (error) {
        heartbeatError = error;
      }
    }, heartbeatMs);
    timer.unref?.();

    const context = Object.freeze({
      heartbeat,
      progress: (progress) => jobs.updateProgress({
        stageId: claim.stageId, claimToken: claim.claimToken, progress, nowMs: now(),
      }),
      persistDraft: (record) => jobs.persistDraft({
        ...record, stageId: claim.stageId, claimToken: claim.claimToken, nowMs: now(),
      }),
      registerArtifact: (record) => jobs.registerArtifact({
        ...record, stageId: claim.stageId, claimToken: claim.claimToken, nowMs: now(),
      }),
      promoteArtifact: (record) => jobs.promoteArtifact({
        ...record, stageId: claim.stageId, claimToken: claim.claimToken, nowMs: now(),
      }),
    });

    try {
      await handlers[claim.type](claim, context);
      if (heartbeatError) throw heartbeatError;
      jobs.complete({stageId: claim.stageId, claimToken: claim.claimToken, nowMs: now()});
    } catch (error) {
      if (error?.code !== ErrorCodes.STALE_CLAIM) {
        try {
          jobs.fail({
            stageId: claim.stageId,
            claimToken: claim.claimToken,
            nowMs: now(),
            retryable: Boolean(error?.retryable),
            errorCode: typeof error?.code === 'string' ? error.code : 'STAGE_HANDLER_FAILED',
            errorMessage: safeErrorMessage(error),
          });
        } catch (failureError) {
          if (failureError?.code !== ErrorCodes.STALE_CLAIM) throw failureError;
        }
      }
    } finally {
      clearInterval(timer);
    }
    return true;
  };

  const run = async ({pollMs = 250, signal} = {}) => {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) throw new TypeError('pollMs out of range');
    while (!stopping && !signal?.aborted) {
      const worked = await runOnce();
      if (!worked && !stopping && !signal?.aborted) {
        try {
          await delay(pollMs, undefined, {signal});
        } catch (error) {
          if (error?.name !== 'AbortError') throw error;
        }
      }
    }
  };

  return Object.freeze({
    runOnce,
    run,
    stop() {
      stopping = true;
    },
    get stopping() {
      return stopping;
    },
  });
};
