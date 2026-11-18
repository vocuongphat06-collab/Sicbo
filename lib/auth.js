'use strict';

const crypto = require('crypto');

const { getConfig, JWT_TTL_SECONDS } = require('./config');
const { getDb, sanitizeUser } = require('./db');

const SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_LEN = 64;

const SALT_HEX_RE = /^[0-9a-fA-F]{32}$/;
const HASH_HEX_RE = /^[0-9a-fA-F]{128}$/;
const JWT_FORMAT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ============================================================================
// 1. SCRYPT PASSWORD & RECOVERY CODE HASHING
// ============================================================================

function scryptAsync(secret, saltBuffer) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, saltBuffer, SCRYPT_KEY_LEN, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });
}

async function hashSecret(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('Secret to hash must be a non-empty string');
  }
  const saltBuf = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derivedBuf = await scryptAsync(plain, saltBuf);
  return `scrypt$${saltBuf.toString('hex')}$${derivedBuf.toString('hex')}`;
}

async function verifySecret(plain, storedHash) {
  try {
    if (typeof plain !== 'string' || plain.length === 0 || typeof storedHash !== 'string') {
      return false;
    }
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return false;
    }
    const [, saltHex, hashHex] = parts;
    if (!SALT_HEX_RE.test(saltHex) || !HASH_HEX_RE.test(hashHex)) {
      return false;
    }
    const saltBuf = Buffer.from(saltHex, 'hex');
    const expectedBuf = Buffer.from(hashHex, 'hex');
    if (saltBuf.length !== SCRYPT_SALT_BYTES || expectedBuf.length !== SCRYPT_KEY_LEN) {
      return false;
    }
    const derivedBuf = await scryptAsync(plain, saltBuf);
    if (!Buffer.isBuffer(derivedBuf) || derivedBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(derivedBuf, expectedBuf);
  } catch (_) {
    return false;
  }
}

async function hashPassword(password) {
  return hashSecret(password);
}

async function verifyPassword(password, storedHash) {
  return verifySecret(password, storedHash);
}

function generateRecoveryCode() {
  const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `SOV-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function normalizeRecoveryCode(code) {
  if (typeof code !== 'string') return '';
  return code.trim().toUpperCase();
}

async function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) {
    throw new TypeError('Recovery code must be a non-empty string');
  }
  return hashSecret(normalized);
}

async function verifyRecoveryCode(code, storedHash) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return false;
  return verifySecret(normalized, storedHash);
}

// ============================================================================
// 2. ZERO-DEPENDENCY HS256 JWT
// ============================================================================

function resolveJwtSecret(explicitSecret) {
  if (typeof explicitSecret === 'string' && explicitSecret.trim().length > 0) {
    return explicitSecret.trim();
  }
  const cfg = getConfig();
  if (typeof cfg.jwtSecret === 'string' && cfg.jwtSecret.trim().length > 0) {
    return cfg.jwtSecret.trim();
  }
  return '';
}

function signJwt(payload, secret, options = {}) {
  const resolvedSecret = resolveJwtSecret(secret);
  if (!resolvedSecret) {
    throw new Error('JWT secret is required');
  }
  if (!isPlainObject(payload)) {
    throw new TypeError('JWT payload must be a plain object');
  }

  const ttlSeconds = Number.isFinite(options.ttlSeconds)
    ? options.ttlSeconds
    : (Number.isFinite(options.expiresInSeconds) ? options.expiresInSeconds : JWT_TTL_SECONDS);

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    ...payload,
    iat: payload.iat !== undefined ? payload.iat : nowSec,
    exp: payload.exp !== undefined ? payload.exp : (nowSec + ttlSeconds)
  };

  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = crypto
    .createHmac('sha256', resolvedSecret)
    .update(signingInput, 'utf8')
    .digest()
    .toString('base64url');

  return `${signingInput}.${sigB64}`;
}

function verifyJwt(token, secret, options = {}) {
  try {
    const resolvedSecret = resolveJwtSecret(secret);
    if (!resolvedSecret) return null;
    if (typeof token !== 'string' || !JWT_FORMAT_RE.test(token)) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const headerRaw = Buffer.from(headerB64, 'base64url');
    if (headerRaw.toString('base64url') !== headerB64) return null;
    const header = JSON.parse(headerRaw.toString('utf8'));
    if (!isPlainObject(header) || header.alg !== 'HS256') {
      return null;
    }
    if (header.typ !== undefined && header.typ !== 'JWT') {
      return null;
    }

    const expectedSigBuf = crypto
      .createHmac('sha256', resolvedSecret)
      .update(`${headerB64}.${payloadB64}`, 'utf8')
      .digest();
    const actualSigBuf = Buffer.from(sigB64, 'base64url');
    if (actualSigBuf.toString('base64url') !== sigB64) {
      return null;
    }
    if (actualSigBuf.length !== expectedSigBuf.length) {
      return null;
    }
    if (!crypto.timingSafeEqual(actualSigBuf, expectedSigBuf)) {
      return null;
    }

    const payloadRaw = Buffer.from(payloadB64, 'base64url');
    if (payloadRaw.toString('base64url') !== payloadB64) return null;
    const payload = JSON.parse(payloadRaw.toString('utf8'));
    if (!isPlainObject(payload)) {
      return null;
    }

    const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSec >= payload.exp) {
      return null;
    }
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || nowSec < payload.nbf) {
        return null;
      }
    }

    if (options.requireSessionClaims !== false) {
      if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
        return null;
      }
      if (!Number.isInteger(payload.sv) || payload.sv < 1) {
        return null;
      }
    }

    return payload;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// 3. COOKIE PARSING & EXPRESS 5 AUTH COOKIE HELPERS
// ============================================================================

function parseCookies(cookieHeaderOrReq) {
  const out = Object.create(null);
  const rawHeader = typeof cookieHeaderOrReq === 'string'
    ? cookieHeaderOrReq
    : (cookieHeaderOrReq && cookieHeaderOrReq.headers && cookieHeaderOrReq.headers.cookie);

  if (typeof rawHeader !== 'string' || rawHeader.trim().length === 0) {
    return out;
  }

  const pairs = rawHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const rawKey = pair.slice(0, eqIdx).trim();
    if (!rawKey || rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') {
      continue;
    }
    let rawVal = pair.slice(eqIdx + 1).trim();
    if (rawVal.length >= 2 && rawVal.startsWith('"') && rawVal.endsWith('"')) {
      rawVal = rawVal.slice(1, -1);
    }
    let decodedVal = rawVal;
    try {
      decodedVal = decodeURIComponent(rawVal);
    } catch (_) {
      decodedVal = rawVal;
    }
    out[rawKey] = decodedVal;
  }

  return out;
}

function appendSetCookieHeader(res, cookieStr) {
  if (typeof res.append === 'function') {
    res.append('Set-Cookie', cookieStr);
    return;
  }
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (!existing) {
    res.setHeader('Set-Cookie', cookieStr);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieStr]);
  }
}

function buildAuthCookieString(token, options = {}) {
  const cfg = options.config || getConfig();
  const name = options.cookieName || cfg.COOKIE_NAME || 'sicbo_token';
  const maxAge = Number.isInteger(options.maxAgeSeconds)
    ? options.maxAgeSeconds
    : (cfg.JWT_TTL_SECONDS || 604800);
  const isSecure = options.secure !== undefined
    ? Boolean(options.secure)
    : Boolean(cfg.isProduction || cfg.isVercel);

  return `${name}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

function buildClearCookieString(options = {}) {
  const cfg = options.config || getConfig();
  const name = options.cookieName || cfg.COOKIE_NAME || 'sicbo_token';
  const isSecure = options.secure !== undefined
    ? Boolean(options.secure)
    : Boolean(cfg.isProduction || cfg.isVercel);

  return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

function setAuthCookie(res, token, options = {}) {
  const cookieStr = buildAuthCookieString(token, options);
  appendSetCookieHeader(res, cookieStr);
  return cookieStr;
}

function clearAuthCookie(res, options = {}) {
  const cookieStr = buildClearCookieString(options);
  appendSetCookieHeader(res, cookieStr);
  return cookieStr;
}

// ============================================================================
// 4. AUTH & RBAC MIDDLEWARE
// ============================================================================

function extractAuthToken(req, cookieName) {
  const cookies = parseCookies(req);
  if (Object.prototype.hasOwnProperty.call(cookies, cookieName) && cookies[cookieName] !== '') {
    return cookies[cookieName];
  }
  const authHeader = req && req.headers && req.headers.authorization;
  if (typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.length > 7 && trimmed.slice(0, 7).toLowerCase() === 'bearer ') {
      const bearer = trimmed.slice(7).trim();
      if (bearer) return bearer;
    }
  }
  return '';
}

function createAuthMiddleware({ db, getConfig: getConfigFn } = {}) {
  const resolveDb = () => {
    if (typeof db === 'function') return db();
    return db || getDb();
  };
  const resolveCfg = () => (typeof getConfigFn === 'function' ? getConfigFn() : getConfig());

  async function authenticateRequest(req) {
    const cfg = resolveCfg();
    const activeDb = resolveDb();
    const cookieName = cfg.COOKIE_NAME || 'sicbo_token';
    const token = extractAuthToken(req, cookieName);
    if (!token) {
      return { ok: false, reason: 'missing_token', user: null, auth: null };
    }

    const payload = verifyJwt(token, cfg.jwtSecret);
    if (!payload) {
      return { ok: false, reason: 'invalid_token', user: null, auth: null };
    }

    const user = await activeDb.getUserById(payload.sub);
    if (!user) {
      return { ok: false, reason: 'user_not_found', user: null, auth: null };
    }

    if (user.locked === true) {
      return { ok: false, reason: 'user_locked', user: null, auth: null };
    }

    const userSv = Number.isInteger(user.sessionVersion) && user.sessionVersion >= 1
      ? user.sessionVersion
      : 1;
    if (payload.sv !== userSv) {
      return { ok: false, reason: 'session_revoked', user: null, auth: null };
    }

    return {
      ok: true,
      reason: null,
      user: sanitizeUser(user),
      auth: {
        userId: user.id,
        role: user.role === 'admin' ? 'admin' : 'user',
        sv: userSv,
        payload
      }
    };
  }

  async function requireAuth(req, res, next) {
    try {
      const result = await authenticateRequest(req);
      if (!result.ok) {
        const msg = result.reason === 'user_locked'
          ? 'Tài khoản đã bị khóa. Phiên đăng nhập bị thu hồi.'
          : (result.reason === 'session_revoked'
            ? 'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.'
            : 'Vui lòng đăng nhập để tiếp tục.');
        return res.status(401).json({ error: msg, code: result.reason });
      }
      req.user = result.user;
      req.auth = result.auth;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  async function authenticateOptional(req, res, next) {
    try {
      const result = await authenticateRequest(req);
      if (result.ok) {
        req.user = result.user;
        req.auth = result.auth;
      } else {
        req.user = null;
        req.auth = null;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Vui lòng đăng nhập để tiếp tục.' });
    }
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Bạn không có quyền Quản trị viên (Admin).' });
    }
    return next();
  }

  return {
    authenticateRequest,
    requireAuth,
    authenticateOptional,
    requireAdmin
  };
}

const defaultAuthMiddleware = createAuthMiddleware({
  db: () => getDb(),
  getConfig
});

// ============================================================================
// 5. SLIDING-WINDOW RATE LIMITER
// ============================================================================

function getClientIp(req) {
  if (!req) return 'unknown';
  if (typeof req.ip === 'string' && req.ip) return req.ip;
  if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
}

function createRateLimiter(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : 60_000;
  const max = Number.isInteger(options.max) && options.max > 0
    ? options.max
    : 20;
  const maxBuckets = Number.isInteger(options.maxBuckets) && options.maxBuckets > 0
    ? options.maxBuckets
    : 10_000;
  const sweepIntervalMs = Number.isFinite(options.sweepIntervalMs) && options.sweepIntervalMs > 0
    ? options.sweepIntervalMs
    : windowMs;
  const keyGenerator = typeof options.keyGenerator === 'function'
    ? options.keyGenerator
    : (req) => `ip:${getClientIp(req)}`;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const message = options.message || 'Quá nhiều yêu cầu, vui lòng thử lại sau.';

  const buckets = new Map();
  let lastSweepAt = nowFn();

  function sweepStale(ts) {
    const cutoff = ts - windowMs;
    for (const [k, timestamps] of buckets.entries()) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        buckets.delete(k);
      }
    }
    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
    lastSweepAt = ts;
  }

  let sweepTimer = null;
  if (options.enableTimer !== false && sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      sweepStale(nowFn());
    }, sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
  }

  function middleware(req, res, next) {
    const ts = nowFn();
    if ((ts - lastSweepAt) >= sweepIntervalMs || buckets.size >= maxBuckets) {
      sweepStale(ts);
    }

    const key = String(keyGenerator(req));
    const cutoff = ts - windowMs;
    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
    } else {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
    }

    if (timestamps.length >= max) {
      const retryAfterMs = Math.max(1, timestamps[0] + windowMs - ts);
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const resetSec = Math.ceil((timestamps[0] + windowMs) / 1000);

      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(resetSec));

      return res.status(429).json({
        error: message,
        retryAfterMs
      });
    }

    timestamps.push(ts);
    buckets.delete(key);
    buckets.set(key, timestamps);
    if (buckets.size > maxBuckets) {
      sweepStale(ts);
    }

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - timestamps.length)));
    return next();
  }

  middleware.reset = () => {
    buckets.clear();
    lastSweepAt = nowFn();
  };

  middleware.destroy = () => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    buckets.clear();
  };

  middleware.size = () => buckets.size;

  return middleware;
}

// ============================================================================
// 6. M3 SERVER HELPERS (RBAC, VALIDATION & XSS ESCAPING)
// ============================================================================

function isAdminUsername(username, cfg = getConfig()) {
  if (typeof username !== 'string' || !cfg || !cfg.adminUsernameLower) {
    return false;
  }
  return username.trim().toLowerCase() === cfg.adminUsernameLower;
}

function resolveInitialRole(username, cfg = getConfig()) {
  return isAdminUsername(username, cfg) ? 'admin' : 'user';
}

function validateUsername(username, options = {}) {
  if (typeof username !== 'string') {
    return { valid: false, username: '', usernameLower: '', error: 'Tên đăng nhập không hợp lệ.' };
  }
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    return {
      valid: false,
      username: trimmed,
      usernameLower: trimmed.toLowerCase(),
      error: 'Tên đăng nhập phải dài 3–32 ký tự (chữ cái, số, _, ., -).'
    };
  }
  if (!options.allowGuestPrefix && /^guest_/i.test(trimmed)) {
    return {
      valid: false,
      username: trimmed,
      usernameLower: trimmed.toLowerCase(),
      error: 'Tên đăng nhập không được bắt đầu bằng "guest_".'
    };
  }
  return {
    valid: true,
    username: trimmed,
    usernameLower: trimmed.toLowerCase(),
    error: null
  };
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Mật khẩu phải là chuỗi ký tự.' };
  }
  if (password.length < 6 || password.length > 128) {
    return { valid: false, error: 'Mật khẩu phải dài từ 6 đến 128 ký tự.' };
  }
  return { valid: true, error: null };
}

function validateDisplayName(displayName, fallbackUsername = '') {
  if (typeof displayName !== 'string') {
    return String(fallbackUsername || '').trim().slice(0, 40);
  }
  // Strip ASCII control characters
  let cleaned = '';
  for (let i = 0; i < displayName.length; i++) {
    const code = displayName.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      cleaned += displayName[i];
    }
  }
  cleaned = cleaned.trim().slice(0, 40);
  return cleaned || String(fallbackUsername || '').trim().slice(0, 40);
}

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  generateRecoveryCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  signJwt,
  verifyJwt,
  parseCookies,
  setAuthCookie,
  clearAuthCookie,
  extractAuthToken,
  sanitizeUser,
  isAdminUsername,
  resolveInitialRole,
  validateUsername,
  validatePassword,
  validateDisplayName,
  generateTempPassword,
  escapeHtml,
  getClientIp,
  createRateLimiter,
  createAuthMiddleware,
  requireAuth: defaultAuthMiddleware.requireAuth,
  authenticateOptional: defaultAuthMiddleware.authenticateOptional,
  requireAdmin: defaultAuthMiddleware.requireAdmin
};
