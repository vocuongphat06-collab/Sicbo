'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { loadConfig, resetConfigCache } = require('../../lib/config');
const { sha256Hex, evaluateRoll, deriveFairDice } = require('../../lib/sicbo-engine');
const {
  LEDGER_TYPES,
  createDb,
  resetDbCache,
  sanitizeUser,
  computeIdempotencyHash
} = require('../../lib/db');
const {
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
  isAdminUsername,
  resolveInitialRole,
  validateUsername,
  validatePassword,
  validateDisplayName,
  generateTempPassword,
  escapeHtml,
  createRateLimiter,
  createAuthMiddleware
} = require('../../lib/auth');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const tempDirsToClean = [];
const limitersToDestroy = [];
const serversToClose = [];
let initialDataSnapshot = null;

function snapshotDataDir() {
  const entries = fs.readdirSync(DATA_DIR).sort();
  return entries.map((name) => {
    const stat = fs.statSync(path.join(DATA_DIR, name));
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sicbo-m2-test-'));
  tempDirsToClean.push(dir);
  return dir;
}

function createIsolatedDb(extraOpts = {}) {
  const dir = makeTempDir();
  const cfg = loadConfig({
    env: { NODE_ENV: 'test' },
    dataDir: dir,
    loadDotEnv: false
  });
  return createDb(cfg, { seedLegacyHistory: false, ...extraOpts });
}

function createMockRes({ withAppend = true } = {}) {
  const headers = new Map();
  const res = {
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    }
  };
  if (withAppend) {
    res.append = function append(name, value) {
      const k = name.toLowerCase();
      const prev = headers.get(k);
      if (!prev) {
        headers.set(k, value);
      } else if (Array.isArray(prev)) {
        headers.set(k, [...prev, value]);
      } else {
        headers.set(k, [prev, value]);
      }
    };
  }
  return res;
}

before(() => {
  initialDataSnapshot = snapshotDataDir();
});

afterEach(async () => {
  resetDbCache();
  resetConfigCache();
  while (serversToClose.length > 0) {
    await serversToClose.pop().close();
  }
  while (limitersToDestroy.length > 0) {
    limitersToDestroy.pop().destroy();
  }
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  const finalSnapshot = snapshotDataDir();
  assert.deepEqual(finalSnapshot, initialDataSnapshot);
});

// ============================================================================
// SUITE 1: JSON Adapter, VERCEL=1 Isolation & Repo Data Guard
// ============================================================================

describe('lib/db.js — JSON Adapter, VERCEL=1 Isolation & Integrity', () => {
  it('seeds globalHistory read-only and persists users/ledger across reloads without mutating repo data/', async () => {
    const dir = makeTempDir();
    const cfg = loadConfig({ env: { NODE_ENV: 'test' }, dataDir: dir, loadDotEnv: false });
    const db1 = createDb(cfg, { seedLegacyHistory: true });
    await db1.init();

    const seededHistory = await db1.getGlobalHistory(100);
    assert.ok(seededHistory.length > 0, 'expected seeded global history from data/history.json');

    const pwHash = await hashPassword('VipSecret123!');
    const recHash = await hashRecoveryCode('SOV-1111-2222-3333');
    const created = await db1.createUser({
      username: 'SalonVIP',
      displayName: 'Đại Gia',
      passwordHash: pwHash,
      recoveryCodeHash: recHash,
      balance: 500_000
    });

    assert.equal(created.username, 'SalonVIP');
    assert.equal(created.usernameLower, 'salonvip');
    assert.equal(created.balance, 500_000);
    assert.equal(created.fairness.nonce, 0);

    const sanitized = sanitizeUser(created);
    assert.equal(sanitized.passwordHash, undefined);
    assert.equal(sanitized.recoveryCodeHash, undefined);
    assert.equal(sanitized.casVersion, undefined);
    assert.equal(sanitized.fairness.serverSeed, undefined);
    assert.equal(sanitized.fairness.serverSeedHash, created.fairness.serverSeedHash);

    const db2 = createDb(cfg, { seedLegacyHistory: true });
    await db2.init();
    const reloaded = await db2.getUserByUsername('salonvip');
    assert.ok(reloaded);
    assert.equal(reloaded.id, created.id);
    assert.equal(reloaded.balance, 500_000);
    assert.deepEqual(snapshotDataDir(), initialDataSnapshot);
  });

  it('uses os.tmpdir()/sicbo-data/db.json under VERCEL=1 and cleans up cleanly', async () => {
    const vercelTmpDir = path.join(os.tmpdir(), 'sicbo-data');
    const expectedDbPath = path.join(vercelTmpDir, 'db.json');
    const preExisted = fs.existsSync(vercelTmpDir);

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const cfg = loadConfig({
        env: { VERCEL: '1', NODE_ENV: 'production' },
        fresh: true,
        silent: true
      });
      assert.equal(cfg.isVercel, true);
      assert.equal(cfg.dbDriver, 'json');
      assert.equal(cfg.dataDir, vercelTmpDir);

      const db = createDb(cfg, { seedLegacyHistory: false });
      await db.init();
      assert.equal(db.getFilePath(), expectedDbPath);
      assert.equal(fs.existsSync(expectedDbPath), true);

      const user = await db.createUser({
        username: 'vercelUser',
        passwordHash: await hashPassword('VercelPass123'),
        balance: 200_000
      });
      const fetched = await db.getUserById(user.id);
      assert.equal(fetched.balance, 200_000);
      assert.deepEqual(snapshotDataDir(), initialDataSnapshot);
    } finally {
      console.warn = origWarn;
      if (!preExisted) {
        fs.rmSync(vercelTmpDir, { recursive: true, force: true });
      } else {
        fs.rmSync(expectedDbPath, { force: true });
      }
    }
    assert.equal(fs.existsSync(expectedDbPath), false);
    assert.equal(warnings.length, 0);
  });
});

// ============================================================================
// SUITE 2: Concurrency, Double-Spend, Idempotency, Upgrade & Rotation
// ============================================================================

describe('lib/db.js — Concurrency, Idempotency, Guest Upgrade & Fairness Rotation', () => {
  it('prevents double-spend across 12 parallel placeManualRollAtomic calls (all-loss)', async () => {
    const db = createIsolatedDb();
    await db.init();
    const user = await db.createUser({
      username: 'raceAllLoss',
      passwordHash: await hashPassword('pass1234'),
      balance: 100_000
    });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => db.placeManualRollAtomic({
        userId: user.id,
        bets: { tai: 25_000 },
        resolveFn: () => ({ dice: [1, 1, 1] }) // triple loses tai
      }))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);

    assert.equal(fulfilled.length, 4);
    assert.equal(rejected.length, 8);
    for (const err of rejected) {
      assert.equal(err.code, 'INSUFFICIENT_BALANCE');
      assert.equal(err.status, 400);
    }

    const nonces = fulfilled.map((r) => r.fairness.nonce).sort((a, b) => a - b);
    assert.deepEqual(nonces, [0, 1, 2, 3]);

    const finalUser = await db.getUserById(user.id);
    assert.equal(finalUser.balance, 0);
    assert.equal(finalUser.fairness.nonce, 4);
    assert.equal(finalUser.rounds, 4);

    const ledger = await db.getWalletLedger(user.id, 50);
    assert.equal(ledger.length, 4);
    const chrono = ledger.slice().reverse();
    for (let i = 0; i < chrono.length; i++) {
      assert.equal(chrono[i].type, 'bet');
      assert.equal(chrono[i].amount, -25_000);
      assert.equal(chrono[i].balanceBefore + chrono[i].amount, chrono[i].balanceAfter);
      assert.ok(chrono[i].balanceAfter >= 0);
      if (i > 0) {
        assert.equal(chrono[i - 1].balanceAfter, chrono[i].balanceBefore);
      }
    }
  });

  it('maintains exact ledger & balance invariants across 10 parallel mixed win/loss rolls', async () => {
    const db = createIsolatedDb();
    await db.init();
    const user = await db.createUser({
      username: 'raceMixed',
      passwordHash: await hashPassword('pass1234'),
      balance: 50_000
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => db.placeManualRollAtomic({
        userId: user.id,
        bets: { tai: 25_000 },
        resolveFn: ({ nonce }) => ({ dice: nonce === 0 ? [6, 5, 4] : [1, 1, 1] })
      }))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    assert.equal(fulfilled.length, 4); // 50k -> -25k +50k = 75k -> 50k -> 25k -> 0

    const finalUser = await db.getUserById(user.id);
    assert.equal(finalUser.balance, 0);
    assert.equal(finalUser.totalBet, 100_000);
    assert.equal(finalUser.totalWon, 50_000);
    assert.equal(finalUser.netProfit, -50_000);

    const ledger = await db.getWalletLedger(user.id, 50);
    assert.equal(ledger.length, 5); // 4 bets + 1 win
    const chrono = ledger.slice().reverse();
    assert.equal(chrono[0].type, 'bet');
    assert.equal(chrono[1].type, 'win');
    assert.equal(chrono[0].balanceAfter, chrono[1].balanceBefore);
    for (const entry of chrono) {
      assert.equal(entry.balanceBefore + entry.amount, entry.balanceAfter);
      assert.ok(entry.balanceAfter >= 0);
    }
  });

  it('serializes 10 parallel placeLiveBetAtomic and prevents double-settlement on 10 parallel settleLiveRoundAtomic calls', async () => {
    const db = createIsolatedDb();
    await db.init();
    const user = await db.createUser({
      username: 'liveRacer',
      passwordHash: await hashPassword('pass1234'),
      balance: 100_000
    });

    const liveRoundId = 889901;
    const betResults = await Promise.allSettled(
      Array.from({ length: 10 }, () => db.placeLiveBetAtomic({
        userId: user.id,
        liveRoundId,
        bets: { tai: 25_000 }
      }))
    );

    const acceptedBets = betResults.filter((r) => r.status === 'fulfilled');
    const rejectedBets = betResults.filter((r) => r.status === 'rejected');
    assert.equal(acceptedBets.length, 4);
    assert.equal(rejectedBets.length, 6);

    const ticket = await db.getLiveTicket({ userId: user.id, liveRoundId });
    assert.equal(ticket.totalBet, 100_000);
    assert.equal(ticket.bets.tai, 100_000);
    assert.equal(ticket.settled, false);

    // 10 parallel settlements on winning TAI dice [6, 4, 2]
    const settleResults = await Promise.all(
      Array.from({ length: 10 }, () => db.settleLiveRoundAtomic({
        userId: user.id,
        liveRoundId,
        dice: [6, 4, 2],
        roundSeedHash: sha256Hex('commit:test')
      }))
    );

    const newlySettled = settleResults.filter((r) => r.settledNow === true);
    const alreadySettled = settleResults.filter((r) => r.alreadySettled === true);
    assert.equal(newlySettled.length, 1);
    assert.equal(alreadySettled.length, 9);

    const afterUser = await db.getUserById(user.id);
    assert.equal(afterUser.balance, 200_000);
    assert.equal(afterUser.rounds, 1);
    assert.equal(afterUser.winRounds, 1);

    const ledger = await db.getWalletLedger(user.id, 50);
    assert.equal(ledger.filter((e) => e.type === 'win').length, 1);
    assert.equal(ledger.filter((e) => e.type === 'bet').length, 4);

    const personal = await db.getPersonalHistory(user.id, 20);
    assert.equal(personal.length, 1);
    assert.equal(personal[0].mode, 'live');

    // Post-settlement bet MUST be rejected
    await assert.rejects(
      () => db.placeLiveBetAtomic({ userId: user.id, liveRoundId, bets: { xiu: 10_000 } }),
      (err) => err.code === 'ROUND_ALREADY_SETTLED' && err.status === 409
    );
  });

  it('enforces Idempotency-Key replay, 5x parallel dedup, 409 conflict, key-order normalization, non-poisoning, and empty-key bypass', async () => {
    const db = createIsolatedDb();
    await db.init();
    const userA = await db.createUser({
      username: 'idemUserA',
      passwordHash: await hashPassword('pass1234'),
      balance: 200_000
    });
    const userB = await db.createUser({
      username: 'idemUserB',
      passwordHash: await hashPassword('pass1234'),
      balance: 200_000
    });

    // 5 parallel identical calls with same key
    const key1 = 'roll-idem-001';
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => db.placeManualRollAtomic({
        userId: userA.id,
        bets: { tai: 10_000, even: 20_000 },
        idempotencyKey: key1,
        resolveFn: () => ({ dice: [1, 1, 1] })
      }))
    );

    const roundIds = new Set(parallel.map((r) => r.roundId));
    assert.equal(roundIds.size, 1);
    assert.equal(parallel.filter((r) => !r.replayed).length, 1);
    assert.equal(parallel.filter((r) => r.replayed).length, 4);

    // Reordered keys normalize to identical hash -> replayed: true
    const reordered = await db.placeManualRollAtomic({
      userId: userA.id,
      bets: { even: 20_000, tai: 10_000 },
      idempotencyKey: key1,
      resolveFn: () => ({ dice: [1, 1, 1] })
    });
    assert.equal(reordered.replayed, true);
    assert.equal(reordered.roundId, parallel[0].roundId);

    // Different payload with same key -> 409 conflict
    await assert.rejects(
      () => db.placeManualRollAtomic({
        userId: userA.id,
        bets: { xiu: 30_000 },
        idempotencyKey: key1
      }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
    );

    // Same key on User B is isolated
    const userBRes = await db.placeManualRollAtomic({
      userId: userB.id,
      bets: { tai: 10_000 },
      idempotencyKey: key1,
      resolveFn: () => ({ dice: [1, 1, 1] })
    });
    assert.equal(userBRes.replayed, false);
    assert.notEqual(userBRes.roundId, parallel[0].roundId);

    // Same key in live_bet scope for User A is isolated
    const liveRes = await db.placeLiveBetAtomic({
      userId: userA.id,
      liveRoundId: 12345,
      bets: { tai: 10_000 },
      idempotencyKey: key1
    });
    assert.equal(liveRes.replayed, false);

    // Failed request does NOT poison key
    const failKey = 'fail-then-succeed';
    await assert.rejects(
      () => db.placeManualRollAtomic({
        userId: userA.id,
        bets: { tai: 999_999_999 },
        idempotencyKey: failKey
      }),
      (err) => err.code === 'INSUFFICIENT_BALANCE'
    );
    const retryAfterFail = await db.placeManualRollAtomic({
      userId: userA.id,
      bets: { tai: 10_000 },
      idempotencyKey: failKey,
      resolveFn: () => ({ dice: [1, 1, 1] })
    });
    assert.equal(retryAfterFail.replayed, false);

    // Empty/whitespace/missing key bypasses cache
    for (const emptyKey of ['', '   ', undefined, null]) {
      const beforeBal = (await db.getUserById(userB.id)).balance;
      const r = await db.placeManualRollAtomic({
        userId: userB.id,
        bets: { tai: 5_000 },
        idempotencyKey: emptyKey,
        resolveFn: () => ({ dice: [1, 1, 1] })
      });
      assert.equal(r.replayed, false);
      assert.equal(r.newBalance, beforeBal - 5_000);
    }
  });

  it('upgrades guest atomically preserving balance/ledger/history/fairness and handles username races', async () => {
    const db = createIsolatedDb();
    await db.init();

    const guest1 = await db.createUser({
      username: 'guest_001',
      displayName: 'Khách 001',
      isGuest: true,
      balance: 2_000_000
    });
    const guest2 = await db.createUser({
      username: 'guest_002',
      displayName: 'Khách 002',
      isGuest: true,
      balance: 2_000_000
    });
    const existing = await db.createUser({
      username: 'Alice',
      passwordHash: await hashPassword('AlicePass123'),
      balance: 5_000_000
    });
    assert.ok(existing);

    const roll = await db.placeManualRollAtomic({
      userId: guest1.id,
      bets: { tai: 100_000 },
      resolveFn: () => ({ dice: [6, 5, 4] }) // wins +100k -> 2_100_000
    });
    assert.equal(roll.newBalance, 2_100_000);

    // Case-insensitive collision with existing 'Alice' -> 409
    await assert.rejects(
      async () => db.upgradeGuestAtomic({
        userId: guest1.id,
        username: 'alice',
        passwordHash: await hashPassword('NewPass123'),
        recoveryCodeHash: await hashRecoveryCode('SOV-AAAA-BBBB-CCCC')
      }),
      (err) => err.code === 'USERNAME_TAKEN' && err.status === 409
    );

    // Concurrent race between guest1 and guest2 for 'RacedVIP'
    const pw1 = await hashPassword('PassOne123');
    const rc1 = await hashRecoveryCode('SOV-1111-1111-1111');
    const pw2 = await hashPassword('PassTwo123');
    const rc2 = await hashRecoveryCode('SOV-2222-2222-2222');

    const race = await Promise.allSettled([
      db.upgradeGuestAtomic({
        userId: guest1.id,
        username: 'RacedVIP',
        displayName: 'Raced VIP',
        passwordHash: pw1,
        recoveryCodeHash: rc1
      }),
      db.upgradeGuestAtomic({
        userId: guest2.id,
        username: 'racedvip',
        displayName: 'Raced Two',
        passwordHash: pw2,
        recoveryCodeHash: rc2
      })
    ]);

    const wins = race.filter((r) => r.status === 'fulfilled');
    const losses = race.filter((r) => r.status === 'rejected');
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].reason.code, 'USERNAME_TAKEN');

    // Ensure guest1 retains exact stats/ledger/history/fairness if guest1 won, else test direct upgrade
    const winner = wins[0].value;
    assert.equal(winner.isGuest, false);
    assert.equal(winner.recoveryCode, undefined);
    assert.ok(winner.recoveryCodeHash.startsWith('scrypt$'));
    assert.equal(winner.sessionVersion, 2);

    if (winner.id === guest1.id) {
      assert.equal(winner.balance, 2_100_000);
      assert.equal(winner.rounds, 1);
      assert.equal(winner.fairness.nonce, 1);
      assert.equal((await db.getWalletLedger(guest1.id, 10)).length, 2);
      assert.equal((await db.getPersonalHistory(guest1.id, 10)).length, 1);
    }

    // Upgrading a non-guest rejects
    await assert.rejects(
      () => db.upgradeGuestAtomic({
        userId: existing.id,
        username: 'NewAlice',
        passwordHash: pw1,
        recoveryCodeHash: rc1
      }),
      (err) => err.code === 'NOT_A_GUEST'
    );
  });

  it('rotates fairness atomically and never leaks new serverSeed in current DTO', async () => {
    const db = createIsolatedDb();
    await db.init();
    const user = await db.createUser({
      username: 'fairPlayer',
      passwordHash: await hashPassword('pass1234'),
      balance: 1_000_000
    });
    const oldSeed = user.fairness.serverSeed;
    const oldHash = user.fairness.serverSeedHash;

    await db.placeManualRollAtomic({
      userId: user.id,
      bets: { tai: 10_000 }
    });

    const rotated = await db.rotateFairnessAtomic({
      userId: user.id,
      newClientSeed: 'custom-vip-seed'
    });

    assert.equal(rotated.previous.serverSeed, oldSeed);
    assert.equal(rotated.previous.serverSeedHash, oldHash);
    assert.equal(sha256Hex(rotated.previous.serverSeed), rotated.previous.serverSeedHash);
    assert.equal(rotated.previous.finalNonce, 1);

    assert.equal(rotated.current.nonce, 0);
    assert.equal(rotated.current.clientSeed, 'custom-vip-seed');
    assert.notEqual(rotated.current.serverSeedHash, oldHash);
    assert.equal(rotated.current.serverSeed, undefined);
    assert.equal(rotated.user.fairness.serverSeed, undefined);
  });

  it('enforces adjustBalanceAtomic cooldowns, bankruptcy threshold, negative guards & leaderboard', async () => {
    const db = createIsolatedDb();
    await db.init();
    assert.deepEqual(LEDGER_TYPES, ['bet', 'win', 'refund', 'daily_bonus', 'bankruptcy_aid', 'admin_adjust']);

    const u1 = await db.createUser({ username: 'whale', passwordHash: await hashPassword('p123456'), balance: 1_000 });
    const u2 = await db.createUser({ username: 'dolphin', passwordHash: await hashPassword('p123456'), balance: 500_000 });

    const now = 1_700_000_000_000;
    const aid = await db.adjustBalanceAtomic({
      userId: u1.id,
      delta: 500_000,
      type: 'bankruptcy_aid',
      reason: 'Trợ cấp phá sản',
      cooldownField: 'lastBankruptcyAidAt',
      cooldownMs: 3_600_000,
      maxBalanceBefore: 10_000,
      now
    });
    assert.equal(aid.balance, 501_000);

    await assert.rejects(
      () => db.adjustBalanceAtomic({
        userId: u1.id,
        delta: 500_000,
        type: 'bankruptcy_aid',
        cooldownField: 'lastBankruptcyAidAt',
        cooldownMs: 3_600_000,
        maxBalanceBefore: 10_000_000,
        now: now + 1000
      }),
      (err) => err.code === 'COOLDOWN_ACTIVE' && err.status === 429
    );

    await assert.rejects(
      () => db.adjustBalanceAtomic({
        userId: u2.id,
        delta: 500_000,
        type: 'bankruptcy_aid',
        maxBalanceBefore: 10_000,
        now
      }),
      (err) => err.code === 'BANKRUPTCY_INELIGIBLE' && err.status === 400
    );

    await assert.rejects(
      () => db.adjustBalanceAtomic({
        userId: u2.id,
        delta: -999_999,
        type: 'admin_adjust',
        reason: 'Overdraw'
      }),
      (err) => err.code === 'INSUFFICIENT_BALANCE' && err.status === 400
    );

    const lb = await db.getLeaderboard(10);
    assert.equal(lb.byBalance[0].username, 'whale');
    assert.equal(lb.byBalance[1].username, 'dolphin');
    assert.equal(lb.byBalance[0].passwordHash, undefined);
  });

  it('preserves __proto__, constructor, and prototype keys in computeIdempotencyHash without collision or pollution', () => {
    const evil1 = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const evil2 = JSON.parse('{"__proto__":{"polluted":false},"a":1}');
    const clean = { a: 1 };
    const reordered = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');

    const hEvil1 = computeIdempotencyHash(evil1);
    const hEvil2 = computeIdempotencyHash(evil2);
    const hClean = computeIdempotencyHash(clean);
    const hReordered = computeIdempotencyHash(reordered);

    assert.notEqual(hEvil1, hClean);
    assert.notEqual(hEvil2, hClean);
    assert.notEqual(hEvil1, hEvil2);
    assert.equal(hEvil1, hReordered);
    assert.equal(({}).polluted, undefined);

    const ctorA = { constructor: { x: 1 }, prototype: [1, 2], b: undefined };
    const ctorB = { prototype: [1, 2], constructor: { x: 1 } };
    assert.equal(computeIdempotencyHash(ctorA), computeIdempotencyHash(ctorB));
    assert.notEqual(computeIdempotencyHash({ constructor: 1 }), computeIdempotencyHash({}));
  });

  it('enforces merged MAX_SINGLE_BET and Idempotency-Key replay/conflict atomically in JSON placeLiveBetAtomic', async () => {
    const db = createIsolatedDb();
    await db.init();
    const u1 = await db.createUser({
      username: 'json_whale_1',
      passwordHash: await hashPassword('pass1234'),
      balance: 3_000_000_000
    });
    const u2 = await db.createUser({
      username: 'json_whale_2',
      passwordHash: await hashPassword('pass1234'),
      balance: 3_000_000_000
    });

    const b1 = await db.placeLiveBetAtomic({
      userId: u1.id,
      liveRoundId: 801,
      bets: { tai: 800_000_000 },
      idempotencyKey: 'json-live-k1',
      now: 10_000
    });
    assert.equal(b1.replayed, false);
    assert.equal(b1.ticket.bets.tai, 800_000_000);
    assert.equal(b1.newBalance, 2_200_000_000);

    const b1Replay = await db.placeLiveBetAtomic({
      userId: u1.id,
      liveRoundId: 801,
      bets: { tai: 800_000_000 },
      idempotencyKey: 'json-live-k1',
      now: 10_500
    });
    assert.equal(b1Replay.replayed, true);
    assert.equal(b1Replay.newBalance, 2_200_000_000);

    await assert.rejects(
      () => db.placeLiveBetAtomic({
        userId: u1.id,
        liveRoundId: 801,
        bets: { xiu: 800_000_000 },
        idempotencyKey: 'json-live-k1',
        now: 10_600
      }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
    );

    await assert.rejects(
      () => db.placeLiveBetAtomic({
        userId: u1.id,
        liveRoundId: 801,
        bets: { tai: 800_000_000 },
        idempotencyKey: 'json-live-k2',
        now: 10_700
      }),
      (err) => err.code === 'INVALID_BETS' && err.status === 400
    );
    assert.equal((await db.getUserById(u1.id)).balance, 2_200_000_000);

    const bExact = await db.placeLiveBetAtomic({
      userId: u1.id,
      liveRoundId: 801,
      bets: { tai: 200_000_000 },
      idempotencyKey: 'json-live-k3',
      now: 10_800
    });
    assert.equal(bExact.ticket.bets.tai, 1_000_000_000);
    assert.equal(bExact.newBalance, 2_000_000_000);

    const concurrent = await Promise.allSettled([
      db.placeLiveBetAtomic({ userId: u2.id, liveRoundId: 801, bets: { tai: 800_000_000 }, now: 10_900 }),
      db.placeLiveBetAtomic({ userId: u2.id, liveRoundId: 801, bets: { tai: 800_000_000 }, now: 10_900 })
    ]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = concurrent.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'INVALID_BETS');
    assert.equal(rejected[0].reason.status, 400);

    const settled = await db.settleLiveRoundAtomic({ userId: u2.id, liveRoundId: 801, dice: [1, 2, 3] });
    assert.equal(settled.settled, true);
    assert.equal(settled.ticket.totalBet, 800_000_000);
  });
});

// ============================================================================
// SUITE 3: Upstash REST Wire Protocol & PostgreSQL Driver
// ============================================================================

describe('lib/db.js — Upstash REST POST / ["EVAL", ...] & PostgreSQL Drivers', () => {
  function startMockUpstashServer({
    failFirstCas = false,
    alwaysConflict = false,
    forceHttp500 = false,
    forceRedisError = false,
    simulateCjsonEmptyObject = false,
    onCommand = null
  } = {}) {
    const kv = new Map();
    const lists = new Map();
    const sets = new Map();
    const zsets = new Map();
    const capturedRequests = [];
    let casInjected = false;

    function cjsonEncode(val) {
      if (simulateCjsonEmptyObject) {
        const convert = (node) => {
          if (Array.isArray(node)) {
            if (node.length === 0) return {};
            return node.map(convert);
          }
          if (node && typeof node === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(node)) {
              out[k] = convert(v);
            }
            return out;
          }
          return node;
        };
        return JSON.stringify(convert(val));
      }
      return JSON.stringify(val);
    }

    function readJsonBody(req) {
      return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
        req.on('error', reject);
      });
    }

    function executeEval(script, keys, args) {
      // 1. LUA_CREATE_USER
      if (script.includes('unameKey') && script.includes('idxKey') && keys.length === 5) {
        const [unameKey, userKey, idxKey, lbBalKey, lbProfKey] = keys;
        const [userId, userJson, bal, prof] = args;
        if (kv.has(unameKey)) return cjsonEncode({ err: 'USERNAME_TAKEN' });
        kv.set(unameKey, userId);
        kv.set(userKey, userJson);
        if (!sets.has(idxKey)) sets.set(idxKey, new Set());
        sets.get(idxKey).add(userId);
        if (!zsets.has(lbBalKey)) zsets.set(lbBalKey, new Map());
        zsets.get(lbBalKey).set(userId, Number(bal));
        if (!zsets.has(lbProfKey)) zsets.set(lbProfKey, new Map());
        zsets.get(lbProfKey).set(userId, Number(prof));
        return cjsonEncode({ ok: true });
      }

      // 2. LUA_UPGRADE_GUEST
      if (script.includes('NOT_A_GUEST') && keys.length === 4) {
        const [userKey, idxKey, lbBalKey, lbProfKey] = keys;
        const [prefix, userId, username, nextLower, displayName, passwordHash, recoveryCodeHash, role, nowStr] = args;
        const now = Number(nowStr);
        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (!user.isGuest) return cjsonEncode({ err: 'NOT_A_GUEST' });
        if (user.locked) return cjsonEncode({ err: 'USER_LOCKED' });

        const nextUnameKey = `${prefix}uname:${nextLower}`;
        const existingOwner = kv.get(nextUnameKey);
        if (existingOwner && existingOwner !== userId) {
          return cjsonEncode({ err: 'USERNAME_TAKEN' });
        }
        if (user.usernameLower && user.usernameLower !== nextLower) {
          const oldKey = `${prefix}uname:${user.usernameLower}`;
          if (kv.get(oldKey) === userId) kv.delete(oldKey);
        }
        kv.set(nextUnameKey, userId);

        user.username = username;
        user.usernameLower = nextLower;
        user.displayName = displayName;
        user.passwordHash = passwordHash;
        user.recoveryCodeHash = recoveryCodeHash;
        user.role = role;
        user.isGuest = false;
        user.sessionVersion = (user.sessionVersion || 1) + 1;
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;

        const encoded = cjsonEncode(user);
        kv.set(userKey, encoded);
        if (!sets.has(idxKey)) sets.set(idxKey, new Set());
        sets.get(idxKey).add(userId);
        if (!zsets.has(lbBalKey)) zsets.set(lbBalKey, new Map());
        zsets.get(lbBalKey).set(userId, user.balance || 0);
        if (!zsets.has(lbProfKey)) zsets.set(lbProfKey, new Map());
        zsets.get(lbProfKey).set(userId, user.netProfit || 0);
        return encoded;
      }

      // 3. LUA_ROTATE_FAIRNESS
      if (script.includes('lastRevealed') && keys.length === 1) {
        const [userKey] = keys;
        const [newServerSeed, newServerSeedHash, newClientSeed, nowStr] = args;
        const now = Number(nowStr);
        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (user.locked) return cjsonEncode({ err: 'USER_LOCKED' });

        const previous = {
          serverSeed: user.fairness.serverSeed,
          serverSeedHash: user.fairness.serverSeedHash,
          clientSeed: user.fairness.clientSeed,
          finalNonce: user.fairness.nonce || 0
        };
        const effectiveClient = (newClientSeed !== '' && newClientSeed) || user.fairness.clientSeed;
        user.fairness = {
          serverSeed: newServerSeed,
          serverSeedHash: newServerSeedHash,
          clientSeed: effectiveClient,
          nonce: 0,
          lastRevealed: previous
        };
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        return cjsonEncode({ ok: true, previous, user });
      }

      // 4. LUA_UPDATE_USER_PASSWORD
      if (script.includes('pwMode') && keys.length === 1) {
        const [userKey] = keys;
        const [pwMode, passwordHash, recMode, recoveryCodeHash, bumpSvStr, nowStr, checkExpectedRec, expectedRecHash] = args;
        const now = Number(nowStr);
        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (checkExpectedRec === '1') {
          const curRec = user.recoveryCodeHash || '';
          if (curRec !== (expectedRecHash || '')) {
            return cjsonEncode({ err: 'INVALID_RECOVERY_CODE' });
          }
        }
        user.passwordHash = pwMode === 'null' ? null : passwordHash;
        if (recMode === '1') user.recoveryCodeHash = recoveryCodeHash;
        else if (recMode === '2') user.recoveryCodeHash = null;
        if (bumpSvStr === '1') user.sessionVersion = (Number(user.sessionVersion) || 1) + 1;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        return cjsonEncode({ ok: true, user });
      }

      // 5. LUA_TOGGLE_USER_LOCK
      if (script.includes('lockMode') && keys.length === 1) {
        const [userKey] = keys;
        const [lockMode, nowStr] = args;
        const now = Number(nowStr);
        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (lockMode === 'true') user.locked = true;
        else if (lockMode === 'false') user.locked = false;
        else user.locked = !(user.locked === true);
        user.sessionVersion = (Number(user.sessionVersion) || 1) + 1;
        user.casVersion = (Number(user.casVersion) || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        return cjsonEncode({ ok: true, user });
      }

      // 6. LUA_PLACE_MANUAL_ROLL
      if (script.includes('expectedCas') && keys.length === 8) {
        const [userKey, ledgerKey, personalKey, globalKey, roundSeqKey, lbBalKey, lbProfKey, idemKey] = keys;
        const [
          hasIdem, reqHash, expectedCasStr, totalBetStr, totalWinStr, netProfitStr,
          usedNonceStr, effectiveClientSeed, hmacHex, betEntryId, winEntryId, nowStr,
          diceJson, betsJson, winDetailsJson, totalDiceStr, isTripleStr, outcome
        ] = args;

        if (alwaysConflict) {
          return cjsonEncode({ err: 'CAS_CONFLICT' });
        }
        if (failFirstCas && !casInjected) {
          casInjected = true;
          return cjsonEncode({ err: 'CAS_CONFLICT' });
        }

        if (hasIdem === '1' && kv.has(idemKey)) {
          const idem = JSON.parse(kv.get(idemKey));
          if (idem.requestHash !== reqHash) {
            return cjsonEncode({ err: 'IDEMPOTENCY_CONFLICT' });
          }
          return cjsonEncode({ replayed: true, response: idem.response });
        }

        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (user.locked) return cjsonEncode({ err: 'USER_LOCKED' });
        if ((user.casVersion || 0) !== Number(expectedCasStr)) {
          return cjsonEncode({ err: 'CAS_CONFLICT' });
        }
        const totalBet = Number(totalBetStr);
        const totalWin = Number(totalWinStr);
        const netProfit = Number(netProfitStr);
        const usedNonce = Number(usedNonceStr);
        const now = Number(nowStr);
        if ((user.balance || 0) < totalBet) {
          return cjsonEncode({ err: 'INSUFFICIENT_BALANCE' });
        }

        let roundId = Number(kv.get(roundSeqKey) || '1000') + 1;
        if (roundId <= 1000) roundId = 1001;
        kv.set(roundSeqKey, String(roundId));

        const b0 = user.balance;
        const b1 = b0 - totalBet;
        const b2 = b1 + totalWin;
        const betEntry = {
          id: betEntryId,
          userId: user.id,
          type: 'bet',
          amount: -totalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Tự Lắc #${roundId}`,
          refId: `manual:${roundId}`,
          timestamp: now
        };
        if (!lists.has(ledgerKey)) lists.set(ledgerKey, []);
        lists.get(ledgerKey).unshift(cjsonEncode(betEntry));
        let winEntry = null;
        if (totalWin > 0) {
          winEntry = {
            id: winEntryId,
            userId: user.id,
            type: 'win',
            amount: totalWin,
            balanceBefore: b1,
            balanceAfter: b2,
            reason: `Thắng Tự Lắc #${roundId}`,
            refId: `manual:${roundId}`,
            timestamp: now
          };
          lists.get(ledgerKey).unshift(cjsonEncode(winEntry));
        }

        user.balance = b2;
        user.totalBet = (user.totalBet || 0) + totalBet;
        user.totalWon = (user.totalWon || 0) + totalWin;
        user.netProfit = (user.netProfit || 0) + netProfit;
        user.rounds = (user.rounds || 0) + 1;
        if (netProfit > 0) user.winRounds = (user.winRounds || 0) + 1;
        user.fairness.nonce = usedNonce + 1;
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));

        const dice = JSON.parse(diceJson);
        const bets = JSON.parse(betsJson);
        const winningDetails = JSON.parse(winDetailsJson);

        const personalEntry = {
          roundId,
          timestamp: now,
          mode: 'manual',
          bets,
          dice,
          total: Number(totalDiceStr),
          isTriple: isTripleStr === '1',
          outcome,
          totalBet,
          totalWin,
          netProfit,
          balanceAfter: b2,
          fairness: {
            roundId,
            serverSeedHash: user.fairness.serverSeedHash,
            clientSeed: effectiveClientSeed,
            nonce: usedNonce,
            hmacHex
          }
        };
        if (!lists.has(personalKey)) lists.set(personalKey, []);
        lists.get(personalKey).unshift(cjsonEncode(personalEntry));

        if (!lists.has(globalKey)) lists.set(globalKey, []);
        lists.get(globalKey).push(cjsonEncode({
          id: roundId,
          dice,
          total: Number(totalDiceStr),
          isTriple: isTripleStr === '1',
          outcome,
          serverSeedHash: user.fairness.serverSeedHash,
          nonce: usedNonce,
          timestamp: now
        }));

        const resp = {
          replayed: false,
          roundId,
          mode: 'manual',
          dice,
          total: Number(totalDiceStr),
          isTriple: isTripleStr === '1',
          outcome,
          totalBet,
          totalWin,
          netProfit,
          newBalance: b2,
          winningDetails,
          fairness: {
            serverSeedHash: user.fairness.serverSeedHash,
            clientSeed: effectiveClientSeed,
            nonce: usedNonce
          },
          ledgerEntries: winEntry ? [betEntry, winEntry] : [betEntry],
          user
        };

        if (hasIdem === '1') {
          kv.set(idemKey, cjsonEncode({ requestHash: reqHash, response: resp, createdAt: now }));
        }
        return cjsonEncode({ ok: true, response: resp });
      }

      // 7. LUA_PLACE_LIVE_BET
      if (script.includes('ROUND_ALREADY_SETTLED') && keys.length === 7) {
        const [userKey, ledgerKey, ticketKey, userTicketsKey, lbBalKey, lbProfKey, idemKey] = keys;
        const [hasIdem, reqHash, liveRoundIdStr, totalBetStr, cleanBetsJson, ledgerId, nowStr, maxSingleBetStr] = args;
        const liveRoundId = Number(liveRoundIdStr);
        const totalBet = Number(totalBetStr);
        const now = Number(nowStr);
        const maxSingleBet = Number(maxSingleBetStr) || 1_000_000_000;

        if (hasIdem === '1' && kv.has(idemKey)) {
          const idem = JSON.parse(kv.get(idemKey));
          if (idem.requestHash !== reqHash) return cjsonEncode({ err: 'IDEMPOTENCY_CONFLICT' });
          return cjsonEncode({ replayed: true, response: idem.response });
        }

        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (user.locked) return cjsonEncode({ err: 'USER_LOCKED' });

        const rawTicket = kv.get(ticketKey);
        let ticket = rawTicket ? JSON.parse(rawTicket) : null;
        if (ticket && ticket.settled) return cjsonEncode({ err: 'ROUND_ALREADY_SETTLED' });

        const cleanBets = JSON.parse(cleanBetsJson);
        if (ticket && ticket.bets) {
          for (const [k, amt] of Object.entries(cleanBets)) {
            const prevAmt = Number(ticket.bets[k]) || 0;
            if ((prevAmt + amt) > maxSingleBet) {
              return cjsonEncode({ err: 'MAX_SINGLE_BET_EXCEEDED', gate: k });
            }
          }
        }

        if ((user.balance || 0) < totalBet) return cjsonEncode({ err: 'INSUFFICIENT_BALANCE' });

        const b0 = user.balance;
        const b1 = b0 - totalBet;
        const ledgerEntry = {
          id: ledgerId,
          userId: user.id,
          type: 'bet',
          amount: -totalBet,
          balanceBefore: b0,
          balanceAfter: b1,
          reason: `Đặt cược Phòng Live #${liveRoundId}`,
          refId: `live:${liveRoundId}`,
          timestamp: now
        };
        if (!lists.has(ledgerKey)) lists.set(ledgerKey, []);
        lists.get(ledgerKey).unshift(cjsonEncode(ledgerEntry));

        if (!ticket) {
          ticket = {
            liveRoundId,
            userId: user.id,
            bets: cleanBets,
            totalBet,
            settled: false,
            totalWin: 0,
            netProfit: 0,
            winningDetails: [],
            casVersion: 1,
            createdAt: now,
            updatedAt: now
          };
        } else {
          for (const [k, amt] of Object.entries(cleanBets)) {
            ticket.bets[k] = (ticket.bets[k] || 0) + amt;
          }
          ticket.totalBet = (ticket.totalBet || 0) + totalBet;
          ticket.casVersion = (Number(ticket.casVersion) || 0) + 1;
          ticket.updatedAt = now;
        }
        kv.set(ticketKey, cjsonEncode(ticket));
        if (!sets.has(userTicketsKey)) sets.set(userTicketsKey, new Set());
        sets.get(userTicketsKey).add(String(liveRoundId));

        user.balance = b1;
        user.totalBet = (user.totalBet || 0) + totalBet;
        user.netProfit = (user.netProfit || 0) - totalBet;
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        if (!zsets.has(lbBalKey)) zsets.set(lbBalKey, new Map());
        zsets.get(lbBalKey).set(user.id, user.balance);
        if (!zsets.has(lbProfKey)) zsets.set(lbProfKey, new Map());
        zsets.get(lbProfKey).set(user.id, user.netProfit);

        const resp = {
          replayed: false,
          liveRoundId,
          ticket,
          newBalance: b1,
          ledgerEntry,
          user
        };
        if (hasIdem === '1') {
          kv.set(idemKey, cjsonEncode({ requestHash: reqHash, response: resp, createdAt: now }));
        }
        return cjsonEncode({ ok: true, response: resp });
      }

      // 8. LUA_SETTLE_LIVE_ROUND
      if (script.includes('expectedTicketCas') && keys.length === 10) {
        const [
          userKey, ledgerKey, personalKey, globalKey, roundSeqKey,
          liveSettledKey, ticketKey, userTicketsKey, lbBalKey, lbProfKey
        ] = keys;
        const [
          liveRoundIdStr, diceJson, totalDiceStr, isTripleStr, outcome,
          totalWinStr, winDetailsJson, roundSeedHash, winLedgerId, nowStr,
          expectedTicketCasStr, expectedTotalBetStr
        ] = args;
        const liveRoundId = Number(liveRoundIdStr);
        const totalDice = Number(totalDiceStr);
        const isTriple = isTripleStr === '1';
        const totalWin = Number(totalWinStr);
        const now = Number(nowStr);
        const expectedTicketCas = Number(expectedTicketCasStr);
        const expectedTotalBet = Number(expectedTotalBetStr);

        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);

        const rawTicket = kv.get(ticketKey);
        if (!rawTicket) return cjsonEncode({ err: 'TICKET_NOT_FOUND' });
        const ticket = JSON.parse(rawTicket);
        if (ticket.settled) {
          return cjsonEncode({
            ok: true,
            alreadySettled: true,
            settledNow: false,
            liveRoundId,
            settled: true,
            ticket,
            newBalance: user.balance,
            user
          });
        }

        const actualTicketCas = Number(ticket.casVersion || 0);
        const actualTotalBet = Number(ticket.totalBet || 0);
        if (actualTicketCas !== expectedTicketCas || actualTotalBet !== expectedTotalBet) {
          return cjsonEncode({ err: 'CAS_CONFLICT' });
        }

        const dice = JSON.parse(diceJson);
        const winningDetails = JSON.parse(winDetailsJson);
        const netProfit = totalWin - (ticket.totalBet || 0);

        ticket.settled = true;
        ticket.dice = dice;
        ticket.total = totalDice;
        ticket.isTriple = isTriple;
        ticket.outcome = outcome;
        ticket.totalWin = totalWin;
        ticket.netProfit = netProfit;
        ticket.winningDetails = winningDetails;
        ticket.casVersion = actualTicketCas + 1;
        ticket.settledAt = now;
        ticket.updatedAt = now;
        kv.set(ticketKey, cjsonEncode(ticket));
        if (sets.has(userTicketsKey)) sets.get(userTicketsKey).delete(String(liveRoundId));

        const b0 = user.balance || 0;
        const b1 = b0 + totalWin;
        let ledgerEntry = null;
        if (totalWin > 0) {
          ledgerEntry = {
            id: winLedgerId,
            userId: user.id,
            type: 'win',
            amount: totalWin,
            balanceBefore: b0,
            balanceAfter: b1,
            reason: `Thắng Phòng Live #${liveRoundId}`,
            refId: `live:${liveRoundId}`,
            timestamp: now
          };
          if (!lists.has(ledgerKey)) lists.set(ledgerKey, []);
          lists.get(ledgerKey).unshift(cjsonEncode(ledgerEntry));
        }

        user.balance = b1;
        user.totalWon = (user.totalWon || 0) + totalWin;
        user.netProfit = (user.netProfit || 0) + totalWin;
        user.rounds = (user.rounds || 0) + 1;
        if (netProfit > 0) user.winRounds = (user.winRounds || 0) + 1;
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        if (!zsets.has(lbBalKey)) zsets.set(lbBalKey, new Map());
        zsets.get(lbBalKey).set(user.id, user.balance);
        if (!zsets.has(lbProfKey)) zsets.set(lbProfKey, new Map());
        zsets.get(lbProfKey).set(user.id, user.netProfit);

        if (!lists.has(personalKey)) lists.set(personalKey, []);
        lists.get(personalKey).unshift(cjsonEncode({
          roundId: liveRoundId,
          timestamp: now,
          mode: 'live',
          bets: ticket.bets,
          dice,
          total: totalDice,
          isTriple,
          outcome,
          totalBet: ticket.totalBet,
          totalWin,
          netProfit,
          balanceAfter: b1,
          fairness: {
            liveRoundId,
            roundSeedHash: roundSeedHash !== '' ? roundSeedHash : null
          }
        }));

        if (!kv.has(liveSettledKey)) {
          kv.set(liveSettledKey, '1');
          let globalId = Number(kv.get(roundSeqKey) || '1000') + 1;
          if (globalId <= 1000) globalId = 1001;
          kv.set(roundSeqKey, String(globalId));
          const globalEntry = {
            id: globalId,
            liveRoundId,
            dice,
            total: totalDice,
            isTriple,
            outcome,
            timestamp: now
          };
          if (roundSeedHash !== '') globalEntry.serverSeedHash = roundSeedHash;
          if (!lists.has(globalKey)) lists.set(globalKey, []);
          lists.get(globalKey).push(cjsonEncode(globalEntry));
        }

        return cjsonEncode({
          ok: true,
          alreadySettled: false,
          settledNow: true,
          liveRoundId,
          settled: true,
          ticket,
          newBalance: b1,
          ledgerEntry,
          user
        });
      }

      // 9. LUA_ADJUST_BALANCE
      if (script.includes('BANKRUPTCY_INELIGIBLE') && keys.length === 4) {
        const [userKey, ledgerKey, lbBalKey, idemKey] = keys;
        const [
          hasIdem, reqHash, deltaStr, txType, reason, refId, allowLockedStr,
          minBalanceAfterStr, cooldownField, cooldownMsStr, hasMaxBeforeStr,
          maxBalanceBeforeStr, ledgerId, nowStr
        ] = args;
        const delta = Number(deltaStr);
        const allowLocked = allowLockedStr === '1';
        const minBalanceAfter = Number(minBalanceAfterStr);
        const cooldownMs = Number(cooldownMsStr);
        const hasMaxBefore = hasMaxBeforeStr === '1';
        const maxBalanceBefore = Number(maxBalanceBeforeStr);
        const now = Number(nowStr);

        if (hasIdem === '1' && kv.has(idemKey)) {
          const idem = JSON.parse(kv.get(idemKey));
          if (idem.requestHash !== reqHash) return cjsonEncode({ err: 'IDEMPOTENCY_CONFLICT' });
          return cjsonEncode({ replayed: true, response: idem.response });
        }
        const rawUser = kv.get(userKey);
        if (!rawUser) return cjsonEncode({ err: 'USER_NOT_FOUND' });
        const user = JSON.parse(rawUser);
        if (!allowLocked && user.locked) return cjsonEncode({ err: 'USER_LOCKED' });

        const b0 = user.balance || 0;
        if (hasMaxBefore && b0 >= maxBalanceBefore) {
          return cjsonEncode({ err: 'BANKRUPTCY_INELIGIBLE' });
        }
        if (cooldownField !== '' && cooldownMs > 0) {
          const lastAt = user[cooldownField];
          if (typeof lastAt === 'number' && (now - lastAt) < cooldownMs) {
            return cjsonEncode({ err: 'COOLDOWN_ACTIVE', nextEligibleAt: lastAt + cooldownMs });
          }
        }
        const b1 = b0 + delta;
        if (!Number.isSafeInteger(b1) || b1 > 9007199254740991) return cjsonEncode({ err: 'SAFE_INT_OVERFLOW' });
        if (b1 < minBalanceAfter) return cjsonEncode({ err: 'INSUFFICIENT_BALANCE' });

        const ledgerEntry = {
          id: ledgerId,
          userId: user.id,
          type: txType,
          amount: delta,
          balanceBefore: b0,
          balanceAfter: b1,
          reason,
          refId: refId !== '' ? refId : null,
          timestamp: now
        };
        if (!lists.has(ledgerKey)) lists.set(ledgerKey, []);
        lists.get(ledgerKey).unshift(cjsonEncode(ledgerEntry));

        user.balance = b1;
        if (cooldownField !== '') user[cooldownField] = now;
        user.casVersion = (user.casVersion || 0) + 1;
        user.updatedAt = now;
        kv.set(userKey, cjsonEncode(user));
        if (!zsets.has(lbBalKey)) zsets.set(lbBalKey, new Map());
        zsets.get(lbBalKey).set(user.id, b1);

        const nextEligibleAt = (cooldownField !== '' && cooldownMs > 0) ? (now + cooldownMs) : null;
        const resp = {
          replayed: false,
          user,
          balance: b1,
          ledgerEntry,
          nextEligibleAt
        };
        if (hasIdem === '1') {
          kv.set(idemKey, cjsonEncode({ requestHash: reqHash, response: resp, createdAt: now }));
        }
        return cjsonEncode({ ok: true, response: resp });
      }

      throw new Error('Unhandled Lua script in mock Upstash server');
    }

    const server = http.createServer(async (req, res) => {
      try {
        capturedRequests.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers }
        });

        if (forceHttp500) {
          res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' });
          res.end('Internal Upstash Error');
          return;
        }

        const cmd = await readJsonBody(req);
        capturedRequests[capturedRequests.length - 1].body = cmd;

        if (forceRedisError) {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'ERR mock redis failure' }));
          return;
        }

        if (typeof onCommand === 'function') {
          await onCommand(cmd);
        }

        const op = String(cmd[0]).toUpperCase();
        let result = null;
        if (op === 'LLEN') {
          result = (lists.get(cmd[1]) || []).length;
        } else if (op === 'SETNX') {
          if (!kv.has(cmd[1])) {
            kv.set(cmd[1], String(cmd[2]));
            result = 1;
          } else {
            result = 0;
          }
        } else if (op === 'GET') {
          result = kv.has(cmd[1]) ? kv.get(cmd[1]) : null;
        } else if (op === 'SET') {
          kv.set(cmd[1], String(cmd[2]));
          result = 'OK';
        } else if (op === 'DEL') {
          result = kv.delete(cmd[1]) ? 1 : 0;
        } else if (op === 'RPUSH') {
          if (!lists.has(cmd[1])) lists.set(cmd[1], []);
          const list = lists.get(cmd[1]);
          for (let i = 2; i < cmd.length; i++) list.push(String(cmd[i]));
          result = list.length;
        } else if (op === 'LRANGE') {
          const list = lists.get(cmd[1]) || [];
          const start = Number(cmd[2]);
          const stop = Number(cmd[3]);
          const normStart = start < 0 ? Math.max(0, list.length + start) : start;
          const normStop = stop < 0 ? list.length + stop : stop;
          result = list.slice(normStart, normStop + 1);
        } else if (op === 'SMEMBERS') {
          const set = sets.get(cmd[1]);
          result = set ? Array.from(set) : [];
        } else if (op === 'MGET') {
          result = cmd.slice(1).map((k) => (kv.has(k) ? kv.get(k) : null));
        } else if (op === 'EVAL') {
          const script = cmd[1];
          const numKeys = Number(cmd[2]);
          const keys = cmd.slice(3, 3 + numKeys);
          const args = cmd.slice(3 + numKeys);
          result = executeEval(script, keys, args);
        }

        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ result }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' });
        }
        res.end(err && err.message ? err.message : 'Mock server error');
      }
    });

    let closed = false;
    const handle = {
      server,
      capturedRequests,
      start() {
        return new Promise((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve(`http://127.0.0.1:${addr.port}/`);
          });
        });
      },
      close() {
        if (closed) return Promise.resolve();
        closed = true;
        return new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        });
      }
    };
    serversToClose.push(handle);
    return handle;
  }

  it('sends Upstash POST / ["EVAL", script, numkeys, ...] wire format, handles CAS retries & 10x concurrent rolls', async () => {
    const mock = startMockUpstashServer({ failFirstCas: true });
    const baseUrlWithSlash = await mock.start();

    try {
      const cfg = loadConfig({
        env: {
          NODE_ENV: 'test',
          UPSTASH_REDIS_REST_URL: baseUrlWithSlash,
          UPSTASH_REDIS_REST_TOKEN: 'upstash-secret-tok'
        },
        dataDir: makeTempDir(),
        loadDotEnv: false
      });
      assert.equal(cfg.dbDriver, 'upstash');

      const db = createDb(cfg, { seedLegacyHistory: false, keyPrefix: 'test:' });
      await db.init();

      const user = await db.createUser({
        username: 'upstashPlayer',
        passwordHash: await hashPassword('pass1234'),
        balance: 100_000
      });

      // Verify wire format on EVAL requests
      const evalReqs = mock.capturedRequests.filter((r) => Array.isArray(r.body) && r.body[0] === 'EVAL');
      assert.ok(evalReqs.length >= 1);
      for (const req of evalReqs) {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/');
        assert.equal(req.headers.authorization, 'Bearer upstash-secret-tok');
        assert.equal(req.headers['content-type'], 'application/json');
        assert.equal(typeof req.body[1], 'string');
        assert.equal(typeof req.body[2], 'number');
      }

      // First roll triggers simulated CAS_CONFLICT once and succeeds on retry
      const firstRoll = await db.placeManualRollAtomic({
        userId: user.id,
        bets: { tai: 20_000 },
        resolveFn: () => ({ dice: [1, 1, 1] })
      });
      assert.equal(firstRoll.newBalance, 80_000);
      assert.equal(firstRoll.fairness.nonce, 0);

      // 10 parallel rolls on remaining 80_000 balance (20_000 each -> 4 succeed, 6 fail)
      const race = await Promise.allSettled(
        Array.from({ length: 10 }, () => db.placeManualRollAtomic({
          userId: user.id,
          bets: { tai: 20_000 },
          resolveFn: () => ({ dice: [1, 1, 1] })
        }))
      );
      const ok = race.filter((r) => r.status === 'fulfilled');
      const fail = race.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 4);
      assert.equal(fail.length, 6);

      const finalUser = await db.getUserById(user.id);
      assert.equal(finalUser.balance, 0);
      assert.equal(finalUser.fairness.nonce, 5);
      const ledger = await db.getWalletLedger(user.id, 20);
      assert.equal(ledger.length, 5);
    } finally {
      await mock.close();
    }
  });

  it('propagates Upstash HTTP 500, Redis { error }, and CAS retry exhaustion cleanly', async () => {
    const httpErrServer = startMockUpstashServer({ forceHttp500: true });
    const httpUrl = await httpErrServer.start();
    try {
      const cfg = loadConfig({
        env: { NODE_ENV: 'test', UPSTASH_REDIS_REST_URL: httpUrl, UPSTASH_REDIS_REST_TOKEN: 'tok' },
        dataDir: makeTempDir(),
        loadDotEnv: false
      });
      const db = createDb(cfg, { seedLegacyHistory: false });
      await assert.rejects(() => db.init(), (err) => err.code === 'UPSTASH_HTTP_ERROR');
    } finally {
      await httpErrServer.close();
    }

    const redisErrServer = startMockUpstashServer({ forceRedisError: true });
    const redisUrl = await redisErrServer.start();
    try {
      const cfg = loadConfig({
        env: { NODE_ENV: 'test', UPSTASH_REDIS_REST_URL: redisUrl, UPSTASH_REDIS_REST_TOKEN: 'tok' },
        dataDir: makeTempDir(),
        loadDotEnv: false
      });
      const db = createDb(cfg, { seedLegacyHistory: false });
      await assert.rejects(() => db.init(), (err) => err.code === 'UPSTASH_REDIS_ERROR');
    } finally {
      await redisErrServer.close();
    }

    const conflictServer = startMockUpstashServer({ alwaysConflict: true });
    const conflictUrl = await conflictServer.start();
    try {
      const cfg = loadConfig({
        env: { NODE_ENV: 'test', UPSTASH_REDIS_REST_URL: conflictUrl, UPSTASH_REDIS_REST_TOKEN: 'tok' },
        dataDir: makeTempDir(),
        loadDotEnv: false
      });
      const db = createDb(cfg, { seedLegacyHistory: false, maxRetries: 2 });
      await db.init();
      const user = await db.createUser({
        username: 'casVictim',
        passwordHash: await hashPassword('pass1234'),
        balance: 100_000
      });
      await assert.rejects(
        () => db.placeManualRollAtomic({ userId: user.id, bets: { tai: 10_000 } }),
        (err) => err.code === 'CAS_CONFLICT_EXHAUSTED' && err.status === 409
      );
    } finally {
      await conflictServer.close();
    }
  });

  it('handles missing pg package gracefully by falling back to JSON (or throwing PG_NOT_INSTALLED when strictPg=true)', async () => {
    const tmpDir = makeTempDir();
    const cfg = loadConfig({
      env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://user:pass@localhost:5432/sicbo' },
      dataDir: tmpDir,
      loadDotEnv: false
    });
    assert.equal(cfg.dbDriver, 'postgres');

    // Non-strict mode: warns and falls back to JSON without crashing
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const db = createDb(cfg, {
        seedLegacyHistory: false,
        requireFn: () => { throw new Error("Cannot find module 'pg'"); }
      });
      await db.init();
      assert.equal(db.driver, 'postgres');
      assert.equal(db.effectiveDriver, 'json');
      assert.equal(db.pgMissing, true);
      assert.ok(warnings.some((w) => w.includes('pg')));

      const u = await db.createUser({
        username: 'pgFallbackUser',
        passwordHash: await hashPassword('pass1234')
      });
      assert.equal((await db.getUserById(u.id)).username, 'pgFallbackUser');
    } finally {
      console.warn = origWarn;
    }

    // Strict mode: throws PG_NOT_INSTALLED
    const strictDb = createDb(cfg, {
      strictPg: true,
      seedLegacyHistory: false,
      requireFn: () => { throw new Error("Cannot find module 'pg'"); }
    });
    await assert.rejects(
      () => strictDb.init(),
      (err) => err.code === 'PG_NOT_INSTALLED' && err.status === 500
    );
  });

  it('executes BEGIN, SELECT ... FOR UPDATE, COMMIT, ROLLBACK and client.release() with mocked pgPool', async () => {
    const usersTable = new Map();
    const ledgerTable = [];
    const idemTable = new Map();
    const ticketsTable = new Map();
    const personalTable = [];
    const globalTable = [];
    let nextRoundId = 1001;

    const queryLog = [];
    let releaseCount = 0;
    let connectCount = 0;
    let forceSqlErrorOnNextUpdate = false;

    function runSql(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queryLog.push(normalized);

      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS')) {
        return { rows: [] };
      }
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT COUNT(*) AS cnt FROM global_history')) {
        return { rows: [{ cnt: String(globalTable.length) }] };
      }
      if (normalized.startsWith('SELECT id FROM users WHERE username_lower = $1')) {
        const match = Array.from(usersTable.values()).find((u) => u.username_lower === params[0]);
        return { rows: match ? [{ id: match.id }] : [] };
      }
      if (normalized.startsWith('INSERT INTO users')) {
        const row = {
          id: params[0],
          username: params[1],
          username_lower: params[2],
          display_name: params[3],
          role: params[4],
          is_guest: params[5],
          locked: params[6],
          session_version: params[7],
          password_hash: params[8],
          recovery_code_hash: params[9],
          balance: String(params[10]),
          total_bet: String(params[11]),
          total_won: String(params[12]),
          net_profit: String(params[13]),
          rounds: params[14],
          win_rounds: params[15],
          last_daily_bonus_at: params[16],
          last_bankruptcy_aid_at: params[17],
          fairness: JSON.parse(params[18]),
          cas_version: params[19],
          created_at: String(params[20]),
          updated_at: String(params[21])
        };
        usersTable.set(row.id, row);
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM users WHERE id = $1')) {
        const u = usersTable.get(params[0]);
        return { rows: u ? [{ ...u }] : [] };
      }
      if (normalized.startsWith('SELECT request_hash, response, created_at FROM idempotency_keys')) {
        const k = `${params[0]}:${params[1]}:${params[2]}`;
        const rec = idemTable.get(k);
        return { rows: rec ? [rec] : [] };
      }
      if (normalized.startsWith('INSERT INTO idempotency_keys')) {
        const k = `${params[0]}:${params[1]}:${params[2]}`;
        idemTable.set(k, {
          request_hash: params[3],
          response: JSON.parse(params[4]),
          created_at: String(params[5])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO global_history (dice,')) {
        const id = nextRoundId++;
        globalTable.push({ id, dice: JSON.parse(params[0]), total: params[1], is_triple: params[2], outcome: params[3] });
        return { rows: [{ id: String(id) }] };
      }
      if (normalized.startsWith('INSERT INTO wallet_ledger')) {
        ledgerTable.push({
          id: params[0], user_id: params[1], type: params[2], amount: String(params[3]),
          balance_before: String(params[4]), balance_after: String(params[5]),
          reason: params[6], ref_id: params[7], timestamp: String(params[8])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE users SET balance = $2, total_bet = $3, total_won = $4')) {
        if (forceSqlErrorOnNextUpdate) {
          forceSqlErrorOnNextUpdate = false;
          throw new Error('Simulated PG constraint error');
        }
        const u = usersTable.get(params[0]);
        u.balance = String(params[1]);
        u.total_bet = String(params[2]);
        u.total_won = String(params[3]);
        u.net_profit = String(params[4]);
        u.rounds = params[5];
        u.win_rounds = params[6];
        u.fairness = JSON.parse(params[7]);
        u.cas_version = params[8];
        u.updated_at = String(params[9]);
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO personal_history')) {
        personalTable.push({ user_id: params[0], round_id: String(params[1]) });
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM wallet_ledger WHERE user_id = $1')) {
        return { rows: ledgerTable.filter((l) => l.user_id === params[0]).slice().reverse().slice(0, params[1]) };
      }
      if (normalized.startsWith('SELECT * FROM live_tickets WHERE live_round_id = $1 AND user_id = $2')) {
        const t = ticketsTable.get(`${params[0]}:${params[1]}`);
        return { rows: t ? [{ ...t }] : [] };
      }
      if (normalized.startsWith('INSERT INTO live_tickets')) {
        ticketsTable.set(`${params[0]}:${params[1]}`, {
          live_round_id: String(params[0]),
          user_id: params[1],
          bets: JSON.parse(params[2]),
          total_bet: String(params[3]),
          settled: false,
          created_at: String(params[4]),
          updated_at: String(params[5])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE live_tickets SET bets =')) {
        const t = ticketsTable.get(`${params[0]}:${params[1]}`);
        t.bets = JSON.parse(params[2]);
        t.total_bet = String(params[3]);
        t.updated_at = String(params[4]);
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE users SET balance = $2, total_bet = $3, net_profit = $4')) {
        const u = usersTable.get(params[0]);
        u.balance = String(params[1]);
        u.total_bet = String(params[2]);
        u.net_profit = String(params[3]);
        u.cas_version = params[4];
        u.updated_at = String(params[5]);
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE live_tickets SET settled = TRUE')) {
        const t = ticketsTable.get(`${params[0]}:${params[1]}`);
        t.settled = true;
        t.dice = JSON.parse(params[2]);
        t.total = params[3];
        t.is_triple = params[4];
        t.outcome = params[5];
        t.total_win = String(params[6]);
        t.net_profit = String(params[7]);
        t.winning_details = JSON.parse(params[8]);
        t.settled_at = String(params[9]);
        t.updated_at = String(params[10]);
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE users SET balance = $2, total_won = $3')) {
        const u = usersTable.get(params[0]);
        u.balance = String(params[1]);
        u.total_won = String(params[2]);
        u.net_profit = String(params[3]);
        u.rounds = params[4];
        u.win_rounds = params[5];
        u.cas_version = params[6];
        u.updated_at = String(params[7]);
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO global_history (live_round_id')) {
        globalTable.push({ live_round_id: params[0] });
        return { rows: [] };
      }
      return { rows: [] };
    }

    const mockPool = {
      async query(sql, params) {
        return runSql(sql, params);
      },
      async connect() {
        connectCount += 1;
        let released = false;
        return {
          async query(sql, params) {
            return runSql(sql, params);
          },
          release() {
            if (!released) {
              released = true;
              releaseCount += 1;
            }
          }
        };
      },
      async end() {
        return undefined;
      }
    };

    const cfg = loadConfig({
      env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://mock:mock@localhost:5432/sicbo' },
      dataDir: makeTempDir(),
      loadDotEnv: false
    });
    const db = createDb(cfg, { pgPool: mockPool, seedLegacyHistory: false });
    await db.init();

    const user = await db.createUser({
      username: 'pgPlayer',
      passwordHash: await hashPassword('pass1234'),
      balance: 100_000
    });

    // Success transaction: BEGIN -> SELECT ... FOR UPDATE -> COMMIT -> release()
    queryLog.length = 0;
    const roll = await db.placeManualRollAtomic({
      userId: user.id,
      bets: { tai: 40_000 },
      resolveFn: () => ({ dice: [1, 1, 1] })
    });
    assert.equal(roll.newBalance, 60_000);
    assert.ok(queryLog.includes('BEGIN'));
    assert.ok(queryLog.some((q) => q.includes('SELECT * FROM users WHERE id = $1 FOR UPDATE')));
    assert.ok(queryLog.includes('COMMIT'));
    assert.equal(queryLog.includes('ROLLBACK'), false);

    // Live bet + settle transaction
    await db.placeLiveBetAtomic({ userId: user.id, liveRoundId: 500, bets: { tai: 20_000 } });
    const settled = await db.settleLiveRoundAtomic({ userId: user.id, liveRoundId: 500, dice: [6, 5, 4] });
    assert.equal(settled.newBalance, 80_000);

    // Failure transaction (insufficient balance): BEGIN -> ROLLBACK -> release()
    queryLog.length = 0;
    await assert.rejects(
      () => db.placeManualRollAtomic({ userId: user.id, bets: { tai: 999_000 } }),
      (err) => err.code === 'INSUFFICIENT_BALANCE'
    );
    assert.ok(queryLog.includes('BEGIN'));
    assert.ok(queryLog.includes('ROLLBACK'));
    assert.equal(queryLog.includes('COMMIT'), false);

    // Failure transaction (mid-tx SQL error): BEGIN -> ROLLBACK -> release()
    queryLog.length = 0;
    forceSqlErrorOnNextUpdate = true;
    await assert.rejects(
      () => db.placeManualRollAtomic({ userId: user.id, bets: { tai: 10_000 }, resolveFn: () => ({ dice: [1, 1, 1] }) }),
      /Simulated PG constraint error/
    );
    assert.ok(queryLog.includes('ROLLBACK'));
    assert.equal(queryLog.includes('COMMIT'), false);

    // Zero leaked connections
    assert.equal(releaseCount, connectCount);
  });

  it('exercises all Upstash Lua scripts, cjson {} normalization, settleLiveRoundAtomic CAS retry, and atomic lock/password ops', async () => {
    let db = null;
    let userIdForHook = null;
    let injectLiveBetOnTicketGet = false;
    let injectRollOnLockEval = false;
    let injectBonusOnPwEval = false;

    const mock = startMockUpstashServer({
      simulateCjsonEmptyObject: true,
      onCommand: async (cmd) => {
        const op = String(cmd[0]).toUpperCase();
        // Inject intervening placeLiveBetAtomic right after GET ticket, before EVAL LUA_SETTLE_LIVE_ROUND
        if (
          injectLiveBetOnTicketGet &&
          op === 'EVAL' &&
          typeof cmd[1] === 'string' &&
          cmd[1].includes('expectedTicketCas')
        ) {
          injectLiveBetOnTicketGet = false;
          await db.placeLiveBetAtomic({
            userId: userIdForHook,
            liveRoundId: 777,
            bets: { tai: 400_000 }
          });
        }
        if (
          injectRollOnLockEval &&
          op === 'EVAL' &&
          typeof cmd[1] === 'string' &&
          cmd[1].includes('lockMode')
        ) {
          injectRollOnLockEval = false;
          await db.placeManualRollAtomic({
            userId: userIdForHook,
            bets: { tai: 200_000 },
            resolveFn: () => ({ dice: [1, 1, 1] })
          });
        }
        if (
          injectBonusOnPwEval &&
          op === 'EVAL' &&
          typeof cmd[1] === 'string' &&
          cmd[1].includes('pwMode')
        ) {
          injectBonusOnPwEval = false;
          await db.adjustBalanceAtomic({
            userId: userIdForHook,
            delta: 2_000_000,
            type: 'daily_bonus',
            reason: 'Điểm danh 24h',
            cooldownField: 'lastDailyBonusAt',
            cooldownMs: 86_400_000
          });
        }
      }
    });

    const baseUrl = await mock.start();
    try {
      const cfg = loadConfig({
        env: { NODE_ENV: 'test', UPSTASH_REDIS_REST_URL: baseUrl, UPSTASH_REDIS_REST_TOKEN: 'tok' },
        dataDir: makeTempDir(),
        loadDotEnv: false
      });
      db = createDb(cfg, { seedLegacyHistory: false, keyPrefix: 'm2full:' });
      await db.init();

      // 1. Create guest -> upgradeGuestAtomic -> rotateFairnessAtomic
      const guest = await db.createUser({
        username: 'guest_upstash_1',
        isGuest: true,
        balance: 2_000_000
      });
      const upgraded = await db.upgradeGuestAtomic({
        userId: guest.id,
        username: 'UpstashVIP',
        displayName: 'Upstash VIP',
        passwordHash: await hashPassword('VipPass123'),
        recoveryCodeHash: await hashRecoveryCode('SOV-AAAA-BBBB-CCCC')
      });
      assert.equal(upgraded.isGuest, false);
      assert.equal(upgraded.username, 'UpstashVIP');
      assert.equal(upgraded.sessionVersion, 2);

      const rotated = await db.rotateFairnessAtomic({
        userId: guest.id,
        newClientSeed: 'upstash-seed-999'
      });
      assert.equal(rotated.current.clientSeed, 'upstash-seed-999');
      assert.equal(rotated.current.nonce, 0);

      // 2. cjson {} normalization on losing manual roll
      const lossRoll = await db.placeManualRollAtomic({
        userId: guest.id,
        bets: { tai: 100_000 },
        resolveFn: () => ({ dice: [1, 1, 1] })
      });
      assert.equal(Array.isArray(lossRoll.winningDetails), true);
      assert.deepEqual(lossRoll.winningDetails, []);
      assert.equal(lossRoll.newBalance, 1_900_000);

      // 3. cjson {} normalization on live bet, getLiveTicket, getUnsettledLiveTickets & losing live settlement
      const liveLossBet = await db.placeLiveBetAtomic({
        userId: guest.id,
        liveRoundId: 776,
        bets: { tai: 100_000 }
      });
      assert.equal(Array.isArray(liveLossBet.ticket.winningDetails), true);
      assert.deepEqual(liveLossBet.ticket.winningDetails, []);

      const fetchedTicket = await db.getLiveTicket({ userId: guest.id, liveRoundId: 776 });
      assert.equal(Array.isArray(fetchedTicket.winningDetails), true);
      const unsettledList = await db.getUnsettledLiveTickets(guest.id);
      assert.equal(unsettledList.length, 1);
      assert.equal(Array.isArray(unsettledList[0].winningDetails), true);

      const settledLoss = await db.settleLiveRoundAtomic({
        userId: guest.id,
        liveRoundId: 776,
        dice: [1, 1, 1]
      });
      assert.equal(Array.isArray(settledLoss.ticket.winningDetails), true);
      assert.deepEqual(settledLoss.ticket.winningDetails, []);

      // 4. TOCTOU race regression: intervening placeLiveBetAtomic during settleLiveRoundAtomic
      userIdForHook = guest.id;
      await db.placeLiveBetAtomic({
        userId: guest.id,
        liveRoundId: 777,
        bets: { tai: 100_000 }
      });
      injectLiveBetOnTicketGet = true;
      const settledRace = await db.settleLiveRoundAtomic({
        userId: guest.id,
        liveRoundId: 777,
        dice: [6, 5, 4] // tai wins 2x
      });
      assert.equal(settledRace.settledNow, true);
      assert.equal(settledRace.ticket.totalBet, 500_000);
      assert.equal(settledRace.ticket.totalWin, 1_000_000);
      assert.equal(settledRace.ticket.netProfit, 500_000);
      // 1_800_000 (after 776) - 100_000 - 400_000 + 1_000_000 = 2_300_000
      assert.equal(settledRace.newBalance, 2_300_000);

      // 5. Atomic toggleUserLock & updateUserPassword via EVAL (no lost updates!)
      const reqCountBeforeLock = mock.capturedRequests.length;
      injectRollOnLockEval = true;
      const lockedUser = await db.toggleUserLock({ userId: guest.id, locked: true });
      assert.equal(lockedUser.locked, true);
      // Concurrent roll ran right before LUA_TOGGLE_USER_LOCK -> -200k preserved!
      assert.equal(lockedUser.balance, 2_100_000);
      const lockCmds = mock.capturedRequests.slice(reqCountBeforeLock).map((r) => r.body[0]);
      assert.equal(lockCmds.includes('SET'), false, 'toggleUserLock must use EVAL, not GET+SET');

      // Unlock so daily bonus can succeed (or test allowLocked=false -> USER_LOCKED)
      await assert.rejects(
        () => db.adjustBalanceAtomic({ userId: guest.id, delta: 500_000, type: 'daily_bonus' }),
        (err) => err.code === 'USER_LOCKED'
      );
      await db.toggleUserLock({ userId: guest.id, locked: false });

      const reqCountBeforePw = mock.capturedRequests.length;
      injectBonusOnPwEval = true;
      const pwUpdated = await db.updateUserPassword({
        userId: guest.id,
        passwordHash: await hashPassword('NewVipPass123'),
        bumpSessionVersion: true
      });
      // Concurrent daily bonus (+2M) ran right before LUA_UPDATE_USER_PASSWORD -> 4_100_000 preserved!
      assert.equal(pwUpdated.balance, 4_100_000);
      const pwCmds = mock.capturedRequests.slice(reqCountBeforePw).map((r) => r.body[0]);
      assert.equal(pwCmds.includes('SET'), false, 'updateUserPassword must use EVAL, not GET+SET');

      // 6. listUsers, getLeaderboard, getPersonalHistory, getGlobalHistory, getWalletLedger
      const listed = await db.listUsers({ q: 'UpstashVIP' });
      assert.equal(listed.total, 1);
      assert.equal(listed.users[0].balance, 4_100_000);

      const lb = await db.getLeaderboard(10);
      assert.equal(lb.byBalance[0].username, 'UpstashVIP');
      const personal = await db.getPersonalHistory(guest.id, 10);
      assert.equal(personal.length, 4);
      const globalHist = await db.getGlobalHistory(10);
      assert.equal(globalHist.length, 4);
      const ledger = await db.getWalletLedger(guest.id, 20);
      assert.ok(ledger.length >= 6);

      // 6. Merged MAX_SINGLE_BET enforcement + Idempotency-Key replay/conflict in Upstash Lua
      const upstashWhale = await db.createUser({
        username: 'UpstashWhale',
        passwordHash: await hashPassword('WhalePass123'),
        balance: 3_000_000_000
      });
      const upB1 = await db.placeLiveBetAtomic({
        userId: upstashWhale.id,
        liveRoundId: 778,
        bets: { tai: 800_000_000 },
        idempotencyKey: 'up-live-k1',
        now: 9000
      });
      assert.equal(upB1.replayed, false);
      assert.equal(upB1.ticket.bets.tai, 800_000_000);

      const upB1Replay = await db.placeLiveBetAtomic({
        userId: upstashWhale.id,
        liveRoundId: 778,
        bets: { tai: 800_000_000 },
        idempotencyKey: 'up-live-k1',
        now: 9100
      });
      assert.equal(upB1Replay.replayed, true);
      assert.equal(upB1Replay.newBalance, 2_200_000_000);

      await assert.rejects(
        () => db.placeLiveBetAtomic({
          userId: upstashWhale.id,
          liveRoundId: 778,
          bets: { xiu: 800_000_000 },
          idempotencyKey: 'up-live-k1',
          now: 9200
        }),
        (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
      );

      await assert.rejects(
        () => db.placeLiveBetAtomic({
          userId: upstashWhale.id,
          liveRoundId: 778,
          bets: { tai: 800_000_000 },
          idempotencyKey: 'up-live-k2',
          now: 9300
        }),
        (err) => err.code === 'INVALID_BETS' && err.status === 400
      );
      assert.equal((await db.getUserById(upstashWhale.id)).balance, 2_200_000_000);

      const upExact = await db.placeLiveBetAtomic({
        userId: upstashWhale.id,
        liveRoundId: 778,
        bets: { tai: 200_000_000 },
        idempotencyKey: 'up-live-k3',
        now: 9400
      });
      assert.equal(upExact.ticket.bets.tai, 1_000_000_000);
      assert.equal(upExact.newBalance, 2_000_000_000);

      // 7. Upstash Lua expectedRecoveryCodeHash CAS & SAFE_INT_OVERFLOW guard
      const upRecUser = await db.createUser({
        username: 'UpstashRecUser',
        passwordHash: await hashPassword('InitPass123'),
        recoveryCodeHash: 'rec-hash-1',
        balance: 500_000
      });
      await assert.rejects(
        () => db.updateUserPassword({
          userId: upRecUser.id,
          passwordHash: 'pw-hash-2',
          recoveryCodeHash: 'rec-hash-2',
          expectedRecoveryCodeHash: 'wrong-rec-hash'
        }),
        (err) => err.code === 'INVALID_RECOVERY_CODE' && err.status === 401
      );
      const upRecOk = await db.updateUserPassword({
        userId: upRecUser.id,
        passwordHash: 'pw-hash-2',
        recoveryCodeHash: 'rec-hash-2',
        expectedRecoveryCodeHash: 'rec-hash-1'
      });
      assert.equal(upRecOk.recoveryCodeHash, 'rec-hash-2');
      await assert.rejects(
        () => db.adjustBalanceAtomic({
          userId: upRecUser.id,
          delta: Number.MAX_SAFE_INTEGER,
          type: 'admin_adjust',
          reason: 'Upstash overflow check'
        }),
        (err) => err.code === 'INVALID_AMOUNT' && err.status === 400
      );
    } finally {
      await mock.close();
    }
  });

  it('enforces PG FOR UPDATE before idempotency check, maps 23505 to 409, and orders wallet_ledger by timestamp DESC, seq DESC', async () => {
    const queryLog = [];
    let releaseCount = 0;
    let connectCount = 0;
    let nextSeq = 1;
    const users = new Map();
    const ledger = [];
    const idem = new Map();
    const tickets = new Map();

    // Serialize simulated PG FOR UPDATE row locks across concurrent transactions
    let lockHolder = Promise.resolve();

    function runPgSql(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queryLog.push(normalized);

      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS')) {
        assert.ok(normalized.includes('seq BIGSERIAL'), 'PG_SCHEMA_SQL wallet_ledger must include seq BIGSERIAL');
        assert.ok(normalized.includes('ORDER BY') || normalized.includes('(user_id, timestamp DESC, seq DESC)'), 'wallet_ledger index should include seq DESC');
        return { rows: [] };
      }
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT COUNT(*) AS cnt FROM global_history')) {
        return { rows: [{ cnt: '0' }] };
      }
      if (normalized.startsWith('SELECT id FROM users WHERE username_lower = $1')) {
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO users')) {
        const lower = params[2];
        for (const u of users.values()) {
          if (u.username_lower === lower) {
            const err = new Error('duplicate key value violates unique constraint "users_username_lower_key"');
            err.code = '23505';
            throw err;
          }
        }
        users.set(params[0], {
          id: params[0],
          username: params[1],
          username_lower: params[2],
          display_name: params[3],
          role: params[4],
          is_guest: params[5],
          locked: params[6],
          session_version: params[7],
          password_hash: params[8],
          recovery_code_hash: params[9],
          balance: String(params[10]),
          total_bet: String(params[11]),
          total_won: String(params[12]),
          net_profit: String(params[13]),
          rounds: params[14],
          win_rounds: params[15],
          last_daily_bonus_at: params[16],
          last_bankruptcy_aid_at: params[17],
          fairness: JSON.parse(params[18]),
          cas_version: params[19],
          created_at: String(params[20]),
          updated_at: String(params[21])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM users WHERE id = $1 FOR UPDATE')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ ...u }] : [] };
      }
      if (normalized.startsWith('UPDATE users SET username = $2')) {
        const lower = params[2];
        for (const u of users.values()) {
          if (u.username_lower === lower && u.id !== params[0]) {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err;
          }
        }
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT request_hash, response, created_at FROM idempotency_keys')) {
        const rec = idem.get(`${params[0]}:${params[1]}:${params[2]}`);
        return { rows: rec ? [rec] : [] };
      }
      if (normalized.startsWith('INSERT INTO idempotency_keys')) {
        idem.set(`${params[0]}:${params[1]}:${params[2]}`, {
          request_hash: params[3],
          response: JSON.parse(params[4]),
          created_at: String(params[5])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM live_tickets WHERE live_round_id = $1 AND user_id = $2')) {
        const t = tickets.get(`${params[0]}:${params[1]}`);
        return { rows: t ? [{ ...t, bets: { ...t.bets } }] : [] };
      }
      if (normalized.startsWith('INSERT INTO live_tickets')) {
        tickets.set(`${params[0]}:${params[1]}`, {
          live_round_id: String(params[0]),
          user_id: params[1],
          bets: JSON.parse(params[2]),
          total_bet: String(params[3]),
          settled: false,
          created_at: String(params[4]),
          updated_at: String(params[5])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE live_tickets SET bets =')) {
        const t = tickets.get(`${params[0]}:${params[1]}`);
        t.bets = JSON.parse(params[2]);
        t.total_bet = String(params[3]);
        t.updated_at = String(params[4]);
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO wallet_ledger')) {
        ledger.push({
          seq: nextSeq++,
          id: params[0], user_id: params[1], type: params[2], amount: String(params[3]),
          balance_before: String(params[4]), balance_after: String(params[5]),
          reason: params[6], ref_id: params[7], timestamp: String(params[8])
        });
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE users SET balance = $2, total_bet = $3, net_profit = $4')) {
        const u = users.get(params[0]);
        u.balance = String(params[1]);
        u.total_bet = String(params[2]);
        u.net_profit = String(params[3]);
        u.cas_version = params[4];
        u.updated_at = String(params[5]);
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE users SET balance = $2, last_daily_bonus_at = $3')) {
        const u = users.get(params[0]);
        u.balance = String(params[1]);
        u.last_daily_bonus_at = params[2];
        u.last_bankruptcy_aid_at = params[3];
        u.cas_version = params[4];
        u.updated_at = String(params[5]);
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY timestamp DESC, seq DESC')) {
        return {
          rows: ledger
            .filter((r) => r.user_id === params[0])
            .slice()
            .sort((a, b) => (Number(b.timestamp) - Number(a.timestamp)) || (b.seq - a.seq))
            .slice(0, params[1])
        };
      }
      return { rows: [] };
    }

    const mockPool = {
      async query(sql, params) {
        return runPgSql(sql, params);
      },
      async connect() {
        connectCount += 1;
        let released = false;
        let releaseLock = null;
        return {
          async query(sql, params) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            if (normalized.startsWith('SELECT * FROM users WHERE id = $1 FOR UPDATE')) {
              const prev = lockHolder;
              let resFn;
              lockHolder = new Promise((r) => { resFn = r; });
              releaseLock = resFn;
              await prev;
            }
            const out = runPgSql(sql, params);
            if ((normalized === 'COMMIT' || normalized === 'ROLLBACK') && releaseLock) {
              const fn = releaseLock;
              releaseLock = null;
              fn();
            }
            return out;
          },
          release() {
            if (!released) {
              released = true;
              releaseCount += 1;
            }
            if (releaseLock) {
              const fn = releaseLock;
              releaseLock = null;
              fn();
            }
          }
        };
      },
      async end() {
        return undefined;
      }
    };

    const cfg = loadConfig({
      env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://mock:mock@localhost:5432/sicbo' },
      dataDir: makeTempDir(),
      loadDotEnv: false
    });
    const db = createDb(cfg, { pgPool: mockPool, seedLegacyHistory: false });
    await db.init();

    const u1 = await db.createUser({
      username: 'TakenName',
      passwordHash: await hashPassword('pass1234'),
      balance: 500_000
    });
    const g1 = await db.createUser({
      username: 'guest_pg_1',
      isGuest: true,
      balance: 200_000
    });

    // 1. PG 23505 unique violation -> USERNAME_TAKEN (409) in createUser & upgradeGuestAtomic
    await assert.rejects(
      async () => db.createUser({ username: 'takenname', passwordHash: await hashPassword('pass1234') }),
      (err) => err.code === 'USERNAME_TAKEN' && err.status === 409
    );
    await assert.rejects(
      async () => db.upgradeGuestAtomic({
        userId: g1.id,
        username: 'takenname',
        passwordHash: await hashPassword('pass1234'),
        recoveryCodeHash: await hashRecoveryCode('SOV-1111-2222-3333')
      }),
      (err) => err.code === 'USERNAME_TAKEN' && err.status === 409
    );

    // 2. Lock ordering in placeLiveBetAtomic & concurrent same-key stampede
    queryLog.length = 0;
    const liveRace = await Promise.all([
      db.placeLiveBetAtomic({ userId: u1.id, liveRoundId: 901, bets: { tai: 100_000 }, idempotencyKey: 'pg-live-1', now: 5000 }),
      db.placeLiveBetAtomic({ userId: u1.id, liveRoundId: 901, bets: { tai: 100_000 }, idempotencyKey: 'pg-live-1', now: 5000 })
    ]);
    assert.equal(liveRace.filter((r) => !r.replayed).length, 1);
    assert.equal(liveRace.filter((r) => r.replayed).length, 1);
    assert.equal(Number(users.get(u1.id).balance), 400_000);

    const userLockIdx = queryLog.findIndex((q) => q.startsWith('SELECT * FROM users WHERE id = $1 FOR UPDATE'));
    const idemIdx = queryLog.findIndex((q) => q.startsWith('SELECT request_hash, response, created_at FROM idempotency_keys'));
    assert.ok(userLockIdx !== -1 && idemIdx !== -1);
    assert.ok(userLockIdx < idemIdx, 'placeLiveBetAtomic must lock users FOR UPDATE before checkPgIdempotency');

    // 3. Lock ordering in adjustBalanceAtomic & concurrent same-key stampede
    queryLog.length = 0;
    const adjRace = await Promise.all([
      db.adjustBalanceAtomic({ userId: u1.id, delta: 200_000, type: 'admin_adjust', reason: 'test', idempotencyKey: 'pg-adj-1', now: 5000 }),
      db.adjustBalanceAtomic({ userId: u1.id, delta: 200_000, type: 'admin_adjust', reason: 'test', idempotencyKey: 'pg-adj-1', now: 5000 })
    ]);
    assert.equal(adjRace.filter((r) => !r.replayed).length, 1);
    assert.equal(adjRace.filter((r) => r.replayed).length, 1);
    assert.equal(Number(users.get(u1.id).balance), 600_000);

    const adjLockIdx = queryLog.findIndex((q) => q.startsWith('SELECT * FROM users WHERE id = $1 FOR UPDATE'));
    const adjIdemIdx = queryLog.findIndex((q) => q.startsWith('SELECT request_hash, response, created_at FROM idempotency_keys'));
    assert.ok(adjLockIdx !== -1 && adjIdemIdx !== -1);
    assert.ok(adjLockIdx < adjIdemIdx, 'adjustBalanceAtomic must lock users FOR UPDATE before checkPgIdempotency');

    // 4. Same-timestamp wallet_ledger tie-breaking via seq DESC
    queryLog.length = 0;
    const pgLedger = await db.getWalletLedger(u1.id, 10);
    assert.ok(queryLog.some((q) => q.includes('ORDER BY timestamp DESC, seq DESC')));
    assert.equal(pgLedger.length, 2);
    assert.equal(pgLedger[0].type, 'admin_adjust');
    assert.equal(pgLedger[1].type, 'bet');

    // 5. Merged MAX_SINGLE_BET + concurrent race + Idempotency-Key replay/conflict in PG transaction
    const pgWhale = await db.createUser({
      username: 'PgWhale',
      passwordHash: await hashPassword('pass1234'),
      balance: 3_000_000_000
    });
    const pgB1 = await db.placeLiveBetAtomic({
      userId: pgWhale.id,
      liveRoundId: 902,
      bets: { tai: 800_000_000 },
      idempotencyKey: 'pg-live-k1',
      now: 6000
    });
    assert.equal(pgB1.replayed, false);
    assert.equal(pgB1.ticket.bets.tai, 800_000_000);

    const pgB1Replay = await db.placeLiveBetAtomic({
      userId: pgWhale.id,
      liveRoundId: 902,
      bets: { tai: 800_000_000 },
      idempotencyKey: 'pg-live-k1',
      now: 6100
    });
    assert.equal(pgB1Replay.replayed, true);
    assert.equal(pgB1Replay.newBalance, 2_200_000_000);

    await assert.rejects(
      () => db.placeLiveBetAtomic({
        userId: pgWhale.id,
        liveRoundId: 902,
        bets: { xiu: 800_000_000 },
        idempotencyKey: 'pg-live-k1',
        now: 6200
      }),
      (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
    );

    const pgConcurrent = await Promise.allSettled([
      db.placeLiveBetAtomic({ userId: pgWhale.id, liveRoundId: 902, bets: { tai: 800_000_000 }, idempotencyKey: 'pg-live-k2', now: 6300 }),
      db.placeLiveBetAtomic({ userId: pgWhale.id, liveRoundId: 902, bets: { tai: 200_000_000 }, idempotencyKey: 'pg-live-k3', now: 6300 })
    ]);
    assert.equal(pgConcurrent[0].status, 'rejected');
    assert.equal(pgConcurrent[0].reason.code, 'INVALID_BETS');
    assert.equal(pgConcurrent[0].reason.status, 400);
    assert.equal(pgConcurrent[1].status, 'fulfilled');
    assert.equal(pgConcurrent[1].value.ticket.bets.tai, 1_000_000_000);
    assert.equal(pgConcurrent[1].value.newBalance, 2_000_000_000);

    assert.equal(releaseCount, connectCount);
  });
});

// ============================================================================
// SUITE 4: lib/auth.js — scrypt, timingSafeEqual & Recovery Codes
// ============================================================================

describe('lib/auth.js — scrypt, timingSafeEqual & Recovery Codes', () => {
  it('uses N=16384, r=8, p=1, 16B unique salt, 64B key and verifies cleanly', async () => {
    assert.equal(SCRYPT_PARAMS.N, 16384);
    assert.equal(SCRYPT_PARAMS.r, 8);
    assert.equal(SCRYPT_PARAMS.p, 1);

    const h1 = await hashPassword('SovereignPass#1');
    const h2 = await hashPassword('SovereignPass#1');
    assert.match(h1, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.match(h2, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.notEqual(h1, h2);

    assert.equal(await verifyPassword('SovereignPass#1', h1), true);
    assert.equal(await verifyPassword('WrongPass', h1), false);
  });

  it('never throws RangeError/ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on malformed hashes', async () => {
    const malformed = [
      '',
      null,
      undefined,
      123,
      'scrypt$short$short',
      `scrypt$${'a'.repeat(32)}$${'b'.repeat(64)}`,
      `scrypt$${'z'.repeat(32)}$${'b'.repeat(128)}`,
      `scrypt$${'a'.repeat(31)}$${'b'.repeat(128)}`,
      `sha256$${'a'.repeat(32)}$${'b'.repeat(128)}`,
      'scrypt$onlytwo'
    ];
    for (const candidate of malformed) {
      assert.equal(await verifyPassword('AnyPassword', candidate), false);
    }
    assert.equal(await verifyPassword('', await hashPassword('valid')), false);
    assert.equal(await verifyPassword(null, await hashPassword('valid')), false);
  });

  it('generates unique SOV-XXXX-XXXX-XXXX recovery codes and supports single-use rotation', async () => {
    const codes = new Set();
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      assert.match(code, /^SOV-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      codes.add(code);
    }
    assert.equal(codes.size, 50);

    const firstCode = Array.from(codes)[0];
    assert.equal(normalizeRecoveryCode(`  ${firstCode.toLowerCase()}  `), firstCode);
    const hash1 = await hashRecoveryCode(firstCode);
    assert.equal(await verifyRecoveryCode(`  ${firstCode.toLowerCase()}  `, hash1), true);
    assert.equal(await verifyRecoveryCode('SOV-0000-0000-0000', hash1), false);

    // Single-use rotation in DB
    const db = createIsolatedDb();
    await db.init();
    const user = await db.createUser({
      username: 'recoverUser',
      passwordHash: await hashPassword('OldPass123'),
      recoveryCodeHash: hash1
    });

    const secondCode = generateRecoveryCode();
    const hash2 = await hashRecoveryCode(secondCode);
    const updated = await db.updateUserPassword({
      userId: user.id,
      passwordHash: await hashPassword('RecoveredPass123'),
      recoveryCodeHash: hash2,
      bumpSessionVersion: true
    });
    assert.equal(updated.sessionVersion, 2);
    assert.equal(await verifyRecoveryCode(firstCode, updated.recoveryCodeHash), false);
    assert.equal(await verifyRecoveryCode(secondCode, updated.recoveryCodeHash), true);

    // Concurrent updateUserPassword with expectedRecoveryCodeHash CAS guard -> exactly 1 succeeds, 1 rejects 401
    const thirdCode = generateRecoveryCode();
    const hash3 = await hashRecoveryCode(thirdCode);
    const fourthCode = generateRecoveryCode();
    const hash4 = await hashRecoveryCode(fourthCode);
    const pwNew1 = await hashPassword('Concurrent1!');
    const pwNew2 = await hashPassword('Concurrent2!');
    const recRace = await Promise.allSettled([
      db.updateUserPassword({
        userId: user.id,
        passwordHash: pwNew1,
        recoveryCodeHash: hash3,
        expectedRecoveryCodeHash: hash2,
        bumpSessionVersion: true
      }),
      db.updateUserPassword({
        userId: user.id,
        passwordHash: pwNew2,
        recoveryCodeHash: hash4,
        expectedRecoveryCodeHash: hash2,
        bumpSessionVersion: true
      })
    ]);
    assert.equal(recRace.filter((r) => r.status === 'fulfilled').length, 1);
    const recFailed = recRace.filter((r) => r.status === 'rejected');
    assert.equal(recFailed.length, 1);
    assert.equal(recFailed[0].reason.code, 'INVALID_RECOVERY_CODE');
    assert.equal(recFailed[0].reason.status, 401);

    // Positive safe-integer overflow in JSON adjustBalanceAtomic rejects 400 INVALID_AMOUNT
    await assert.rejects(
      () => db.adjustBalanceAtomic({
        userId: user.id,
        delta: Number.MAX_SAFE_INTEGER,
        type: 'admin_adjust',
        reason: 'Overflow test'
      }),
      (err) => err.code === 'INVALID_AMOUNT' && err.status === 400
    );
  });
});

// ============================================================================
// SUITE 5: lib/auth.js — JWT Edge Cases, Session Revocation, Cookies & RBAC
// ============================================================================

describe('lib/auth.js — JWT Attack Vectors, Session Revocation, Cookies & RBAC', () => {
  it('signs/verifies HS256 JWTs and rejects alg:none, tampered payloads/sigs, expired exp & invalid claims', () => {
    const secret = 'super-strong-test-jwt-secret-0123456789abcdef';
    const nowMs = 1_700_000_000_000;
    const token = signJwt({ sub: 'user-1', sv: 1, role: 'user' }, secret, { nowMs, ttlSeconds: 3600 });

    const verified = verifyJwt(token, secret, { nowMs: nowMs + 1000 });
    assert.ok(verified);
    assert.equal(verified.sub, 'user-1');
    assert.equal(verified.sv, 1);
    assert.equal(verified.role, 'user');

    const [hB64, pB64, sB64] = token.split('.');

    // 1. alg: none (unsigned and forged sig)
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal(verifyJwt(`${noneHeader}.${pB64}.`, secret, { nowMs }), null);
    assert.equal(verifyJwt(`${noneHeader}.${pB64}.${sB64}`, secret, { nowMs }), null);

    // 2. unsupported alg HS512
    const hs512Header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const hs512Sig = crypto.createHmac('sha512', secret).update(`${hs512Header}.${pB64}`).digest('base64url');
    assert.equal(verifyJwt(`${hs512Header}.${pB64}.${hs512Sig}`, secret, { nowMs }), null);

    // 3. tampered payload (privilege escalation)
    const tamperedPayload = Buffer.from(JSON.stringify({
      sub: 'user-1',
      sv: 1,
      role: 'admin',
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600
    })).toString('base64url');
    assert.equal(verifyJwt(`${hB64}.${tamperedPayload}.${sB64}`, secret, { nowMs }), null);

    // 4. tampered / truncated signature
    assert.equal(verifyJwt(`${hB64}.${pB64}.${sB64.slice(0, -4)}`, secret, { nowMs }), null);
    const flippedSig = (sB64[0] === 'A' ? 'B' : 'A') + sB64.slice(1);
    assert.equal(verifyJwt(`${hB64}.${pB64}.${flippedSig}`, secret, { nowMs }), null);

    // 5. wrong secret
    assert.equal(verifyJwt(token, 'wrong-secret', { nowMs }), null);

    // 6. expired exp (at exp and exp + 1)
    assert.equal(verifyJwt(token, secret, { nowMs: nowMs + 3600 * 1000 }), null);
    assert.equal(verifyJwt(token, secret, { nowMs: nowMs + 3601 * 1000 }), null);

    // 7. missing sub or invalid sv
    const noSub = signJwt({ sv: 1, role: 'user' }, secret, { nowMs });
    assert.equal(verifyJwt(noSub, secret, { nowMs }), null);
    const badSv = signJwt({ sub: 'u1', sv: -1, role: 'user' }, secret, { nowMs });
    assert.equal(verifyJwt(badSv, secret, { nowMs }), null);
    const floatSv = signJwt({ sub: 'u1', sv: 1.5, role: 'user' }, secret, { nowMs });
    assert.equal(verifyJwt(floatSv, secret, { nowMs }), null);
  });

  it('parses cookies safely (malformed % and __proto__) and sets conditional Secure cookie flags', () => {
    const parsed = parseCookies('sicbo_token=abc.def.ghi; bad=%ZZ; __proto__=polluted; quoted="hello%20world"');
    assert.equal(parsed.sicbo_token, 'abc.def.ghi');
    assert.equal(parsed.bad, '%ZZ');
    assert.equal(parsed.quoted, 'hello world');
    assert.equal(({}).polluted, undefined);

    // Local dev -> NO Secure
    const localCfg = loadConfig({ env: { NODE_ENV: 'development' }, dataDir: makeTempDir(), loadDotEnv: false });
    const resLocal = createMockRes({ withAppend: true });
    const localCookie = setAuthCookie(resLocal, 'tok123', { config: localCfg });
    assert.match(localCookie, /^sicbo_token=tok123; .*HttpOnly; SameSite=Lax$/);
    assert.equal(localCookie.includes('Secure'), false);

    // VERCEL=1 -> includes ; Secure (and fallback res.setHeader works too)
    const vercelCfg = loadConfig({ env: { VERCEL: '1', NODE_ENV: 'production' }, fresh: true, silent: true });
    const resVercel = createMockRes({ withAppend: false });
    const vercelCookie = setAuthCookie(resVercel, 'tok123', { config: vercelCfg });
    assert.ok(vercelCookie.includes('; HttpOnly; SameSite=Lax; Secure'));
    assert.equal(resVercel.getHeader('Set-Cookie'), vercelCookie);

    const cleared = clearAuthCookie(resVercel, { config: vercelCfg });
    assert.ok(cleared.includes('Max-Age=0'));
    assert.ok(cleared.includes('; HttpOnly; SameSite=Lax; Secure'));
  });

  it('enforces DB sessionVersion revocation, locked user 401, deleted user 401, and requireAdmin 401/403', async () => {
    const db = createIsolatedDb();
    await db.init();
    const cfg = loadConfig({
      env: { NODE_ENV: 'test', JWT_SECRET: 'm2-auth-middleware-secret-0123456789abcdef', ADMIN_USERNAME: 'BossAdmin' },
      dataDir: makeTempDir(),
      loadDotEnv: false
    });

    const { requireAuth, authenticateOptional, requireAdmin } = createAuthMiddleware({
      db,
      getConfig: () => cfg
    });

    const normalUser = await db.createUser({
      username: 'vipMember',
      passwordHash: await hashPassword('MemberPass123'),
      role: resolveInitialRole('vipMember', cfg)
    });
    const adminUser = await db.createUser({
      username: 'bossadmin',
      passwordHash: await hashPassword('AdminPass123'),
      role: resolveInitialRole('bossadmin', cfg)
    });
    assert.equal(normalUser.role, 'user');
    assert.equal(adminUser.role, 'admin');
    assert.equal(isAdminUsername('BOSSADMIN', cfg), true);

    const userTokenV1 = signJwt({ sub: normalUser.id, sv: 1, role: 'user' }, cfg.jwtSecret);
    const adminTokenV1 = signJwt({ sub: adminUser.id, sv: 1, role: 'admin' }, cfg.jwtSecret);

    // 1. Valid user passes requireAuth -> 403 on requireAdmin
    {
      const req = { headers: { cookie: `sicbo_token=${userTokenV1}` } };
      const res = createMockRes();
      let nextCalled = false;
      await requireAuth(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(req.user.id, normalUser.id);
      assert.equal(req.user.passwordHash, undefined);
      assert.equal(req.user.fairness.serverSeed, undefined);

      let adminNext = false;
      const adminRes = createMockRes();
      requireAdmin(req, adminRes, () => { adminNext = true; });
      assert.equal(adminNext, false);
      assert.equal(adminRes.statusCode, 403);
    }

    // 2. Admin passes requireAuth + requireAdmin
    {
      const req = { headers: { cookie: `sicbo_token=${adminTokenV1}` } };
      const res = createMockRes();
      let nextCalled = false;
      await requireAuth(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      let adminNext = false;
      requireAdmin(req, res, () => { adminNext = true; });
      assert.equal(adminNext, true);
    }

    // 3. Unauthenticated requireAdmin -> 401; authenticateOptional -> req.user = null
    {
      const req = { headers: {} };
      const res = createMockRes();
      let optNext = false;
      await authenticateOptional(req, res, () => { optNext = true; });
      assert.equal(optNext, true);
      assert.equal(req.user, null);

      let adminNext = false;
      requireAdmin(req, res, () => { adminNext = true; });
      assert.equal(adminNext, false);
      assert.equal(res.statusCode, 401);
    }

    // 4. Password change bumps sessionVersion -> old token returns 401 immediately
    await db.updateUserPassword({
      userId: normalUser.id,
      passwordHash: await hashPassword('NewMemberPass123'),
      bumpSessionVersion: true
    });
    {
      const req = { headers: { cookie: `sicbo_token=${userTokenV1}` } };
      const res = createMockRes();
      let nextCalled = false;
      await requireAuth(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
    }

    // 5. Locking user -> 401 even with latest sv token
    const adminTokenV2 = signJwt({ sub: adminUser.id, sv: 2, role: 'admin' }, cfg.jwtSecret);
    await db.toggleUserLock({ userId: adminUser.id, locked: true });
    {
      const req = { headers: { cookie: `sicbo_token=${adminTokenV2}` } };
      const res = createMockRes();
      let nextCalled = false;
      await requireAuth(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
    }

    // 6. Deleted/non-existent user -> 401
    {
      const ghostToken = signJwt({ sub: 'deleted-user-id', sv: 1, role: 'user' }, cfg.jwtSecret);
      const req = { headers: { cookie: `sicbo_token=${ghostToken}` } };
      const res = createMockRes();
      let nextCalled = false;
      await requireAuth(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
    }
  });

  it('validates username/password/displayName and escapes HTML cleanly', () => {
    assert.equal(validateUsername('guest_123').valid, false);
    assert.equal(validateUsername('guest_123', { allowGuestPrefix: true }).valid, true);
    assert.equal(validateUsername('ab').valid, false);
    assert.equal(validateUsername('vip_salon.01').valid, true);
    assert.equal(validatePassword('12345').valid, false);
    assert.equal(validatePassword('123456').valid, true);
    assert.equal(validateDisplayName('  <b>VIP\x00</b>  ', 'fallback'), '<b>VIP</b>');
    assert.equal(escapeHtml('<script>"alert\'&</script>'), '&lt;script&gt;&quot;alert&#39;&amp;&lt;/script&gt;');
    assert.ok(generateTempPassword().length >= 12);
  });
});

// ============================================================================
// SUITE 6: lib/auth.js — Sliding-Window Rate Limiter
// ============================================================================

describe('lib/auth.js — Sliding-Window Rate Limiter', () => {
  it('enforces 429 + Retry-After, isolates IP vs userId keys, and slides window accurately', () => {
    let fakeNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 3,
      now: () => fakeNow,
      keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}:${req.ip}` : `ip:${req.ip}`),
      enableTimer: false
    });
    limitersToDestroy.push(limiter);

    function hit(req) {
      const res = createMockRes();
      let passed = false;
      limiter(req, res, () => { passed = true; });
      return { passed, res };
    }

    // t = 0: 2 hits on IP A
    assert.equal(hit({ ip: '1.1.1.1' }).passed, true);
    assert.equal(hit({ ip: '1.1.1.1' }).passed, true);

    // t = 40_000: 1 more hit on IP A (total 3 = max)
    fakeNow = 1_040_000;
    assert.equal(hit({ ip: '1.1.1.1' }).passed, true);

    // t = 50_000: 4th hit on IP A -> 429 with Retry-After: 10 (10s until t=0 expires at 60_000)
    fakeNow = 1_050_000;
    const blocked = hit({ ip: '1.1.1.1' });
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.res.getHeader('Retry-After'), '10');
    assert.equal(blocked.res.getHeader('X-RateLimit-Remaining'), '0');

    // Different IP and authenticated userId on same IP are isolated
    assert.equal(hit({ ip: '2.2.2.2' }).passed, true);
    assert.equal(hit({ ip: '1.1.1.1', user: { id: 'u1' } }).passed, true);

    // t = 60_001: the two t=0 hits expired, t=40_000 remains -> 2 more allowed, 3rd hits 429!
    fakeNow = 1_060_001;
    assert.equal(hit({ ip: '1.1.1.1' }).passed, true);
    assert.equal(hit({ ip: '1.1.1.1' }).passed, true);
    const blockedAgain = hit({ ip: '1.1.1.1' });
    assert.equal(blockedAgain.passed, false);
    assert.equal(blockedAgain.res.statusCode, 429);
  });

  it('bounds memory via maxBuckets & stale bucket sweep', () => {
    let fakeNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 10_000,
      max: 5,
      maxBuckets: 3,
      sweepIntervalMs: 5_000,
      now: () => fakeNow,
      enableTimer: false
    });
    limitersToDestroy.push(limiter);

    for (let i = 0; i < 10; i++) {
      const res = createMockRes();
      limiter({ ip: `10.0.0.${i}` }, res, () => {});
    }
    assert.ok(limiter.size() <= 3);

    fakeNow += 20_000;
    const res = createMockRes();
    limiter({ ip: '10.0.0.99' }, res, () => {});
    assert.equal(limiter.size(), 1);
  });
});
