export const ErrorCodes = Object.freeze({
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  FAILED_STAGE_NOT_RETRYABLE: 'FAILED_STAGE_NOT_RETRYABLE',
  DOWNSTREAM_WORK_STARTED: 'DOWNSTREAM_WORK_STARTED',
  INVALID_DOMAIN_DATA: 'INVALID_DOMAIN_DATA',
  UNKNOWN_SOURCE_REFERENCE: 'UNKNOWN_SOURCE_REFERENCE',
  APPROVAL_BLOCKED: 'APPROVAL_BLOCKED',
  STALE_CLAIM: 'STALE_CLAIM',
  STAGE_NOT_RETRYABLE: 'STAGE_NOT_RETRYABLE',
  STAGE_NOT_ACTIVE: 'STAGE_NOT_ACTIVE',
  FETCH_BLOCKED: 'FETCH_BLOCKED',
  FETCH_TIMEOUT: 'FETCH_TIMEOUT',
  FETCH_TOO_LARGE: 'FETCH_TOO_LARGE',
  FETCH_UNSUPPORTED_MEDIA_TYPE: 'FETCH_UNSUPPORTED_MEDIA_TYPE',
  FETCH_REDIRECT_LIMIT: 'FETCH_REDIRECT_LIMIT',
  FETCH_HTTP_STATUS: 'FETCH_HTTP_STATUS',
  FETCH_NETWORK_ERROR: 'FETCH_NETWORK_ERROR',
});

export class AppError extends Error {
  constructor(code, message, {status = 409, details = undefined} = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const invalidTransition = (from, to, details) => new AppError(
  ErrorCodes.INVALID_TRANSITION,
  `Project transition from ${from} to ${to} is not allowed`,
  {details},
);

export const invalidDomainData = (message, details) => new AppError(
  ErrorCodes.INVALID_DOMAIN_DATA,
  message,
  {status: 400, details},
);
