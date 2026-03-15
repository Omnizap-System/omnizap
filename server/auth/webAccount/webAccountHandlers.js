import { scryptSync } from 'node:crypto';

const MY_PROFILE_DEFAULT_STATS = Object.freeze({
  total: 0,
  published: 0,
  drafts: 0,
  private: 0,
  unlisted: 0,
  public: 0,
});

const buildMyProfileStatsTemplate = () => ({ ...MY_PROFILE_DEFAULT_STATS });

const normalizeMyProfileView = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'summary') return 'summary';
  if (normalized === 'packs') return 'packs';
  return 'full';
};

const toUserPasswordStatePayload = (credential) => {
  if (!credential) {
    return {
      configured: false,
      failed_attempts: 0,
      last_failed_at: null,
      last_login_at: null,
      password_changed_at: null,
      revoked_at: null,
    };
  }

  return {
    configured: Boolean(credential.has_password && !credential.revoked_at),
    failed_attempts: Number(credential.failed_attempts || 0),
    last_failed_at: credential.last_failed_at || null,
    last_login_at: credential.last_login_at || null,
    password_changed_at: credential.password_changed_at || null,
    revoked_at: credential.revoked_at || null,
  };
};

const maskEmailForResponse = (value, { normalizeEmail }) => {
  const normalized = normalizeEmail(value);
  if (!normalized || !normalized.includes('@')) return null;
  const [localPart, domainPart] = normalized.split('@');
  if (!localPart || !domainPart) return null;
  const safeLocal = localPart.length <= 2 ? `${localPart.charAt(0) || '*'}*` : `${localPart.slice(0, 2)}***`;
  const domainSegments = domainPart.split('.');
  const domainHead = String(domainSegments.shift() || '');
  const safeDomainHead = domainHead.length <= 2 ? `${domainHead.charAt(0) || '*'}*` : `${domainHead.slice(0, 2)}***`;
  const suffix = domainSegments.length ? `.${domainSegments.join('.')}` : '';
  return `${safeLocal}@${safeDomainHead}${suffix}`;
};

const normalizePasswordRecoverySessionToken = (value) =>
  String(value || '')
    .trim()
    .slice(0, 4096);

const PASSWORD_RECOVERY_SESSION_HEADER_KEYS = Object.freeze(['x-password-recovery-session', 'x-recovery-session-token']);

const PASSWORD_RECOVERY_SESSION_BODY_KEYS = Object.freeze(['session_token', 'recovery_session_token', 'password_recovery_session']);

const PASSWORD_LOGIN_IDENTITY_HASH_NAMESPACE = 'web_user_password_login_identity';
const PASSWORD_LOGIN_IDENTITY_KDF_SALT = 'web_user_password_login_identity_salt_v1';
const PASSWORD_LOGIN_IDENTITY_KDF_OPTIONS = Object.freeze({
  N: 1 << 14,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

const hashPasswordLoginIdentityKey = (identityKey) => {
  const normalizedKey = String(identityKey || '').trim();
  if (!normalizedKey) return null;
  return scryptSync(`${PASSWORD_LOGIN_IDENTITY_HASH_NAMESPACE}|${normalizedKey}`, PASSWORD_LOGIN_IDENTITY_KDF_SALT, 32, PASSWORD_LOGIN_IDENTITY_KDF_OPTIONS);
};

const buildPasswordRecoverySessionPath = ({ userPasswordResetWebPath = '', userProfileWebPath = '' }) => {
  const safeResetPath = String(userPasswordResetWebPath || '').trim();
  if (safeResetPath) return safeResetPath;
  const safeProfilePath = String(userProfileWebPath || '').trim();
  if (!safeProfilePath) return '/';
  return safeProfilePath.endsWith('/') ? safeProfilePath : `${safeProfilePath}/`;
};

const resolvePasswordRecoverySessionTokenFromRequest = (req, payload = null) => {
  for (const key of PASSWORD_RECOVERY_SESSION_HEADER_KEYS) {
    const token = normalizePasswordRecoverySessionToken(req?.headers?.[key]);
    if (token) return token;
  }

  const authHeader = String(req?.headers?.authorization || '').trim();
  if (authHeader) {
    const [scheme = '', rawToken = ''] = authHeader.split(/\s+/, 2);
    if (scheme.toLowerCase() === 'bearer') {
      const normalizedBearerToken = normalizePasswordRecoverySessionToken(rawToken);
      if (normalizedBearerToken) return normalizedBearerToken;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  for (const key of PASSWORD_RECOVERY_SESSION_BODY_KEYS) {
    const token = normalizePasswordRecoverySessionToken(payload?.[key]);
    if (token) return token;
  }
  return '';
};

const toPasswordRecoverySessionExpiresAt = (claims) => {
  const expUnix = Number(claims?.exp || 0);
  if (!Number.isFinite(expUnix) || expUnix <= 0) return null;
  return new Date(expUnix * 1000).toISOString();
};

const toPasswordRecoverySessionExpiresIn = (claims) => {
  const expUnix = Number(claims?.exp || 0);
  if (!Number.isFinite(expUnix) || expUnix <= 0) return null;
  return Math.max(0, Math.floor(expUnix - Date.now() / 1000));
};

const signPasswordRecoverySessionToken = ({ sub = '', email = '', ownerJid = '' } = {}, { isWebAuthJwtEnabled, signWebAuthJwt, passwordRecoverySessionAuthMethod, passwordRecoverySessionTtlSeconds }) => {
  if (!isWebAuthJwtEnabled()) return '';
  return signWebAuthJwt(
    {
      sub,
      email,
      ownerJid,
      authMethod: passwordRecoverySessionAuthMethod,
    },
    {
      expiresInSeconds: passwordRecoverySessionTtlSeconds,
    },
  );
};

const resolvePasswordRecoverySessionClaims = (sessionToken, { isWebAuthJwtEnabled, verifyWebAuthJwt, passwordRecoverySessionAuthMethod, normalizeJid, normalizeEmail }) => {
  if (!isWebAuthJwtEnabled()) {
    return {
      ok: false,
      statusCode: 503,
      error: 'JWT de autenticacao nao configurado no servidor.',
      code: 'JWT_NOT_CONFIGURED',
    };
  }

  const normalizedSessionToken = normalizePasswordRecoverySessionToken(sessionToken);
  if (!normalizedSessionToken) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Sessao de redefinicao invalida.',
      code: 'PASSWORD_RECOVERY_SESSION_INVALID',
    };
  }

  const claims = verifyWebAuthJwt(normalizedSessionToken);
  if (!claims?.sub || claims.amr !== passwordRecoverySessionAuthMethod) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Sessao de redefinicao invalida ou expirada.',
      code: 'PASSWORD_RECOVERY_SESSION_EXPIRED',
    };
  }

  const normalizedOwnerJid = normalizeJid(claims.owner_jid || '');
  const normalizedEmail = normalizeEmail(claims.email || '');
  if (!normalizedOwnerJid || !normalizedEmail || !normalizedEmail.includes('@')) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Sessao de redefinicao invalida.',
      code: 'PASSWORD_RECOVERY_SESSION_INVALID',
    };
  }

  return {
    ok: true,
    claims,
    identity: {
      googleSub: claims.sub,
      email: normalizedEmail,
      ownerJid: normalizedOwnerJid,
      purpose: 'reset',
    },
  };
};

const toObjectDetailsIfAny = (error) => {
  if (Array.isArray(error?.details)) return error.details;
  if (error?.details && typeof error.details === 'object') return error.details;
  return undefined;
};

const isUnknownColumnError = (error, columnName = '') => {
  const code = String(error?.code || '').toUpperCase();
  const errno = Number(error?.errno || 0);
  if (code !== 'ER_BAD_FIELD_ERROR' && errno !== 1054) return false;
  if (!columnName) return true;
  const message = String(error?.message || '').toLowerCase();
  const normalizedColumn = String(columnName).trim().toLowerCase();
  if (!normalizedColumn) return true;
  return message.includes(`unknown column '${normalizedColumn}'`) || message.includes(`unknown column \`${normalizedColumn}\``);
};

const buildHttpError = (message, { statusCode = 400, code = 'BAD_REQUEST' } = {}) => {
  const error = new Error(String(message || 'Erro interno.'));
  error.statusCode = Number(statusCode) || 400;
  error.code = String(code || 'BAD_REQUEST');
  return error;
};

export const createWebAccountAuthHandlers = ({ sendJson, readJsonBody, logger, parseUserPasswordUpsertPayload, parseUserPasswordRecoveryRequestPayload, parseUserPasswordRecoveryVerifyPayload, parseUserPasswordLoginPayload, resolveGoogleWebSessionFromRequest, mapGoogleSessionResponseData, revokeGoogleWebSessionsByIdentity, createPersistedGoogleWebSessionFromIdentity, setGoogleWebSessionCookie, issueAccessTokenForSession, userPasswordAuthService, userPasswordRecoveryService, resolveRequestRemoteIp, normalizeEmail, normalizeGoogleSubject, normalizeJid, isWebAuthJwtEnabled, signWebAuthJwt, verifyWebAuthJwt, passwordRecoverySessionAuthMethod, passwordRecoverySessionTtlSeconds, userProfileWebPath, userPasswordResetWebPath, toSiteAbsoluteUrl, executeQuery, tables, toIsoOrNull, sanitizeText, listStickerPacksByOwner, listStickerPackEngagementByPackIds, mapPackSummary, isPackPubliclyVisible, resolveMyProfileOwnerCandidates, shouldHidePackFromMyProfileDefault, parseEnvBool, clampInt, stickerWebGoogleClientId, stickerWebGoogleAuthRequired, toWhatsAppPhoneDigits, getActiveSocket: _getActiveSocket, profilePictureUrlFromActiveSocket }) => {
  const passwordPolicy = typeof userPasswordAuthService?.getPolicy === 'function' ? userPasswordAuthService.getPolicy() : {};
  const passwordLoginIdentityMaxAttempts = clampInt(process.env.WEB_USER_PASSWORD_LOGIN_IDENTITY_MAX_ATTEMPTS, Number(passwordPolicy?.maxFailedAttempts || 8) || 8, 3, 100);
  const passwordLoginIdentityLockoutSeconds = clampInt(process.env.WEB_USER_PASSWORD_LOGIN_IDENTITY_LOCKOUT_SECONDS, Number(passwordPolicy?.lockoutSeconds || 900) || 900, 30, 86_400);
  const passwordLoginIdentityThrottleTable = String(tables.STICKER_WEB_USER_PASSWORD_LOGIN_THROTTLE || 'web_user_password_login_throttle').trim() || 'web_user_password_login_throttle';
  let passwordLoginIdentityPruneAt = 0;

  const buildPasswordLoginIdentityKey = ({ google_sub = '', email = '', owner_jid = '' } = {}) => {
    const normalizedSub = normalizeGoogleSubject(google_sub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOwnerJid = normalizeJid(owner_jid || '') || '';
    if (normalizedSub) return `sub:${normalizedSub}`;
    if (normalizedEmail) return `email:${normalizedEmail}`;
    if (normalizedOwnerJid) return `owner:${normalizedOwnerJid}`;
    return '';
  };

  const maybePrunePasswordLoginIdentityThrottle = async (nowMs = Date.now()) => {
    if (nowMs - passwordLoginIdentityPruneAt < 60 * 60 * 1000) return;
    passwordLoginIdentityPruneAt = nowMs;
    const staleAfterSeconds = Math.max(60 * 60, passwordLoginIdentityLockoutSeconds * 2);
    try {
      await executeQuery(
        `DELETE FROM ${passwordLoginIdentityThrottleTable}
          WHERE (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP())
            AND last_failed_at < (UTC_TIMESTAMP() - INTERVAL ${staleAfterSeconds} SECOND)`,
      );
    } catch (error) {
      logger?.warn?.('Falha ao limpar throttle distribuido de login por identidade.', {
        action: 'web_user_password_login_identity_prune_failed',
        error: error?.message,
      });
    }
  };

  const getPasswordLoginIdentityLockState = async (identityKey) => {
    const identityHash = hashPasswordLoginIdentityKey(identityKey);
    if (!identityHash) return { locked: false, retryAfterSeconds: 0 };
    await maybePrunePasswordLoginIdentityThrottle();

    try {
      const rows = await executeQuery(
        `SELECT locked_until
           FROM ${passwordLoginIdentityThrottleTable}
          WHERE identity_hash = ?
          LIMIT 1`,
        [identityHash],
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      const lockedUntilMs = Date.parse(String(row?.locked_until || ''));
      if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= Date.now()) {
        return { locked: false, retryAfterSeconds: 0 };
      }
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000)),
      };
    } catch (error) {
      logger?.warn?.('Falha ao consultar throttle distribuido de login por identidade.', {
        action: 'web_user_password_login_identity_lock_read_failed',
        error: error?.message,
      });
      return { locked: false, retryAfterSeconds: 0 };
    }
  };

  const registerPasswordLoginIdentityFailure = async (identityKey) => {
    const identityHash = hashPasswordLoginIdentityKey(identityKey);
    if (!identityHash) return { locked: false, retryAfterSeconds: 0 };
    await maybePrunePasswordLoginIdentityThrottle();

    try {
      await executeQuery(
        `INSERT INTO ${passwordLoginIdentityThrottleTable}
          (identity_hash, failed_attempts, last_failed_at, locked_until)
         VALUES (?, 1, UTC_TIMESTAMP(), NULL)
         ON DUPLICATE KEY UPDATE
          failed_attempts = IF(
            locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP(),
            failed_attempts,
            failed_attempts + 1
          ),
          last_failed_at = UTC_TIMESTAMP(),
          locked_until = IF(
            locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP(),
            locked_until,
            IF(
              failed_attempts + 1 >= ?,
              UTC_TIMESTAMP() + INTERVAL ? SECOND,
              NULL
            )
          ),
          updated_at = UTC_TIMESTAMP()`,
        [identityHash, passwordLoginIdentityMaxAttempts, passwordLoginIdentityLockoutSeconds],
      );

      const rows = await executeQuery(
        `SELECT locked_until
           FROM ${passwordLoginIdentityThrottleTable}
          WHERE identity_hash = ?
          LIMIT 1`,
        [identityHash],
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      const lockedUntilMs = Date.parse(String(row?.locked_until || ''));
      if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= Date.now()) {
        return { locked: false, retryAfterSeconds: 0 };
      }
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000)),
      };
    } catch (error) {
      logger?.warn?.('Falha ao registrar tentativa no throttle distribuido de login por identidade.', {
        action: 'web_user_password_login_identity_write_failed',
        error: error?.message,
      });
      return { locked: false, retryAfterSeconds: 0 };
    }
  };

  const clearPasswordLoginIdentityState = async (identityKey) => {
    const identityHash = hashPasswordLoginIdentityKey(identityKey);
    if (!identityHash) return;
    await executeQuery(
      `DELETE FROM ${passwordLoginIdentityThrottleTable}
        WHERE identity_hash = ?`,
      [identityHash],
    ).catch((error) => {
      logger?.warn?.('Falha ao limpar throttle distribuido de login por identidade.', {
        action: 'web_user_password_login_identity_clear_failed',
        error: error?.message,
      });
    });
  };

  const resolvePasswordLoginFailureIdentityKey = (payload, authResult) => {
    const credentialSub = normalizeGoogleSubject(authResult?.credential?.google_sub);
    if (credentialSub) return `sub:${credentialSub}`;
    return buildPasswordLoginIdentityKey(payload);
  };

  const sendPasswordLoginRateLimited = (req, res, retryAfterSeconds) => {
    const safeRetryAfterSeconds = Math.max(1, Number(retryAfterSeconds || 0) || 1);
    res.setHeader('Retry-After', String(safeRetryAfterSeconds));
    sendJson(req, res, 429, {
      error: 'Muitas tentativas de login. Aguarde alguns instantes para tentar novamente.',
      code: 'AUTH_RATE_LIMITED',
    });
  };

  const revokeSessionsByIdentityStrict = async ({ googleSub = '', email = '', ownerJid = '' } = {}, { reason = '' } = {}) => {
    if (typeof revokeGoogleWebSessionsByIdentity !== 'function') return 0;
    try {
      return await revokeGoogleWebSessionsByIdentity({
        googleSub,
        email,
        ownerJid,
      });
    } catch (error) {
      logger.warn('Falha ao revogar sessoes web durante rotacao de credencial.', {
        action: 'web_auth_session_revoke_failed',
        reason: reason || 'unknown',
        google_sub: normalizeGoogleSubject(googleSub),
        owner_jid: normalizeJid(ownerJid || '') || null,
        error: error?.message,
      });
      throw buildHttpError('Nao foi possivel revogar sessoes ativas da conta.', {
        statusCode: 503,
        code: 'SESSION_REVOKE_FAILED',
      });
    }
  };

  const isSessionRevokeFailure = (error) =>
    String(error?.code || '')
      .trim()
      .toUpperCase() === 'SESSION_REVOKE_FAILED';

  const createSessionPayloadFromCredential = async (req, res, credential, { reason = 'credential_update' } = {}) => {
    if (!credential?.google_sub || !credential?.owner_jid) {
      return mapGoogleSessionResponseData(null);
    }

    await revokeSessionsByIdentityStrict(
      {
        googleSub: credential.google_sub,
        email: credential.email || '',
        ownerJid: credential.owner_jid,
      },
      { reason },
    );

    const session = await createPersistedGoogleWebSessionFromIdentity({
      sub: credential.google_sub,
      email: credential.email || '',
      name: credential.name || '',
      picture: credential.picture || '',
      ownerJid: credential.owner_jid,
      requestMeta: {
        remoteIp: resolveRequestRemoteIp(req),
        userAgent: req.headers?.['user-agent'] || null,
      },
    });

    setGoogleWebSessionCookie(req, res, session.token);
    const accessToken = issueAccessTokenForSession(session);
    return mapGoogleSessionResponseData(session, { accessToken });
  };

  const handlePasswordAuthRequest = async (req, res) => {
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const googleSession = await resolveGoogleWebSessionFromRequest(req);
    if (!googleSession?.sub || !googleSession?.ownerJid) {
      sendJson(req, res, 401, { error: 'Sessao Google invalida ou expirada.' });
      return;
    }

    const identity = {
      googleSub: googleSession.sub,
      email: googleSession.email,
      ownerJid: googleSession.ownerJid,
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      const credential = await userPasswordAuthService.findCredentialByIdentity(identity, {
        includeRevoked: true,
      });
      sendJson(req, res, 200, {
        data: {
          session: mapGoogleSessionResponseData(googleSession),
          password: toUserPasswordStatePayload(credential),
        },
      });
      return;
    }

    if (req.method === 'DELETE') {
      const revoked = await userPasswordAuthService.revokePasswordForIdentity(identity);
      sendJson(req, res, 200, {
        data: {
          revoked: Boolean(revoked),
          session: mapGoogleSessionResponseData(googleSession),
          password: toUserPasswordStatePayload(revoked),
        },
      });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    try {
      payload = parseUserPasswordUpsertPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de senha invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const credential = await userPasswordAuthService.setPasswordForIdentity({
        ...identity,
        password: payload.password,
      });
      let sessionPayload = mapGoogleSessionResponseData(null);
      try {
        sessionPayload = await createSessionPayloadFromCredential(req, res, credential, {
          reason: 'password_upsert',
        });
      } catch (sessionError) {
        if (isSessionRevokeFailure(sessionError)) {
          throw sessionError;
        }
        logger.warn('Senha atualizada, mas falhou ao rotacionar sessao.', {
          action: 'web_password_upsert_session_rotation_failed',
          error: sessionError?.message,
          google_sub: credential?.google_sub || null,
        });
      }

      sendJson(req, res, 200, {
        data: {
          updated: true,
          session: sessionPayload,
          password: toUserPasswordStatePayload(credential),
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao salvar senha.',
        code: error?.code || 'PASSWORD_UPDATE_FAILED',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
    }
  };

  const handlePasswordRecoveryRequest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    try {
      payload = parseUserPasswordRecoveryRequestPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de recuperacao de senha invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const result = await userPasswordRecoveryService.requestPasswordRecoveryCode({
        googleSub: payload.google_sub,
        email: payload.email,
        ownerJid: payload.owner_jid,
        purpose: payload.purpose || 'reset',
        requestMeta: {
          remoteIp: resolveRequestRemoteIp(req),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      sendJson(req, res, 200, {
        data: {
          accepted: true,
          queued: Boolean(result?.queued),
          cooldown_active: Boolean(result?.cooldown_active),
          rate_limited: Boolean(result?.rate_limited),
          expires_in_seconds: Number(result?.expires_in_seconds || 0) || null,
          masked_email:
            result?.masked_email ||
            maskEmailForResponse(payload.email, {
              normalizeEmail,
            }) ||
            null,
        },
      });
    } catch (error) {
      const retryAfterSeconds = Math.max(0, Number(error?.details?.retry_after_seconds || 0));
      if (retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
      }
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao solicitar codigo de verificacao.',
        code: error?.code || 'PASSWORD_RECOVERY_REQUEST_FAILED',
        details: toObjectDetailsIfAny(error),
      });
    }
  };

  const handlePasswordRecoveryVerifyRequest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    try {
      payload = parseUserPasswordRecoveryVerifyPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de verificacao invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const recoveryResult = await userPasswordRecoveryService.verifyPasswordRecoveryCode({
        googleSub: payload.google_sub,
        email: payload.email,
        ownerJid: payload.owner_jid,
        purpose: payload.purpose || '',
        code: payload.code,
        password: payload.password,
        requestMeta: {
          remoteIp: resolveRequestRemoteIp(req),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      let sessionPayload = mapGoogleSessionResponseData(null);
      if (recoveryResult?.credential?.google_sub && recoveryResult?.credential?.owner_jid) {
        try {
          sessionPayload = await createSessionPayloadFromCredential(req, res, recoveryResult.credential, {
            reason: 'password_recovery_verify',
          });
        } catch (sessionError) {
          if (isSessionRevokeFailure(sessionError)) {
            throw sessionError;
          }
          logger.warn('Senha redefinida, mas sessao automatica nao foi criada.', {
            action: 'web_password_recovery_session_create_failed',
            error: sessionError?.message,
            google_sub: recoveryResult?.credential?.google_sub || null,
          });
        }
      }

      sendJson(req, res, 200, {
        data: {
          updated: true,
          auth_method: 'password_recovery',
          session: sessionPayload,
          password: toUserPasswordStatePayload(recoveryResult?.credential || null),
          masked_email:
            recoveryResult?.masked_email ||
            maskEmailForResponse(payload.email, {
              normalizeEmail,
            }) ||
            null,
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao validar codigo de verificacao.',
        code: error?.code || 'PASSWORD_RECOVERY_VERIFY_FAILED',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
    }
  };

  const handlePasswordRecoverySessionCreateRequest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const googleSession = await resolveGoogleWebSessionFromRequest(req);
    if (!googleSession?.sub || !googleSession?.ownerJid) {
      sendJson(req, res, 401, { error: 'Sessao Google invalida ou expirada.' });
      return;
    }

    const normalizedEmail = normalizeEmail(googleSession.email || '');
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      sendJson(req, res, 400, {
        error: 'Conta sem e-mail valido para recuperacao.',
        code: 'PASSWORD_RECOVERY_EMAIL_REQUIRED',
      });
      return;
    }

    const sessionToken = signPasswordRecoverySessionToken(
      {
        sub: googleSession.sub,
        email: normalizedEmail,
        ownerJid: googleSession.ownerJid,
      },
      {
        isWebAuthJwtEnabled,
        signWebAuthJwt,
        passwordRecoverySessionAuthMethod,
        passwordRecoverySessionTtlSeconds,
      },
    );

    if (!sessionToken) {
      sendJson(req, res, 503, {
        error: 'JWT de autenticacao nao configurado no servidor.',
        code: 'JWT_NOT_CONFIGURED',
      });
      return;
    }

    const claims = verifyWebAuthJwt(sessionToken);
    const sessionPath = buildPasswordRecoverySessionPath({
      userPasswordResetWebPath,
      userProfileWebPath,
    });
    const sessionUrl = toSiteAbsoluteUrl(sessionPath);

    sendJson(req, res, 200, {
      data: {
        created: true,
        purpose: 'reset',
        session_token: sessionToken,
        session_path: sessionPath,
        session_url: sessionUrl,
        session_path_legacy: null,
        session_url_legacy: null,
        masked_email: maskEmailForResponse(normalizedEmail, {
          normalizeEmail,
        }),
        expires_at: toPasswordRecoverySessionExpiresAt(claims),
        expires_in_seconds: toPasswordRecoverySessionExpiresIn(claims),
      },
    });
  };

  const handlePasswordRecoverySessionStatusRequest = async (req, res, { sessionToken = '' } = {}) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const resolvedSessionToken = normalizePasswordRecoverySessionToken(sessionToken) || resolvePasswordRecoverySessionTokenFromRequest(req);
    if (!resolvedSessionToken) {
      sendJson(req, res, 400, {
        error: 'Sessao de redefinicao invalida.',
        code: 'PASSWORD_RECOVERY_SESSION_INVALID',
      });
      return;
    }

    const resolvedSession = resolvePasswordRecoverySessionClaims(resolvedSessionToken, {
      isWebAuthJwtEnabled,
      verifyWebAuthJwt,
      passwordRecoverySessionAuthMethod,
      normalizeJid,
      normalizeEmail,
    });
    if (!resolvedSession.ok) {
      sendJson(req, res, resolvedSession.statusCode, {
        error: resolvedSession.error,
        code: resolvedSession.code,
      });
      return;
    }

    const credential = await userPasswordAuthService.findCredentialByIdentity(
      {
        googleSub: resolvedSession.identity.googleSub,
        email: resolvedSession.identity.email,
        ownerJid: resolvedSession.identity.ownerJid,
      },
      { includeRevoked: true },
    );

    sendJson(req, res, 200, {
      data: {
        valid: true,
        purpose: resolvedSession.identity.purpose,
        masked_email: maskEmailForResponse(resolvedSession.identity.email, {
          normalizeEmail,
        }),
        expires_at: toPasswordRecoverySessionExpiresAt(resolvedSession.claims),
        expires_in_seconds: toPasswordRecoverySessionExpiresIn(resolvedSession.claims),
        password: toUserPasswordStatePayload(credential),
      },
    });
  };

  const handlePasswordRecoverySessionRequest = async (req, res, { sessionToken = '' } = {}) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let resolvedSessionToken = normalizePasswordRecoverySessionToken(sessionToken) || resolvePasswordRecoverySessionTokenFromRequest(req);
    if (!resolvedSessionToken) {
      try {
        const payload = await readJsonBody(req);
        resolvedSessionToken = resolvePasswordRecoverySessionTokenFromRequest(req, payload);
      } catch (error) {
        sendJson(req, res, Number(error?.statusCode || 400), {
          error: error?.message || 'Body invalido.',
        });
        return;
      }
    }

    if (!resolvedSessionToken) {
      sendJson(req, res, 400, {
        error: 'Sessao de redefinicao invalida.',
        code: 'PASSWORD_RECOVERY_SESSION_INVALID',
      });
      return;
    }

    const resolvedSession = resolvePasswordRecoverySessionClaims(resolvedSessionToken, {
      isWebAuthJwtEnabled,
      verifyWebAuthJwt,
      passwordRecoverySessionAuthMethod,
      normalizeJid,
      normalizeEmail,
    });
    if (!resolvedSession.ok) {
      sendJson(req, res, resolvedSession.statusCode, {
        error: resolvedSession.error,
        code: resolvedSession.code,
      });
      return;
    }

    try {
      const result = await userPasswordRecoveryService.requestPasswordRecoveryCode({
        googleSub: resolvedSession.identity.googleSub,
        email: resolvedSession.identity.email,
        ownerJid: resolvedSession.identity.ownerJid,
        purpose: resolvedSession.identity.purpose,
        requestMeta: {
          remoteIp: resolveRequestRemoteIp(req),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      sendJson(req, res, 200, {
        data: {
          accepted: true,
          queued: Boolean(result?.queued),
          cooldown_active: Boolean(result?.cooldown_active),
          rate_limited: Boolean(result?.rate_limited),
          expires_in_seconds: Number(result?.expires_in_seconds || 0) || null,
          masked_email:
            result?.masked_email ||
            maskEmailForResponse(resolvedSession.identity.email, {
              normalizeEmail,
            }) ||
            null,
        },
      });
    } catch (error) {
      const retryAfterSeconds = Math.max(0, Number(error?.details?.retry_after_seconds || 0));
      if (retryAfterSeconds > 0) {
        res.setHeader('Retry-After', String(retryAfterSeconds));
      }
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao solicitar codigo de verificacao.',
        code: error?.code || 'PASSWORD_RECOVERY_REQUEST_FAILED',
        details: toObjectDetailsIfAny(error),
      });
    }
  };

  const handlePasswordRecoverySessionVerifyRequest = async (req, res, { sessionToken = '' } = {}) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    const resolvedSessionToken = normalizePasswordRecoverySessionToken(sessionToken) || resolvePasswordRecoverySessionTokenFromRequest(req, payload);
    if (!resolvedSessionToken) {
      sendJson(req, res, 400, {
        error: 'Sessao de redefinicao invalida.',
        code: 'PASSWORD_RECOVERY_SESSION_INVALID',
      });
      return;
    }

    const resolvedSession = resolvePasswordRecoverySessionClaims(resolvedSessionToken, {
      isWebAuthJwtEnabled,
      verifyWebAuthJwt,
      passwordRecoverySessionAuthMethod,
      normalizeJid,
      normalizeEmail,
    });
    if (!resolvedSession.ok) {
      sendJson(req, res, resolvedSession.statusCode, {
        error: resolvedSession.error,
        code: resolvedSession.code,
      });
      return;
    }

    try {
      payload = parseUserPasswordRecoveryVerifyPayload({
        ...payload,
        google_sub: resolvedSession.identity.googleSub,
        email: resolvedSession.identity.email,
        owner_jid: resolvedSession.identity.ownerJid,
        purpose: resolvedSession.identity.purpose,
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de verificacao invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const recoveryResult = await userPasswordRecoveryService.verifyPasswordRecoveryCode({
        googleSub: payload.google_sub,
        email: payload.email,
        ownerJid: payload.owner_jid,
        purpose: payload.purpose || '',
        code: payload.code,
        password: payload.password,
        requestMeta: {
          remoteIp: resolveRequestRemoteIp(req),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      let sessionPayload = mapGoogleSessionResponseData(null);
      if (recoveryResult?.credential?.google_sub && recoveryResult?.credential?.owner_jid) {
        try {
          sessionPayload = await createSessionPayloadFromCredential(req, res, recoveryResult.credential, {
            reason: 'password_recovery_session_verify',
          });
        } catch (sessionError) {
          if (isSessionRevokeFailure(sessionError)) {
            throw sessionError;
          }
          logger.warn('Senha redefinida por sessao, mas login automatico nao foi criado.', {
            action: 'web_password_recovery_session_login_create_failed',
            error: sessionError?.message,
            google_sub: recoveryResult?.credential?.google_sub || null,
          });
        }
      }

      sendJson(req, res, 200, {
        data: {
          updated: true,
          auth_method: 'password_recovery_session',
          session: sessionPayload,
          password: toUserPasswordStatePayload(recoveryResult?.credential || null),
          masked_email:
            recoveryResult?.masked_email ||
            maskEmailForResponse(payload.email, {
              normalizeEmail,
            }) ||
            null,
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao validar codigo de verificacao.',
        code: error?.code || 'PASSWORD_RECOVERY_VERIFY_FAILED',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
    }
  };

  const handlePasswordLoginRequest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    try {
      payload = parseUserPasswordLoginPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de login por senha invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    const loginIdentityKey = buildPasswordLoginIdentityKey(payload);
    const localLockState = await getPasswordLoginIdentityLockState(loginIdentityKey);
    if (localLockState.locked) {
      sendPasswordLoginRateLimited(req, res, localLockState.retryAfterSeconds);
      return;
    }

    const authResult = await userPasswordAuthService.verifyPasswordForIdentity({
      googleSub: payload.google_sub,
      email: payload.email,
      ownerJid: payload.owner_jid,
      password: payload.password,
    });

    if (!authResult?.authenticated || !authResult?.credential?.google_sub || !authResult?.credential?.owner_jid) {
      const failedIdentityKey = resolvePasswordLoginFailureIdentityKey(payload, authResult);
      const failedLockState = await registerPasswordLoginIdentityFailure(failedIdentityKey);
      const retryAfterSeconds = Math.max(Number(authResult?.retryAfterSeconds || 0), Number(failedLockState.retryAfterSeconds || 0));
      if (retryAfterSeconds > 0) {
        sendPasswordLoginRateLimited(req, res, retryAfterSeconds);
        return;
      }
      sendJson(req, res, 401, {
        error: 'Credenciais invalidas.',
        code: 'INVALID_CREDENTIALS',
      });
      return;
    }

    try {
      const credential = authResult.credential;
      await clearPasswordLoginIdentityState(loginIdentityKey);
      const credentialSubKey = normalizeGoogleSubject(credential.google_sub);
      if (credentialSubKey) {
        await clearPasswordLoginIdentityState(`sub:${credentialSubKey}`);
      }
      const session = await createPersistedGoogleWebSessionFromIdentity({
        sub: credential.google_sub,
        email: credential.email || '',
        name: credential.name || '',
        picture: credential.picture || '',
        ownerJid: credential.owner_jid,
        requestMeta: {
          remoteIp: resolveRequestRemoteIp(req),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      setGoogleWebSessionCookie(req, res, session.token);
      const accessToken = issueAccessTokenForSession(session);
      sendJson(req, res, 200, {
        data: {
          auth_method: 'password',
          session: mapGoogleSessionResponseData(session, { accessToken }),
          password: toUserPasswordStatePayload(credential),
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 500), {
        error: error?.message || 'Falha ao finalizar login por senha.',
        code: error?.code || 'PASSWORD_LOGIN_FAILED',
      });
    }
  };

  const resolveMyProfileAccountSummary = async (session) => {
    if (!session) return null;

    const planLabel = sanitizeText(process.env.STICKER_WEB_USER_PLAN_LABEL || '', 80, { allowEmpty: true }) || 'Conta padrao';
    const normalizedSub = normalizeGoogleSubject(session?.sub);
    const normalizedEmail = normalizeEmail(session?.email);
    const normalizedOwnerJid = normalizeJid(session?.ownerJid || '') || '';
    const identityClauses = [];
    const identityParams = [];

    if (normalizedSub) {
      identityClauses.push('google_sub = ?');
      identityParams.push(normalizedSub);
    }
    if (normalizedEmail) {
      identityClauses.push('email = ?');
      identityParams.push(normalizedEmail);
    }
    if (normalizedOwnerJid) {
      identityClauses.push('owner_jid = ?');
      identityParams.push(normalizedOwnerJid);
    }

    let lastLoginAt = null;
    let lastSeenAt = null;
    let dbOwnerJid = null;
    let dbPicture = null;

    if (identityClauses.length) {
      try {
        let rows = null;
        try {
          rows = await executeQuery('SELECT last_login_at, last_seen_at, owner_jid, picture_url AS picture FROM ' + tables.STICKER_WEB_GOOGLE_USER + ' WHERE ' + identityClauses.join(' OR ') + ' ORDER BY COALESCE(last_login_at, last_seen_at, updated_at, created_at) DESC LIMIT 1', identityParams);
        } catch (error) {
          if (!isUnknownColumnError(error, 'picture_url')) throw error;
          rows = await executeQuery('SELECT last_login_at, last_seen_at, owner_jid, picture FROM ' + tables.STICKER_WEB_GOOGLE_USER + ' WHERE ' + identityClauses.join(' OR ') + ' ORDER BY COALESCE(last_login_at, last_seen_at, updated_at, created_at) DESC LIMIT 1', identityParams);
        }
        const entry = Array.isArray(rows) ? rows[0] : null;
        lastLoginAt = toIsoOrNull(entry?.last_login_at);
        lastSeenAt = toIsoOrNull(entry?.last_seen_at);
        dbOwnerJid = normalizeJid(entry?.owner_jid);
        dbPicture = entry?.picture;
      } catch (error) {
        logger.warn('Falha ao resolver resumo de conta do perfil web.', { error: error?.message });
      }
    }

    const effectiveOwnerJid = normalizedOwnerJid || dbOwnerJid;
    let rpg = null;
    const usage = { messages: 0, packs: 0, stickers: 0, activity_chart: [], insights: {} };

    if (effectiveOwnerJid) {
      try {
        // Basic RPG Info
        const rpgRows = await executeQuery('SELECT level, xp, gold, created_at, updated_at FROM ' + tables.RPG_PLAYER + ' WHERE jid = ? LIMIT 1', [effectiveOwnerJid]);
        const rpgRow = rpgRows?.[0];

        if (rpgRow) {
          const activePokemonRows = await executeQuery('SELECT poke_id, nickname, level, is_shiny FROM ' + tables.RPG_PLAYER_POKEMON + ' WHERE owner_jid = ? AND is_active = 1 LIMIT 1', [effectiveOwnerJid]);
          const pokemonCountRows = await executeQuery('SELECT COUNT(*) as total FROM ' + tables.RPG_PLAYER_POKEMON + ' WHERE owner_jid = ?', [effectiveOwnerJid]);
          const pvpStatsRows = await executeQuery('SELECT COALESCE(SUM(matches_played), 0) AS matches_played, COALESCE(SUM(wins), 0) AS wins, COALESCE(SUM(losses), 0) AS losses FROM ' + tables.RPG_PVP_WEEKLY_STATS + ' WHERE owner_jid = ?', [effectiveOwnerJid]);
          const karmaRows = await executeQuery('SELECT karma_score, positive_votes, negative_votes FROM ' + tables.RPG_KARMA_PROFILE + ' WHERE owner_jid = ? LIMIT 1', [effectiveOwnerJid]);
          const inventoryRows = await executeQuery('SELECT COUNT(*) as total FROM ' + tables.RPG_PLAYER_INVENTORY + ' WHERE owner_jid = ?', [effectiveOwnerJid]);

          const karmaRow = karmaRows?.[0];
          const pvpRow = pvpStatsRows?.[0];

          rpg = {
            level: Number(rpgRow.level || 1),
            xp: Number(rpgRow.xp || 0),
            gold: Number(rpgRow.gold || 0),
            member_since: toIsoOrNull(rpgRow.created_at),
            active_pokemon: activePokemonRows?.[0] || null,
            total_pokemons: Number(pokemonCountRows?.[0]?.total || 0),
            inventory_count: Number(inventoryRows?.[0]?.total || 0),
            karma: karmaRow
              ? {
                  score: Number(karmaRow.karma_score),
                  positive: Number(karmaRow.positive_votes),
                  negative: Number(karmaRow.negative_votes),
                }
              : { score: 0, positive: 0, negative: 0 },
            pvp: {
              matches: Number(pvpRow?.matches_played || 0),
              wins: Number(pvpRow?.wins || 0),
              losses: Number(pvpRow?.losses || 0),
            },
          };
          const rpgLastSeen = toIsoOrNull(rpgRow.updated_at);
          if (rpgLastSeen && (!lastSeenAt || new Date(rpgLastSeen) > new Date(lastSeenAt))) {
            lastSeenAt = rpgLastSeen;
          }
        }

        // Usage Stats
        const msgStatsRows = await executeQuery('SELECT COUNT(*) as total, MIN(timestamp) as first_msg, MAX(timestamp) as last_msg FROM ' + tables.MESSAGES + ' WHERE canonical_sender_id = ? OR sender_id = ?', [effectiveOwnerJid, effectiveOwnerJid]);
        const msgStats = msgStatsRows?.[0];
        usage.messages = Number(msgStats?.total || 0);
        usage.first_message_at = toIsoOrNull(msgStats?.first_msg);
        usage.last_message_at = toIsoOrNull(msgStats?.last_msg);

        const commandStatsRows = await executeQuery('SELECT COUNT(*) as total FROM ' + tables.MESSAGES + " WHERE (canonical_sender_id = ? OR sender_id = ?) AND content LIKE '/%'", [effectiveOwnerJid, effectiveOwnerJid]);

        const topCommandRows = await executeQuery("SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(content, ' ', 1), '\\n', 1) as cmd, COUNT(*) as total FROM " + tables.MESSAGES + " WHERE (canonical_sender_id = ? OR sender_id = ?) AND content LIKE '/%' GROUP BY cmd ORDER BY total DESC LIMIT 1", [effectiveOwnerJid, effectiveOwnerJid]);

        const typeSql = "(CASE WHEN JSON_EXTRACT(raw_message, '$.message.conversation') IS NOT NULL THEN 'texto' WHEN JSON_EXTRACT(raw_message, '$.message.extendedTextMessage') IS NOT NULL THEN 'texto' WHEN JSON_EXTRACT(raw_message, '$.message.imageMessage') IS NOT NULL THEN 'imagem' WHEN JSON_EXTRACT(raw_message, '$.message.videoMessage') IS NOT NULL THEN 'video' WHEN JSON_EXTRACT(raw_message, '$.message.audioMessage') IS NOT NULL THEN 'audio' WHEN JSON_EXTRACT(raw_message, '$.message.stickerMessage') IS NOT NULL THEN 'figurinha' WHEN JSON_EXTRACT(raw_message, '$.message.documentMessage') IS NOT NULL THEN 'documento' WHEN JSON_EXTRACT(raw_message, '$.message.reactionMessage') IS NOT NULL THEN 'reacao' ELSE 'outros' END)";
        const topTypeRows = await executeQuery('SELECT ' + typeSql + ' as type, COUNT(*) as total FROM ' + tables.MESSAGES + ' WHERE canonical_sender_id = ? OR sender_id = ? GROUP BY type ORDER BY total DESC LIMIT 1', [effectiveOwnerJid, effectiveOwnerJid]);

        const groupsCountRows = await executeQuery('SELECT COUNT(DISTINCT chat_id) as total FROM ' + tables.MESSAGES + " WHERE (canonical_sender_id = ? OR sender_id = ?) AND chat_id LIKE '%@g.us'", [effectiveOwnerJid, effectiveOwnerJid]);

        const topGroupRows = await executeQuery('SELECT m.chat_id, COALESCE(gm.subject, m.chat_id) as name, COUNT(*) as total FROM ' + tables.MESSAGES + ' m LEFT JOIN ' + tables.GROUPS_METADATA + " gm ON gm.id = m.chat_id WHERE (m.canonical_sender_id = ? OR m.sender_id = ?) AND m.chat_id LIKE '%@g.us' GROUP BY m.chat_id, gm.subject ORDER BY total DESC LIMIT 1", [effectiveOwnerJid, effectiveOwnerJid]);

        const activeHourRows = await executeQuery('SELECT HOUR(timestamp) as hour, COUNT(*) as total FROM ' + tables.MESSAGES + ' WHERE canonical_sender_id = ? OR sender_id = ? GROUP BY hour ORDER BY total DESC LIMIT 1', [effectiveOwnerJid, effectiveOwnerJid]);

        const chartRows = await executeQuery('SELECT DATE(timestamp) as day, COUNT(*) as count FROM ' + tables.MESSAGES + ' WHERE (canonical_sender_id = ? OR sender_id = ?) AND timestamp >= NOW() - INTERVAL 7 DAY GROUP BY DATE(timestamp) ORDER BY day ASC', [effectiveOwnerJid, effectiveOwnerJid]);

        let avgDaily = 0;
        if (usage.messages > 0 && usage.first_message_at) {
          const daysDiff = Math.max(1, (Date.now() - new Date(usage.first_message_at).getTime()) / (1000 * 60 * 60 * 24));
          avgDaily = (usage.messages / daysDiff).toFixed(2);
        }

        usage.insights = {
          commands_total: Number(commandStatsRows?.[0]?.total || 0),
          top_command: topCommandRows?.[0]?.cmd || 'N/D',
          top_command_count: Number(topCommandRows?.[0]?.total || 0),
          top_message_type: topTypeRows?.[0]?.type || 'texto',
          groups_active: Number(groupsCountRows?.[0]?.total || 0),
          top_group: topGroupRows?.[0]?.name || 'N/D',
          active_hour: activeHourRows?.[0]?.hour ?? null,
          avg_daily: avgDaily,
        };

        usage.activity_chart = (chartRows || []).map((r) => ({
          day: r.day instanceof Date ? r.day.toISOString().slice(5, 10) : String(r.day).slice(5, 10),
          count: Number(r.count),
        }));
      } catch (error) {
        logger.warn('Falha ao buscar estatisticas expandidas do usuario.', { owner_jid: effectiveOwnerJid, error: error?.message });
      }
    }

    if (effectiveOwnerJid) {
      const packRows = await executeQuery('SELECT COUNT(DISTINCT p.id) AS packs, COUNT(i.sticker_id) AS stickers FROM ' + tables.STICKER_PACK + ' p LEFT JOIN ' + tables.STICKER_PACK_ITEM + ' i ON i.pack_id = p.id WHERE p.owner_jid = ? AND p.deleted_at IS NULL', [effectiveOwnerJid]);
      usage.packs = Number(packRows?.[0]?.packs || 0);
      usage.stickers = Number(packRows?.[0]?.stickers || 0);
    }

    // Resolve Profile Picture
    let picture = dbPicture || session?.user?.picture;
    const isGeneric = !picture || picture.includes('brand-logo');

    if (effectiveOwnerJid && isGeneric) {
      try {
        const waPicture = await profilePictureUrlFromActiveSocket(effectiveOwnerJid, 'image', 3000);
        if (waPicture) {
          picture = waPicture;
        }
      } catch {
        logger.debug('Falha ao buscar foto de perfil do WhatsApp.', { jid: effectiveOwnerJid });
      }
    }

    return {
      plan_label: planLabel,
      status: 'active',
      last_login_at: lastLoginAt,
      last_seen_at: lastSeenAt,
      rpg,
      usage,
      owner_phone: toWhatsAppPhoneDigits(effectiveOwnerJid),
      picture: picture || null,
    };
  };

  const handleMyProfileRequest = async (req, res, url = null) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const session = await resolveGoogleWebSessionFromRequest(req);
    const authGoogle = {
      enabled: Boolean(stickerWebGoogleClientId),
      required: Boolean(stickerWebGoogleAuthRequired),
      client_id: stickerWebGoogleClientId || null,
    };
    const sessionIdentity = {
      googleSub: normalizeGoogleSubject(session?.sub),
      email: normalizeEmail(session?.email),
      ownerJid: normalizeJid(session?.ownerJid || ''),
    };
    const credential = sessionIdentity.googleSub || sessionIdentity.email || sessionIdentity.ownerJid ? await userPasswordAuthService.findCredentialByIdentity(sessionIdentity, { includeRevoked: true }).catch(() => null) : null;
    const passwordState = toUserPasswordStatePayload(credential);
    const view = normalizeMyProfileView(url?.searchParams?.get('view'));
    const shouldIncludePacks = view !== 'summary';

    if (!session?.ownerJid && !session?.email && !session?.ownerPhone) {
      sendJson(req, res, 200, {
        data: {
          auth: { google: authGoogle },
          session: mapGoogleSessionResponseData(null),
          owner_jid: null,
          owner_jids: [],
          account: null,
          password: passwordState,
          packs: [],
          stats: shouldIncludePacks ? buildMyProfileStatsTemplate() : null,
          meta: {
            view,
            lazy: !shouldIncludePacks,
          },
        },
      });
      return;
    }

    const account = await resolveMyProfileAccountSummary(session);
    const ownerCandidates = await resolveMyProfileOwnerCandidates(session);
    const primaryOwnerJid = normalizeJid(session?.ownerJid || '') || ownerCandidates[0] || null;

    if (!ownerCandidates.length) {
      sendJson(req, res, 200, {
        data: {
          auth: { google: authGoogle },
          session: mapGoogleSessionResponseData(session),
          owner_jid: primaryOwnerJid,
          owner_jids: [],
          account,
          password: passwordState,
          packs: [],
          stats: shouldIncludePacks ? buildMyProfileStatsTemplate() : null,
          meta: {
            view,
            lazy: !shouldIncludePacks,
          },
        },
      });
      return;
    }

    if (!shouldIncludePacks) {
      sendJson(req, res, 200, {
        data: {
          auth: { google: authGoogle },
          session: mapGoogleSessionResponseData(session),
          owner_jid: primaryOwnerJid,
          owner_jids: ownerCandidates,
          account,
          password: passwordState,
          packs: [],
          stats: null,
          meta: {
            view,
            lazy: true,
          },
        },
      });
      return;
    }

    const packLimit = clampInt(url?.searchParams?.get('limit'), view === 'packs' ? 120 : 300, 1, 300);
    const ownerPacks = await Promise.all(ownerCandidates.map((ownerJid) => listStickerPacksByOwner(ownerJid, { limit: 200, offset: 0 })));
    const includeAutoPacks = parseEnvBool(url?.searchParams?.get('include_auto'), parseEnvBool(process.env.STICKER_WEB_MY_PROFILE_INCLUDE_AUTO_PACKS, false));

    const dedupPacks = new Map();
    for (const packList of ownerPacks) {
      for (const pack of Array.isArray(packList) ? packList : []) {
        if (!pack?.id) continue;
        if (shouldHidePackFromMyProfileDefault(pack, { includeAutoPacks })) continue;
        const existing = dedupPacks.get(pack.id);
        if (!existing) {
          dedupPacks.set(pack.id, pack);
          continue;
        }
        const currentUpdatedAt = Date.parse(String(pack.updated_at || pack.created_at || ''));
        const existingUpdatedAt = Date.parse(String(existing.updated_at || existing.created_at || ''));
        if (Number.isFinite(currentUpdatedAt) && (!Number.isFinite(existingUpdatedAt) || currentUpdatedAt > existingUpdatedAt)) {
          dedupPacks.set(pack.id, pack);
        }
      }
    }

    const packs = Array.from(dedupPacks.values())
      .sort((a, b) => {
        const aUpdatedAt = Date.parse(String(a?.updated_at || a?.created_at || ''));
        const bUpdatedAt = Date.parse(String(b?.updated_at || b?.created_at || ''));
        if (!Number.isFinite(aUpdatedAt) && !Number.isFinite(bUpdatedAt)) return 0;
        if (!Number.isFinite(aUpdatedAt)) return 1;
        if (!Number.isFinite(bUpdatedAt)) return -1;
        return bUpdatedAt - aUpdatedAt;
      })
      .slice(0, packLimit);

    const engagementByPackId = await listStickerPackEngagementByPackIds(packs.map((pack) => pack.id));

    const mappedPacks = packs.map((pack) => {
      const safeSummary = mapPackSummary(pack, engagementByPackId.get(pack.id) || null, null);
      const publicVisible = isPackPubliclyVisible(pack);
      return {
        ...safeSummary,
        is_publicly_visible: publicVisible,
        cover_url: publicVisible ? safeSummary.cover_url : null,
        cover_preview_url: publicVisible ? safeSummary.cover_preview_url : null,
      };
    });

    const stats = mappedPacks.reduce((acc, pack) => {
      acc.total += 1;
      const status = String(pack.status || '').toLowerCase();
      const visibility = String(pack.visibility || '').toLowerCase();
      if (status === 'published') acc.published += 1;
      if (status === 'draft') acc.drafts += 1;
      if (visibility === 'private') acc.private += 1;
      if (visibility === 'unlisted') acc.unlisted += 1;
      if (visibility === 'public') acc.public += 1;
      return acc;
    }, buildMyProfileStatsTemplate());

    sendJson(req, res, 200, {
      data: {
        auth: { google: authGoogle },
        session: mapGoogleSessionResponseData(session),
        owner_jid: primaryOwnerJid,
        owner_jids: ownerCandidates,
        account,
        password: passwordState,
        packs: mappedPacks,
        stats,
        meta: {
          view,
          lazy: view === 'packs',
        },
      },
    });
  };

  return {
    handlePasswordAuthRequest,
    handlePasswordRecoveryRequest,
    handlePasswordRecoveryVerifyRequest,
    handlePasswordRecoverySessionCreateRequest,
    handlePasswordRecoverySessionStatusRequest,
    handlePasswordRecoverySessionRequest,
    handlePasswordRecoverySessionVerifyRequest,
    handlePasswordLoginRequest,
    handleMyProfileRequest,
  };
};
