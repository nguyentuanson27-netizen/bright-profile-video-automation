export const ErrorCodes = Object.freeze({
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  FAILED_STAGE_NOT_RETRYABLE: 'FAILED_STAGE_NOT_RETRYABLE',
  DOWNSTREAM_WORK_STARTED: 'DOWNSTREAM_WORK_STARTED',
  INVALID_DOMAIN_DATA: 'INVALID_DOMAIN_DATA',
  UNKNOWN_SOURCE_REFERENCE: 'UNKNOWN_SOURCE_REFERENCE',
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
