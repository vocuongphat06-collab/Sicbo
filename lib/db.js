'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadConfig, getConfig } = require('./config');
const sicboEngine = require('./sicbo-engine');

const {
  sha256Hex,
  validateBets,
  evaluateRoll,
  deriveFairDice
} = sicboEngine;

const LEDGER_TYPES = Object.freeze([
  'bet',
  'win',
  'refund',
  'daily_bonus',
  'bankruptcy_aid',
  'admin_adjust'
]);

const LEDGER_TYPE_SET = new Set(LEDGER_TYPES);
const MAX_LEDGER_PER_USER = 200;
const MAX_PERSONAL_HISTORY_PER_USER = 100;
const MAX_GLOBAL_HISTORY = 120;
const MAX_JSON_IDEMPOTENCY_ENTRIES = 5000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function makeDbError(code, status, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalizeValue(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  const sorted = Object.create(null);
  const keys = Object.keys(value).sort();
  for (const k of keys) {
    if (value[k] !== undefined) {
      Object.defineProperty(sorted, k, {
        value: canonicalizeValue(value[k]),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  return sorted;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'null' : serialized;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        return 'null';
      }
      return canonicalStringify(item);
    });
    return '[' + items.join(',') + ']';
  }
  if (typeof value.toJSON === 'function') {
    return canonicalStringify(value.toJSON());
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
      parts.push(JSON.stringify(k) + ':' + canonicalStringify(v));
    }
  }
  return '{' + parts.join(',') + '}';
}

function computeIdempotencyHash(payload) {
  const canonical = canonicalStringify(payload === undefined ? null : payload);
  return sha256Hex(canonical);
}

function normalizeArrayField(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeLiveTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  return {
    ...ticket,
    winningDetails: normalizeArrayField(ticket.winningDetails)
  };
}

function normalizeIdempotencyKey(key) {
  if (typeof key !== 'string') return '';
  return key.trim();
}

function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return null;

  const balance = Number(user.balance) || 0;
  const totalBet = Number(user.totalBet) || 0;
  const totalWon = Number(user.totalWon) || 0;
  const netProfit = Number.isFinite(Number(user.netProfit))
    ? Number(user.netProfit)
    : (totalWon - totalBet);

  let fairness = null;
  if (user.fairness && typeof user.fairness === 'object') {
    fairness = {
      serverSeedHash: user.fairness.serverSeedHash || '',
      clientSeed: user.fairness.clientSeed || sicboEngine.DEFAULT_CLIENT_SEED,
      nonce: Number(user.fairness.nonce) || 0,
      lastRevealed: user.fairness.lastRevealed ? deepClone(user.fairness.lastRevealed) : null
    };
  }

  return {
    id: String(user.id),
    username: String(user.username || ''),
    displayName: String(user.displayName || user.username || ''),
    role: user.role === 'admin' ? 'admin' : 'user',
    isGuest: Boolean(user.isGuest),
    locked: Boolean(user.locked),
    balance,
    totalBet,
    totalWon,
    netProfit,
    rounds: Number(user.rounds) || 0,
    winRounds: Number(user.winRounds) || 0,
    sessionVersion: Number.isInteger(user.sessionVersion) && user.sessionVersion >= 1
      ? user.sessionVersion
      : 1,
    lastDailyBonusAt: user.lastDailyBonusAt ?? null,
    lastBankruptcyAidAt: user.lastBankruptcyAidAt ?? null,
    fairness,
    createdAt: Number(user.createdAt) || 0,
    updatedAt: Number(user.updatedAt) || 0
  };
}

function buildLeaderboardRow(user) {
  return {
    id: String(user.id),
    username: String(user.username || ''),
    displayName: String(user.displayName || user.username || ''),
    isGuest: Boolean(user.isGuest),
    role: user.role === 'admin' ? 'admin' : 'user',
    balance: Number(user.balance) || 0,
    netProfit: Number(user.netProfit) || 0,
    totalBet: Number(user.totalBet) || 0,
    totalWon: Number(user.totalWon) || 0,
    rounds: Number(user.rounds) || 0,
    winRounds: Number(user.winRounds) || 0
  };
}

function sortLeaderboardRows(users, mode) {
  const active = users.filter((u) => u && !u.locked);
  const sorted = active.slice().sort((a, b) => {
    if (mode === 'byNetProfit') {
      if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
      if (b.balance !== a.balance) return b.balance - a.balance;
    } else {
      if (b.balance !== a.balance) return b.balance - a.balance;
      if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
    }
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return sorted;
}

function readLegacySeedHistory(rootDir, seedLegacyHistory) {
  if (seedLegacyHistory === false) {
    return { items: [], nextRoundId: 1001 };
  }
  const legacyPath = path.join(rootDir, 'data', 'history.json');
  try {
    if (fs.existsSync(legacyPath)) {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const clean = parsed
          .filter((item) => item && Array.isArray(item.dice) && item.dice.length === 3)
          .slice(-MAX_GLOBAL_HISTORY)
          .map((item) => deepClone(item));
        const maxId = clean.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 1000);
        return { items: clean, nextRoundId: maxId + 1 };
      }
    }
  } catch (_) {
    // Ignore unreadable legacy seed file and fall back cleanly
  }
  return { items: [], nextRoundId: 1001 };
}

function buildInitialUserRecord(params, config) {
  const now = Number.isFinite(params.now) ? params.now : Date.now();
  const username = typeof params.username === 'string' ? params.username.trim() : '';
  if (!username) {
    throw makeDbError('INVALID_INPUT', 400, 'Username is required');
  }
  const usernameLower = username.toLowerCase();
  const isGuest = Boolean(params.isGuest);
  const role = params.role === 'admin' ? 'admin' : 'user';
  const defaultBalance = isGuest ? config.GUEST_INITIAL_BALANCE : config.INITIAL_BALANCE;
  const balance = params.balance !== undefined ? params.balance : defaultBalance;

  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw makeDbError('INVALID_INPUT', 400, 'Initial balance must be a non-negative safe integer');
  }

  const serverSeed = (typeof params.serverSeed === 'string' && params.serverSeed.trim())
    ? params.serverSeed.trim()
    : crypto.randomBytes(32).toString('hex');
  const serverSeedHash = (typeof params.serverSeedHash === 'string' && params.serverSeedHash.trim())
    ? params.serverSeedHash.trim()
    : sha256Hex(serverSeed);
  const clientSeed = (typeof params.clientSeed === 'string' && params.clientSeed.trim())
    ? params.clientSeed.trim()
    : config.DEFAULT_CLIENT_SEED;

  return {
    id: params.id || crypto.randomUUID(),
    username,
    usernameLower,
    displayName: (typeof params.displayName === 'string' && params.displayName.trim())
      ? params.displayName.trim()
      : username,
    role,
    isGuest,
    locked: Boolean(params.locked),
    sessionVersion: 1,
    passwordHash: params.passwordHash ?? null,
    recoveryCodeHash: params.recoveryCodeHash ?? null,
    balance,
    totalBet: 0,
    totalWon: 0,
    netProfit: 0,
    rounds: 0,
    winRounds: 0,
    lastDailyBonusAt: null,
    lastBankruptcyAidAt: null,
    fairness: {
      serverSeed,
      serverSeedHash,
      clientSeed,
      nonce: 0,
      lastRevealed: null
    },
    casVersion: 0,
    createdAt: now,
    updatedAt: now
  };
}

function resolveRollOutcome({ user, cleanBets, totalBet, effectiveClientSeed, resolveFn }) {
  const usedNonce = Number(user.fairness?.nonce) || 0;
  let dice;
  let hmacHex = null;
  let evaluation = null;

  if (typeof resolveFn === 'function') {
    const custom = resolveFn({
      user: sanitizeUser(user),
      fairness: deepClone(user.fairness),
      nonce: usedNonce,
      clientSeed: effectiveClientSeed,
      bets: deepClone(cleanBets),
      totalBet
    });
    if (!custom || typeof custom !== 'object') {
      throw makeDbError('INVALID_INPUT', 500, 'resolveFn must return an object');
    }
    if (custom.evaluation && typeof custom.evaluation === 'object') {
      evaluation = custom.evaluation;
      dice = evaluation.dice;
      hmacHex = custom.hmacHex || null;
    } else if (Array.isArray(custom.dice) && typeof custom.totalWin === 'number') {
      evaluation = custom;
      dice = custom.dice;
      hmacHex = custom.hmacHex || null;
    } else {
      dice = custom.dice;
      hmacHex = custom.hmacHex || null;
    }
  } else {
    const derived = deriveFairDice(user.fairness.serverSeed, effectiveClientSeed, usedNonce);
    dice = derived.dice;
    hmacHex = derived.hmacHex;
  }

  if (!evaluation) {
    evaluation = evaluateRoll(dice, cleanBets);
  }

  return {
    usedNonce,
    effectiveClientSeed,
    hmacHex,
    evaluation
  };
}

// ============================================================================
// 1. JSON FILE STORE BACKEND (Async Mutex + Atomic Temp-File Rename)
// ============================================================================

function createJsonBackend(config, opts) {
  const dbFileName = opts.dbFileName || 'db.json';
  const dbFilePath = path.join(config.dataDir, dbFileName);

  let mutexTail = Promise.resolve();
  let state = null;
  let initialized = false;

  function withMutex(fn) {
    const run = mutexTail.then(() => fn());
    // Never poison the mutex chain on rejected operations
    mutexTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function writeStateAtomic(nextState) {
    const dir = path.dirname(dbFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpName = `${path.basename(dbFilePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const tmpPath = path.join(dir, tmpName);
    const payload = JSON.stringify(nextState, null, 2);
    try {
      await fs.promises.writeFile(tmpPath, payload, 'utf8');
      await fs.promises.rename(tmpPath, dbFilePath);
    } catch (err) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch (_) {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  function createEmptyState() {
    const seed = readLegacySeedHistory(config.rootDir, opts.seedLegacyHistory);
    return {
      version: 1,
      nextRoundId: seed.nextRoundId,
      users: Object.create(null),
      usernameIndex: Object.create(null),
      ledgerByUser: Object.create(null),
      personalByUser: Object.create(null),
      globalHistory: seed.items,
      liveTickets: Object.create(null),
      idempotency: Object.create(null)
    };
  }

  function normalizeLoadedState(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createEmptyState();
    }
    const base = createEmptyState();
    return {
      version: 1,
      nextRoundId: Number.isSafeInteger(parsed.nextRoundId) ? parsed.nextRoundId : base.nextRoundId,
      users: isPlainObject(parsed.users) ? parsed.users : Object.create(null),
      usernameIndex: isPlainObject(parsed.usernameIndex) ? parsed.usernameIndex : Object.create(null),
      ledgerByUser: isPlainObject(parsed.ledgerByUser) ? parsed.ledgerByUser : Object.create(null),
      personalByUser: isPlainObject(parsed.personalByUser) ? parsed.personalByUser : Object.create(null),
      globalHistory: Array.isArray(parsed.globalHistory) ? parsed.globalHistory : base.globalHistory,
      liveTickets: isPlainObject(parsed.liveTickets) ? parsed.liveTickets : Object.create(null),
      idempotency: isPlainObject(parsed.idempotency) ? parsed.idempotency : Object.create(null)
    };
  }

  async function ensureInit() {
    if (initialized && state) return;
    await fs.promises.mkdir(path.dirname(dbFilePath), { recursive: true });
    if (fs.existsSync(dbFilePath)) {
      const raw = await fs.promises.readFile(dbFilePath, 'utf8');
      state = normalizeLoadedState(JSON.parse(raw));
    } else {
      state = createEmptyState();
      await writeStateAtomic(state);
    }
    initialized = true;
  }

  function pruneIdempotency(now) {
    const keys = Object.keys(state.idempotency);
    if (keys.length <= MAX_JSON_IDEMPOTENCY_ENTRIES) return;
    for (const k of keys) {
      const rec = state.idempotency[k];
      if (!rec || (now - (rec.createdAt || 0)) > IDEMPOTENCY_TTL_MS) {
        delete state.idempotency[k];
      }
    }
    const remaining = Object.keys(state.idempotency);
    if (remaining.length > MAX_JSON_IDEMPOTENCY_ENTRIES) {
      remaining.sort((a, b) => (state.idempotency[a].createdAt || 0) - (state.idempotency[b].createdAt || 0));
      const removeCount = remaining.length - MAX_JSON_IDEMPOTENCY_ENTRIES;
      for (let i = 0; i < removeCount; i++) {
        delete state.idempotency[remaining[i]];
      }
    }
  }

  function idemCompoundKey(userId, scope, key) {
    return `${userId}\u0000${scope}\u0000${key}`;
  }

  function checkIdempotency(userId, scope, cleanKey, requestHash, now) {
    if (!cleanKey) return null;
    const ck = idemCompoundKey(userId, scope, cleanKey);
    const existing = state.idempotency[ck];
    if (!existing) return null;
    if ((now - (existing.createdAt || 0)) > IDEMPOTENCY_TTL_MS) {
      delete state.idempotency[ck];
      return null;
    }
    if (existing.requestHash !== requestHash) {
      throw makeDbError(
        'IDEMPOTENCY_CONFLICT',
        409,
        'Idempotency-Key reused with different request payload'
      );
    }
    return { ...deepClone(existing.response), replayed: true };
  }

  function saveIdempotency(userId, scope, cleanKey, requestHash, response, now) {
    if (!cleanKey) return;
    pruneIdempotency(now);
    const ck = idemCompoundKey(userId, scope, cleanKey);
    state.idempotency[ck] = {
      userId,
      scope,
      key: cleanKey,
      requestHash,
      response: deepClone(response),
      createdAt: now
    };
  }

  function pushLedger(userId, entry) {
    if (!Array.isArray(state.ledgerByUser[userId])) {
      state.ledgerByUser[userId] = [];
    }
    state.ledgerByUser[userId].unshift(entry);
    if (state.ledgerByUser[userId].length > MAX_LEDGER_PER_USER) {
      state.ledgerByUser[userId].length = MAX_LEDGER_PER_USER;
    }
  }

  function pushPersonalHistory(userId, entry) {
    if (!Array.isArray(state.personalByUser[userId])) {
      state.personalByUser[userId] = [];
    }
    state.personalByUser[userId].unshift(entry);
    if (state.personalByUser[userId].length > MAX_PERSONAL_HISTORY_PER_USER) {
      state.personalByUser[userId].length = MAX_PERSONAL_HISTORY_PER_USER;
    }
  }

  function pushGlobalHistory(entry) {
    state.globalHistory.push(entry);
    if (state.globalHistory.length > MAX_GLOBAL_HISTORY) {
      state.globalHistory = state.globalHistory.slice(-MAX_GLOBAL_HISTORY);
    }
  }

  return {
    async init() {
      return withMutex(() => ensureInit());
    },
    async close() {
      return undefined;
    },
    getFilePath() {
      return dbFilePath;
    },
    async getUserById(userId) {
      return withMutex(async () => {
        await ensureInit();
        const u = state.users[userId];
        return u ? deepClone(u) : null;
      });
    },
    async getUserByUsername(username) {
      return withMutex(async () => {
        await ensureInit();
        if (typeof username !== 'string' || !username.trim()) return null;
        const userId = state.usernameIndex[username.trim().toLowerCase()];
        if (!userId) return null;
        const u = state.users[userId];
        return u ? deepClone(u) : null;
      });
    },
    async createUser(params) {
      return withMutex(async () => {
        await ensureInit();
        const user = buildInitialUserRecord(params, config);
        if (state.usernameIndex[user.usernameLower]) {
          throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
        }
        state.users[user.id] = user;
        state.usernameIndex[user.usernameLower] = user.id;
        state.ledgerByUser[user.id] = [];
        state.personalByUser[user.id] = [];
        await writeStateAtomic(state);
        return deepClone(user);
      });
    },
    async upgradeGuestAtomic({ userId, username, displayName, passwordHash, recoveryCodeHash, role = 'user', now = Date.now() }) {
      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (!user.isGuest) throw makeDbError('NOT_A_GUEST', 400, 'Tài khoản này không phải tài khoản Khách.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const cleanUsername = typeof username === 'string' ? username.trim() : '';
        if (!cleanUsername) throw makeDbError('INVALID_INPUT', 400, 'Tên đăng nhập không hợp lệ.');
        const nextLower = cleanUsername.toLowerCase();

        const existingOwnerId = state.usernameIndex[nextLower];
        if (existingOwnerId && existingOwnerId !== userId) {
          throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
        }

        const oldLower = user.usernameLower;
        if (oldLower && oldLower !== nextLower && state.usernameIndex[oldLower] === userId) {
          delete state.usernameIndex[oldLower];
        }
        state.usernameIndex[nextLower] = userId;

        user.username = cleanUsername;
        user.usernameLower = nextLower;
        user.displayName = (typeof displayName === 'string' && displayName.trim())
          ? displayName.trim()
          : cleanUsername;
        user.passwordHash = passwordHash;
        user.recoveryCodeHash = recoveryCodeHash;
        user.role = role === 'admin' ? 'admin' : 'user';
        user.isGuest = false;
        user.sessionVersion = (Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1) + 1;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        await writeStateAtomic(state);
        return deepClone(user);
      });
    },
    async updateUserPassword({ userId, passwordHash, recoveryCodeHash, expectedRecoveryCodeHash, bumpSessionVersion = true, now = Date.now() }) {
      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (expectedRecoveryCodeHash !== undefined && user.recoveryCodeHash !== expectedRecoveryCodeHash) {
          throw makeDbError('INVALID_RECOVERY_CODE', 401, 'Tên đăng nhập hoặc mã khôi phục không hợp lệ.');
        }
        user.passwordHash = passwordHash;
        if (recoveryCodeHash !== undefined) {
          user.recoveryCodeHash = recoveryCodeHash;
        }
        if (bumpSessionVersion !== false) {
          user.sessionVersion = (Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1) + 1;
        }
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;
        await writeStateAtomic(state);
        return deepClone(user);
      });
    },
    async toggleUserLock({ userId, locked, now = Date.now() }) {
      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        user.locked = typeof locked === 'boolean' ? locked : !user.locked;
        user.sessionVersion = (Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1) + 1;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;
        await writeStateAtomic(state);
        return deepClone(user);
      });
    },
    async listUsers({ q = '', limit = 50, offset = 0 } = {}) {
      return withMutex(async () => {
        await ensureInit();
        const query = typeof q === 'string' ? q.trim().toLowerCase() : '';
        let all = Object.values(state.users);
        if (query) {
          all = all.filter((u) => (
            (u.username && u.username.toLowerCase().includes(query)) ||
            (u.displayName && u.displayName.toLowerCase().includes(query)) ||
            (u.id && String(u.id).toLowerCase().includes(query))
          ));
        }
        all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const safeOffset = Math.max(0, Number(offset) || 0);
        const safeLimit = Math.max(1, Number(limit) || 50);
        return {
          users: all.slice(safeOffset, safeOffset + safeLimit).map((u) => sanitizeUser(u)),
          total: all.length
        };
      });
    },
    async rotateFairnessAtomic({ userId, newServerSeed, newServerSeedHash, newClientSeed, now = Date.now() }) {
      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const previous = {
          serverSeed: user.fairness.serverSeed,
          serverSeedHash: user.fairness.serverSeedHash,
          clientSeed: user.fairness.clientSeed,
          finalNonce: Number(user.fairness.nonce) || 0
        };

        const nextServerSeed = (typeof newServerSeed === 'string' && newServerSeed.trim())
          ? newServerSeed.trim()
          : crypto.randomBytes(32).toString('hex');
        const nextServerSeedHash = (typeof newServerSeedHash === 'string' && newServerSeedHash.trim())
          ? newServerSeedHash.trim()
          : sha256Hex(nextServerSeed);
        const nextClientSeed = (typeof newClientSeed === 'string' && newClientSeed.trim())
          ? newClientSeed.trim()
          : user.fairness.clientSeed;

        user.fairness = {
          serverSeed: nextServerSeed,
          serverSeedHash: nextServerSeedHash,
          clientSeed: nextClientSeed,
          nonce: 0,
          lastRevealed: previous
        };
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        await writeStateAtomic(state);
        return {
          previous,
          current: {
            serverSeedHash: nextServerSeedHash,
            clientSeed: nextClientSeed,
            nonce: 0,
            lastRevealed: previous
          },
          user: sanitizeUser(user)
        };
      });
    },
    async placeManualRollAtomic({ userId, bets, totalBet, clientSeed, idempotencyKey, idempotencyHash, resolveFn, now = Date.now() }) {
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const effectiveClientSeedInput = (typeof clientSeed === 'string' && clientSeed.trim())
        ? clientSeed.trim()
        : null;

      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        const reqHash = idempotencyHash || computeIdempotencyHash({
          bets: cleanBets,
          clientSeed: effectiveClientSeedInput || (user ? user.fairness.clientSeed : '')
        });
        const replayed = checkIdempotency(userId, 'manual_roll', cleanKey, reqHash, now);
        if (replayed) return replayed;

        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');
        if (user.balance < expectedTotalBet) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư không đủ để đặt cược.');
        }

        const effectiveClientSeed = effectiveClientSeedInput || user.fairness.clientSeed;
        const { usedNonce, hmacHex, evaluation } = resolveRollOutcome({
          user,
          cleanBets,
          totalBet: expectedTotalBet,
          effectiveClientSeed,
          resolveFn
        });

        const roundId = state.nextRoundId;
        state.nextRoundId += 1;

        const b0 = user.balance;
        const b1 = b0 - expectedTotalBet;
        const b2 = b1 + evaluation.totalWin;

        const betEntry = {
          id: crypto.randomUUID(),
          userId,
          type: 'bet',
          amount: -expectedTotalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Tự Lắc #${roundId}`,
          refId: `manual:${roundId}`,
          timestamp: now
        };
        pushLedger(userId, betEntry);

        let winEntry = null;
        if (evaluation.totalWin > 0) {
          winEntry = {
            id: crypto.randomUUID(),
            userId,
            type: 'win',
            amount: evaluation.totalWin,
            balanceBefore: b1,
            balanceAfter: b2,
            reason: `Thắng Tự Lắc #${roundId}`,
            refId: `manual:${roundId}`,
            timestamp: now
          };
          pushLedger(userId, winEntry);
        }

        user.balance = b2;
        user.totalBet += expectedTotalBet;
        user.totalWon += evaluation.totalWin;
        user.netProfit += evaluation.netProfit;
        user.rounds += 1;
        if (evaluation.netProfit > 0) {
          user.winRounds += 1;
        }
        user.fairness.nonce = usedNonce + 1;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        const fairnessProof = {
          roundId,
          serverSeedHash: user.fairness.serverSeedHash,
          clientSeed: effectiveClientSeed,
          nonce: usedNonce,
          hmacHex
        };

        pushPersonalHistory(userId, {
          roundId,
          timestamp: now,
          mode: 'manual',
          bets: cleanBets,
          dice: evaluation.dice,
          total: evaluation.total,
          isTriple: evaluation.isTriple,
          outcome: evaluation.outcome,
          totalBet: expectedTotalBet,
          totalWin: evaluation.totalWin,
          netProfit: evaluation.netProfit,
          balanceAfter: b2,
          fairness: fairnessProof
        });

        pushGlobalHistory({
          id: roundId,
          dice: evaluation.dice,
          total: evaluation.total,
          isTriple: evaluation.isTriple,
          outcome: evaluation.outcome,
          serverSeedHash: user.fairness.serverSeedHash,
          nonce: usedNonce,
          timestamp: now
        });

        const response = {
          replayed: false,
          roundId,
          mode: 'manual',
          dice: evaluation.dice,
          total: evaluation.total,
          isTriple: evaluation.isTriple,
          outcome: evaluation.outcome,
          totalBet: expectedTotalBet,
          totalWin: evaluation.totalWin,
          netProfit: evaluation.netProfit,
          newBalance: b2,
          winningDetails: evaluation.winningDetails,
          fairness: {
            serverSeedHash: user.fairness.serverSeedHash,
            clientSeed: effectiveClientSeed,
            nonce: usedNonce
          },
          ledgerEntries: winEntry ? [betEntry, winEntry] : [betEntry],
          user: sanitizeUser(user)
        };

        saveIdempotency(userId, 'manual_roll', cleanKey, reqHash, response, now);
        await writeStateAtomic(state);
        return response;
      });
    },
    async placeLiveBetAtomic({ userId, liveRoundId, bets, totalBet, idempotencyKey, idempotencyHash, now = Date.now() }) {
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ liveRoundId, bets: cleanBets });

      return withMutex(async () => {
        await ensureInit();
        const replayed = checkIdempotency(userId, 'live_bet', cleanKey, reqHash, now);
        if (replayed) return replayed;

        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const ticketKey = `${liveRoundId}:${userId}`;
        const existingTicket = state.liveTickets[ticketKey];
        if (existingTicket && existingTicket.settled) {
          throw makeDbError('ROUND_ALREADY_SETTLED', 409, 'Phiên Live này đã mở bát kết toán.');
        }

        if (existingTicket && existingTicket.bets) {
          for (const [gate, amt] of Object.entries(cleanBets)) {
            const prevAmt = Number(existingTicket.bets[gate]) || 0;
            if (!Number.isSafeInteger(prevAmt + amt) || (prevAmt + amt) > sicboEngine.MAX_SINGLE_BET) {
              throw makeDbError(
                'INVALID_BETS',
                400,
                `Tổng cược cho cửa ${gate} trong phiên Live không được vượt quá ${sicboEngine.MAX_SINGLE_BET}.`
              );
            }
          }
        }

        if (user.balance < expectedTotalBet) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư không đủ để đặt cược.');
        }

        const b0 = user.balance;
        const b1 = b0 - expectedTotalBet;
        const ledgerEntry = {
          id: crypto.randomUUID(),
          userId,
          type: 'bet',
          amount: -expectedTotalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Phòng Live #${liveRoundId}`,
          refId: `live:${liveRoundId}`,
          timestamp: now
        };
        pushLedger(userId, ledgerEntry);

        let ticket = existingTicket;
        if (!ticket) {
          ticket = {
            liveRoundId,
            userId,
            bets: {},
            totalBet: 0,
            settled: false,
            dice: null,
            total: null,
            isTriple: null,
            outcome: null,
            totalWin: 0,
            netProfit: 0,
            winningDetails: [],
            createdAt: now,
            updatedAt: now,
            settledAt: null
          };
          state.liveTickets[ticketKey] = ticket;
        }

        for (const [k, amt] of Object.entries(cleanBets)) {
          ticket.bets[k] = (ticket.bets[k] || 0) + amt;
        }
        ticket.totalBet += expectedTotalBet;
        ticket.updatedAt = now;

        user.balance = b1;
        user.totalBet += expectedTotalBet;
        user.netProfit -= expectedTotalBet;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        const response = {
          replayed: false,
          liveRoundId,
          ticket: deepClone(ticket),
          newBalance: b1,
          ledgerEntry,
          user: sanitizeUser(user)
        };

        saveIdempotency(userId, 'live_bet', cleanKey, reqHash, response, now);
        await writeStateAtomic(state);
        return response;
      });
    },
    async getLiveTicket({ userId, liveRoundId }) {
      return withMutex(async () => {
        await ensureInit();
        const ticket = state.liveTickets[`${liveRoundId}:${userId}`];
        return ticket ? deepClone(ticket) : null;
      });
    },
    async getUnsettledLiveTickets(userId) {
      return withMutex(async () => {
        await ensureInit();
        return Object.values(state.liveTickets)
          .filter((t) => t && t.userId === userId && !t.settled)
          .sort((a, b) => a.liveRoundId - b.liveRoundId)
          .map((t) => deepClone(t));
      });
    },
    async settleLiveRoundAtomic({ userId, liveRoundId, dice, evaluation, roundSeedHash = null, now = Date.now() }) {
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }
      return withMutex(async () => {
        await ensureInit();
        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');

        const ticketKey = `${liveRoundId}:${userId}`;
        const ticket = state.liveTickets[ticketKey];
        if (!ticket) {
          throw makeDbError('TICKET_NOT_FOUND', 404, 'Không tìm thấy vé cược cho phiên Live này.');
        }

        if (ticket.settled) {
          return {
            alreadySettled: true,
            settledNow: false,
            liveRoundId,
            settled: true,
            ticket: deepClone(ticket),
            newBalance: user.balance,
            ledgerEntry: null,
            user: sanitizeUser(user)
          };
        }

        const effectiveEval = (dice && Array.isArray(dice))
          ? evaluateRoll(dice, ticket.bets)
          : evaluation;
        if (!effectiveEval || !Array.isArray(effectiveEval.dice)) {
          throw makeDbError('INVALID_INPUT', 400, 'Dice or evaluation is required to settle live round');
        }

        ticket.settled = true;
        ticket.dice = effectiveEval.dice;
        ticket.total = effectiveEval.total;
        ticket.isTriple = effectiveEval.isTriple;
        ticket.outcome = effectiveEval.outcome;
        ticket.totalWin = effectiveEval.totalWin;
        ticket.netProfit = effectiveEval.totalWin - ticket.totalBet;
        ticket.winningDetails = effectiveEval.winningDetails;
        ticket.settledAt = now;
        ticket.updatedAt = now;

        const b0 = user.balance;
        const b1 = b0 + effectiveEval.totalWin;

        let ledgerEntry = null;
        if (effectiveEval.totalWin > 0) {
          ledgerEntry = {
            id: crypto.randomUUID(),
            userId,
            type: 'win',
            amount: effectiveEval.totalWin,
            balanceBefore: b0,
            balanceAfter: b1,
            reason: `Thắng Phòng Live #${liveRoundId}`,
            refId: `live:${liveRoundId}`,
            timestamp: now
          };
          pushLedger(userId, ledgerEntry);
        }

        user.balance = b1;
        user.totalWon += effectiveEval.totalWin;
        user.netProfit += effectiveEval.totalWin;
        user.rounds += 1;
        if (ticket.netProfit > 0) {
          user.winRounds += 1;
        }
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        pushPersonalHistory(userId, {
          roundId: liveRoundId,
          timestamp: now,
          mode: 'live',
          bets: deepClone(ticket.bets),
          dice: effectiveEval.dice,
          total: effectiveEval.total,
          isTriple: effectiveEval.isTriple,
          outcome: effectiveEval.outcome,
          totalBet: ticket.totalBet,
          totalWin: effectiveEval.totalWin,
          netProfit: ticket.netProfit,
          balanceAfter: b1,
          fairness: {
            liveRoundId,
            roundSeedHash
          }
        });

        const alreadyInGlobal = state.globalHistory.some((item) => item.liveRoundId === liveRoundId);
        if (!alreadyInGlobal) {
          const globalId = state.nextRoundId;
          state.nextRoundId += 1;
          pushGlobalHistory({
            id: globalId,
            liveRoundId,
            dice: effectiveEval.dice,
            total: effectiveEval.total,
            isTriple: effectiveEval.isTriple,
            outcome: effectiveEval.outcome,
            serverSeedHash: roundSeedHash || undefined,
            timestamp: now
          });
        }

        await writeStateAtomic(state);
        return {
          alreadySettled: false,
          settledNow: true,
          liveRoundId,
          settled: true,
          ticket: deepClone(ticket),
          newBalance: b1,
          ledgerEntry,
          user: sanitizeUser(user)
        };
      });
    },
    async adjustBalanceAtomic({
      userId,
      delta,
      type,
      reason = '',
      refId = null,
      idempotencyKey,
      idempotencyHash,
      allowLocked = false,
      minBalanceAfter = 0,
      cooldownField = null,
      cooldownMs = 0,
      maxBalanceBefore = null,
      now = Date.now()
    }) {
      if (!LEDGER_TYPE_SET.has(type)) {
        throw makeDbError('INVALID_INPUT', 400, `Unsupported ledger type: ${type}`);
      }
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Balance delta must be a non-zero safe integer');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ delta, type, reason, refId });

      return withMutex(async () => {
        await ensureInit();
        const replayed = checkIdempotency(userId, type, cleanKey, reqHash, now);
        if (replayed) return replayed;

        const user = state.users[userId];
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (!allowLocked && user.locked) {
          throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');
        }
        if (maxBalanceBefore !== null && user.balance >= maxBalanceBefore) {
          throw makeDbError('BANKRUPTCY_INELIGIBLE', 400, 'Số dư hiện tại chưa đủ điều kiện nhận trợ cấp.');
        }
        if (cooldownField && cooldownMs > 0) {
          const lastAt = user[cooldownField];
          if (typeof lastAt === 'number' && (now - lastAt) < cooldownMs) {
            throw makeDbError('COOLDOWN_ACTIVE', 429, 'Chưa hết thời gian chờ nhận thưởng.', {
              nextEligibleAt: lastAt + cooldownMs
            });
          }
        }

        const b0 = user.balance;
        const b1 = b0 + delta;
        if (!Number.isSafeInteger(b1)) {
          throw makeDbError('INVALID_AMOUNT', 400, 'Số dư sau điều chỉnh vượt quá giới hạn an toàn.');
        }
        if (b1 < minBalanceAfter) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư sau điều chỉnh không được âm.');
        }

        const ledgerEntry = {
          id: crypto.randomUUID(),
          userId,
          type,
          amount: delta,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: String(reason || ''),
          refId: refId ?? null,
          timestamp: now
        };
        pushLedger(userId, ledgerEntry);

        user.balance = b1;
        if (cooldownField) {
          user[cooldownField] = now;
        }
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;

        const response = {
          replayed: false,
          user: sanitizeUser(user),
          balance: b1,
          ledgerEntry,
          nextEligibleAt: (cooldownField && cooldownMs > 0) ? (now + cooldownMs) : null
        };

        saveIdempotency(userId, type, cleanKey, reqHash, response, now);
        await writeStateAtomic(state);
        return response;
      });
    },
    async getWalletLedger(userId, limit = 50) {
      return withMutex(async () => {
        await ensureInit();
        const entries = state.ledgerByUser[userId] || [];
        return deepClone(entries.slice(0, Math.max(0, limit)));
      });
    },
    async getPersonalHistory(userId, limit = 40) {
      return withMutex(async () => {
        await ensureInit();
        const entries = state.personalByUser[userId] || [];
        return deepClone(entries.slice(0, Math.max(0, limit)));
      });
    },
    async getGlobalHistory(limit = 60) {
      return withMutex(async () => {
        await ensureInit();
        const safeLimit = Math.max(0, limit);
        if (safeLimit === 0) return [];
        return deepClone(state.globalHistory.slice(-safeLimit));
      });
    },
    async getLeaderboard(limit = 20) {
      return withMutex(async () => {
        await ensureInit();
        const safeLimit = Math.max(1, limit);
        const allUsers = Object.values(state.users);
        return {
          byBalance: sortLeaderboardRows(allUsers, 'byBalance').slice(0, safeLimit).map(buildLeaderboardRow),
          byNetProfit: sortLeaderboardRows(allUsers, 'byNetProfit').slice(0, safeLimit).map(buildLeaderboardRow)
        };
      });
    }
  };
}

// ============================================================================
// 2. UPSTASH REDIS REST BACKEND (POST / ["EVAL", script, numkeys, ...])
// ============================================================================

const LUA_CREATE_USER = `
local unameKey = KEYS[1]
local userKey = KEYS[2]
local idxKey = KEYS[3]
local lbBalKey = KEYS[4]
local lbProfKey = KEYS[5]
local userId = ARGV[1]
local userJson = ARGV[2]
local balance = tonumber(ARGV[3])
local netProfit = tonumber(ARGV[4])
if redis.call('EXISTS', unameKey) == 1 then
  return cjson.encode({ err = 'USERNAME_TAKEN' })
end
redis.call('SET', unameKey, userId)
redis.call('SET', userKey, userJson)
redis.call('SADD', idxKey, userId)
redis.call('ZADD', lbBalKey, balance, userId)
redis.call('ZADD', lbProfKey, netProfit, userId)
return cjson.encode({ ok = true })
`;

const LUA_UPGRADE_GUEST = `
local userKey = KEYS[1]
local idxKey = KEYS[2]
local lbBalKey = KEYS[3]
local lbProfKey = KEYS[4]
local prefix = ARGV[1]
local userId = ARGV[2]
local username = ARGV[3]
local nextLower = ARGV[4]
local displayName = ARGV[5]
local passwordHash = ARGV[6]
local recoveryCodeHash = ARGV[7]
local role = ARGV[8]
local now = tonumber(ARGV[9])

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if not user.isGuest then
  return cjson.encode({ err = 'NOT_A_GUEST' })
end
if user.locked then
  return cjson.encode({ err = 'USER_LOCKED' })
end

local nextUnameKey = prefix .. 'uname:' .. nextLower
local existingOwner = redis.call('GET', nextUnameKey)
if existingOwner and existingOwner ~= userId then
  return cjson.encode({ err = 'USERNAME_TAKEN' })
end

if user.usernameLower and user.usernameLower ~= nextLower then
  local oldKey = prefix .. 'uname:' .. user.usernameLower
  if redis.call('GET', oldKey) == userId then
    redis.call('DEL', oldKey)
  end
end
redis.call('SET', nextUnameKey, userId)

user.username = username
user.usernameLower = nextLower
user.displayName = displayName
user.passwordHash = passwordHash
user.recoveryCodeHash = recoveryCodeHash
user.role = role
user.isGuest = false
user.sessionVersion = (user.sessionVersion or 1) + 1
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now

local encoded = cjson.encode(user)
redis.call('SET', userKey, encoded)
redis.call('SADD', idxKey, userId)
redis.call('ZADD', lbBalKey, user.balance or 0, userId)
redis.call('ZADD', lbProfKey, user.netProfit or 0, userId)
return encoded
`;

const LUA_ROTATE_FAIRNESS = `
local userKey = KEYS[1]
local newServerSeed = ARGV[1]
local newServerSeedHash = ARGV[2]
local newClientSeed = ARGV[3]
local now = tonumber(ARGV[4])

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if user.locked then
  return cjson.encode({ err = 'USER_LOCKED' })
end

local previous = {
  serverSeed = user.fairness.serverSeed,
  serverSeedHash = user.fairness.serverSeedHash,
  clientSeed = user.fairness.clientSeed,
  finalNonce = user.fairness.nonce or 0
}
local effectiveClient = (newClientSeed ~= '' and newClientSeed) or user.fairness.clientSeed
user.fairness = {
  serverSeed = newServerSeed,
  serverSeedHash = newServerSeedHash,
  clientSeed = effectiveClient,
  nonce = 0,
  lastRevealed = previous
}
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now

redis.call('SET', userKey, cjson.encode(user))
return cjson.encode({ ok = true, previous = previous, user = user })
`;

const LUA_UPDATE_USER_PASSWORD = `
local userKey = KEYS[1]
local pwMode = ARGV[1]
local passwordHash = ARGV[2]
local recMode = ARGV[3]
local recoveryCodeHash = ARGV[4]
local bumpSv = (ARGV[5] == '1')
local now = tonumber(ARGV[6])
local checkExpectedRec = (ARGV[7] == '1')
local expectedRecHash = ARGV[8]

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if checkExpectedRec then
  local curRec = user.recoveryCodeHash
  if curRec == cjson.null or curRec == nil then
    curRec = ''
  end
  if curRec ~= expectedRecHash then
    return cjson.encode({ err = 'INVALID_RECOVERY_CODE' })
  end
end
if pwMode == 'null' then
  user.passwordHash = cjson.null
else
  user.passwordHash = passwordHash
end
if recMode == '1' then
  user.recoveryCodeHash = recoveryCodeHash
elseif recMode == '2' then
  user.recoveryCodeHash = cjson.null
end
if bumpSv then
  user.sessionVersion = (tonumber(user.sessionVersion) or 1) + 1
end
user.casVersion = (tonumber(user.casVersion) or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))
return cjson.encode({ ok = true, user = user })
`;

const LUA_TOGGLE_USER_LOCK = `
local userKey = KEYS[1]
local lockMode = ARGV[1]
local now = tonumber(ARGV[2])

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if lockMode == 'true' then
  user.locked = true
elseif lockMode == 'false' then
  user.locked = false
else
  user.locked = not (user.locked == true)
end
user.sessionVersion = (tonumber(user.sessionVersion) or 1) + 1
user.casVersion = (tonumber(user.casVersion) or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))
return cjson.encode({ ok = true, user = user })
`;

const LUA_PLACE_MANUAL_ROLL = `
local userKey = KEYS[1]
local ledgerKey = KEYS[2]
local personalKey = KEYS[3]
local globalKey = KEYS[4]
local roundSeqKey = KEYS[5]
local lbBalKey = KEYS[6]
local lbProfKey = KEYS[7]
local idemKey = KEYS[8]

local hasIdem = ARGV[1]
local reqHash = ARGV[2]
local expectedCas = tonumber(ARGV[3])
local totalBet = tonumber(ARGV[4])
local totalWin = tonumber(ARGV[5])
local netProfit = tonumber(ARGV[6])
local usedNonce = tonumber(ARGV[7])
local effectiveClientSeed = ARGV[8]
local hmacHex = ARGV[9]
local betEntryId = ARGV[10]
local winEntryId = ARGV[11]
local now = tonumber(ARGV[12])
local diceJson = ARGV[13]
local betsJson = ARGV[14]
local winDetailsJson = ARGV[15]
local totalDice = tonumber(ARGV[16])
local isTriple = (ARGV[17] == '1')
local outcome = ARGV[18]

if hasIdem == '1' then
  local rawIdem = redis.call('GET', idemKey)
  if rawIdem then
    local idem = cjson.decode(rawIdem)
    if idem.requestHash ~= reqHash then
      return cjson.encode({ err = 'IDEMPOTENCY_CONFLICT' })
    end
    return cjson.encode({ replayed = true, response = idem.response })
  end
end

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if user.locked then
  return cjson.encode({ err = 'USER_LOCKED' })
end
if (user.casVersion or 0) ~= expectedCas then
  return cjson.encode({ err = 'CAS_CONFLICT' })
end
if (user.balance or 0) < totalBet then
  return cjson.encode({ err = 'INSUFFICIENT_BALANCE' })
end

local roundId = redis.call('INCR', roundSeqKey)
if roundId <= 1000 then
  roundId = 1001
  redis.call('SET', roundSeqKey, tostring(roundId))
end

local b0 = user.balance
local b1 = b0 - totalBet
local b2 = b1 + totalWin

local betEntry = {
  id = betEntryId,
  userId = user.id,
  type = 'bet',
  amount = -totalBet,
  balanceBefore = b0,
  balanceAfter = b1,
  reason = 'Đặt cược Tự Lắc #' .. tostring(roundId),
  refId = 'manual:' .. tostring(roundId),
  timestamp = now
}
redis.call('LPUSH', ledgerKey, cjson.encode(betEntry))

local winEntry = nil
if totalWin > 0 then
  winEntry = {
    id = winEntryId,
    userId = user.id,
    type = 'win',
    amount = totalWin,
    balanceBefore = b1,
    balanceAfter = b2,
    reason = 'Thắng Tự Lắc #' .. tostring(roundId),
    refId = 'manual:' .. tostring(roundId),
    timestamp = now
  }
  redis.call('LPUSH', ledgerKey, cjson.encode(winEntry))
end
redis.call('LTRIM', ledgerKey, 0, 199)

user.balance = b2
user.totalBet = (user.totalBet or 0) + totalBet
user.totalWon = (user.totalWon or 0) + totalWin
user.netProfit = (user.netProfit or 0) + netProfit
user.rounds = (user.rounds or 0) + 1
if netProfit > 0 then
  user.winRounds = (user.winRounds or 0) + 1
end
user.fairness.nonce = usedNonce + 1
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))

redis.call('ZADD', lbBalKey, user.balance, user.id)
redis.call('ZADD', lbProfKey, user.netProfit, user.id)

local diceTbl = cjson.decode(diceJson)
local betsTbl = cjson.decode(betsJson)
local winDetailsTbl = cjson.decode(winDetailsJson)

local fairnessProof = {
  roundId = roundId,
  serverSeedHash = user.fairness.serverSeedHash,
  clientSeed = effectiveClientSeed,
  nonce = usedNonce,
  hmacHex = hmacHex
}

local personalEntry = {
  roundId = roundId,
  timestamp = now,
  mode = 'manual',
  bets = betsTbl,
  dice = diceTbl,
  total = totalDice,
  isTriple = isTriple,
  outcome = outcome,
  totalBet = totalBet,
  totalWin = totalWin,
  netProfit = netProfit,
  balanceAfter = b2,
  fairness = fairnessProof
}
redis.call('LPUSH', personalKey, cjson.encode(personalEntry))
redis.call('LTRIM', personalKey, 0, 99)

local globalEntry = {
  id = roundId,
  dice = diceTbl,
  total = totalDice,
  isTriple = isTriple,
  outcome = outcome,
  serverSeedHash = user.fairness.serverSeedHash,
  nonce = usedNonce,
  timestamp = now
}
redis.call('RPUSH', globalKey, cjson.encode(globalEntry))
redis.call('LTRIM', globalKey, -120, -1)

local ledgerList = { betEntry }
if winEntry then
  ledgerList[2] = winEntry
end

local resp = {
  replayed = false,
  roundId = roundId,
  mode = 'manual',
  dice = diceTbl,
  total = totalDice,
  isTriple = isTriple,
  outcome = outcome,
  totalBet = totalBet,
  totalWin = totalWin,
  netProfit = netProfit,
  newBalance = b2,
  winningDetails = winDetailsTbl,
  fairness = {
    serverSeedHash = user.fairness.serverSeedHash,
    clientSeed = effectiveClientSeed,
    nonce = usedNonce
  },
  ledgerEntries = ledgerList,
  user = user
}

if hasIdem == '1' then
  redis.call('SET', idemKey, cjson.encode({ requestHash = reqHash, response = resp, createdAt = now }), 'EX', 86400)
end

return cjson.encode({ ok = true, response = resp })
`;

const LUA_PLACE_LIVE_BET = `
local userKey = KEYS[1]
local ledgerKey = KEYS[2]
local ticketKey = KEYS[3]
local userTicketsKey = KEYS[4]
local lbBalKey = KEYS[5]
local lbProfKey = KEYS[6]
local idemKey = KEYS[7]

local hasIdem = ARGV[1]
local reqHash = ARGV[2]
local liveRoundId = tonumber(ARGV[3])
local totalBet = tonumber(ARGV[4])
local cleanBetsJson = ARGV[5]
local ledgerId = ARGV[6]
local now = tonumber(ARGV[7])
local maxSingleBet = tonumber(ARGV[8]) or 1000000000

if hasIdem == '1' then
  local rawIdem = redis.call('GET', idemKey)
  if rawIdem then
    local idem = cjson.decode(rawIdem)
    if idem.requestHash ~= reqHash then
      return cjson.encode({ err = 'IDEMPOTENCY_CONFLICT' })
    end
    return cjson.encode({ replayed = true, response = idem.response })
  end
end

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if user.locked then
  return cjson.encode({ err = 'USER_LOCKED' })
end

local rawTicket = redis.call('GET', ticketKey)
local ticket = nil
if rawTicket then
  ticket = cjson.decode(rawTicket)
  if ticket.settled then
    return cjson.encode({ err = 'ROUND_ALREADY_SETTLED' })
  end
end

local cleanBets = cjson.decode(cleanBetsJson)
if ticket and ticket.bets then
  for k, amt in pairs(cleanBets) do
    local prevAmt = tonumber(ticket.bets[k]) or 0
    if (prevAmt + amt) > maxSingleBet then
      return cjson.encode({ err = 'MAX_SINGLE_BET_EXCEEDED', gate = k })
    end
  end
end

if (user.balance or 0) < totalBet then
  return cjson.encode({ err = 'INSUFFICIENT_BALANCE' })
end

local b0 = user.balance
local b1 = b0 - totalBet
local ledgerEntry = {
  id = ledgerId,
  userId = user.id,
  type = 'bet',
  amount = -totalBet,
  balanceBefore = b0,
  balanceAfter = b1,
  reason = 'Đặt cược Phòng Live #' .. tostring(liveRoundId),
  refId = 'live:' .. tostring(liveRoundId),
  timestamp = now
}
redis.call('LPUSH', ledgerKey, cjson.encode(ledgerEntry))
redis.call('LTRIM', ledgerKey, 0, 199)

if not ticket then
  ticket = {
    liveRoundId = liveRoundId,
    userId = user.id,
    bets = cleanBets,
    totalBet = totalBet,
    settled = false,
    totalWin = 0,
    netProfit = 0,
    winningDetails = {},
    casVersion = 1,
    createdAt = now,
    updatedAt = now
  }
else
  for k, amt in pairs(cleanBets) do
    ticket.bets[k] = (ticket.bets[k] or 0) + amt
  end
  ticket.totalBet = (ticket.totalBet or 0) + totalBet
  ticket.casVersion = (tonumber(ticket.casVersion) or 0) + 1
  ticket.updatedAt = now
end

redis.call('SET', ticketKey, cjson.encode(ticket), 'EX', 604800)
redis.call('SADD', userTicketsKey, tostring(liveRoundId))

user.balance = b1
user.totalBet = (user.totalBet or 0) + totalBet
user.netProfit = (user.netProfit or 0) - totalBet
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))
redis.call('ZADD', lbBalKey, user.balance, user.id)
redis.call('ZADD', lbProfKey, user.netProfit, user.id)

local resp = {
  replayed = false,
  liveRoundId = liveRoundId,
  ticket = ticket,
  newBalance = b1,
  ledgerEntry = ledgerEntry,
  user = user
}
if hasIdem == '1' then
  redis.call('SET', idemKey, cjson.encode({ requestHash = reqHash, response = resp, createdAt = now }), 'EX', 86400)
end
return cjson.encode({ ok = true, response = resp })
`;

const LUA_SETTLE_LIVE_ROUND = `
local userKey = KEYS[1]
local ledgerKey = KEYS[2]
local personalKey = KEYS[3]
local globalKey = KEYS[4]
local roundSeqKey = KEYS[5]
local liveSettledKey = KEYS[6]
local ticketKey = KEYS[7]
local userTicketsKey = KEYS[8]
local lbBalKey = KEYS[9]
local lbProfKey = KEYS[10]

local liveRoundId = tonumber(ARGV[1])
local diceJson = ARGV[2]
local totalDice = tonumber(ARGV[3])
local isTriple = (ARGV[4] == '1')
local outcome = ARGV[5]
local totalWin = tonumber(ARGV[6])
local winDetailsJson = ARGV[7]
local roundSeedHash = ARGV[8]
local winLedgerId = ARGV[9]
local now = tonumber(ARGV[10])
local expectedTicketCas = tonumber(ARGV[11])
local expectedTotalBet = tonumber(ARGV[12])

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)

local rawTicket = redis.call('GET', ticketKey)
if not rawTicket then
  return cjson.encode({ err = 'TICKET_NOT_FOUND' })
end
local ticket = cjson.decode(rawTicket)
if ticket.settled then
  return cjson.encode({
    ok = true,
    alreadySettled = true,
    settledNow = false,
    liveRoundId = liveRoundId,
    settled = true,
    ticket = ticket,
    newBalance = user.balance,
    user = user
  })
end

local actualTicketCas = tonumber(ticket.casVersion or 0)
local actualTotalBet = tonumber(ticket.totalBet or 0)
if actualTicketCas ~= expectedTicketCas or actualTotalBet ~= expectedTotalBet then
  return cjson.encode({ err = 'CAS_CONFLICT' })
end

local diceTbl = cjson.decode(diceJson)
local winDetailsTbl = cjson.decode(winDetailsJson)
local netProfit = totalWin - (ticket.totalBet or 0)

ticket.settled = true
ticket.dice = diceTbl
ticket.total = totalDice
ticket.isTriple = isTriple
ticket.outcome = outcome
ticket.totalWin = totalWin
ticket.netProfit = netProfit
ticket.winningDetails = winDetailsTbl
ticket.casVersion = actualTicketCas + 1
ticket.settledAt = now
ticket.updatedAt = now

redis.call('SET', ticketKey, cjson.encode(ticket), 'EX', 604800)
redis.call('SREM', userTicketsKey, tostring(liveRoundId))

local b0 = user.balance or 0
local b1 = b0 + totalWin
local ledgerEntry = nil
if totalWin > 0 then
  ledgerEntry = {
    id = winLedgerId,
    userId = user.id,
    type = 'win',
    amount = totalWin,
    balanceBefore = b0,
    balanceAfter = b1,
    reason = 'Thắng Phòng Live #' .. tostring(liveRoundId),
    refId = 'live:' .. tostring(liveRoundId),
    timestamp = now
  }
  redis.call('LPUSH', ledgerKey, cjson.encode(ledgerEntry))
  redis.call('LTRIM', ledgerKey, 0, 199)
end

user.balance = b1
user.totalWon = (user.totalWon or 0) + totalWin
user.netProfit = (user.netProfit or 0) + totalWin
user.rounds = (user.rounds or 0) + 1
if netProfit > 0 then
  user.winRounds = (user.winRounds or 0) + 1
end
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))
redis.call('ZADD', lbBalKey, user.balance, user.id)
redis.call('ZADD', lbProfKey, user.netProfit, user.id)

local personalEntry = {
  roundId = liveRoundId,
  timestamp = now,
  mode = 'live',
  bets = ticket.bets,
  dice = diceTbl,
  total = totalDice,
  isTriple = isTriple,
  outcome = outcome,
  totalBet = ticket.totalBet,
  totalWin = totalWin,
  netProfit = netProfit,
  balanceAfter = b1,
  fairness = {
    liveRoundId = liveRoundId,
    roundSeedHash = (roundSeedHash ~= '' and roundSeedHash) or cjson.null
  }
}
redis.call('LPUSH', personalKey, cjson.encode(personalEntry))
redis.call('LTRIM', personalKey, 0, 99)

if redis.call('SET', liveSettledKey, '1', 'EX', 86400, 'NX') then
  local globalId = redis.call('INCR', roundSeqKey)
  if globalId <= 1000 then
    globalId = 1001
    redis.call('SET', roundSeqKey, tostring(globalId))
  end
  local globalEntry = {
    id = globalId,
    liveRoundId = liveRoundId,
    dice = diceTbl,
    total = totalDice,
    isTriple = isTriple,
    outcome = outcome,
    timestamp = now
  }
  if roundSeedHash ~= '' then
    globalEntry.serverSeedHash = roundSeedHash
  end
  redis.call('RPUSH', globalKey, cjson.encode(globalEntry))
  redis.call('LTRIM', globalKey, -120, -1)
end

return cjson.encode({
  ok = true,
  alreadySettled = false,
  settledNow = true,
  liveRoundId = liveRoundId,
  settled = true,
  ticket = ticket,
  newBalance = b1,
  ledgerEntry = ledgerEntry,
  user = user
})
`;

const LUA_ADJUST_BALANCE = `
local userKey = KEYS[1]
local ledgerKey = KEYS[2]
local lbBalKey = KEYS[3]
local idemKey = KEYS[4]

local hasIdem = ARGV[1]
local reqHash = ARGV[2]
local delta = tonumber(ARGV[3])
local txType = ARGV[4]
local reason = ARGV[5]
local refId = ARGV[6]
local allowLocked = (ARGV[7] == '1')
local minBalanceAfter = tonumber(ARGV[8])
local cooldownField = ARGV[9]
local cooldownMs = tonumber(ARGV[10])
local hasMaxBefore = (ARGV[11] == '1')
local maxBalanceBefore = tonumber(ARGV[12])
local ledgerId = ARGV[13]
local now = tonumber(ARGV[14])

if hasIdem == '1' then
  local rawIdem = redis.call('GET', idemKey)
  if rawIdem then
    local idem = cjson.decode(rawIdem)
    if idem.requestHash ~= reqHash then
      return cjson.encode({ err = 'IDEMPOTENCY_CONFLICT' })
    end
    return cjson.encode({ replayed = true, response = idem.response })
  end
end

local rawUser = redis.call('GET', userKey)
if not rawUser then
  return cjson.encode({ err = 'USER_NOT_FOUND' })
end
local user = cjson.decode(rawUser)
if (not allowLocked) and user.locked then
  return cjson.encode({ err = 'USER_LOCKED' })
end

local b0 = user.balance or 0
if hasMaxBefore and b0 >= maxBalanceBefore then
  return cjson.encode({ err = 'BANKRUPTCY_INELIGIBLE' })
end

if cooldownField ~= '' and cooldownMs > 0 then
  local lastAt = user[cooldownField]
  if type(lastAt) == 'number' and (now - lastAt) < cooldownMs then
    return cjson.encode({ err = 'COOLDOWN_ACTIVE', nextEligibleAt = lastAt + cooldownMs })
  end
end

local b1 = b0 + delta
if b1 > 9007199254740991 then
  return cjson.encode({ err = 'SAFE_INT_OVERFLOW' })
end
if b1 < minBalanceAfter then
  return cjson.encode({ err = 'INSUFFICIENT_BALANCE' })
end

local ledgerEntry = {
  id = ledgerId,
  userId = user.id,
  type = txType,
  amount = delta,
  balanceBefore = b0,
  balanceAfter = b1,
  reason = reason,
  refId = (refId ~= '' and refId) or cjson.null,
  timestamp = now
}
redis.call('LPUSH', ledgerKey, cjson.encode(ledgerEntry))
redis.call('LTRIM', ledgerKey, 0, 199)

user.balance = b1
if cooldownField ~= '' then
  user[cooldownField] = now
end
user.casVersion = (user.casVersion or 0) + 1
user.updatedAt = now
redis.call('SET', userKey, cjson.encode(user))
redis.call('ZADD', lbBalKey, b1, user.id)

local nextEligibleAt = nil
if cooldownField ~= '' and cooldownMs > 0 then
  nextEligibleAt = now + cooldownMs
end

local resp = {
  replayed = false,
  user = user,
  balance = b1,
  ledgerEntry = ledgerEntry,
  nextEligibleAt = nextEligibleAt
}
if hasIdem == '1' then
  redis.call('SET', idemKey, cjson.encode({ requestHash = reqHash, response = resp, createdAt = now }), 'EX', 86400)
end
return cjson.encode({ ok = true, response = resp })
`;

function createUpstashBackend(config, opts) {
  const baseUrl = String(config.upstashRedisRestUrl || '').replace(/\/+$/, '');
  const token = String(config.upstashRedisRestToken || '');
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const p = opts.keyPrefix || 'sicbo:';
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : 20;

  if (typeof fetchFn !== 'function') {
    throw makeDbError('FETCH_UNAVAILABLE', 500, 'globalThis.fetch is unavailable for Upstash REST driver');
  }

  let initialized = false;

  async function redisCommand(commandArray) {
    const res = await fetchFn(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commandArray)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw makeDbError('UPSTASH_HTTP_ERROR', res.status >= 500 ? 502 : res.status, `Upstash REST HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    if (data && data.error) {
      throw makeDbError('UPSTASH_REDIS_ERROR', 500, `Upstash Redis error: ${data.error}`);
    }
    return data ? data.result : null;
  }

  async function redisEval(script, keys, args) {
    const raw = await redisCommand(['EVAL', script, keys.length, ...keys, ...args]);
    if (typeof raw === 'string') {
      return JSON.parse(raw);
    }
    return raw;
  }

  function mapLuaError(parsed) {
    if (!parsed || !parsed.err) return;
    switch (parsed.err) {
      case 'USERNAME_TAKEN':
        throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
      case 'USER_NOT_FOUND':
        throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
      case 'USER_LOCKED':
        throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');
      case 'NOT_A_GUEST':
        throw makeDbError('NOT_A_GUEST', 400, 'Tài khoản này không phải tài khoản Khách.');
      case 'IDEMPOTENCY_CONFLICT':
        throw makeDbError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key reused with different request payload');
      case 'INSUFFICIENT_BALANCE':
        throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư không đủ.');
      case 'SAFE_INT_OVERFLOW':
        throw makeDbError('INVALID_AMOUNT', 400, 'Số dư sau điều chỉnh vượt quá giới hạn an toàn.');
      case 'INVALID_RECOVERY_CODE':
        throw makeDbError('INVALID_RECOVERY_CODE', 401, 'Tên đăng nhập hoặc mã khôi phục không hợp lệ.');
      case 'MAX_SINGLE_BET_EXCEEDED':
        throw makeDbError(
          'INVALID_BETS',
          400,
          `Tổng cược cho cửa ${parsed.gate || ''} trong phiên Live không được vượt quá ${sicboEngine.MAX_SINGLE_BET}.`
        );
      case 'ROUND_ALREADY_SETTLED':
        throw makeDbError('ROUND_ALREADY_SETTLED', 409, 'Phiên Live này đã mở bát kết toán.');
      case 'TICKET_NOT_FOUND':
        throw makeDbError('TICKET_NOT_FOUND', 404, 'Không tìm thấy vé cược.');
      case 'BANKRUPTCY_INELIGIBLE':
        throw makeDbError('BANKRUPTCY_INELIGIBLE', 400, 'Số dư hiện tại chưa đủ điều kiện nhận trợ cấp.');
      case 'COOLDOWN_ACTIVE':
        throw makeDbError('COOLDOWN_ACTIVE', 429, 'Chưa hết thời gian chờ nhận thưởng.', {
          nextEligibleAt: parsed.nextEligibleAt ?? null
        });
      case 'CAS_CONFLICT':
        throw makeDbError('CAS_CONFLICT', 409, 'Concurrent modification conflict');
      default:
        throw makeDbError('UPSTASH_LUA_ERROR', 500, `Upstash Lua error: ${parsed.err}`);
    }
  }

  async function ensureInit() {
    if (initialized) return;
    initialized = true;
    const existingLen = await redisCommand(['LLEN', `${p}global_history`]);
    if (!existingLen || Number(existingLen) === 0) {
      const seed = readLegacySeedHistory(config.rootDir, opts.seedLegacyHistory);
      if (seed.items.length > 0) {
        const serialized = seed.items.map((item) => JSON.stringify(item));
        await redisCommand(['RPUSH', `${p}global_history`, ...serialized]);
        await redisCommand(['SET', `${p}round_seq`, String(seed.nextRoundId - 1)]);
      } else {
        await redisCommand(['SETNX', `${p}round_seq`, '1000']);
      }
    }
  }

  async function getUserInternal(userId) {
    const raw = await redisCommand(['GET', `${p}user:${userId}`]);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  return {
    async init() {
      await ensureInit();
    },
    async close() {
      return undefined;
    },
    async getUserById(userId) {
      await ensureInit();
      return getUserInternal(userId);
    },
    async getUserByUsername(username) {
      await ensureInit();
      if (typeof username !== 'string' || !username.trim()) return null;
      const userId = await redisCommand(['GET', `${p}uname:${username.trim().toLowerCase()}`]);
      if (!userId) return null;
      return getUserInternal(userId);
    },
    async createUser(params) {
      await ensureInit();
      const user = buildInitialUserRecord(params, config);
      const res = await redisEval(
        LUA_CREATE_USER,
        [
          `${p}uname:${user.usernameLower}`,
          `${p}user:${user.id}`,
          `${p}users_idx`,
          `${p}lb:balance`,
          `${p}lb:profit`
        ],
        [
          user.id,
          JSON.stringify(user),
          String(user.balance),
          String(user.netProfit)
        ]
      );
      mapLuaError(res);
      return user;
    },
    async upgradeGuestAtomic({ userId, username, displayName, passwordHash, recoveryCodeHash, role = 'user', now = Date.now() }) {
      await ensureInit();
      const cleanUsername = typeof username === 'string' ? username.trim() : '';
      if (!cleanUsername) throw makeDbError('INVALID_INPUT', 400, 'Tên đăng nhập không hợp lệ.');
      const cleanDisplay = (typeof displayName === 'string' && displayName.trim()) ? displayName.trim() : cleanUsername;
      const res = await redisEval(
        LUA_UPGRADE_GUEST,
        [`${p}user:${userId}`, `${p}users_idx`, `${p}lb:balance`, `${p}lb:profit`],
        [
          p,
          userId,
          cleanUsername,
          cleanUsername.toLowerCase(),
          cleanDisplay,
          passwordHash || '',
          recoveryCodeHash || '',
          role === 'admin' ? 'admin' : 'user',
          String(now)
        ]
      );
      mapLuaError(res);
      return res;
    },
    async updateUserPassword({ userId, passwordHash, recoveryCodeHash, expectedRecoveryCodeHash, bumpSessionVersion = true, now = Date.now() }) {
      await ensureInit();
      const pwMode = passwordHash === null ? 'null' : 'str';
      const recMode = recoveryCodeHash === undefined ? '0' : (recoveryCodeHash === null ? '2' : '1');
      const checkExpectedRec = expectedRecoveryCodeHash !== undefined ? '1' : '0';
      const expectedRecStr = expectedRecoveryCodeHash === null || expectedRecoveryCodeHash === undefined ? '' : String(expectedRecoveryCodeHash);
      const res = await redisEval(
        LUA_UPDATE_USER_PASSWORD,
        [`${p}user:${userId}`],
        [
          pwMode,
          passwordHash === null || passwordHash === undefined ? '' : String(passwordHash),
          recMode,
          recoveryCodeHash === null || recoveryCodeHash === undefined ? '' : String(recoveryCodeHash),
          bumpSessionVersion !== false ? '1' : '0',
          String(now),
          checkExpectedRec,
          expectedRecStr
        ]
      );
      mapLuaError(res);
      return res.user;
    },
    async toggleUserLock({ userId, locked, now = Date.now() }) {
      await ensureInit();
      const lockMode = typeof locked === 'boolean' ? (locked ? 'true' : 'false') : 'toggle';
      const res = await redisEval(
        LUA_TOGGLE_USER_LOCK,
        [`${p}user:${userId}`],
        [lockMode, String(now)]
      );
      mapLuaError(res);
      return res.user;
    },
    async listUsers({ q = '', limit = 50, offset = 0 } = {}) {
      await ensureInit();
      const ids = await redisCommand(['SMEMBERS', `${p}users_idx`]);
      if (!Array.isArray(ids) || ids.length === 0) {
        return { users: [], total: 0 };
      }
      const rawUsers = await redisCommand(['MGET', ...ids.map((id) => `${p}user:${id}`)]);
      let users = (Array.isArray(rawUsers) ? rawUsers : [])
        .filter(Boolean)
        .map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
      const query = typeof q === 'string' ? q.trim().toLowerCase() : '';
      if (query) {
        users = users.filter((u) => (
          (u.username && u.username.toLowerCase().includes(query)) ||
          (u.displayName && u.displayName.toLowerCase().includes(query)) ||
          (u.id && String(u.id).toLowerCase().includes(query))
        ));
      }
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const safeLimit = Math.max(1, Number(limit) || 50);
      return {
        users: users.slice(safeOffset, safeOffset + safeLimit).map((u) => sanitizeUser(u)),
        total: users.length
      };
    },
    async rotateFairnessAtomic({ userId, newServerSeed, newServerSeedHash, newClientSeed, now = Date.now() }) {
      await ensureInit();
      const nextSeed = (typeof newServerSeed === 'string' && newServerSeed.trim())
        ? newServerSeed.trim()
        : crypto.randomBytes(32).toString('hex');
      const nextHash = (typeof newServerSeedHash === 'string' && newServerSeedHash.trim())
        ? newServerSeedHash.trim()
        : sha256Hex(nextSeed);
      const cleanClient = (typeof newClientSeed === 'string' && newClientSeed.trim()) ? newClientSeed.trim() : '';

      const res = await redisEval(
        LUA_ROTATE_FAIRNESS,
        [`${p}user:${userId}`],
        [nextSeed, nextHash, cleanClient, String(now)]
      );
      mapLuaError(res);
      return {
        previous: res.previous,
        current: {
          serverSeedHash: res.user.fairness.serverSeedHash,
          clientSeed: res.user.fairness.clientSeed,
          nonce: 0,
          lastRevealed: res.previous
        },
        user: sanitizeUser(res.user)
      };
    },
    async placeManualRollAtomic({ userId, bets, totalBet, clientSeed, idempotencyKey, idempotencyHash, resolveFn, now = Date.now() }) {
      await ensureInit();
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }

      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const effectiveClientSeedInput = (typeof clientSeed === 'string' && clientSeed.trim())
        ? clientSeed.trim()
        : null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const user = await getUserInternal(userId);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');

        const reqHash = idempotencyHash || computeIdempotencyHash({
          bets: cleanBets,
          clientSeed: effectiveClientSeedInput || user.fairness.clientSeed
        });

        const effectiveClientSeed = effectiveClientSeedInput || user.fairness.clientSeed;
        const { usedNonce, hmacHex, evaluation } = resolveRollOutcome({
          user,
          cleanBets,
          totalBet: expectedTotalBet,
          effectiveClientSeed,
          resolveFn
        });

        const res = await redisEval(
          LUA_PLACE_MANUAL_ROLL,
          [
            `${p}user:${userId}`,
            `${p}ledger:${userId}`,
            `${p}personal:${userId}`,
            `${p}global_history`,
            `${p}round_seq`,
            `${p}lb:balance`,
            `${p}lb:profit`,
            `${p}idem:${userId}:manual_roll:${cleanKey || '_'}`
          ],
          [
            cleanKey ? '1' : '0',
            reqHash,
            String(user.casVersion || 0),
            String(expectedTotalBet),
            String(evaluation.totalWin),
            String(evaluation.netProfit),
            String(usedNonce),
            effectiveClientSeed,
            hmacHex || '',
            crypto.randomUUID(),
            crypto.randomUUID(),
            String(now),
            JSON.stringify(evaluation.dice),
            JSON.stringify(cleanBets),
            JSON.stringify(evaluation.winningDetails),
            String(evaluation.total),
            evaluation.isTriple ? '1' : '0',
            evaluation.outcome
          ]
        );

        if (res && res.replayed) {
          const out = res.response;
          out.replayed = true;
          out.winningDetails = normalizeArrayField(out.winningDetails);
          out.ledgerEntries = normalizeArrayField(out.ledgerEntries);
          if (out.user) out.user = sanitizeUser(out.user);
          return out;
        }
        if (res && res.err === 'CAS_CONFLICT') {
          if (attempt < maxRetries) {
            const delayMs = 3 + Math.floor(Math.random() * 12);
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          throw makeDbError('CAS_CONFLICT_EXHAUSTED', 409, 'Concurrent modification conflict persisted after retries');
        }
        mapLuaError(res);
        const out = res.response;
        out.winningDetails = normalizeArrayField(out.winningDetails);
        out.ledgerEntries = normalizeArrayField(out.ledgerEntries);
        out.user = sanitizeUser(out.user);
        return out;
      }
      throw makeDbError('CAS_CONFLICT_EXHAUSTED', 409, 'Concurrent modification conflict persisted after retries');
    },
    async placeLiveBetAtomic({ userId, liveRoundId, bets, totalBet, idempotencyKey, idempotencyHash, now = Date.now() }) {
      await ensureInit();
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ liveRoundId, bets: cleanBets });

      const res = await redisEval(
        LUA_PLACE_LIVE_BET,
        [
          `${p}user:${userId}`,
          `${p}ledger:${userId}`,
          `${p}ticket:${liveRoundId}:${userId}`,
          `${p}user_tickets:${userId}`,
          `${p}lb:balance`,
          `${p}lb:profit`,
          `${p}idem:${userId}:live_bet:${cleanKey || '_'}`
        ],
        [
          cleanKey ? '1' : '0',
          reqHash,
          String(liveRoundId),
          String(expectedTotalBet),
          JSON.stringify(cleanBets),
          crypto.randomUUID(),
          String(now),
          String(sicboEngine.MAX_SINGLE_BET)
        ]
      );
      if (res && res.replayed) {
        const out = res.response;
        out.replayed = true;
        if (out.ticket) out.ticket = normalizeLiveTicket(out.ticket);
        if (out.user) out.user = sanitizeUser(out.user);
        return out;
      }
      mapLuaError(res);
      const out = res.response;
      if (out.ticket) out.ticket = normalizeLiveTicket(out.ticket);
      out.user = sanitizeUser(out.user);
      return out;
    },
    async getLiveTicket({ userId, liveRoundId }) {
      await ensureInit();
      const raw = await redisCommand(['GET', `${p}ticket:${liveRoundId}:${userId}`]);
      if (!raw) return null;
      return normalizeLiveTicket(typeof raw === 'string' ? JSON.parse(raw) : raw);
    },
    async getUnsettledLiveTickets(userId) {
      await ensureInit();
      const roundIds = await redisCommand(['SMEMBERS', `${p}user_tickets:${userId}`]);
      if (!Array.isArray(roundIds) || roundIds.length === 0) return [];
      const rawTickets = await redisCommand(['MGET', ...roundIds.map((rid) => `${p}ticket:${rid}:${userId}`)]);
      return (Array.isArray(rawTickets) ? rawTickets : [])
        .filter(Boolean)
        .map((r) => normalizeLiveTicket(typeof r === 'string' ? JSON.parse(r) : r))
        .filter((t) => !t.settled)
        .sort((a, b) => a.liveRoundId - b.liveRoundId);
    },
    async settleLiveRoundAtomic({ userId, liveRoundId, dice, evaluation, roundSeedHash = '', now = Date.now() }) {
      await ensureInit();
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const rawTicket = await redisCommand(['GET', `${p}ticket:${liveRoundId}:${userId}`]);
        if (!rawTicket) {
          throw makeDbError('TICKET_NOT_FOUND', 404, 'Không tìm thấy vé cược cho phiên Live này.');
        }
        const ticket = normalizeLiveTicket(typeof rawTicket === 'string' ? JSON.parse(rawTicket) : rawTicket);
        if (ticket.settled) {
          const user = await getUserInternal(userId);
          if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
          return {
            alreadySettled: true,
            settledNow: false,
            liveRoundId,
            settled: true,
            ticket,
            newBalance: user.balance,
            ledgerEntry: null,
            user: sanitizeUser(user)
          };
        }

        const effectiveEval = (dice && Array.isArray(dice))
          ? evaluateRoll(dice, ticket.bets)
          : evaluation;
        if (!effectiveEval || !Array.isArray(effectiveEval.dice)) {
          throw makeDbError('INVALID_INPUT', 400, 'Dice or evaluation is required to settle live round');
        }

        const res = await redisEval(
          LUA_SETTLE_LIVE_ROUND,
          [
            `${p}user:${userId}`,
            `${p}ledger:${userId}`,
            `${p}personal:${userId}`,
            `${p}global_history`,
            `${p}round_seq`,
            `${p}live_settled:${liveRoundId}`,
            `${p}ticket:${liveRoundId}:${userId}`,
            `${p}user_tickets:${userId}`,
            `${p}lb:balance`,
            `${p}lb:profit`
          ],
          [
            String(liveRoundId),
            JSON.stringify(effectiveEval.dice),
            String(effectiveEval.total),
            effectiveEval.isTriple ? '1' : '0',
            effectiveEval.outcome,
            String(effectiveEval.totalWin),
            JSON.stringify(effectiveEval.winningDetails),
            roundSeedHash || '',
            crypto.randomUUID(),
            String(now),
            String(Number(ticket.casVersion) || 0),
            String(Number(ticket.totalBet) || 0)
          ]
        );
        if (res && res.err === 'CAS_CONFLICT') {
          if (attempt < maxRetries) {
            const delayMs = 3 + Math.floor(Math.random() * 12);
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          throw makeDbError('CAS_CONFLICT_EXHAUSTED', 409, 'Concurrent modification conflict persisted after retries');
        }
        mapLuaError(res);
        if (res.ticket) res.ticket = normalizeLiveTicket(res.ticket);
        if (res.winningDetails !== undefined) {
          res.winningDetails = normalizeArrayField(res.winningDetails);
        }
        res.user = sanitizeUser(res.user);
        if (res.ledgerEntry === undefined) res.ledgerEntry = null;
        return res;
      }
      throw makeDbError('CAS_CONFLICT_EXHAUSTED', 409, 'Concurrent modification conflict persisted after retries');
    },
    async adjustBalanceAtomic({
      userId,
      delta,
      type,
      reason = '',
      refId = null,
      idempotencyKey,
      idempotencyHash,
      allowLocked = false,
      minBalanceAfter = 0,
      cooldownField = null,
      cooldownMs = 0,
      maxBalanceBefore = null,
      now = Date.now()
    }) {
      await ensureInit();
      if (!LEDGER_TYPE_SET.has(type)) {
        throw makeDbError('INVALID_INPUT', 400, `Unsupported ledger type: ${type}`);
      }
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Balance delta must be a non-zero safe integer');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ delta, type, reason, refId });

      const res = await redisEval(
        LUA_ADJUST_BALANCE,
        [
          `${p}user:${userId}`,
          `${p}ledger:${userId}`,
          `${p}lb:balance`,
          `${p}idem:${userId}:${type}:${cleanKey || '_'}`
        ],
        [
          cleanKey ? '1' : '0',
          reqHash,
          String(delta),
          type,
          String(reason || ''),
          refId ? String(refId) : '',
          allowLocked ? '1' : '0',
          String(minBalanceAfter),
          cooldownField || '',
          String(cooldownMs || 0),
          maxBalanceBefore !== null ? '1' : '0',
          maxBalanceBefore !== null ? String(maxBalanceBefore) : '0',
          crypto.randomUUID(),
          String(now)
        ]
      );
      if (res && res.replayed) {
        const out = res.response;
        out.replayed = true;
        if (out.user) out.user = sanitizeUser(out.user);
        return out;
      }
      mapLuaError(res);
      const out = res.response;
      out.user = sanitizeUser(out.user);
      if (out.nextEligibleAt === undefined) out.nextEligibleAt = null;
      return out;
    },
    async getWalletLedger(userId, limit = 50) {
      await ensureInit();
      if (limit <= 0) return [];
      const items = await redisCommand(['LRANGE', `${p}ledger:${userId}`, 0, limit - 1]);
      return (Array.isArray(items) ? items : []).map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    },
    async getPersonalHistory(userId, limit = 40) {
      await ensureInit();
      if (limit <= 0) return [];
      const items = await redisCommand(['LRANGE', `${p}personal:${userId}`, 0, limit - 1]);
      return (Array.isArray(items) ? items : []).map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    },
    async getGlobalHistory(limit = 60) {
      await ensureInit();
      if (limit <= 0) return [];
      const items = await redisCommand(['LRANGE', `${p}global_history`, -limit, -1]);
      return (Array.isArray(items) ? items : []).map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    },
    async getLeaderboard(limit = 20) {
      await ensureInit();
      const safeLimit = Math.max(1, limit);
      const ids = await redisCommand(['SMEMBERS', `${p}users_idx`]);
      if (!Array.isArray(ids) || ids.length === 0) {
        return { byBalance: [], byNetProfit: [] };
      }
      const rawUsers = await redisCommand(['MGET', ...ids.map((id) => `${p}user:${id}`)]);
      const users = (Array.isArray(rawUsers) ? rawUsers : [])
        .filter(Boolean)
        .map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
      return {
        byBalance: sortLeaderboardRows(users, 'byBalance').slice(0, safeLimit).map(buildLeaderboardRow),
        byNetProfit: sortLeaderboardRows(users, 'byNetProfit').slice(0, safeLimit).map(buildLeaderboardRow)
      };
    }
  };
}

// ============================================================================
// 3. POSTGRESQL BACKEND (Lazy `pg` loading + Transactional FOR UPDATE)
// ============================================================================

const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  session_version INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  recovery_code_hash TEXT,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_bet BIGINT NOT NULL DEFAULT 0,
  total_won BIGINT NOT NULL DEFAULT 0,
  net_profit BIGINT NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 0,
  win_rounds INTEGER NOT NULL DEFAULT 0,
  last_daily_bonus_at BIGINT,
  last_bankruptcy_aid_at BIGINT,
  fairness JSONB NOT NULL,
  cas_version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  balance_before BIGINT NOT NULL,
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL DEFAULT '',
  ref_id TEXT,
  timestamp BIGINT NOT NULL
);
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_ts ON wallet_ledger (user_id, timestamp DESC, seq DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, scope, idem_key)
);

CREATE TABLE IF NOT EXISTS live_tickets (
  live_round_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  bets JSONB NOT NULL,
  total_bet BIGINT NOT NULL,
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  dice JSONB,
  total INTEGER,
  is_triple BOOLEAN,
  outcome TEXT,
  total_win BIGINT NOT NULL DEFAULT 0,
  net_profit BIGINT NOT NULL DEFAULT 0,
  winning_details JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  settled_at BIGINT,
  PRIMARY KEY (live_round_id, user_id)
);

CREATE TABLE IF NOT EXISTS personal_history (
  seq BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  round_id BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  mode TEXT NOT NULL,
  bets JSONB NOT NULL,
  dice JSONB NOT NULL,
  total INTEGER NOT NULL,
  is_triple BOOLEAN NOT NULL,
  outcome TEXT NOT NULL,
  total_bet BIGINT NOT NULL,
  total_won BIGINT NOT NULL,
  net_profit BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  fairness JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_history_user_seq ON personal_history (user_id, seq DESC);

CREATE TABLE IF NOT EXISTS global_history (
  id BIGSERIAL PRIMARY KEY,
  live_round_id BIGINT UNIQUE,
  dice JSONB NOT NULL,
  total INTEGER NOT NULL,
  is_triple BOOLEAN NOT NULL,
  outcome TEXT NOT NULL,
  server_seed_hash TEXT,
  nonce INTEGER,
  timestamp BIGINT NOT NULL
);
`;

function toSafeNumber(val, fallback = 0) {
  if (val === null || val === undefined) return fallback;
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    throw makeDbError('UNSAFE_INTEGER', 500, `Unsafe integer value from PostgreSQL: ${val}`);
  }
  return n;
}

function mapPgUserRow(row) {
  if (!row) return null;
  if (row.id !== undefined && row.usernameLower !== undefined) {
    return deepClone(row);
  }
  const fairness = typeof row.fairness === 'string' ? JSON.parse(row.fairness) : row.fairness;
  return {
    id: row.id,
    username: row.username,
    usernameLower: row.username_lower,
    displayName: row.display_name,
    role: row.role || 'user',
    isGuest: Boolean(row.is_guest),
    locked: Boolean(row.locked),
    sessionVersion: Number(row.session_version) || 1,
    passwordHash: row.password_hash ?? null,
    recoveryCodeHash: row.recovery_code_hash ?? null,
    balance: toSafeNumber(row.balance, 0),
    totalBet: toSafeNumber(row.total_bet, 0),
    totalWon: toSafeNumber(row.total_won, 0),
    netProfit: toSafeNumber(row.net_profit, 0),
    rounds: Number(row.rounds) || 0,
    winRounds: Number(row.win_rounds) || 0,
    lastDailyBonusAt: row.last_daily_bonus_at !== null && row.last_daily_bonus_at !== undefined
      ? toSafeNumber(row.last_daily_bonus_at)
      : null,
    lastBankruptcyAidAt: row.last_bankruptcy_aid_at !== null && row.last_bankruptcy_aid_at !== undefined
      ? toSafeNumber(row.last_bankruptcy_aid_at)
      : null,
    fairness,
    casVersion: Number(row.cas_version) || 0,
    createdAt: toSafeNumber(row.created_at, 0),
    updatedAt: toSafeNumber(row.updated_at, 0)
  };
}

function mapPgTicketRow(row) {
  if (!row) return null;
  if (row.liveRoundId !== undefined) return deepClone(row);
  return {
    liveRoundId: toSafeNumber(row.live_round_id),
    userId: row.user_id,
    bets: typeof row.bets === 'string' ? JSON.parse(row.bets) : row.bets,
    totalBet: toSafeNumber(row.total_bet),
    settled: Boolean(row.settled),
    dice: typeof row.dice === 'string' ? JSON.parse(row.dice) : (row.dice ?? null),
    total: row.total ?? null,
    isTriple: row.is_triple ?? null,
    outcome: row.outcome ?? null,
    totalWin: toSafeNumber(row.total_win, 0),
    netProfit: toSafeNumber(row.net_profit, 0),
    winningDetails: typeof row.winning_details === 'string'
      ? JSON.parse(row.winning_details)
      : (row.winning_details ?? []),
    createdAt: toSafeNumber(row.created_at),
    updatedAt: toSafeNumber(row.updated_at),
    settledAt: row.settled_at !== null && row.settled_at !== undefined ? toSafeNumber(row.settled_at) : null
  };
}

function createPostgresBackend(config, opts) {
  let pool = opts.pgPool || null;
  let initialized = false;
  let fallbackJson = null;

  async function ensureInit() {
    if (fallbackJson) {
      await fallbackJson.init();
      return;
    }
    if (initialized && pool) return;

    if (!pool) {
      let pgMod = opts.pgModule || null;
      if (!pgMod) {
        const reqFn = opts.requireFn || require;
        try {
          pgMod = reqFn('pg');
        } catch (err) {
          if (opts.strictPg) {
            throw makeDbError(
              'PG_NOT_INSTALLED',
              500,
              'DATABASE_URL is configured but "pg" package is not installed.',
              { cause: err }
            );
          }
          console.warn(
            '[sicbo-db] DATABASE_URL is set but "pg" package is not installed; falling back to JSON store.'
          );
          fallbackJson = createJsonBackend(config, opts);
          await fallbackJson.init();
          initialized = true;
          return;
        }
      }
      const poolOpts = { connectionString: config.databaseUrl };
      if (config.isVercel || String(config.databaseUrl).includes('sslmode=require')) {
        poolOpts.ssl = { rejectUnauthorized: false };
      }
      pool = new pgMod.Pool(poolOpts);
    }

    await pool.query(PG_SCHEMA_SQL);
    const countRes = await pool.query('SELECT COUNT(*) AS cnt FROM global_history');
    const cnt = Number(countRes.rows?.[0]?.cnt || 0);
    if (cnt === 0) {
      const seed = readLegacySeedHistory(config.rootDir, opts.seedLegacyHistory);
      if (seed.items.length > 0) {
        for (const item of seed.items) {
          await pool.query(
            `INSERT INTO global_history (id, dice, total, is_triple, outcome, server_seed_hash, nonce, timestamp)
             VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
              item.id,
              JSON.stringify(item.dice),
              item.total,
              Boolean(item.isTriple),
              item.outcome,
              item.serverSeedHash || null,
              item.nonce ?? null,
              item.timestamp || Date.now()
            ]
          );
        }
        await pool.query(
          `SELECT setval(pg_get_serial_sequence('global_history', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1000) FROM global_history), 1000))`
        ).catch(() => undefined);
      }
    }
    initialized = true;
  }

  async function withTransaction(fn) {
    await ensureInit();
    if (fallbackJson) {
      throw makeDbError('INTERNAL_ROUTING_ERROR', 500, 'Expected fallback delegation');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function checkPgIdempotency(client, userId, scope, cleanKey, reqHash, now) {
    if (!cleanKey) return null;
    const res = await client.query(
      `SELECT request_hash, response, created_at FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND idem_key = $3 FOR UPDATE`,
      [userId, scope, cleanKey]
    );
    const row = res.rows?.[0];
    if (!row) return null;
    const createdAt = toSafeNumber(row.created_at, 0);
    if ((now - createdAt) > IDEMPOTENCY_TTL_MS) {
      await client.query(
        `DELETE FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND idem_key = $3`,
        [userId, scope, cleanKey]
      );
      return null;
    }
    if (row.request_hash !== reqHash) {
      throw makeDbError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key reused with different request payload');
    }
    const resp = typeof row.response === 'string' ? JSON.parse(row.response) : deepClone(row.response);
    return { ...resp, replayed: true };
  }

  async function savePgIdempotency(client, userId, scope, cleanKey, reqHash, response, now) {
    if (!cleanKey) return;
    await client.query(
      `INSERT INTO idempotency_keys (user_id, scope, idem_key, request_hash, response, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (user_id, scope, idem_key) DO UPDATE SET request_hash = EXCLUDED.request_hash, response = EXCLUDED.response, created_at = EXCLUDED.created_at`,
      [userId, scope, cleanKey, reqHash, JSON.stringify(response), now]
    );
  }

  return {
    isFallback() {
      return Boolean(fallbackJson);
    },
    async init() {
      await ensureInit();
    },
    async close() {
      if (fallbackJson) return fallbackJson.close();
      if (pool && typeof pool.end === 'function') {
        await pool.end();
      }
    },
    async getUserById(userId) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getUserById(userId);
      const res = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      return mapPgUserRow(res.rows?.[0]);
    },
    async getUserByUsername(username) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getUserByUsername(username);
      if (typeof username !== 'string' || !username.trim()) return null;
      const res = await pool.query('SELECT * FROM users WHERE username_lower = $1', [username.trim().toLowerCase()]);
      return mapPgUserRow(res.rows?.[0]);
    },
    async createUser(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.createUser(params);
      const user = buildInitialUserRecord(params, config);
      return withTransaction(async (client) => {
        const existing = await client.query(
          'SELECT id FROM users WHERE username_lower = $1',
          [user.usernameLower]
        );
        if (existing.rows && existing.rows.length > 0) {
          throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
        }
        try {
          await client.query(
            `INSERT INTO users (
              id, username, username_lower, display_name, role, is_guest, locked,
              session_version, password_hash, recovery_code_hash, balance, total_bet,
              total_won, net_profit, rounds, win_rounds, last_daily_bonus_at,
              last_bankruptcy_aid_at, fairness, cas_version, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17,
              $18, $19::jsonb, $20, $21, $22
            )`,
            [
              user.id, user.username, user.usernameLower, user.displayName, user.role,
              user.isGuest, user.locked, user.sessionVersion, user.passwordHash,
              user.recoveryCodeHash, user.balance, user.totalBet, user.totalWon,
              user.netProfit, user.rounds, user.winRounds, user.lastDailyBonusAt,
              user.lastBankruptcyAidAt, JSON.stringify(user.fairness),
              user.casVersion, user.createdAt, user.updatedAt
            ]
          );
        } catch (err) {
          if (err && err.code === '23505') {
            throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
          }
          throw err;
        }
        return user;
      });
    },
    async upgradeGuestAtomic(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.upgradeGuestAtomic(params);
      const { userId, username, displayName, passwordHash, recoveryCodeHash, role = 'user', now = Date.now() } = params;
      const cleanUsername = typeof username === 'string' ? username.trim() : '';
      if (!cleanUsername) throw makeDbError('INVALID_INPUT', 400, 'Tên đăng nhập không hợp lệ.');
      const nextLower = cleanUsername.toLowerCase();
      const nextDisplay = (typeof displayName === 'string' && displayName.trim()) ? displayName.trim() : cleanUsername;

      return withTransaction(async (client) => {
        const res = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(res.rows?.[0]);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (!user.isGuest) throw makeDbError('NOT_A_GUEST', 400, 'Tài khoản này không phải tài khoản Khách.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const conflict = await client.query(
          'SELECT id FROM users WHERE username_lower = $1 AND id <> $2',
          [nextLower, userId]
        );
        if (conflict.rows && conflict.rows.length > 0) {
          throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
        }

        const nextRole = role === 'admin' ? 'admin' : 'user';
        const nextSv = user.sessionVersion + 1;
        const nextCas = user.casVersion + 1;
        try {
          await client.query(
            `UPDATE users
             SET username = $2, username_lower = $3, display_name = $4, password_hash = $5,
                 recovery_code_hash = $6, role = $7, is_guest = FALSE,
                 session_version = $8, cas_version = $9, updated_at = $10
             WHERE id = $1`,
            [userId, cleanUsername, nextLower, nextDisplay, passwordHash, recoveryCodeHash, nextRole, nextSv, nextCas, now]
          );
        } catch (err) {
          if (err && err.code === '23505') {
            throw makeDbError('USERNAME_TAKEN', 409, 'Tên đăng nhập đã được sử dụng.');
          }
          throw err;
        }
        return {
          ...user,
          username: cleanUsername,
          usernameLower: nextLower,
          displayName: nextDisplay,
          passwordHash,
          recoveryCodeHash,
          role: nextRole,
          isGuest: false,
          sessionVersion: nextSv,
          casVersion: nextCas,
          updatedAt: now
        };
      });
    },
    async updateUserPassword(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.updateUserPassword(params);
      const { userId, passwordHash, recoveryCodeHash, expectedRecoveryCodeHash, bumpSessionVersion = true, now = Date.now() } = params;
      return withTransaction(async (client) => {
        const res = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(res.rows?.[0]);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (expectedRecoveryCodeHash !== undefined && user.recoveryCodeHash !== expectedRecoveryCodeHash) {
          throw makeDbError('INVALID_RECOVERY_CODE', 401, 'Tên đăng nhập hoặc mã khôi phục không hợp lệ.');
        }
        const nextSv = bumpSessionVersion !== false ? user.sessionVersion + 1 : user.sessionVersion;
        const nextRec = recoveryCodeHash !== undefined ? recoveryCodeHash : user.recoveryCodeHash;
        const nextCas = user.casVersion + 1;
        await client.query(
          `UPDATE users SET password_hash = $2, recovery_code_hash = $3, session_version = $4, cas_version = $5, updated_at = $6 WHERE id = $1`,
          [userId, passwordHash, nextRec, nextSv, nextCas, now]
        );
        return {
          ...user,
          passwordHash,
          recoveryCodeHash: nextRec,
          sessionVersion: nextSv,
          casVersion: nextCas,
          updatedAt: now
        };
      });
    },
    async toggleUserLock(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.toggleUserLock(params);
      const { userId, locked, now = Date.now() } = params;
      return withTransaction(async (client) => {
        const res = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(res.rows?.[0]);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        const nextLocked = typeof locked === 'boolean' ? locked : !user.locked;
        const nextSv = user.sessionVersion + 1;
        const nextCas = user.casVersion + 1;
        await client.query(
          `UPDATE users SET locked = $2, session_version = $3, cas_version = $4, updated_at = $5 WHERE id = $1`,
          [userId, nextLocked, nextSv, nextCas, now]
        );
        return { ...user, locked: nextLocked, sessionVersion: nextSv, casVersion: nextCas, updatedAt: now };
      });
    },
    async listUsers({ q = '', limit = 50, offset = 0 } = {}) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.listUsers({ q, limit, offset });
      const query = typeof q === 'string' ? q.trim() : '';
      const safeLimit = Math.max(1, Number(limit) || 50);
      const safeOffset = Math.max(0, Number(offset) || 0);
      const res = query
        ? await pool.query(
          `SELECT * FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 OR id ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [`%${query}%`, safeLimit, safeOffset]
        )
        : await pool.query(
          `SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [safeLimit, safeOffset]
        );
      const countRes = query
        ? await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 OR id ILIKE $1`, [`%${query}%`])
        : await pool.query(`SELECT COUNT(*) AS cnt FROM users`);
      return {
        users: (res.rows || []).map((r) => sanitizeUser(mapPgUserRow(r))),
        total: Number(countRes.rows?.[0]?.cnt || 0)
      };
    },
    async rotateFairnessAtomic({ userId, newServerSeed, newServerSeedHash, newClientSeed, now = Date.now() }) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.rotateFairnessAtomic({ userId, newServerSeed, newServerSeedHash, newClientSeed, now });
      return withTransaction(async (client) => {
        const res = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(res.rows?.[0]);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const previous = {
          serverSeed: user.fairness.serverSeed,
          serverSeedHash: user.fairness.serverSeedHash,
          clientSeed: user.fairness.clientSeed,
          finalNonce: Number(user.fairness.nonce) || 0
        };
        const nextServerSeed = (typeof newServerSeed === 'string' && newServerSeed.trim())
          ? newServerSeed.trim()
          : crypto.randomBytes(32).toString('hex');
        const nextServerSeedHash = (typeof newServerSeedHash === 'string' && newServerSeedHash.trim())
          ? newServerSeedHash.trim()
          : sha256Hex(nextServerSeed);
        const nextClientSeed = (typeof newClientSeed === 'string' && newClientSeed.trim())
          ? newClientSeed.trim()
          : user.fairness.clientSeed;
        const nextFairness = {
          serverSeed: nextServerSeed,
          serverSeedHash: nextServerSeedHash,
          clientSeed: nextClientSeed,
          nonce: 0,
          lastRevealed: previous
        };
        const nextCas = user.casVersion + 1;
        await client.query(
          `UPDATE users SET fairness = $2::jsonb, cas_version = $3, updated_at = $4 WHERE id = $1`,
          [userId, JSON.stringify(nextFairness), nextCas, now]
        );
        user.fairness = nextFairness;
        user.casVersion = nextCas;
        user.updatedAt = now;
        return {
          previous,
          current: {
            serverSeedHash: nextServerSeedHash,
            clientSeed: nextClientSeed,
            nonce: 0,
            lastRevealed: previous
          },
          user: sanitizeUser(user)
        };
      });
    },
    async placeManualRollAtomic(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.placeManualRollAtomic(params);
      const { userId, bets, totalBet, clientSeed, idempotencyKey, idempotencyHash, resolveFn, now = Date.now() } = params;
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const effectiveClientSeedInput = (typeof clientSeed === 'string' && clientSeed.trim())
        ? clientSeed.trim()
        : null;

      return withTransaction(async (client) => {
        const res = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(res.rows?.[0]);
        const reqHash = idempotencyHash || computeIdempotencyHash({
          bets: cleanBets,
          clientSeed: effectiveClientSeedInput || (user ? user.fairness.clientSeed : '')
        });
        const replayed = await checkPgIdempotency(client, userId, 'manual_roll', cleanKey, reqHash, now);
        if (replayed) return replayed;

        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');
        if (user.balance < expectedTotalBet) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư không đủ để đặt cược.');
        }

        const effectiveClientSeed = effectiveClientSeedInput || user.fairness.clientSeed;
        const { usedNonce, hmacHex, evaluation } = resolveRollOutcome({
          user,
          cleanBets,
          totalBet: expectedTotalBet,
          effectiveClientSeed,
          resolveFn
        });

        const ghRes = await client.query(
          `INSERT INTO global_history (dice, total, is_triple, outcome, server_seed_hash, nonce, timestamp)
           VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            JSON.stringify(evaluation.dice),
            evaluation.total,
            evaluation.isTriple,
            evaluation.outcome,
            user.fairness.serverSeedHash,
            usedNonce,
            now
          ]
        );
        const roundId = toSafeNumber(ghRes.rows?.[0]?.id, 1001);

        const b0 = user.balance;
        const b1 = b0 - expectedTotalBet;
        const b2 = b1 + evaluation.totalWin;

        const betEntry = {
          id: crypto.randomUUID(),
          userId,
          type: 'bet',
          amount: -expectedTotalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Tự Lắc #${roundId}`,
          refId: `manual:${roundId}`,
          timestamp: now
        };
        await client.query(
          `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, reason, ref_id, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [betEntry.id, userId, betEntry.type, betEntry.amount, betEntry.balanceBefore, betEntry.balanceAfter, betEntry.reason, betEntry.refId, betEntry.timestamp]
        );

        let winEntry = null;
        if (evaluation.totalWin > 0) {
          winEntry = {
            id: crypto.randomUUID(),
            userId,
            type: 'win',
            amount: evaluation.totalWin,
            balanceBefore: b1,
            balanceAfter: b2,
            reason: `Thắng Tự Lắc #${roundId}`,
            refId: `manual:${roundId}`,
            timestamp: now
          };
          await client.query(
            `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, reason, ref_id, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [winEntry.id, userId, winEntry.type, winEntry.amount, winEntry.balanceBefore, winEntry.balanceAfter, winEntry.reason, winEntry.refId, winEntry.timestamp]
          );
        }

        user.balance = b2;
        user.totalBet += expectedTotalBet;
        user.totalWon += evaluation.totalWin;
        user.netProfit += evaluation.netProfit;
        user.rounds += 1;
        if (evaluation.netProfit > 0) user.winRounds += 1;
        user.fairness.nonce = usedNonce + 1;
        user.casVersion += 1;
        user.updatedAt = now;

        await client.query(
          `UPDATE users
           SET balance = $2, total_bet = $3, total_won = $4, net_profit = $5,
               rounds = $6, win_rounds = $7, fairness = $8::jsonb,
               cas_version = $9, updated_at = $10
           WHERE id = $1`,
          [
            userId, user.balance, user.totalBet, user.totalWon, user.netProfit,
            user.rounds, user.winRounds, JSON.stringify(user.fairness),
            user.casVersion, user.updatedAt
          ]
        );

        const fairnessProof = {
          roundId,
          serverSeedHash: user.fairness.serverSeedHash,
          clientSeed: effectiveClientSeed,
          nonce: usedNonce,
          hmacHex
        };

        await client.query(
          `INSERT INTO personal_history (
            user_id, round_id, timestamp, mode, bets, dice, total, is_triple,
            outcome, total_bet, total_won, net_profit, balance_after, fairness
          ) VALUES ($1, $2, $3, 'manual', $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
          [
            userId, roundId, now, JSON.stringify(cleanBets), JSON.stringify(evaluation.dice),
            evaluation.total, evaluation.isTriple, evaluation.outcome, expectedTotalBet,
            evaluation.totalWin, evaluation.netProfit, b2, JSON.stringify(fairnessProof)
          ]
        );

        const response = {
          replayed: false,
          roundId,
          mode: 'manual',
          dice: evaluation.dice,
          total: evaluation.total,
          isTriple: evaluation.isTriple,
          outcome: evaluation.outcome,
          totalBet: expectedTotalBet,
          totalWin: evaluation.totalWin,
          netProfit: evaluation.netProfit,
          newBalance: b2,
          winningDetails: evaluation.winningDetails,
          fairness: {
            serverSeedHash: user.fairness.serverSeedHash,
            clientSeed: effectiveClientSeed,
            nonce: usedNonce
          },
          ledgerEntries: winEntry ? [betEntry, winEntry] : [betEntry],
          user: sanitizeUser(user)
        };

        await savePgIdempotency(client, userId, 'manual_roll', cleanKey, reqHash, response, now);
        return response;
      });
    },
    async placeLiveBetAtomic(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.placeLiveBetAtomic(params);
      const { userId, liveRoundId, bets, totalBet, idempotencyKey, idempotencyHash, now = Date.now() } = params;
      const validation = validateBets(bets);
      if (!validation.valid) {
        throw makeDbError('INVALID_BETS', 400, validation.error);
      }
      const cleanBets = validation.cleanBets;
      const expectedTotalBet = validation.totalBet;
      if (totalBet !== undefined && totalBet !== expectedTotalBet) {
        throw makeDbError('INVALID_BETS', 400, 'Total bet mismatch');
      }
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ liveRoundId, bets: cleanBets });

      return withTransaction(async (client) => {
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(userRes.rows?.[0]);
        const replayed = await checkPgIdempotency(client, userId, 'live_bet', cleanKey, reqHash, now);
        if (replayed) return replayed;

        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (user.locked) throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');

        const ticketRes = await client.query(
          'SELECT * FROM live_tickets WHERE live_round_id = $1 AND user_id = $2 FOR UPDATE',
          [liveRoundId, userId]
        );
        const existingTicket = mapPgTicketRow(ticketRes.rows?.[0]);
        if (existingTicket && existingTicket.settled) {
          throw makeDbError('ROUND_ALREADY_SETTLED', 409, 'Phiên Live này đã mở bát kết toán.');
        }

        if (existingTicket && existingTicket.bets) {
          for (const [gate, amt] of Object.entries(cleanBets)) {
            const prevAmt = Number(existingTicket.bets[gate]) || 0;
            if (!Number.isSafeInteger(prevAmt + amt) || (prevAmt + amt) > sicboEngine.MAX_SINGLE_BET) {
              throw makeDbError(
                'INVALID_BETS',
                400,
                `Tổng cược cho cửa ${gate} trong phiên Live không được vượt quá ${sicboEngine.MAX_SINGLE_BET}.`
              );
            }
          }
        }

        if (user.balance < expectedTotalBet) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư không đủ để đặt cược.');
        }

        const b0 = user.balance;
        const b1 = b0 - expectedTotalBet;
        const ledgerEntry = {
          id: crypto.randomUUID(),
          userId,
          type: 'bet',
          amount: -expectedTotalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Phòng Live #${liveRoundId}`,
          refId: `live:${liveRoundId}`,
          timestamp: now
        };
        await client.query(
          `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, reason, ref_id, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ledgerEntry.id, userId, ledgerEntry.type, ledgerEntry.amount, ledgerEntry.balanceBefore, ledgerEntry.balanceAfter, ledgerEntry.reason, ledgerEntry.refId, ledgerEntry.timestamp]
        );

        let ticket = existingTicket;
        if (!ticket) {
          ticket = {
            liveRoundId,
            userId,
            bets: { ...cleanBets },
            totalBet: expectedTotalBet,
            settled: false,
            dice: null,
            total: null,
            isTriple: null,
            outcome: null,
            totalWin: 0,
            netProfit: 0,
            winningDetails: [],
            createdAt: now,
            updatedAt: now,
            settledAt: null
          };
          await client.query(
            `INSERT INTO live_tickets (live_round_id, user_id, bets, total_bet, settled, created_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, FALSE, $5, $6)`,
            [liveRoundId, userId, JSON.stringify(ticket.bets), ticket.totalBet, now, now]
          );
        } else {
          for (const [k, amt] of Object.entries(cleanBets)) {
            ticket.bets[k] = (ticket.bets[k] || 0) + amt;
          }
          ticket.totalBet += expectedTotalBet;
          ticket.updatedAt = now;
          await client.query(
            `UPDATE live_tickets SET bets = $3::jsonb, total_bet = $4, updated_at = $5 WHERE live_round_id = $1 AND user_id = $2`,
            [liveRoundId, userId, JSON.stringify(ticket.bets), ticket.totalBet, now]
          );
        }

        user.balance = b1;
        user.totalBet += expectedTotalBet;
        user.netProfit -= expectedTotalBet;
        user.casVersion += 1;
        user.updatedAt = now;
        await client.query(
          `UPDATE users SET balance = $2, total_bet = $3, net_profit = $4, cas_version = $5, updated_at = $6 WHERE id = $1`,
          [userId, user.balance, user.totalBet, user.netProfit, user.casVersion, user.updatedAt]
        );

        const response = {
          replayed: false,
          liveRoundId,
          ticket,
          newBalance: b1,
          ledgerEntry,
          user: sanitizeUser(user)
        };
        await savePgIdempotency(client, userId, 'live_bet', cleanKey, reqHash, response, now);
        return response;
      });
    },
    async getLiveTicket({ userId, liveRoundId }) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getLiveTicket({ userId, liveRoundId });
      const res = await pool.query(
        'SELECT * FROM live_tickets WHERE live_round_id = $1 AND user_id = $2',
        [liveRoundId, userId]
      );
      return mapPgTicketRow(res.rows?.[0]);
    },
    async getUnsettledLiveTickets(userId) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getUnsettledLiveTickets(userId);
      const res = await pool.query(
        'SELECT * FROM live_tickets WHERE user_id = $1 AND settled = FALSE ORDER BY live_round_id ASC',
        [userId]
      );
      return (res.rows || []).map(mapPgTicketRow);
    },
    async settleLiveRoundAtomic(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.settleLiveRoundAtomic(params);
      const { userId, liveRoundId, dice, evaluation, roundSeedHash = null, now = Date.now() } = params;
      if (!Number.isSafeInteger(liveRoundId) || liveRoundId < 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Invalid liveRoundId');
      }

      return withTransaction(async (client) => {
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(userRes.rows?.[0]);
        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');

        const ticketRes = await client.query(
          'SELECT * FROM live_tickets WHERE live_round_id = $1 AND user_id = $2 FOR UPDATE',
          [liveRoundId, userId]
        );
        const ticket = mapPgTicketRow(ticketRes.rows?.[0]);
        if (!ticket) {
          throw makeDbError('TICKET_NOT_FOUND', 404, 'Không tìm thấy vé cược cho phiên Live này.');
        }

        if (ticket.settled) {
          return {
            alreadySettled: true,
            settledNow: false,
            liveRoundId,
            settled: true,
            ticket,
            newBalance: user.balance,
            ledgerEntry: null,
            user: sanitizeUser(user)
          };
        }

        const effectiveEval = (dice && Array.isArray(dice))
          ? evaluateRoll(dice, ticket.bets)
          : evaluation;
        if (!effectiveEval || !Array.isArray(effectiveEval.dice)) {
          throw makeDbError('INVALID_INPUT', 400, 'Dice or evaluation is required to settle live round');
        }

        ticket.settled = true;
        ticket.dice = effectiveEval.dice;
        ticket.total = effectiveEval.total;
        ticket.isTriple = effectiveEval.isTriple;
        ticket.outcome = effectiveEval.outcome;
        ticket.totalWin = effectiveEval.totalWin;
        ticket.netProfit = effectiveEval.totalWin - ticket.totalBet;
        ticket.winningDetails = effectiveEval.winningDetails;
        ticket.settledAt = now;
        ticket.updatedAt = now;

        await client.query(
          `UPDATE live_tickets
           SET settled = TRUE, dice = $3::jsonb, total = $4, is_triple = $5, outcome = $6,
               total_win = $7, net_profit = $8, winning_details = $9::jsonb, settled_at = $10, updated_at = $11
           WHERE live_round_id = $1 AND user_id = $2`,
          [
            liveRoundId, userId, JSON.stringify(ticket.dice), ticket.total, ticket.isTriple,
            ticket.outcome, ticket.totalWin, ticket.netProfit, JSON.stringify(ticket.winningDetails),
            now, now
          ]
        );

        const b0 = user.balance;
        const b1 = b0 + effectiveEval.totalWin;
        let ledgerEntry = null;
        if (effectiveEval.totalWin > 0) {
          ledgerEntry = {
            id: crypto.randomUUID(),
            userId,
            type: 'win',
            amount: effectiveEval.totalWin,
            balanceBefore: b0,
            balanceAfter: b1,
            reason: `Thắng Phòng Live #${liveRoundId}`,
            refId: `live:${liveRoundId}`,
            timestamp: now
          };
          await client.query(
            `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, reason, ref_id, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [ledgerEntry.id, userId, ledgerEntry.type, ledgerEntry.amount, ledgerEntry.balanceBefore, ledgerEntry.balanceAfter, ledgerEntry.reason, ledgerEntry.refId, ledgerEntry.timestamp]
          );
        }

        user.balance = b1;
        user.totalWon += effectiveEval.totalWin;
        user.netProfit += effectiveEval.totalWin;
        user.rounds += 1;
        if (ticket.netProfit > 0) user.winRounds += 1;
        user.casVersion += 1;
        user.updatedAt = now;

        await client.query(
          `UPDATE users
           SET balance = $2, total_won = $3, net_profit = $4, rounds = $5, win_rounds = $6, cas_version = $7, updated_at = $8
           WHERE id = $1`,
          [userId, user.balance, user.totalWon, user.netProfit, user.rounds, user.winRounds, user.casVersion, user.updatedAt]
        );

        await client.query(
          `INSERT INTO personal_history (
            user_id, round_id, timestamp, mode, bets, dice, total, is_triple,
            outcome, total_bet, total_won, net_profit, balance_after, fairness
          ) VALUES ($1, $2, $3, 'live', $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
          [
            userId, liveRoundId, now, JSON.stringify(ticket.bets), JSON.stringify(ticket.dice),
            ticket.total, ticket.isTriple, ticket.outcome, ticket.totalBet, ticket.totalWin,
            ticket.netProfit, b1, JSON.stringify({ liveRoundId, roundSeedHash })
          ]
        );

        await client.query(
          `INSERT INTO global_history (live_round_id, dice, total, is_triple, outcome, server_seed_hash, timestamp)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
           ON CONFLICT (live_round_id) DO NOTHING`,
          [liveRoundId, JSON.stringify(ticket.dice), ticket.total, ticket.isTriple, ticket.outcome, roundSeedHash, now]
        );

        return {
          alreadySettled: false,
          settledNow: true,
          liveRoundId,
          settled: true,
          ticket,
          newBalance: b1,
          ledgerEntry,
          user: sanitizeUser(user)
        };
      });
    },
    async adjustBalanceAtomic(params) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.adjustBalanceAtomic(params);
      const {
        userId, delta, type, reason = '', refId = null, idempotencyKey, idempotencyHash,
        allowLocked = false, minBalanceAfter = 0, cooldownField = null, cooldownMs = 0,
        maxBalanceBefore = null, now = Date.now()
      } = params;
      if (!LEDGER_TYPE_SET.has(type)) {
        throw makeDbError('INVALID_INPUT', 400, `Unsupported ledger type: ${type}`);
      }
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw makeDbError('INVALID_INPUT', 400, 'Balance delta must be a non-zero safe integer');
      }
      const cleanKey = normalizeIdempotencyKey(idempotencyKey);
      const reqHash = idempotencyHash || computeIdempotencyHash({ delta, type, reason, refId });

      return withTransaction(async (client) => {
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = mapPgUserRow(userRes.rows?.[0]);
        const replayed = await checkPgIdempotency(client, userId, type, cleanKey, reqHash, now);
        if (replayed) return replayed;

        if (!user) throw makeDbError('USER_NOT_FOUND', 404, 'Không tìm thấy tài khoản.');
        if (!allowLocked && user.locked) {
          throw makeDbError('USER_LOCKED', 403, 'Tài khoản đã bị khóa.');
        }
        if (maxBalanceBefore !== null && user.balance >= maxBalanceBefore) {
          throw makeDbError('BANKRUPTCY_INELIGIBLE', 400, 'Số dư hiện tại chưa đủ điều kiện nhận trợ cấp.');
        }
        if (cooldownField && cooldownMs > 0) {
          const lastAt = user[cooldownField];
          if (typeof lastAt === 'number' && (now - lastAt) < cooldownMs) {
            throw makeDbError('COOLDOWN_ACTIVE', 429, 'Chưa hết thời gian chờ nhận thưởng.', {
              nextEligibleAt: lastAt + cooldownMs
            });
          }
        }
        const b0 = user.balance;
        const b1 = b0 + delta;
        if (!Number.isSafeInteger(b1)) {
          throw makeDbError('INVALID_AMOUNT', 400, 'Số dư sau điều chỉnh vượt quá giới hạn an toàn.');
        }
        if (b1 < minBalanceAfter) {
          throw makeDbError('INSUFFICIENT_BALANCE', 400, 'Số dư sau điều chỉnh không được âm.');
        }

        const ledgerEntry = {
          id: crypto.randomUUID(),
          userId,
          type,
          amount: delta,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: String(reason || ''),
          refId: refId ?? null,
          timestamp: now
        };
        await client.query(
          `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_before, balance_after, reason, ref_id, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ledgerEntry.id, userId, ledgerEntry.type, ledgerEntry.amount, ledgerEntry.balanceBefore, ledgerEntry.balanceAfter, ledgerEntry.reason, ledgerEntry.refId, ledgerEntry.timestamp]
        );

        user.balance = b1;
        if (cooldownField) user[cooldownField] = now;
        user.casVersion += 1;
        user.updatedAt = now;

        await client.query(
          `UPDATE users SET balance = $2, last_daily_bonus_at = $3, last_bankruptcy_aid_at = $4, cas_version = $5, updated_at = $6 WHERE id = $1`,
          [userId, user.balance, user.lastDailyBonusAt, user.lastBankruptcyAidAt, user.casVersion, user.updatedAt]
        );

        const response = {
          replayed: false,
          user: sanitizeUser(user),
          balance: b1,
          ledgerEntry,
          nextEligibleAt: (cooldownField && cooldownMs > 0) ? (now + cooldownMs) : null
        };
        await savePgIdempotency(client, userId, type, cleanKey, reqHash, response, now);
        return response;
      });
    },
    async getWalletLedger(userId, limit = 50) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getWalletLedger(userId, limit);
      const res = await pool.query(
        'SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY timestamp DESC, seq DESC LIMIT $2',
        [userId, Math.max(0, limit)]
      );
      return (res.rows || []).map((r) => ({
        id: r.id,
        userId: r.user_id,
        type: r.type,
        amount: toSafeNumber(r.amount),
        balanceBefore: toSafeNumber(r.balance_before),
        balanceAfter: toSafeNumber(r.balance_after),
        reason: r.reason,
        refId: r.ref_id,
        timestamp: toSafeNumber(r.timestamp)
      }));
    },
    async getPersonalHistory(userId, limit = 40) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getPersonalHistory(userId, limit);
      const res = await pool.query(
        'SELECT * FROM personal_history WHERE user_id = $1 ORDER BY seq DESC LIMIT $2',
        [userId, Math.max(0, limit)]
      );
      return (res.rows || []).map((r) => ({
        roundId: toSafeNumber(r.round_id),
        timestamp: toSafeNumber(r.timestamp),
        mode: r.mode,
        bets: typeof r.bets === 'string' ? JSON.parse(r.bets) : r.bets,
        dice: typeof r.dice === 'string' ? JSON.parse(r.dice) : r.dice,
        total: Number(r.total),
        isTriple: Boolean(r.is_triple),
        outcome: r.outcome,
        totalBet: toSafeNumber(r.total_bet),
        totalWin: toSafeNumber(r.total_won),
        netProfit: toSafeNumber(r.net_profit),
        balanceAfter: toSafeNumber(r.balance_after),
        fairness: typeof r.fairness === 'string' ? JSON.parse(r.fairness) : r.fairness
      }));
    },
    async getGlobalHistory(limit = 60) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getGlobalHistory(limit);
      const res = await pool.query(
        'SELECT * FROM global_history ORDER BY id DESC LIMIT $1',
        [Math.max(0, limit)]
      );
      return (res.rows || []).reverse().map((r) => ({
        id: toSafeNumber(r.id),
        liveRoundId: r.live_round_id !== null && r.live_round_id !== undefined ? toSafeNumber(r.live_round_id) : undefined,
        dice: typeof r.dice === 'string' ? JSON.parse(r.dice) : r.dice,
        total: Number(r.total),
        isTriple: Boolean(r.is_triple),
        outcome: r.outcome,
        serverSeedHash: r.server_seed_hash || undefined,
        nonce: r.nonce ?? undefined,
        timestamp: toSafeNumber(r.timestamp)
      }));
    },
    async getLeaderboard(limit = 20) {
      await ensureInit();
      if (fallbackJson) return fallbackJson.getLeaderboard(limit);
      const safeLimit = Math.max(1, limit);
      const balRes = await pool.query(
        'SELECT * FROM users WHERE locked = FALSE ORDER BY balance DESC, net_profit DESC, rounds DESC, created_at ASC LIMIT $1',
        [safeLimit]
      );
      const profRes = await pool.query(
        'SELECT * FROM users WHERE locked = FALSE ORDER BY net_profit DESC, balance DESC, rounds DESC, created_at ASC LIMIT $1',
        [safeLimit]
      );
      return {
        byBalance: (balRes.rows || []).map((r) => buildLeaderboardRow(mapPgUserRow(r))),
        byNetProfit: (profRes.rows || []).map((r) => buildLeaderboardRow(mapPgUserRow(r)))
      };
    }
  };
}

// ============================================================================
// 4. UNIFIED ADAPTER FACTORY & SINGLETON CACHE
// ============================================================================

function isLoadedConfigObject(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    typeof obj.dbDriver === 'string' &&
    typeof obj.dataDir === 'string' &&
    typeof obj.jwtSecret === 'string'
  );
}

function createDb(configOrOptions = {}, extraOptions = {}) {
  const config = isLoadedConfigObject(configOrOptions)
    ? configOrOptions
    : loadConfig(configOrOptions);

  const opts = isLoadedConfigObject(configOrOptions)
    ? { ...extraOptions }
    : { ...configOrOptions, ...extraOptions };

  let backend;
  if (config.dbDriver === 'upstash') {
    backend = createUpstashBackend(config, opts);
  } else if (config.dbDriver === 'postgres') {
    backend = createPostgresBackend(config, opts);
  } else {
    backend = createJsonBackend(config, opts);
  }

  const adapter = {
    driver: config.dbDriver,
    get effectiveDriver() {
      if (config.dbDriver === 'postgres' && backend.isFallback && backend.isFallback()) {
        return 'json';
      }
      return config.dbDriver;
    },
    get pgMissing() {
      return Boolean(config.dbDriver === 'postgres' && backend.isFallback && backend.isFallback());
    },
    config,
    init: () => backend.init(),
    close: () => backend.close(),
    getUserById: (userId) => backend.getUserById(userId),
    getUserByUsername: (username) => backend.getUserByUsername(username),
    createUser: (params) => backend.createUser(params),
    upgradeGuestAtomic: (params) => backend.upgradeGuestAtomic(params),
    updateUserPassword: (params) => backend.updateUserPassword(params),
    toggleUserLock: (params) => backend.toggleUserLock(params),
    listUsers: (params) => backend.listUsers(params),
    rotateFairnessAtomic: (params) => backend.rotateFairnessAtomic(params),
    placeManualRollAtomic: (params) => backend.placeManualRollAtomic(params),
    placeLiveBetAtomic: (params) => backend.placeLiveBetAtomic(params),
    getLiveTicket: (params) => backend.getLiveTicket(params),
    getUnsettledLiveTickets: (userId) => backend.getUnsettledLiveTickets(userId),
    settleLiveRoundAtomic: (params) => backend.settleLiveRoundAtomic(params),
    adjustBalanceAtomic: (params) => backend.adjustBalanceAtomic(params),
    getWalletLedger: (userId, limit) => backend.getWalletLedger(userId, limit),
    getPersonalHistory: (userId, limit) => backend.getPersonalHistory(userId, limit),
    getGlobalHistory: (limit) => backend.getGlobalHistory(limit),
    getLeaderboard: (limit) => backend.getLeaderboard(limit),
    sanitizeUser
  };

  if (typeof backend.getFilePath === 'function') {
    adapter.getFilePath = () => backend.getFilePath();
  }

  return adapter;
}

let cachedDb = null;

function getDb() {
  if (!cachedDb) {
    cachedDb = createDb(getConfig());
  }
  return cachedDb;
}

function resetDbCache() {
  cachedDb = null;
}

module.exports = {
  LEDGER_TYPES,
  createDb,
  getDb,
  resetDbCache,
  sanitizeUser,
  computeIdempotencyHash
};
