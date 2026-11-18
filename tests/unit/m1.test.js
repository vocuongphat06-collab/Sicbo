'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const configMod = require('../../lib/config');
const engine = require('../../lib/sicbo-engine');

const {
  CONSTANTS,
  loadConfig,
  getConfig,
  resetConfigCache,
  parseBoolEnv
} = configMod;

const {
  DEFAULT_CLIENT_SEED,
  MAX_SINGLE_BET,
  TOTAL_MULTIPLIERS,
  ALLOWED_BET_KEYS,
  validateBets,
  evaluateRoll,
  sha256Hex,
  hmacSha256Buffer,
  hmacSha256Hex,
  deriveDiceWithHmac,
  deriveFairDice,
  getLiveRoundClock,
  deriveLiveRoundDice,
  computeLiveCommitmentHash,
  deriveLiveRecentHistory
} = engine;

const tempDirsToClean = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sicbo-m1-test-'));
  tempDirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  resetConfigCache();
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function webCryptoDeriveFairDice(serverSeed, clientSeed, nonce) {
  const subtle = crypto.webcrypto.subtle;
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    enc.encode(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const cleanClient = (clientSeed === undefined || clientSeed === null ? '' : String(clientSeed).trim()) || DEFAULT_CLIENT_SEED;
  const cleanNonce = nonce === undefined ? 0 : Number(nonce);
  const baseMessage = `${cleanClient}:${cleanNonce}`;

  const dice = [];
  let attempt = 0;
  let primaryHmacHex = '';

  while (dice.length < 3) {
    const msg = attempt === 0 ? baseMessage : `${baseMessage}:${attempt}`;
    const sig = await subtle.sign('HMAC', key, enc.encode(msg));
    const bytes = new Uint8Array(sig);
    if (attempt === 0) {
      primaryHmacHex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    for (let i = 0; i < bytes.length && dice.length < 3; i++) {
      if (bytes[i] < 252) {
        dice.push((bytes[i] % 6) + 1);
      }
    }
    attempt += 1;
  }

  return { dice, clientSeed: cleanClient, nonce: cleanNonce, hmacHex: primaryHmacHex, attempts: attempt };
}

describe('lib/config.js', () => {
  it('exports exact PROJECT.md constants at top-level, CONSTANTS, and loadConfig output', () => {
    const tmpDir = makeTempDir();
    const cfg = loadConfig({ env: {}, dataDir: tmpDir });

    const expected = {
      LIVE_ROUND_MS: 45_000,
      LIVE_BET_MS: 40_000,
      LIVE_REVEAL_MS: 5_000,
      DAILY_BONUS_AMOUNT: 2_000_000,
      DAILY_BONUS_COOLDOWN_MS: 24 * 60 * 60 * 1000,
      BANKRUPTCY_THRESHOLD: 10_000,
      BANKRUPTCY_AID_AMOUNT: 500_000,
      BANKRUPTCY_COOLDOWN_MS: 60 * 60 * 1000,
      INITIAL_BALANCE: 10_000_000,
      GUEST_INITIAL_BALANCE: 2_000_000,
      BODY_LIMIT: '16kb',
      COOKIE_NAME: 'sicbo_token',
      MAX_SINGLE_BET: 1_000_000_000,
      DEFAULT_CLIENT_SEED: 'sovereign-vip-888'
    };

    for (const [key, val] of Object.entries(expected)) {
      assert.equal(CONSTANTS[key], val, `CONSTANTS.${key}`);
      assert.equal(configMod[key], val, `configMod.${key}`);
      assert.equal(cfg[key], val, `cfg.${key}`);
    }
    assert.ok(Object.isFrozen(CONSTANTS));
  });

  it('parses VERCEL boolean env values cleanly', () => {
    assert.equal(parseBoolEnv(undefined), false);
    assert.equal(parseBoolEnv(null), false);
    assert.equal(parseBoolEnv(''), false);
    assert.equal(parseBoolEnv('0'), false);
    assert.equal(parseBoolEnv('false'), false);
    assert.equal(parseBoolEnv('FALSE'), false);
    assert.equal(parseBoolEnv('no'), false);
    assert.equal(parseBoolEnv('1'), true);
    assert.equal(parseBoolEnv('true'), true);
  });

  it('persists and reuses 32-byte CSPRNG hex secrets in isolated local .secrets.json', () => {
    const tmpDir = makeTempDir();
    const cfg1 = loadConfig({ env: {}, dataDir: tmpDir });
    const secretsPath = path.join(tmpDir, '.secrets.json');

    assert.equal(cfg1.isVercel, false);
    assert.equal(cfg1.secretsDegraded, false);
    assert.equal(cfg1.secretsSource, 'file');
    assert.match(cfg1.jwtSecret, /^[0-9a-f]{64}$/);
    assert.match(cfg1.liveMasterSecret, /^[0-9a-f]{64}$/);
    assert.notEqual(cfg1.jwtSecret, cfg1.liveMasterSecret);
    assert.equal(fs.existsSync(secretsPath), true);

    const cfg2 = loadConfig({ env: {}, dataDir: tmpDir });
    assert.equal(cfg2.jwtSecret, cfg1.jwtSecret);
    assert.equal(cfg2.liveMasterSecret, cfg1.liveMasterSecret);
  });

  it('recovers cleanly from corrupt and partial .secrets.json files', () => {
    const tmpDir = makeTempDir();
    const secretsPath = path.join(tmpDir, '.secrets.json');

    fs.writeFileSync(secretsPath, '{corrupt-json', 'utf8');
    const recovered1 = loadConfig({ env: {}, dataDir: tmpDir });
    assert.match(recovered1.jwtSecret, /^[0-9a-f]{64}$/);
    assert.match(recovered1.liveMasterSecret, /^[0-9a-f]{64}$/);

    const validLive = 'b'.repeat(64);
    fs.writeFileSync(
      secretsPath,
      JSON.stringify({ jwtSecret: 'too-short', liveMasterSecret: validLive }),
      'utf8'
    );
    const recovered2 = loadConfig({ env: {}, dataDir: tmpDir });
    assert.match(recovered2.jwtSecret, /^[0-9a-f]{64}$/);
    assert.equal(recovered2.liveMasterSecret, validLive);
  });

  it('uses local env secrets without writing .secrets.json when both are set', () => {
    const tmpDir = makeTempDir();
    const cfg = loadConfig({
      env: {
        JWT_SECRET: 'env-jwt-secret-value-at-least-32-chars',
        LIVE_MASTER_SECRET: 'env-live-secret-value-at-least-32-chars'
      },
      dataDir: tmpDir
    });

    assert.equal(cfg.jwtSecret, 'env-jwt-secret-value-at-least-32-chars');
    assert.equal(cfg.liveMasterSecret, 'env-live-secret-value-at-least-32-chars');
    assert.equal(cfg.secretsSource, 'env');
    assert.equal(cfg.secretsDegraded, false);
    assert.equal(fs.existsSync(path.join(tmpDir, '.secrets.json')), false);
  });

  it('never crashes on VERCEL=1 without secrets, warns explicitly, and uses non-static CSPRNG secrets', () => {
    const repoSecretsPath = path.resolve(__dirname, '..', '..', 'data', '.secrets.json');
    const existedBefore = fs.existsSync(repoSecretsPath);

    const savedEnv = {
      VERCEL: process.env.VERCEL,
      JWT_SECRET: process.env.JWT_SECRET,
      LIVE_MASTER_SECRET: process.env.LIVE_MASTER_SECRET,
      NODE_ENV: process.env.NODE_ENV
    };

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      process.env.VERCEL = '1';
      delete process.env.JWT_SECRET;
      delete process.env.LIVE_MASTER_SECRET;
      delete process.env.NODE_ENV;
      resetConfigCache();

      const cfg1 = loadConfig();
      assert.equal(cfg1.isVercel, true);
      assert.equal(cfg1.isProduction, true);
      assert.equal(cfg1.secretsDegraded, true);
      assert.equal(cfg1.secretsSource, 'ephemeral');
      assert.equal(cfg1.dataDir, path.join(os.tmpdir(), 'sicbo-data'));
      assert.match(cfg1.jwtSecret, /^[0-9a-f]{64}$/);
      assert.match(cfg1.liveMasterSecret, /^[0-9a-f]{64}$/);
      assert.notEqual(cfg1.jwtSecret, cfg1.liveMasterSecret);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /JWT_SECRET/);
      assert.match(warnings[0], /LIVE_MASTER_SECRET/);

      // Same instance caches ephemeral secrets across repeated loadConfig() calls
      const cfgSame = loadConfig({ silent: true });
      assert.equal(cfgSame.jwtSecret, cfg1.jwtSecret);
      assert.equal(cfgSame.liveMasterSecret, cfg1.liveMasterSecret);

      // Fresh instance generates new CSPRNG secrets (proving non-static)
      resetConfigCache();
      const cfg2 = loadConfig({ silent: true });
      assert.notEqual(cfg2.jwtSecret, cfg1.jwtSecret);
      assert.notEqual(cfg2.liveMasterSecret, cfg1.liveMasterSecret);

      assert.equal(fs.existsSync(repoSecretsPath), existedBefore);
    } finally {
      console.warn = origWarn;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetConfigCache();
    }
  });

  it('sets secretsDegraded=false on VERCEL=1 when both secrets are provided', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      const cfg = loadConfig({
        env: {
          VERCEL: '1',
          JWT_SECRET: 'vercel-prod-jwt-secret-1234567890',
          LIVE_MASTER_SECRET: 'vercel-prod-live-secret-1234567890'
        }
      });
      assert.equal(cfg.isVercel, true);
      assert.equal(cfg.secretsDegraded, false);
      assert.equal(cfg.secretsSource, 'env');
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  it('computes dbDriver, port, adminUsername, and caches getConfig()', () => {
    const tmpDir = makeTempDir();
    const upstashCfg = loadConfig({
      env: {
        PORT: '8080',
        ADMIN_USERNAME: '  BossAdmin  ',
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'tok_123',
        DATABASE_URL: 'postgres://ignored-when-upstash-present'
      },
      dataDir: tmpDir
    });
    assert.equal(upstashCfg.dbDriver, 'upstash');
    assert.equal(upstashCfg.port, 8080);
    assert.equal(upstashCfg.adminUsername, 'BossAdmin');
    assert.equal(upstashCfg.adminUsernameLower, 'bossadmin');

    const pgCfg = loadConfig({
      env: {
        PORT: 'not-a-number',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/sicbo'
      },
      dataDir: tmpDir
    });
    assert.equal(pgCfg.dbDriver, 'postgres');
    assert.equal(pgCfg.port, 3000);

    const jsonCfg = loadConfig({
      env: {
        PORT: '70000',
        UPSTASH_REDIS_REST_URL: 'https://missing-token.upstash.io'
      },
      dataDir: tmpDir
    });
    assert.equal(jsonCfg.dbDriver, 'json');
    assert.equal(jsonCfg.port, 3000);

    // getConfig singleton + resetConfigCache
    const savedVercel = process.env.VERCEL;
    const savedJwt = process.env.JWT_SECRET;
    const savedLive = process.env.LIVE_MASTER_SECRET;
    try {
      process.env.VERCEL = '1';
      process.env.JWT_SECRET = 'singleton-jwt-secret-123456789012';
      process.env.LIVE_MASTER_SECRET = 'singleton-live-secret-123456789012';
      resetConfigCache();
      const g1 = getConfig();
      const g2 = getConfig();
      assert.equal(g1, g2);
      assert.equal(g1.jwtSecret, 'singleton-jwt-secret-123456789012');
    } finally {
      if (savedVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedVercel;
      if (savedJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedJwt;
      if (savedLive === undefined) delete process.env.LIVE_MASTER_SECRET;
      else process.env.LIVE_MASTER_SECRET = savedLive;
      resetConfigCache();
    }
  });
});

describe('lib/sicbo-engine.js — Macau Bets & Validation', () => {
  it('enumerates all 52 Macau bet keys and excludes invalid keys', () => {
    assert.equal(ALLOWED_BET_KEYS.size, 52);

    const expectedKeys = ['tai', 'xiu', 'even', 'odd', 'triple_any'];
    for (let i = 1; i <= 6; i++) expectedKeys.push(`triple_${i}`);
    for (let i = 1; i <= 6; i++) expectedKeys.push(`double_${i}`);
    for (let a = 1; a <= 6; a++) {
      for (let b = a + 1; b <= 6; b++) {
        expectedKeys.push(`pair_${a}_${b}`);
      }
    }
    for (let t = 4; t <= 17; t++) expectedKeys.push(`total_${t}`);
    for (let i = 1; i <= 6; i++) expectedKeys.push(`single_${i}`);

    assert.equal(expectedKeys.length, 52);
    for (const k of expectedKeys) {
      assert.equal(ALLOWED_BET_KEYS.has(k), true, `Missing key ${k}`);
    }

    for (const bad of ['pair_2_1', 'pair_1_1', 'total_3', 'total_18', 'double_0', 'triple_7', 'single_7', 'constructor', 'toString']) {
      assert.equal(ALLOWED_BET_KEYS.has(bad), false, `Unexpected key ${bad}`);
    }
  });

  it('rejects non-plain objects, prototype tampering, unknown keys, and invalid amounts', () => {
    class CustomBet {
      constructor() {
        this.tai = 1000;
      }
    }

    const badInputs = [
      null,
      undefined,
      123,
      'tai',
      [],
      new Date(),
      new Map([['tai', 1000]]),
      new CustomBet(),
      JSON.parse('{"__proto__":{"tai":1000}}'),
      JSON.parse('{"__proto__":1000}'),
      { constructor: 1000 },
      { toString: 1000 },
      {},
      { unknown_bet: 1000 },
      { tai: 0 },
      { tai: -0 },
      { tai: -100 },
      { tai: 10.5 },
      { tai: NaN },
      { tai: Infinity },
      { tai: -Infinity },
      { tai: '1000' },
      { tai: MAX_SINGLE_BET + 1 },
      { tai: Number.MAX_SAFE_INTEGER }
    ];

    for (const input of badInputs) {
      const res = validateBets(input);
      assert.equal(res.valid, false);
      assert.equal(res.totalBet, 0);
      assert.deepEqual(res.cleanBets, {});
      assert.ok(typeof res.error === 'string' && res.error.length > 0);
    }

    const symObj = { tai: 1000, [Symbol('extra')]: 500 };
    assert.equal(validateBets(symObj).valid, false);

    const nonEnumObj = { tai: 1000 };
    Object.defineProperty(nonEnumObj, 'hidden', { value: 500, enumerable: false });
    assert.equal(validateBets(nonEnumObj).valid, false);

    // Valid plain object & null-prototype object & boundary amounts
    const ok1 = validateBets({ tai: 1, triple_6: MAX_SINGLE_BET });
    assert.equal(ok1.valid, true);
    assert.equal(ok1.totalBet, 1 + MAX_SINGLE_BET);
    assert.deepEqual(ok1.cleanBets, { tai: 1, triple_6: MAX_SINGLE_BET });

    const nullProto = Object.create(null);
    nullProto.xiu = 50_000;
    const ok2 = validateBets(nullProto);
    assert.equal(ok2.valid, true);
    assert.equal(ok2.totalBet, 50_000);
    assert.deepEqual(ok2.cleanBets, { xiu: 50_000 });
  });

  it('evaluates primary bets (tai/xiu/even/odd) including house-edge triple losses', () => {
    const taiWin = evaluateRoll([1, 4, 6], { tai: 10_000, xiu: 10_000, odd: 10_000, even: 10_000 });
    assert.equal(taiWin.total, 11);
    assert.equal(taiWin.isTriple, false);
    assert.equal(taiWin.outcome, 'TAI');
    assert.equal(taiWin.totalBet, 40_000);
    assert.equal(taiWin.totalWin, 40_000);
    assert.equal(taiWin.netProfit, 0);

    const xiuWin = evaluateRoll([1, 1, 2], { tai: 10_000, xiu: 10_000, even: 10_000, odd: 10_000 });
    assert.equal(xiuWin.total, 4);
    assert.equal(xiuWin.outcome, 'XIU');
    assert.equal(xiuWin.totalWin, 40_000);
    assert.equal(xiuWin.netProfit, 0);

    const tripleLose = evaluateRoll([4, 4, 4], { tai: 10_000, xiu: 10_000, even: 10_000, odd: 10_000 });
    assert.equal(tripleLose.total, 12);
    assert.equal(tripleLose.isTriple, true);
    assert.equal(tripleLose.outcome, 'TRIPLE');
    assert.equal(tripleLose.totalWin, 0);
    assert.equal(tripleLose.netProfit, -40_000);
    assert.deepEqual(tripleLose.winningDetails, []);
  });

  it('evaluates all triple_any, triple_1..6, double_1..6, pair_1_2..5_6, total_4..17, and single_1..6', () => {
    const stake = 1_000;

    // Specific triples & triple_any
    for (let n = 1; n <= 6; n++) {
      const bets = { triple_any: stake };
      for (let m = 1; m <= 6; m++) bets[`triple_${m}`] = stake;
      const res = evaluateRoll([n, n, n], bets);
      // triple_any (31*stake) + triple_n (181*stake) = 212*stake
      assert.equal(res.totalWin, 212 * stake);
      assert.equal(res.outcome, 'TRIPLE');
    }
    assert.equal(evaluateRoll([1, 1, 2], { triple_any: stake, triple_1: stake }).totalWin, 0);

    // Doubles (win 1:10 on 2 matching faces AND on 3 matching faces)
    for (let n = 1; n <= 6; n++) {
      const others = [1, 2, 3, 4, 5, 6].filter((x) => x !== n);
      const other = others[0];
      const twoMatch = evaluateRoll([n, n, other], { [`double_${n}`]: stake });
      assert.equal(twoMatch.totalWin, 11 * stake);

      const threeMatch = evaluateRoll([n, n, n], { [`double_${n}`]: stake });
      assert.equal(threeMatch.totalWin, 11 * stake);

      const oneMatch = evaluateRoll([n, others[0], others[1]], { [`double_${n}`]: stake });
      assert.equal(oneMatch.totalWin, 0);
    }

    // All 15 pairs (1:5)
    for (let a = 1; a <= 6; a++) {
      for (let b = a + 1; b <= 6; b++) {
        const third = [1, 2, 3, 4, 5, 6].find((x) => x !== a && x !== b);
        const key = `pair_${a}_${b}`;
        assert.equal(evaluateRoll([a, b, third], { [key]: stake }).totalWin, 6 * stake);
        assert.equal(evaluateRoll([b, a, a], { [key]: stake }).totalWin, 6 * stake);
        assert.equal(evaluateRoll([a, a, a], { [key]: stake }).totalWin, 0);
        assert.equal(evaluateRoll([a, third, third], { [key]: stake }).totalWin, 0);
      }
    }

    // All 14 totals 4..17 including Macau triple rule
    const totalDiceSamples = {
      4: [1, 1, 2],
      5: [1, 2, 2],
      6: [2, 2, 2],   // triple!
      7: [1, 2, 4],
      8: [2, 2, 4],
      9: [3, 3, 3],   // triple!
      10: [2, 3, 5],
      11: [2, 4, 5],
      12: [4, 4, 4],  // triple!
      13: [3, 4, 6],
      14: [3, 5, 6],
      15: [5, 5, 5],  // triple!
      16: [4, 6, 6],
      17: [5, 6, 6]
    };

    for (let t = 4; t <= 17; t++) {
      const res = evaluateRoll(totalDiceSamples[t], { [`total_${t}`]: stake });
      const expectedMult = TOTAL_MULTIPLIERS[t];
      assert.equal(res.totalWin, (1 + expectedMult) * stake, `total_${t}`);
    }

    // Triples [1,1,1]=3 and [6,6,6]=18 win no total_4..17
    const allTotalBets = {};
    for (let t = 4; t <= 17; t++) allTotalBets[`total_${t}`] = stake;
    assert.equal(evaluateRoll([1, 1, 1], allTotalBets).totalWin, 0);
    assert.equal(evaluateRoll([6, 6, 6], allTotalBets).totalWin, 0);

    // Singles 1..6 (0 / 1:1 / 1:2 / 1:3)
    for (let n = 1; n <= 6; n++) {
      const other = n === 1 ? 2 : 1;
      const key = `single_${n}`;
      assert.equal(evaluateRoll([other, other, other], { [key]: stake }).totalWin, 0);
      assert.equal(evaluateRoll([n, other, other], { [key]: stake }).totalWin, 2 * stake);
      assert.equal(evaluateRoll([n, n, other], { [key]: stake }).totalWin, 3 * stake);
      assert.equal(evaluateRoll([n, n, n], { [key]: stake }).totalWin, 4 * stake);
    }
  });

  it('handles breakeven, partial win, multi-bet triple combo, and rejects invalid dice', () => {
    const breakeven = evaluateRoll([4, 5, 6], { tai: 10_000, xiu: 10_000 });
    assert.equal(breakeven.totalBet, 20_000);
    assert.equal(breakeven.totalWin, 20_000);
    assert.equal(breakeven.netProfit, 0);

    const partialWin = evaluateRoll([4, 5, 6], { tai: 10_000, xiu: 50_000 });
    assert.equal(partialWin.totalBet, 60_000);
    assert.equal(partialWin.totalWin, 20_000);
    assert.equal(partialWin.netProfit, -40_000);

    const tripleCombo = evaluateRoll([2, 2, 2], {
      tai: 1000,
      xiu: 1000,
      even: 1000,
      odd: 1000,
      triple_any: 1000,
      triple_2: 1000,
      double_2: 1000,
      total_6: 1000,
      single_2: 1000
    });
    // Wins: 31k + 181k + 11k + 19k + 4k = 246k; bet 9k -> netProfit 237k
    assert.equal(tripleCombo.totalBet, 9_000);
    assert.equal(tripleCombo.totalWin, 246_000);
    assert.equal(tripleCombo.netProfit, 237_000);
    assert.equal(tripleCombo.winningDetails.length, 5);

    const emptyPreview = evaluateRoll([1, 2, 3]);
    assert.equal(emptyPreview.total, 6);
    assert.equal(emptyPreview.totalBet, 0);
    assert.equal(emptyPreview.netProfit, 0);

    for (const badDice of [[1, 2], [1, 2, 3, 4], [0, 1, 2], [1, 2, 7], [1.5, 2, 3], ['1', 2, 3], null]) {
      assert.throws(() => evaluateRoll(badDice, { tai: 100 }), TypeError);
    }

    // Sparse arrays must throw TypeError instead of skipping holes
    // eslint-disable-next-line no-sparse-arrays
    for (const sparseDice of [[1, , 3], [, 2, 3], [1, 2, ,], new Array(3)]) {
      assert.throws(() => evaluateRoll(sparseDice, { xiu: 100 }), TypeError);
    }
  });

  it('reads each dice element exactly once to prevent TOCTOU getter mutation', () => {
    let reads0 = 0;
    let reads1 = 0;
    let reads2 = 0;
    const d = [1, 2, 3];
    Object.defineProperty(d, 0, { get() { reads0 += 1; return reads0 === 1 ? 1 : 99; } });
    Object.defineProperty(d, 1, { get() { reads1 += 1; return reads1 === 1 ? 2 : 99; } });
    Object.defineProperty(d, 2, { get() { reads2 += 1; return reads2 === 1 ? 3 : 99; } });

    const res = evaluateRoll(d, { xiu: 100 });
    assert.deepEqual(res.dice, [1, 2, 3]);
    assert.equal(res.total, 6);
    assert.equal(res.totalWin, 200);
    assert.equal(reads0, 1);
    assert.equal(reads1, 1);
    assert.equal(reads2, 1);

    // Also verify triple_* multiplier evaluation does not re-read dice[0]
    let tripleReads0 = 0;
    const tripleDice = [1, 1, 1];
    Object.defineProperty(tripleDice, 0, {
      get() {
        tripleReads0 += 1;
        return tripleReads0 === 1 ? 1 : 6;
      }
    });
    const tripleRes = evaluateRoll(tripleDice, { triple_1: 100, triple_6: 100 });
    assert.deepEqual(tripleRes.dice, [1, 1, 1]);
    assert.equal(tripleRes.totalWin, 18_100);
    assert.equal(tripleReads0, 1);
  });
});

describe('lib/sicbo-engine.js — Provably Fair & Web Crypto Parity', () => {
  it('produces deterministic vectors including nonce=0 and byte >= 252 skipping', () => {
    const v0 = deriveFairDice('seed-alpha', 'client-alpha', 0);
    assert.equal(v0.nonce, 0);
    assert.equal(v0.clientSeed, 'client-alpha');
    assert.equal(v0.hmacHex, '7dced4a5cbfe6cf8713dcc5ca2291f22761b68b7d0f3c5df1067761ba3613645');
    assert.equal(v0.attempts, 1);
    assert.equal(v0.dice.length, 3);

    // undefined nonce defaults to 0; string '0' and -0 normalize to +0
    assert.deepEqual(deriveFairDice('seed-alpha', 'client-alpha', undefined), v0);
    assert.deepEqual(deriveFairDice('seed-alpha', 'client-alpha', '0'), v0);
    const negZeroFair = deriveFairDice('seed-alpha', 'client-alpha', -0);
    assert.equal(Object.is(negZeroFair.nonce, 0), true);
    assert.deepEqual(negZeroFair, v0);

    // empty/null/undefined/whitespace clientSeed falls back to DEFAULT_CLIENT_SEED
    const defaultClient = deriveFairDice('seed-alpha', '', 0);
    assert.equal(defaultClient.clientSeed, DEFAULT_CLIENT_SEED);
    assert.deepEqual(deriveFairDice('seed-alpha', '   ', 0), defaultClient);
    assert.deepEqual(deriveFairDice('seed-alpha', null, 0), defaultClient);
    assert.deepEqual(deriveFairDice('seed-alpha', undefined, 0), defaultClient);

    // Verified nonce=25 vector where digest[2] === 255 (>= 252) is skipped
    const v25 = deriveFairDice('test-server-seed', 'sovereign-vip-888', 25);
    assert.equal(v25.hmacHex, 'aad8ffd7fe482db253ccbf86bef4b7d272fcd120dbc82c50433f58162e035330');
    assert.deepEqual(v25.dice, [3, 1, 6]);
    assert.equal(v25.attempts, 1);
  });

  it('handles attempt > 0 exhaustion deterministically via deriveDiceWithHmac', () => {
    const queriedMessages = [];
    const stubHmac = (msg) => {
      queriedMessages.push(msg);
      if (queriedMessages.length === 1) {
        return Buffer.alloc(32, 255); // all 32 bytes >= 252
      }
      return Buffer.from([252, 253, 254, 255, 0, 5, 11]);
    };

    const res = deriveDiceWithHmac(stubHmac, 'client:42');
    assert.deepEqual(queriedMessages, ['client:42', 'client:42:1']);
    assert.deepEqual(res.dice, [1, 6, 6]);
    assert.equal(res.attempts, 2);
    assert.equal(res.hmacHex, Buffer.alloc(32, 255).toString('hex'));
  });

  it('rejects invalid serverSeed and invalid nonce values', () => {
    for (const badSeed of ['', '   ', null, undefined, 12345, {}]) {
      assert.throws(() => deriveFairDice(badSeed, 'client', 0));
    }
    for (const badNonce of [null, '', '   ', true, false, -1, 1.5, NaN, Infinity, -Infinity, '1.5', '-1']) {
      assert.throws(() => deriveFairDice('valid-seed', 'client', badNonce));
    }
  });

  it('matches Browser Web Crypto HMAC-SHA256 + byte < 252 output 100%', async () => {
    const vectors = [
      ['seed-alpha', 'client-alpha', 0],
      ['test-server-seed', 'sovereign-vip-888', 25],
      ['vip-secret-key-999', 'người-chơi-vip', 7],
      ['0123456789abcdef0123456789abcdef', '', 128]
    ];

    for (const [serverSeed, clientSeed, nonce] of vectors) {
      const nodeRes = deriveFairDice(serverSeed, clientSeed, nonce);
      const webRes = await webCryptoDeriveFairDice(serverSeed, clientSeed, nonce);
      assert.deepEqual(nodeRes, webRes);
    }
  });
});

describe('lib/sicbo-engine.js — Live Clock & Round Derivation', () => {
  it('computes exact BETTING/REVEAL boundaries across 45s rounds (40s bet + 5s reveal)', () => {
    const roundId = 37_777_777;
    const base = roundId * 45_000;

    const c0 = getLiveRoundClock(base);
    assert.equal(c0.liveRoundId, roundId);
    assert.equal(c0.roundStartMs, base);
    assert.equal(c0.elapsedMs, 0);
    assert.equal(c0.phase, 'BETTING');
    assert.equal(c0.betRemainingMs, 40_000);
    assert.equal(c0.roundRemainingMs, 45_000);

    const c39999 = getLiveRoundClock(base + 39_999);
    assert.equal(c39999.liveRoundId, roundId);
    assert.equal(c39999.elapsedMs, 39_999);
    assert.equal(c39999.phase, 'BETTING');
    assert.equal(c39999.betRemainingMs, 1);
    assert.equal(c39999.roundRemainingMs, 5_001);

    const c40000 = getLiveRoundClock(base + 40_000);
    assert.equal(c40000.liveRoundId, roundId);
    assert.equal(c40000.elapsedMs, 40_000);
    assert.equal(c40000.phase, 'REVEAL');
    assert.equal(c40000.betRemainingMs, 0);
    assert.equal(c40000.roundRemainingMs, 5_000);

    const c44999 = getLiveRoundClock(base + 44_999);
    assert.equal(c44999.liveRoundId, roundId);
    assert.equal(c44999.elapsedMs, 44_999);
    assert.equal(c44999.phase, 'REVEAL');
    assert.equal(c44999.betRemainingMs, 0);
    assert.equal(c44999.roundRemainingMs, 1);

    const c45000 = getLiveRoundClock(base + 45_000);
    assert.equal(c45000.liveRoundId, roundId + 1);
    assert.equal(c45000.roundStartMs, base + 45_000);
    assert.equal(c45000.elapsedMs, 0);
    assert.equal(c45000.phase, 'BETTING');
    assert.equal(c45000.betRemainingMs, 40_000);
    assert.equal(c45000.roundRemainingMs, 45_000);

    for (const badNow of [-1, NaN, Infinity, '1700000000000', null]) {
      assert.throws(() => getLiveRoundClock(badNow));
    }
  });

  it('derives deterministic live round dice and non-leaking commitment hash', () => {
    const secret = 'live-master-secret-abc-123';
    const roundId = 85_000_000;

    const r1 = deriveLiveRoundDice(secret, roundId);
    const r2 = deriveLiveRoundDice(secret, roundId);
    assert.deepEqual(r1, r2);
    assert.equal(r1.liveRoundId, roundId);
    assert.equal(r1.dice.length, 3);
    for (const d of r1.dice) {
      assert.ok(Number.isInteger(d) && d >= 1 && d <= 6);
    }
    assert.equal(r1.hmacHex, hmacSha256Hex(secret, `live:${roundId}`));

    const commit1 = computeLiveCommitmentHash(secret, roundId);
    const commit2 = computeLiveCommitmentHash(secret, roundId + 1);
    assert.equal(commit1, sha256Hex(`commit:${r1.hmacHex}`));
    assert.match(commit1, /^[0-9a-f]{64}$/);
    assert.notEqual(commit1, commit2);
    assert.notEqual(commit1, r1.hmacHex);
    assert.notEqual(commit1, sha256Hex(JSON.stringify(r1.dice)));

    assert.throws(() => deriveLiveRoundDice('', roundId));
    assert.throws(() => deriveLiveRoundDice(secret, -1));
    assert.throws(() => computeLiveCommitmentHash(secret, undefined));
  });

  it('normalizes -0 to +0 in getLiveRoundClock and deriveLiveRoundDice', () => {
    const clock = getLiveRoundClock(-0);
    assert.equal(Object.is(clock.serverTime, 0), true);
    assert.equal(Object.is(clock.liveRoundId, 0), true);
    assert.equal(Object.is(clock.roundStartMs, 0), true);
    assert.equal(Object.is(clock.elapsedMs, 0), true);
    assert.equal(clock.phase, 'BETTING');
    assert.equal(clock.betRemainingMs, 40_000);
    assert.equal(clock.roundRemainingMs, 45_000);

    const liveNegZero = deriveLiveRoundDice('live-master-secret-abc-123', -0);
    assert.equal(Object.is(liveNegZero.liveRoundId, 0), true);
  });

  it('derives synced recent Live history strictly hiding active BETTING round and revealing on REVEAL', () => {
    const secret = 'live-master-secret-sync-history';
    const roundId = 100;
    const roundStart = roundId * 45_000;

    const betHist = deriveLiveRecentHistory(secret, getLiveRoundClock(roundStart + 5_000), 10);
    assert.equal(betHist.length, 10);
    assert.equal(betHist[0].liveRoundId, 90);
    assert.equal(betHist[betHist.length - 1].liveRoundId, 99);
    assert.equal(betHist.some((e) => e.liveRoundId === roundId), false);

    const revHist = deriveLiveRecentHistory(secret, getLiveRoundClock(roundStart + 40_000), 10);
    assert.equal(revHist.length, 10);
    assert.equal(revHist[0].liveRoundId, 91);
    assert.equal(revHist[revHist.length - 1].liveRoundId, 100);
    assert.deepEqual(revHist[revHist.length - 1].dice, deriveLiveRoundDice(secret, 100).dice);

    assert.deepEqual(deriveLiveRecentHistory(secret, getLiveRoundClock(0), 10), []);
  });
});
