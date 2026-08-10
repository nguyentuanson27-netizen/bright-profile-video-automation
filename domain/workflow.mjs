import {AppError} from './errors.mjs';

export const JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export function retryDelayMs(attempt, {baseMs = 1_000, maxMs = 60_000} = {}) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new AppError('INVALID_JOB_ATTEMPT', 'Job attempt must be a positive integer', {status: 500});
  }
  if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maxMs) || maxMs < baseMs) {
    throw new AppError('INVALID_RETRY_POLICY', 'Retry policy is invalid', {status: 500});
  }

  return Math.min(maxMs, baseMs * (2 ** Math.min(30, attempt - 1)));
}

export const isRetryableError = (error) => error?.retryable === true;
