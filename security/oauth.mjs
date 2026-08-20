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
  canonicalResource,
  authCodeTtlSeconds = 300,
  tokenTtlSeconds = 3600,
  nowMs = Date.now,
} = {}) {
  const authCodes = new Map();
  const clients = new Map();
  const defaultIssuer = issuer || 'http://127.0.0.1:4190';
  const defaultResource = canonicalResource || `${defaultIssuer}/mcp`;

  return {
    registerClient(options = {}) {
      const clientName = options.client_name || options.clientName || 'ChatGPT MCP Client';
      const redirectUris = options.redirect_uris || options.redirectUris || [];
      const grantTypes = options.grant_types || options.grantTypes || ['authorization_code'];
      const responseTypes = options.response_types || options.responseTypes || ['code'];
      const tokenEndpointAuthMethod = options.token_endpoint_auth_method || options.tokenEndpointAuthMethod || 'none';
      const scope = options.scope || 'bright:profile:write bright:profile:read';

      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        throw new AppError('INVALID_REQUEST', 'redirect_uris must be a non-empty array of valid URLs', {status: 400});
      }
      for (const uri of redirectUris) {
        try {
          const parsed = new URL(uri);
          if (!['https:', 'http:'].includes(parsed.protocol)) {
            throw new Error('invalid protocol');
          }
        } catch {
          throw new AppError('INVALID_REQUEST', `Invalid redirect URI: ${uri}`, {status: 400});
        }
      }

      const clientId = `client_${randomUUID()}`;
      const clientRecord = {
        clientId,
        clientName,
        redirectUris: [...redirectUris],
        grantTypes,
        responseTypes,
        tokenEndpointAuthMethod,
        scope,
        createdAt: nowMs(),
      };
      clients.set(clientId, clientRecord);

      return {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: clientRecord.redirectUris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      };
    },

    getClient(clientId) {
      return clients.get(clientId) || null;
    },

    getProtectedResourceMetadata(mcpResourceUrl, issuerUrl) {
      const res = mcpResourceUrl || defaultResource;
      const iss = issuerUrl || defaultIssuer;
      return {
        resource: res,
        authorization_servers: [iss],
        scopes_supported: ['bright:profile:write', 'bright:profile:read'],
        bearer_methods_supported: ['header'],
        resource_documentation: `${iss}/docs`,
      };
    },

    getAuthorizationServerMetadata(issuerUrl) {
      const iss = issuerUrl || defaultIssuer;
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

    createAuthorizationCode(options = {}) {
      const user = options.user;
      if (!user || (!user.id && !user.sub)) {
        throw new AppError('UNAUTHORIZED', 'User authentication and consent are required to authorize client', {status: 401});
      }
      const userId = user.id || user.sub;

      const clientId = options.client_id || options.clientId;
      const redirectUri = options.redirect_uri || options.redirectUri;
      const scope = options.scope || 'bright:profile:write bright:profile:read';
      const codeChallenge = options.code_challenge || options.codeChallenge;
      const codeChallengeMethod = options.code_challenge_method || options.codeChallengeMethod || 'S256';
      const resource = options.resource || defaultResource;

      if (!clientId) throw new AppError('INVALID_REQUEST', 'client_id is required', {status: 400});
      if (!redirectUri) throw new AppError('INVALID_REQUEST', 'redirect_uri is required', {status: 400});

      const client = clients.get(clientId);
      if (!client) {
        throw new AppError('UNAUTHORIZED_CLIENT', `Client ${clientId} is not registered`, {status: 400});
      }

      if (!client.redirectUris.includes(redirectUri)) {
        throw new AppError('INVALID_REQUEST', `redirect_uri ${redirectUri} is not registered for client ${clientId}`, {status: 400});
      }

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
        user: {
          id: userId,
          name: user.name || userId,
          email: user.email || null,
        },
        issuer: options.issuer || defaultIssuer,
        resource,
        expiresAt,
      });
      return code;
    },

    exchangeCodeForToken(options = {}) {
      const code = options.code;
      const clientId = options.client_id || options.clientId;
      const redirectUri = options.redirect_uri || options.redirectUri;
      const codeVerifier = options.code_verifier || options.codeVerifier;
      const resource = options.resource;
      const issuer = options.issuer;

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

      const targetIssuer = issuer || entry.issuer || defaultIssuer;
      const targetResource = resource || entry.resource || defaultResource;
      const exp = Math.floor((nowMs() / 1000) + tokenTtlSeconds);
      const payload = {
        iss: targetIssuer,
        aud: targetResource,
        sub: entry.user.id,
        user: entry.user,
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

    verifyAccessToken(options = {}) {
      const token = typeof options === 'string' ? options : options.token;
      const expectedIssuer = options.expectedIssuer || options.expected_issuer;
      const expectedAudience = options.expectedAudience || options.expected_audience;

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

      const iss = expectedIssuer || defaultIssuer;
      if (payload.iss && payload.iss !== iss) {
        throw new AppError('UNAUTHORIZED', `Token issuer mismatch: expected ${iss}, got ${payload.iss}`, {status: 401});
      }

      const aud = expectedAudience || defaultResource;
      if (payload.aud && payload.aud !== aud && payload.aud !== iss) {
        throw new AppError('UNAUTHORIZED', `Token audience mismatch: expected ${aud}, got ${payload.aud}`, {status: 401});
      }

      const rawScopes = typeof payload.scope === 'string' ? payload.scope.trim().split(/\s+/) : [];
      return {
        ...payload,
        scopes: rawScopes,
        userId: payload.sub,
      };
    },
  };
}
