import {timingSafeEqual} from 'node:crypto';
import {AppError} from '../domain/errors.mjs';

const SENSITIVE_KEY_PATTERNS = [
  /auth/i,
  /token/i,
  /secret/i,
  /key/i,
  /credential/i,
  /password/i,
];

export function extractBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function compareTokensConstantTime(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    // Perform dummy constant time comparison to avoid timing oracle on length
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function assertValidBearerToken(authHeader, expectedToken, {
  errorCode = 'UNAUTHORIZED',
  errorMessage = 'Unauthorized',
} = {}) {
  if (typeof expectedToken !== 'string' || expectedToken.trim().length === 0) {
    throw new AppError(
      'AUTH_NOT_CONFIGURED',
      'Authentication secret is not configured',
      {status: 500},
    );
  }

  const token = extractBearerToken(authHeader);
  if (!token || !compareTokensConstantTime(token, expectedToken.trim())) {
    throw new AppError(
      errorCode,
      errorMessage,
      {status: 401},
    );
  }
}

export function redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);

  const redacted = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive && typeof value === 'string') {
      redacted[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      redacted[key] = redactSecrets(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}