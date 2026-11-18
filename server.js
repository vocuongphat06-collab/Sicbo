'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const {
  CONSTANTS,
  loadConfig,
  getConfig,
  parseBoolEnv
} = require('./lib/config');

const {
  validateBets,
  evaluateRoll,
  deriveFairDice,
  getLiveRoundClock,
  deriveLiveRoundDice,
  computeLiveCommitmentHash,
  deriveLiveRecentHistory,
  sha256Hex
} = require('./lib/sicbo-engine');

const {
  createDb,
  getDb,
  sanitizeUser
} = require('./lib/db');

const {
  hashPassword,
  verifyPassword,
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  signJwt,
  setAuthCookie,
  clearAuthCookie,
  createAuthMiddleware,
  createRateLimiter,
  resolveInitialRole,
  validateUsername,
  validatePassword,
  validateDisplayName,
  generateTempPassword,
  getClientIp
} = require('./lib/auth');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function makeHttpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const FORBIDDEN_BODY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoForbiddenKeys(value) {
  if (value === null || typeof value !== 'object') {
    return;
  }
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const ownNames = Object.getOwnPropertyNames(current);
    for (const key of ownNames) {
      if (FORBIDDEN_BODY_KEYS.has(key)) {
        throw makeHttpError(400, 'INVALID_BODY', 'Dữ liệu gửi lên chứa khóa không hợp lệ.');
      }
    }

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const item = current[i];
        if (item !== null && typeof item === 'object') {
          stack.push(item);
        }
      }
    } else {
      for (const key of ownNames) {
        const child = current[key];
        if (child !== null && typeof child === 'object') {
          stack.push(child);
        }
      }
    }
  }
}

function requirePlainBody(req) {
  if (req.body === undefined) return {};
  if (!isPlainObject(req.body)) {
    throw makeHttpError(400, 'INVALID_BODY', 'Dữ liệu gửi lên phải là JSON object hợp lệ.');
  }
  assertNoForbiddenKeys(req.body);
  return req.body;
}

function readIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim();
  if (trimmed.length > 128) {
    throw makeHttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key không được vượt quá 128 ký tự.');
  }
  return trimmed;
}

function sanitizeClientSeedInput(rawSeed) {
  if (rawSeed === undefined || rawSeed === null) {
    return { provided: false, value: undefined };
  }
  if (typeof rawSeed !== 'string') {
    throw makeHttpError(400, 'INVALID_CLIENT_SEED', 'Client seed phải là chuỗi ký tự.');
  }
  let cleaned = '';
  for (let i = 0; i < rawSeed.length; i++) {
    const code = rawSeed.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      cleaned += rawSeed[i];
    }
  }
  cleaned = cleaned.trim();
  if (cleaned.length > 64) {
    throw makeHttpError(400, 'INVALID_CLIENT_SEED', 'Client seed không được vượt quá 64 ký tự.');
  }
  return {
    provided: cleaned.length > 0,
    value: cleaned || undefined
  };
}

function parseNonNegativeSafeIntInput(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw makeHttpError(400, 'INVALID_INPUT', `${label} phải là số nguyên không âm hợp lệ.`);
  }
  return value === 0 ? 0 : value;
}

function issueSessionCookie(res, user, cfg) {
  const sv = Number.isInteger(user.sessionVersion) && user.sessionVersion >= 1
    ? user.sessionVersion
    : 1;
  const token = signJwt(
    {
      sub: user.id,
      sv,
      role: user.role === 'admin' ? 'admin' : 'user'
    },
    cfg.jwtSecret
  );
  setAuthCookie(res, token, { config: cfg });
  return token;
}

function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');

  const initialIsVercel = options.config
    ? Boolean(options.config.isVercel)
    : parseBoolEnv(process.env.VERCEL);
  if (initialIsVercel) {
    app.set('trust proxy', 1);
  }

  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  let resolvedConfig = options.config || null;
  let activeDb = options.db || null;
  let initPromise = null;
  let adminSeeded = false;
  const liveBetLocks = new Map();

  function withLiveBetLock(lockKey, fn) {
    const prev = liveBetLocks.get(lockKey) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    const cleanup = run.then(
      () => {
        if (liveBetLocks.get(lockKey) === cleanup) {
          liveBetLocks.delete(lockKey);
        }
      },
      () => {
        if (liveBetLocks.get(lockKey) === cleanup) {
          liveBetLocks.delete(lockKey);
        }
      }
    );
    liveBetLocks.set(lockKey, cleanup);
    return run;
  }

  function resolveConfig() {
    if (!resolvedConfig) {
      resolvedConfig = options.configOptions
        ? loadConfig(options.configOptions)
        : getConfig();
    }
    return resolvedConfig;
  }

  function resolveDb(cfg) {
    if (!activeDb) {
      if (options.db) {
        activeDb = options.db;
      } else if (options.config || options.configOptions || options.dbOptions) {
        activeDb = createDb(cfg, options.dbOptions);
      } else {
        activeDb = getDb();
      }
    }
    return activeDb;
  }

  async function seedAdminIfConfigured(db, cfg) {
    if (adminSeeded) return;
    if (cfg.adminUsername && cfg.adminPassword && cfg.adminPassword.length >= 6) {
      const uCheck = validateUsername(cfg.adminUsername);
      if (uCheck.valid) {
        const existing = await db.getUserByUsername(uCheck.username);
        if (!existing) {
          try {
            const passwordHash = await hashPassword(cfg.adminPassword);
            const recoveryCode = generateRecoveryCode();
            const recoveryCodeHash = await hashRecoveryCode(recoveryCode);
            await db.createUser({
              username: uCheck.username,
              displayName: uCheck.username,
              role: 'admin',
              isGuest: false,
              passwordHash,
              recoveryCodeHash,
              now: nowFn()
            });
          } catch (err) {
            if (!err || err.code !== 'USERNAME_TAKEN') {
              throw err;
            }
          }
        }
      }
    }
    adminSeeded = true;
  }

  async function ensureInitialized() {
    if (!initPromise) {
      initPromise = (async () => {
        const cfg = resolveConfig();
        if (cfg.isVercel && !app.get('trust proxy')) {
          app.set('trust proxy', 1);
        }
        const db = resolveDb(cfg);
        await db.init();
        await seedAdminIfConfigured(db, cfg);
        return { cfg, db };
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  // 1. Security Headers (all responses)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // 2. Same-Origin CORS Policy (no wildcard '*')
  const extraAllowedOrigins = new Set(
    Array.isArray(options.allowedOrigins)
      ? options.allowedOrigins.map((o) => String(o).trim().toLowerCase()).filter(Boolean)
      : []
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      return next();
    }
    const host = req.get('host');
    const expectedOrigin = host ? `${req.protocol}://${host}`.toLowerCase() : '';
    const normalizedOrigin = String(origin).trim().toLowerCase();
    const isAllowed = (expectedOrigin && normalizedOrigin === expectedOrigin)
      || extraAllowedOrigins.has(normalizedOrigin);

    res.setHeader('Vary', 'Origin');
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Idempotency-Key');
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      return next();
    }

    if (req.method === 'OPTIONS') {
      return res.status(403).json({
        error: 'Yêu cầu khác nguồn (Cross-Origin) bị từ chối.',
        code: 'CORS_FORBIDDEN'
      });
    }
    return next();
  });

  // 3. Static Frontend Assets (before /api lazy DB initialization)
  app.use(express.static(path.join(__dirname, 'public')));

  // 4. API JSON Body Parser (16kb limit) + Prototype-Key Guard + Lazy Initialization
  const bodyLimit = (options.config && options.config.BODY_LIMIT) || CONSTANTS.BODY_LIMIT;
  app.use('/api', express.json({ limit: bodyLimit }));
  app.use('/api', (req, res, next) => {
    if (req.body !== undefined) {
      assertNoForbiddenKeys(req.body);
    }
    next();
  });
  app.use('/api', async (req, res, next) => {
    await ensureInitialized();
    next();
  });

  // 5. Auth Middleware & Rate Limiters (no import-time setInterval by default)
  const {
    requireAuth,
    authenticateOptional,
    requireAdmin
  } = createAuthMiddleware({
    db: () => activeDb || resolveDb(resolveConfig()),
    getConfig: resolveConfig
  });

  const enableTimer = Boolean(options.enableRateLimiterTimer ?? options.enableRateLimitTimers);

  const authLimiter = createRateLimiter({
    windowMs: options.authRateLimitWindowMs ?? options.config?.AUTH_RATE_LIMIT_WINDOW_MS ?? CONSTANTS.AUTH_RATE_LIMIT_WINDOW_MS,
    max: options.authRateLimitMax ?? options.config?.AUTH_RATE_LIMIT_MAX ?? CONSTANTS.AUTH_RATE_LIMIT_MAX,
    keyGenerator: (req) => `auth:${getClientIp(req)}`,
    now: nowFn,
    enableTimer,
    message: 'Quá nhiều yêu cầu xác thực, vui lòng thử lại sau.'
  });

  const betLimiter = createRateLimiter({
    windowMs: options.betRateLimitWindowMs ?? options.config?.BET_RATE_LIMIT_WINDOW_MS ?? CONSTANTS.BET_RATE_LIMIT_WINDOW_MS,
    max: options.betRateLimitMax ?? options.config?.BET_RATE_LIMIT_MAX ?? CONSTANTS.BET_RATE_LIMIT_MAX,
    keyGenerator: (req) => (req.user ? `bet:${req.user.id}` : `bet:anon:${getClientIp(req)}`),
    now: nowFn,
    enableTimer,
    message: 'Bạn đặt cược quá nhanh, vui lòng chờ giây lát.'
  });

  app.use('/api/auth', authLimiter);

  // ==================== AUTH & GUEST ROUTES ====================

  app.post('/api/auth/register', async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    const uCheck = validateUsername(body.username);
    if (!uCheck.valid) {
      return res.status(400).json({ error: uCheck.error, code: 'INVALID_USERNAME' });
    }
    const pCheck = validatePassword(body.password);
    if (!pCheck.valid) {
      return res.status(400).json({ error: pCheck.error, code: 'INVALID_PASSWORD' });
    }
    const displayName = validateDisplayName(body.displayName, uCheck.username);
    const role = resolveInitialRole(uCheck.username, cfg);

    const passwordHash = await hashPassword(body.password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashRecoveryCode(recoveryCode);

    const created = await db.createUser({
      username: uCheck.username,
      displayName,
      role,
      isGuest: false,
      passwordHash,
      recoveryCodeHash,
      now: nowFn()
    });

    issueSessionCookie(res, created, cfg);
    return res.status(201).json({
      user: sanitizeUser(created),
      recoveryCode
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return res.status(400).json({
        error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.',
        code: 'INVALID_INPUT'
      });
    }

    const user = await db.getUserByUsername(username);
    if (!user || user.isGuest || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({
        error: 'Tên đăng nhập hoặc mật khẩu không đúng.',
        code: 'INVALID_CREDENTIALS'
      });
    }

    if (user.locked) {
      return res.status(403).json({
        error: 'Tài khoản đã bị khóa.',
        code: 'USER_LOCKED'
      });
    }

    issueSessionCookie(res, user, cfg);
    return res.json({ user: sanitizeUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cfg = resolveConfig();
    clearAuthCookie(res, { config: cfg });
    return res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const [ledger, personalHistory] = await Promise.all([
      db.getWalletLedger(req.user.id, 50),
      db.getPersonalHistory(req.user.id, 40)
    ]);
    return res.json({
      user: req.user,
      ledger,
      personalHistory,
      fairness: req.user.fairness
    });
  });

  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    if (typeof body.currentPassword !== 'string' || body.currentPassword.length === 0) {
      return res.status(400).json({
        error: 'Vui lòng nhập mật khẩu hiện tại.',
        code: 'INVALID_INPUT'
      });
    }
    const pCheck = validatePassword(body.newPassword);
    if (!pCheck.valid) {
      return res.status(400).json({ error: pCheck.error, code: 'INVALID_PASSWORD' });
    }

    const fullUser = await db.getUserById(req.user.id);
    if (!fullUser) {
      return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ.', code: 'USER_NOT_FOUND' });
    }
    if (fullUser.isGuest || !fullUser.passwordHash) {
      return res.status(400).json({
        error: 'Tài khoản Khách cần nâng cấp trước khi đổi mật khẩu.',
        code: 'NOT_REGISTERED'
      });
    }

    const matches = await verifyPassword(body.currentPassword, fullUser.passwordHash);
    if (!matches) {
      return res.status(401).json({
        error: 'Mật khẩu hiện tại không đúng.',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const newHash = await hashPassword(body.newPassword);
    const updated = await db.updateUserPassword({
      userId: fullUser.id,
      passwordHash: newHash,
      bumpSessionVersion: true,
      now: nowFn()
    });

    issueSessionCookie(res, updated, cfg);
    return res.json({
      ok: true,
      user: sanitizeUser(updated)
    });
  });

  app.post('/api/auth/recover', async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
    if (!username || !recoveryCode) {
      return res.status(400).json({
        error: 'Vui lòng nhập tên đăng nhập và mã khôi phục.',
        code: 'INVALID_INPUT'
      });
    }

    const pCheck = validatePassword(body.newPassword);
    if (!pCheck.valid) {
      return res.status(400).json({ error: pCheck.error, code: 'INVALID_PASSWORD' });
    }

    const user = await db.getUserByUsername(username);
    if (!user || user.isGuest || !user.recoveryCodeHash || !(await verifyRecoveryCode(recoveryCode, user.recoveryCodeHash))) {
      return res.status(401).json({
        error: 'Tên đăng nhập hoặc mã khôi phục không hợp lệ.',
        code: 'INVALID_RECOVERY_CODE'
      });
    }

    if (user.locked) {
      return res.status(403).json({
        error: 'Tài khoản đã bị khóa.',
        code: 'USER_LOCKED'
      });
    }

    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryCodeHash = await hashRecoveryCode(newRecoveryCode);
    const newPasswordHash = await hashPassword(body.newPassword);

    await db.updateUserPassword({
      userId: user.id,
      passwordHash: newPasswordHash,
      recoveryCodeHash: newRecoveryCodeHash,
      expectedRecoveryCodeHash: user.recoveryCodeHash,
      bumpSessionVersion: true,
      now: nowFn()
    });

    return res.json({
      ok: true,
      recoveryCode: newRecoveryCode
    });
  });

  app.post('/api/auth/guest', async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const suffix = crypto.randomBytes(6).toString('hex');
    const username = `guest_${suffix}`;
    const displayName = `Khách VIP #${suffix.slice(0, 4).toUpperCase()}`;

    const created = await db.createUser({
      username,
      displayName,
      role: 'user',
      isGuest: true,
      passwordHash: null,
      recoveryCodeHash: null,
      now: nowFn()
    });

    issueSessionCookie(res, created, cfg);
    return res.status(201).json({ user: sanitizeUser(created) });
  });

  app.post('/api/auth/upgrade', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    if (!req.user.isGuest) {
      return res.status(400).json({
        error: 'Tài khoản này không phải tài khoản Khách.',
        code: 'NOT_A_GUEST'
      });
    }

    const uCheck = validateUsername(body.username);
    if (!uCheck.valid) {
      return res.status(400).json({ error: uCheck.error, code: 'INVALID_USERNAME' });
    }
    const pCheck = validatePassword(body.password);
    if (!pCheck.valid) {
      return res.status(400).json({ error: pCheck.error, code: 'INVALID_PASSWORD' });
    }

    const displayName = validateDisplayName(body.displayName, uCheck.username);
    const role = resolveInitialRole(uCheck.username, cfg);
    const passwordHash = await hashPassword(body.password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashRecoveryCode(recoveryCode);

    const updated = await db.upgradeGuestAtomic({
      userId: req.user.id,
      username: uCheck.username,
      displayName,
      passwordHash,
      recoveryCodeHash,
      role,
      now: nowFn()
    });

    issueSessionCookie(res, updated, cfg);
    return res.json({
      user: sanitizeUser(updated),
      recoveryCode
    });
  });

  // ==================== WALLET & LEADERBOARD ROUTES ====================

  app.post('/api/wallet/daily-bonus', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const idempotencyKey = readIdempotencyKey(req);

    const result = await db.adjustBalanceAtomic({
      userId: req.user.id,
      delta: cfg.DAILY_BONUS_AMOUNT,
      type: 'daily_bonus',
      reason: 'Điểm danh nhận thưởng 24h',
      refId: 'daily_bonus',
      idempotencyKey,
      cooldownField: 'lastDailyBonusAt',
      cooldownMs: cfg.DAILY_BONUS_COOLDOWN_MS,
      now: nowFn()
    });

    return res.json({
      balance: result.balance,
      bonusAmount: cfg.DAILY_BONUS_AMOUNT,
      nextEligibleAt: result.nextEligibleAt,
      ledgerEntry: result.ledgerEntry,
      user: result.user
    });
  });

  app.post('/api/wallet/bankruptcy-aid', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const idempotencyKey = readIdempotencyKey(req);

    const result = await db.adjustBalanceAtomic({
      userId: req.user.id,
      delta: cfg.BANKRUPTCY_AID_AMOUNT,
      type: 'bankruptcy_aid',
      reason: 'Trợ cấp phục hồi vốn',
      refId: 'bankruptcy_aid',
      idempotencyKey,
      cooldownField: 'lastBankruptcyAidAt',
      cooldownMs: cfg.BANKRUPTCY_COOLDOWN_MS,
      maxBalanceBefore: cfg.BANKRUPTCY_THRESHOLD,
      now: nowFn()
    });

    return res.json({
      balance: result.balance,
      aidAmount: cfg.BANKRUPTCY_AID_AMOUNT,
      nextEligibleAt: result.nextEligibleAt,
      ledgerEntry: result.ledgerEntry,
      user: result.user
    });
  });

  app.get('/api/leaderboard', async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 20));
    const data = await db.getLeaderboard(limit);
    const mapRow = (row) => ({
      ...row,
      totalRounds: row.totalRounds ?? row.rounds ?? 0
    });

    return res.json({
      byBalance: data.byBalance.map(mapRow),
      byNetProfit: data.byNetProfit.map(mapRow)
    });
  });

  // ==================== FAIRNESS & MANUAL GAME ROUTES ====================

  app.post('/api/fairness/rotate', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);
    const cs = sanitizeClientSeedInput(body.clientSeed);

    const result = await db.rotateFairnessAtomic({
      userId: req.user.id,
      newClientSeed: cs.value,
      now: nowFn()
    });

    return res.json(result);
  });

  app.post('/api/verify-fairness', (req, res) => {
    const body = requirePlainBody(req);
    if (typeof body.serverSeed !== 'string' || body.serverSeed.trim().length === 0) {
      return res.status(400).json({ valid: false, error: 'Thiếu Server Seed để kiểm chứng.' });
    }
    if (body.clientSeed !== undefined && body.clientSeed !== null && typeof body.clientSeed !== 'string') {
      return res.status(400).json({ valid: false, error: 'Client Seed phải là chuỗi ký tự.' });
    }

    let derived;
    try {
      derived = deriveFairDice(body.serverSeed, body.clientSeed, body.nonce);
    } catch (err) {
      return res.status(400).json({ valid: false, error: err.message });
    }

    const ev = evaluateRoll(derived.dice);
    const computedServerSeedHash = sha256Hex(body.serverSeed);
    const expectedHash = (typeof body.expectedHash === 'string' && body.expectedHash.trim())
      ? body.expectedHash.trim().toLowerCase()
      : null;
    const hashMatches = expectedHash ? (computedServerSeedHash === expectedHash) : true;

    return res.json({
      valid: hashMatches,
      hashMatches,
      computedServerSeedHash,
      clientSeed: derived.clientSeed,
      nonce: derived.nonce,
      hmacHex: derived.hmacHex,
      dice: derived.dice,
      total: ev.total,
      isTriple: ev.isTriple,
      outcome: ev.outcome
    });
  });

  app.get('/api/state', authenticateOptional, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const clock = getLiveRoundClock(nowFn());
    const roundSeedHash = computeLiveCommitmentHash(cfg.liveMasterSecret, clock.liveRoundId);
    const liveHistory = deriveLiveRecentHistory(cfg.liveMasterSecret, clock, 60);

    const globalHistory = liveHistory.length > 0 ? liveHistory : await db.getGlobalHistory(60);

    let ledger = [];
    let personalHistory = [];
    let currentTicket = null;
    let unsettledLiveTickets = [];

    if (req.user) {
      [ledger, personalHistory, currentTicket, unsettledLiveTickets] = await Promise.all([
        db.getWalletLedger(req.user.id, 50),
        db.getPersonalHistory(req.user.id, 40),
        db.getLiveTicket({ userId: req.user.id, liveRoundId: clock.liveRoundId }),
        db.getUnsettledLiveTickets(req.user.id)
      ]);
    }

    const livePayload = {
      ...clock,
      roundDurationMs: cfg.LIVE_ROUND_MS,
      betDurationMs: cfg.LIVE_BET_MS,
      revealDurationMs: cfg.LIVE_REVEAL_MS,
      roundSeedHash,
      recentHistory: liveHistory,
      ticket: currentTicket
    };

    if (clock.phase === 'REVEAL') {
      const derived = deriveLiveRoundDice(cfg.liveMasterSecret, clock.liveRoundId);
      const ev = evaluateRoll(derived.dice);
      livePayload.dice = ev.dice;
      livePayload.total = ev.total;
      livePayload.isTriple = ev.isTriple;
      livePayload.outcome = ev.outcome;
    }

    return res.json({
      user: req.user || null,
      balance: req.user ? req.user.balance : null,
      history: globalHistory,
      globalHistory,
      ledger,
      personalHistory,
      fairness: req.user ? req.user.fairness : null,
      live: livePayload,
      unsettledLiveTickets,
      serverTime: clock.serverTime
    });
  });

  app.post('/api/roll', requireAuth, betLimiter, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);
    const idempotencyKey = readIdempotencyKey(req);

    const validation = validateBets(body.bets);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, code: 'INVALID_BETS' });
    }

    const cs = sanitizeClientSeedInput(body.clientSeed);

    const result = await db.placeManualRollAtomic({
      userId: req.user.id,
      bets: validation.cleanBets,
      totalBet: validation.totalBet,
      clientSeed: cs.value || null,
      idempotencyKey,
      now: nowFn(),
      resolveFn: ({ fairness, clientSeed, nonce, bets }) => {
        const derived = deriveFairDice(fairness.serverSeed, clientSeed, nonce);
        return {
          hmacHex: derived.hmacHex,
          evaluation: evaluateRoll(derived.dice, bets)
        };
      }
    });

    const fairnessOut = result.fairness
      ? {
          serverSeedHash: result.fairness.serverSeedHash,
          clientSeed: result.fairness.clientSeed,
          nonce: result.fairness.nonce,
          nextServerSeedHash: result.fairness.serverSeedHash,
          nextNonce: result.user?.fairness?.nonce ?? (result.fairness.nonce + 1)
        }
      : null;

    return res.json({
      ...result,
      fairness: fairnessOut
    });
  });

  // ==================== SERVERLESS LIVE ROOM ROUTES ====================

  app.get('/api/live/state', authenticateOptional, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const clock = getLiveRoundClock(nowFn());
    const roundSeedHash = computeLiveCommitmentHash(cfg.liveMasterSecret, clock.liveRoundId);
    const recentHistory = deriveLiveRecentHistory(cfg.liveMasterSecret, clock, 60);

    let ticket = null;
    let unsettledTickets = [];
    if (req.user) {
      [ticket, unsettledTickets] = await Promise.all([
        db.getLiveTicket({ userId: req.user.id, liveRoundId: clock.liveRoundId }),
        db.getUnsettledLiveTickets(req.user.id)
      ]);
    }

    const payload = {
      ...clock,
      roundDurationMs: cfg.LIVE_ROUND_MS,
      betDurationMs: cfg.LIVE_BET_MS,
      revealDurationMs: cfg.LIVE_REVEAL_MS,
      roundSeedHash,
      recentHistory,
      ticket,
      unsettledTickets
    };

    if (clock.phase === 'REVEAL') {
      const derived = deriveLiveRoundDice(cfg.liveMasterSecret, clock.liveRoundId);
      const ev = evaluateRoll(derived.dice);
      payload.dice = ev.dice;
      payload.total = ev.total;
      payload.isTriple = ev.isTriple;
      payload.outcome = ev.outcome;
    }

    return res.json(payload);
  });

  app.post('/api/live/bet', requireAuth, betLimiter, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);
    const idempotencyKey = readIdempotencyKey(req);

    const validation = validateBets(body.bets);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, code: 'INVALID_BETS' });
    }

    const clock = getLiveRoundClock(nowFn());
    if (clock.phase !== 'BETTING') {
      return res.status(400).json({
        error: 'Đã khóa sổ mở bát, vui lòng đợi phiên Live kế tiếp.',
        code: 'LIVE_BETTING_CLOSED',
        phase: clock.phase,
        liveRoundId: clock.liveRoundId
      });
    }

    if (body.liveRoundId !== undefined && body.liveRoundId !== null) {
      const reqRoundId = parseNonNegativeSafeIntInput(body.liveRoundId, 'liveRoundId');
      if (reqRoundId !== clock.liveRoundId) {
        return res.status(400).json({
          error: 'Phiên Live đã chuyển sang lượt mới.',
          code: 'LIVE_ROUND_MISMATCH',
          activeRoundId: clock.liveRoundId
        });
      }
    }

    const lockKey = `${req.user.id}:${clock.liveRoundId}`;
    let liveClock = clock;
    const result = await withLiveBetLock(lockKey, async () => {
      liveClock = getLiveRoundClock(nowFn());
      if (liveClock.phase !== 'BETTING' || liveClock.liveRoundId !== clock.liveRoundId) {
        throw makeHttpError(
          400,
          'LIVE_BETTING_CLOSED',
          'Đã khóa sổ mở bát, vui lòng đợi phiên Live kế tiếp.',
          { phase: liveClock.phase, liveRoundId: liveClock.liveRoundId }
        );
      }
      return db.placeLiveBetAtomic({
        userId: req.user.id,
        liveRoundId: liveClock.liveRoundId,
        bets: validation.cleanBets,
        totalBet: validation.totalBet,
        idempotencyKey,
        now: liveClock.serverTime
      });
    });

    const roundSeedHash = computeLiveCommitmentHash(cfg.liveMasterSecret, liveClock.liveRoundId);

    return res.json({
      replayed: result.replayed,
      liveRoundId: result.liveRoundId,
      ticket: result.ticket,
      newBalance: result.newBalance,
      roundSeedHash,
      clock: liveClock
    });
  });

  app.post('/api/live/settle', requireAuth, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);
    const clock = getLiveRoundClock(nowFn());

    const targetRoundId = (body.liveRoundId === undefined || body.liveRoundId === null)
      ? clock.liveRoundId
      : parseNonNegativeSafeIntInput(body.liveRoundId, 'liveRoundId');

    if (targetRoundId > clock.liveRoundId) {
      return res.status(400).json({
        error: 'Phiên Live chưa bắt đầu.',
        code: 'LIVE_ROUND_NOT_REVEALED'
      });
    }

    if (targetRoundId === clock.liveRoundId && clock.phase === 'BETTING') {
      return res.status(400).json({
        error: 'Phiên Live đang nhận cược, chưa tới pha Mở bát.',
        code: 'ROUND_STILL_BETTING'
      });
    }

    const derived = deriveLiveRoundDice(cfg.liveMasterSecret, targetRoundId);
    const roundSeedHash = computeLiveCommitmentHash(cfg.liveMasterSecret, targetRoundId);

    const result = await db.settleLiveRoundAtomic({
      userId: req.user.id,
      liveRoundId: targetRoundId,
      dice: derived.dice,
      roundSeedHash,
      now: nowFn()
    });

    const t = result.ticket;
    return res.json({
      liveRoundId: result.liveRoundId,
      settled: true,
      alreadySettled: result.alreadySettled,
      settledNow: result.settledNow,
      dice: t.dice,
      total: t.total,
      isTriple: t.isTriple,
      outcome: t.outcome,
      totalBet: t.totalBet,
      totalWin: t.totalWin,
      netProfit: t.netProfit,
      newBalance: result.newBalance,
      winningDetails: t.winningDetails,
      roundSeedHash,
      ticket: t,
      user: result.user
    });
  });

  // ==================== ADMIN OPS ROUTES ====================

  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 50));
    const offset = Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0);

    const data = await db.listUsers({ q, limit, offset });
    return res.json(data);
  });

  app.post('/api/admin/users/:id/adjust-balance', requireAuth, requireAdmin, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount === 0) {
      return res.status(400).json({
        error: 'Số tiền điều chỉnh phải là số nguyên khác 0.',
        code: 'INVALID_INPUT'
      });
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    if (!reason) {
      return res.status(400).json({
        error: 'Vui lòng nhập lý do điều chỉnh số dư.',
        code: 'INVALID_INPUT'
      });
    }

    const result = await db.adjustBalanceAtomic({
      userId: req.params.id,
      delta: amount,
      type: 'admin_adjust',
      reason,
      refId: `admin:${req.user.id}`,
      idempotencyKey: readIdempotencyKey(req),
      allowLocked: true,
      minBalanceAfter: 0,
      now: nowFn()
    });

    return res.json({
      user: result.user,
      ledgerEntry: result.ledgerEntry
    });
  });

  app.post('/api/admin/users/:id/toggle-lock', requireAuth, requireAdmin, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    if (req.params.id === req.user.id) {
      return res.status(400).json({
        error: 'Không thể tự khóa tài khoản quản trị đang đăng nhập.',
        code: 'CANNOT_LOCK_SELF'
      });
    }

    if (body.locked !== undefined && typeof body.locked !== 'boolean') {
      return res.status(400).json({
        error: 'Trường locked phải là boolean.',
        code: 'INVALID_INPUT'
      });
    }

    const updated = await db.toggleUserLock({
      userId: req.params.id,
      locked: body.locked,
      now: nowFn()
    });

    return res.json({ user: sanitizeUser(updated) });
  });

  app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const cfg = resolveConfig();
    const db = resolveDb(cfg);
    const body = requirePlainBody(req);

    const target = await db.getUserById(req.params.id);
    if (!target) {
      return res.status(404).json({
        error: 'Không tìm thấy tài khoản.',
        code: 'USER_NOT_FOUND'
      });
    }
    if (target.isGuest) {
      return res.status(400).json({
        error: 'Không thể cấp lại mật khẩu cho tài khoản Khách chưa đăng ký.',
        code: 'NOT_REGISTERED'
      });
    }

    let tempPassword;
    if (body.newPassword !== undefined && body.newPassword !== '') {
      const pCheck = validatePassword(body.newPassword);
      if (!pCheck.valid) {
        return res.status(400).json({ error: pCheck.error, code: 'INVALID_PASSWORD' });
      }
      tempPassword = body.newPassword;
    } else {
      tempPassword = generateTempPassword();
    }

    const passwordHash = await hashPassword(tempPassword);
    const updated = await db.updateUserPassword({
      userId: req.params.id,
      passwordHash,
      bumpSessionVersion: true,
      now: nowFn()
    });

    return res.json({
      user: sanitizeUser(updated),
      tempPassword
    });
  });

  // ==================== 404 & ERROR HANDLERS ====================

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'API endpoint không tồn tại.',
      code: 'NOT_FOUND'
    });
  });

  // Express 5 4-arg error handler
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    if (err && (err.type === 'entity.too.large' || err.name === 'PayloadTooLargeError' || err.status === 413)) {
      return res.status(413).json({
        error: 'Dữ liệu gửi lên vượt quá giới hạn 16KB.',
        code: 'PAYLOAD_TOO_LARGE'
      });
    }

    if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
      return res.status(400).json({
        error: 'Dữ liệu JSON không hợp lệ.',
        code: 'INVALID_JSON'
      });
    }

    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      const payload = {
        error: err.message || 'Yêu cầu không hợp lệ.',
        code: err.code || 'BAD_REQUEST'
      };
      if (err.nextEligibleAt !== undefined) {
        payload.nextEligibleAt = err.nextEligibleAt;
      }
      if (err.phase !== undefined) {
        payload.phase = err.phase;
      }
      if (err.liveRoundId !== undefined) {
        payload.liveRoundId = err.liveRoundId;
      }
      return res.status(err.status).json(payload);
    }

    console.error('[sicbo-server] Unexpected error:', err && err.message ? err.message : err);
    return res.status(500).json({
      error: 'Lỗi máy chủ nội bộ.',
      code: 'INTERNAL_ERROR'
    });
  });

  app.createApp = createApp;
  app.ensureInitialized = ensureInitialized;
  app.getConfig = resolveConfig;
  app.getDb = () => activeDb;
  app.locals.limiters = { authLimiter, betLimiter };
  app.close = async () => {
    authLimiter.destroy();
    betLimiter.destroy();
    if (activeDb && typeof activeDb.close === 'function') {
      await activeDb.close();
    }
  };
  app.destroy = app.close;

  return app;
}

const app = createApp();
app.createApp = createApp;

if (require.main === module && !parseBoolEnv(process.env.VERCEL)) {
  app.ensureInitialized()
    .then(({ cfg }) => {
      app.listen(cfg.port, () => {
        console.log('\n======================================================');
        console.log('🎲 SOVEREIGN • PRIVATE 3D SICBO SALON (PRODUCTION)');
        console.log('🛡  Provably Fair SHA-256 Commit-Reveal Engine Active');
        console.log(`🚀 Open browser at: http://localhost:${cfg.port}`);
        console.log('======================================================\n');
      });
    })
    .catch((err) => {
      console.error('[sicbo-server] Failed to start server:', err);
      process.exit(1);
    });
}

module.exports = app;
module.exports.createApp = createApp;
