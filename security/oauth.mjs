import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {AppError} from '../domain/errors.mjs';

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

export function generatePkceChallenge(verifier) {
  const hash = createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

export function verifyPkce(verifier, challenge, method = 'S256') {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (method === 'plain') {
    return verifier === challenge;
  }
  if (method === 'S256') {
    const expected = generatePkceChallenge(verifier);
    if (expected.length !== challenge.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(challenge));
  }
  return false;
}

export function createOauthManager({
  issuer,
  secret,
  authCodeTtlSeconds = 300,
  tokenTtlSeconds = 3600,
  nowMs = Date.now,
} = {}) {
  const authCodes = new Map();

  return {
    getProtectedResourceMetadata(resource) {
      const res = resource || issuer;
      return {
        resource: res,
        authorization_servers: [res],
        scopes_supported: ['bright:profile:write', 'bright:profile:read'],
        bearer_methods_supported: ['header'],
        resource_documentation: `${res}/docs`,
      };
    },

    getAuthorizationServerMetadata(resource) {
      const iss = resource || issuer;
      return {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        registration_endpoint: `${iss}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: ['bright:profile:write', 'bright:profile:read'],
      };
    },

    createAuthorizationCode({
      clientId,
      redirectUri,
      scope = 'bright:profile:write bright:profile:read',
      codeChallenge,
      codeChallengeMethod = 'S256',
      userId = 'chatgpt_user',
    }) {
      if (!clientId) throw new AppError('INVALID_REQUEST', 'client_id is required', {status: 400});
      if (!redirectUri) throw new AppError('INVALID_REQUEST', 'redirect_uri is required', {status: 400});
      if (!codeChallenge) throw new AppError('INVALID_REQUEST', 'code_challenge is required for PKCE', {status: 400});
      if (codeChallengeMethod !== 'S256') {
        throw new AppError('INVALID_REQUEST', 'code_challenge_method must be S256', {status: 400});
      }

      const code = `ac_${randomBytes(24).toString('hex')}`;
      const expiresAt = nowMs() + (authCodeTtlSeconds * 1000);
      authCodes.set(code, {
        code,
        clientId,
        redirectUri,
        scope,
        codeChallenge,
        codeChallengeMethod,
        userId,
        expiresAt,
      });
      return code;
    },

    exchangeCodeForToken({
      code,
      clientId,
      redirectUri,
      codeVerifier,
    }) {
      if (!code) throw new AppError('INVALID_REQUEST', 'code is required', {status: 400});
      if (!codeVerifier) throw new AppError('INVALID_REQUEST', 'code_verifier is required', {status: 400});

      const entry = authCodes.get(code);
      if (!entry) {
        throw new AppError('INVALID_GRANT', 'Invalid or expired authorization code', {status: 400});
      }
      authCodes.delete(code);

      if (nowMs() > entry.expiresAt) {
        throw new AppError('INVALID_GRANT', 'Authorization code has expired', {status: 400});
      }
      if (clientId && entry.clientId !== clientId) {
        throw new AppError('INVALID_GRANT', 'client_id mismatch', {status: 400});
      }
      if (redirectUri && entry.redirectUri !== redirectUri) {
        throw new AppError('INVALID_GRANT', 'redirect_uri mismatch', {status: 400});
      }
      if (!verifyPkce(codeVerifier, entry.codeChallenge, entry.codeChallengeMethod)) {
        throw new AppError('INVALID_GRANT', 'PKCE verification failed', {status: 400});
      }

      const exp = Math.floor((nowMs() / 1000) + tokenTtlSeconds);
      const payload = {
        iss: issuer,
        aud: issuer,
        sub: entry.userId,
        scope: entry.scope,
        exp,
        iat: Math.floor(nowMs() / 1000),
        jti: randomUUID(),
      };

      const header = {alg: 'HS256', typ: 'JWT'};
      const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
      const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
      const signatureInput = `${encodedHeader}.${encodedPayload}`;
      const signature = createHmac('sha256', secret).update(signatureInput).digest();
      const encodedSignature = base64UrlEncode(signature);

      const accessToken = `${signatureInput}.${encodedSignature}`;

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: tokenTtlSeconds,
        scope: entry.scope,
      };
    },

    verifyAccessToken(token) {
      if (typeof token !== 'string' || !token) {
        throw new AppError('UNAUTHORIZED', 'Access token is required', {status: 401});
      }
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new AppError('UNAUTHORIZED', 'Malformed access token', {status: 401});
      }
      const [encodedHeader, encodedPayload, encodedSig] = parts;
      const signatureInput = `${encodedHeader}.${encodedPayload}`;
      const expectedSig = base64UrlEncode(createHmac('sha256', secret).update(signatureInput).digest());

      if (encodedSig.length !== expectedSig.length ||
          !timingSafeEqual(Buffer.from(encodedSig), Buffer.from(expectedSig))) {
        throw new AppError('UNAUTHORIZED', 'Invalid access token signature', {status: 401});
      }

      let payload;
      try {
        payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
      } catch {
        throw new AppError('UNAUTHORIZED', 'Malformed token payload', {status: 401});
      }

      const currentSec = Math.floor(nowMs() / 1000);
      if (payload.exp && currentSec > payload.exp) {
        throw new AppError('UNAUTHORIZED', 'Access token has expired', {status: 401});
      }

      return payload;
    },
  };
}
