import {createHmac, timingSafeEqual} from 'node:crypto';
import {AppError, ErrorCodes} from '../domain/errors.mjs';

const DEFAULT_TTL_SECONDS = 900; // 15 minutes

const base64UrlEncode = (str) => Buffer.from(str).toString('base64url');
const base64UrlDecode = (str) => Buffer.from(str, 'base64url').toString('utf8');

const invalidTokenError = (message = 'Download token is invalid') =>
  new AppError(ErrorCodes.DOWNLOAD_TOKEN_INVALID, message, {status: 401});

const expiredTokenError = (message = 'Download token has expired') =>
  new AppError(ErrorCodes.DOWNLOAD_TOKEN_EXPIRED, message, {status: 401});

export const generateDownloadToken = ({
  projectId,
  revisionId,
  artifactId,
  secret,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  nowMs = Date.now(),
}) => {
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('projectId is required');
  if (typeof revisionId !== 'string' || !revisionId) throw new TypeError('revisionId is required');
  if (typeof artifactId !== 'string' || !artifactId) throw new TypeError('artifactId is required');
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('secret must be a string of at least 16 characters');
  }

  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payloadJson = JSON.stringify({
    p: projectId,
    r: revisionId,
    a: artifactId,
    exp,
  });

  const payloadB64 = base64UrlEncode(payloadJson);
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${signature}`;
};

export const verifyDownloadToken = ({
  token,
  secret,
  nowMs = Date.now(),
}) => {
  if (typeof token !== 'string' || !token) throw invalidTokenError();
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('secret must be a string of at least 16 characters');
  }

  const parts = token.split('.');
  if (parts.length !== 2) throw invalidTokenError('Malformed token format');

  const [payloadB64, providedSig] = parts;
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);

  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw invalidTokenError('Signature mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw invalidTokenError('Malformed payload');
  }

  if (typeof payload !== 'object' || !payload || typeof payload.exp !== 'number') {
    throw invalidTokenError('Missing expiration in payload');
  }

  const currentSec = Math.floor(nowMs / 1000);
  if (payload.exp < currentSec) {
    throw expiredTokenError();
  }

  if (typeof payload.p !== 'string' || typeof payload.r !== 'string' || typeof payload.a !== 'string') {
    throw invalidTokenError('Incomplete token claims');
  }

  return {
    projectId: payload.p,
    revisionId: payload.r,
    artifactId: payload.a,
    expiresAtSec: payload.exp,
  };
};