import {createHmac, timingSafeEqual} from 'node:crypto';
import {AppError, ErrorCodes} from '../domain/errors.mjs';

const DEFAULT_TTL_SECONDS = 900; // 15 minutes

const base64UrlEncode = (str) => Buffer.from(str).toString('base64url');
const base64UrlDecode = (str) => Buffer.from(str, 'base64url').toString('utf8');

const blockedError = (message = 'Delegated approval blocked: missing, invalid, or expired delegation grant') =>
  new AppError(ErrorCodes.DELEGATED_APPROVAL_BLOCKED, message, {status: 409});

export const issueDelegationGrant = ({
  projectId,
  revisionId,
  payloadHash,
  actor = 'user_session',
  sessionId,
  secret,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  nowMs = Date.now(),
}) => {
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('projectId is required');
  if (typeof revisionId !== 'string' || !revisionId) throw new TypeError('revisionId is required');
  if (typeof payloadHash !== 'string' || !payloadHash) throw new TypeError('payloadHash is required');
  if (typeof actor !== 'string' || !actor.trim()) throw new TypeError('actor must be a non-empty string');
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('secret must be a string of at least 16 characters');
  }

  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payloadJson = JSON.stringify({
    p: projectId,
    r: revisionId,
    h: payloadHash,
    a: actor.trim(),
    ...(sessionId ? {s: String(sessionId)} : {}),
    act: 'delegated_e2e',
    exp,
  });

  const payloadB64 = base64UrlEncode(payloadJson);
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${signature}`;
};

export const verifyDelegationGrant = ({
  grant,
  projectId,
  revisionId,
  payloadHash,
  secret,
  nowMs = Date.now(),
}) => {
  if (typeof grant !== 'string' || !grant) throw blockedError('Delegation grant is required for delegated_e2e mode');
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('secret must be a string of at least 16 characters');
  }

  const parts = grant.split('.');
  if (parts.length !== 2) throw blockedError('Malformed delegation grant token');

  const [payloadB64, providedSig] = parts;
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);

  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw blockedError('Delegation grant signature mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw blockedError('Malformed delegation grant payload');
  }

  if (typeof payload !== 'object' || !payload || typeof payload.exp !== 'number') {
    throw blockedError('Delegation grant missing expiration');
  }

  const currentSec = Math.floor(nowMs / 1000);
  if (payload.exp < currentSec) {
    throw blockedError('Delegation grant has expired');
  }

  if (typeof payload.a !== 'string' || !payload.a.trim()) {
    throw blockedError('Delegation grant missing actor context');
  }

  if (payload.act !== 'delegated_e2e') {
    throw blockedError('Delegation grant action is invalid');
  }

  if (payload.p !== projectId) {
    throw blockedError(`Delegation grant project mismatch: expected ${projectId}, got ${payload.p}`);
  }

  if (payload.r !== revisionId) {
    throw blockedError(`Delegation grant revision mismatch: expected ${revisionId}, got ${payload.r}`);
  }

  if (payload.h !== payloadHash) {
    throw blockedError('Delegation grant payload hash mismatch');
  }

  return {
    projectId: payload.p,
    revisionId: payload.r,
    payloadHash: payload.h,
    actor: payload.a,
    sessionId: payload.s,
    action: payload.act,
    expiresAtSec: payload.exp,
  };
};