'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  MACAU_BET_KEYS,
  LIVE_ROUND_MS,
  referenceEvaluateRoll,
  webCryptoSha256Hex,
  webCryptoDeriveFairDice,
  findDeterministicFairVectors,
  startTestServer,
  startClockedServer,
  createClient,
} = require('./helpers');

describe('Tier 1 — F2: Full Macau Sicbo Mathematics & Breakeven', () => {
  let server;
  let client;

  before(async () => {
    server = await startTestServer({ stripSecrets: true });
    client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'f2_macau_player',
      password: 'Password!123',
      displayName: 'Macau VIP',
    });
    assert.equal(reg.status, 201);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F2.1: POST /api/roll accepts all 52 Macau bet keys (>=49) simultaneously and matches oracle', async () => {
    assert.ok(MACAU_BET_KEYS.length >= 49, 'Must cover at least 49 Macau bet keys');
    assert.equal(MACAU_BET_KEYS.length, 52);

    const allBets = {};
    for (const key of MACAU_BET_KEYS) {
      allBets[key] = 1_000;
    }

    const meBefore = await client.get('/api/auth/me');
    const prevBal = meBefore.json.user.balance;

    const rollRes = await client.post('/api/roll', { bets: allBets });
    assert.equal(rollRes.status, 200, `Expected 200 for all 52 Macau keys, got ${rollRes.status}: ${rollRes.text}`);

    const body = rollRes.json;
    assert.equal(body.totalBet, 52_000);
    const expected = referenceEvaluateRoll(body.dice, allBets);
    assert.equal(body.total, expected.total);
    assert.equal(body.isTriple, expected.isTriple);
    assert.equal(body.outcome, expected.outcome);
    assert.equal(body.totalWin, expected.totalWin);
    assert.equal(body.netProfit, expected.netProfit);
    assert.equal(body.newBalance, prevBal - 52_000 + expected.totalWin);
  });

  it('F2.2: primary (tai/xiu/even/odd), single_1..6, and triple bets match referenceEvaluateRoll across rolls', async () => {
    const betBatches = [
      { tai: 10_000, even: 10_000, single_1: 5_000, single_6: 5_000, triple_any: 2_000 },
      { xiu: 10_000, odd: 10_000, single_2: 5_000, single_5: 5_000, triple_3: 1_000 },
      { tai: 5_000, odd: 5_000, single_3: 5_000, single_4: 5_000, triple_6: 1_000 },
    ];

    for (const bets of betBatches) {
      const prevBal = (await client.get('/api/auth/me')).json.user.balance;
      const res = await client.post('/api/roll', { bets });
      assert.equal(res.status, 200);
      const expected = referenceEvaluateRoll(res.json.dice, bets);
      assert.equal(res.json.totalBet, expected.totalBet);
      assert.equal(res.json.totalWin, expected.totalWin);
      assert.equal(res.json.netProfit, expected.netProfit);
      assert.equal(res.json.newBalance, prevBal - expected.totalBet + expected.totalWin);
    }
  });

  it('F2.3: all double_1..6 (1:10) and all 15 pair_1_2..5_6 (1:5) gates execute and match oracle', async () => {
    const doubles = {
      double_1: 2_000, double_2: 2_000, double_3: 2_000,
      double_4: 2_000, double_5: 2_000, double_6: 2_000,
    };
    const pairs = {};
    for (let a = 1; a <= 5; a++) {
      for (let b = a + 1; b <= 6; b++) {
        pairs[`pair_${a}_${b}`] = 2_000;
      }
    }
    assert.equal(Object.keys(pairs).length, 15);

    for (const bets of [doubles, pairs]) {
      const prevBal = (await client.get('/api/auth/me')).json.user.balance;
      const res = await client.post('/api/roll', { bets });
      assert.equal(res.status, 200);
      const expected = referenceEvaluateRoll(res.json.dice, bets);
      assert.equal(res.json.totalBet, expected.totalBet);
      assert.equal(res.json.totalWin, expected.totalWin);
      assert.equal(res.json.netProfit, expected.netProfit);
      assert.equal(res.json.newBalance, prevBal - expected.totalBet + expected.totalWin);
    }
  });

  it('F2.4: all total_4..17 gates execute and match Macau total payouts (including triple-win rule)', async () => {
    const totals = {};
    for (let t = 4; t <= 17; t++) totals[`total_${t}`] = 2_000;
    assert.equal(Object.keys(totals).length, 14);

    // Run 3 rolls to sample multiple totals and verify exact payout match
    let prevBal = (await client.get('/api/auth/me')).json.user.balance;
    for (let i = 0; i < 3; i++) {
      const res = await client.post('/api/roll', { bets: totals });
      assert.equal(res.status, 200);
      const expected = referenceEvaluateRoll(res.json.dice, totals);
      assert.equal(res.json.totalWin, expected.totalWin);
      assert.equal(res.json.netProfit, expected.netProfit);
      assert.equal(res.json.newBalance, prevBal - expected.totalBet + expected.totalWin);
      prevBal = res.json.newBalance;
    }
  });

  it('F2.5: equal tai + xiu hedge produces deterministic breakeven netProfit === 0 on non-triple roll', async () => {
    let hitBreakeven = false;
    let prevBal = (await client.get('/api/auth/me')).json.user.balance;
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await client.post('/api/roll', { bets: { tai: 10_000, xiu: 10_000 } });
      assert.equal(res.status, 200);
      if (!res.json.isTriple) {
        assert.equal(res.json.totalBet, 20_000);
        assert.equal(res.json.totalWin, 20_000);
        assert.equal(res.json.netProfit, 0);
        assert.equal(res.json.newBalance, prevBal);
        hitBreakeven = true;
        break;
      }
      prevBal = res.json.newBalance;
    }
    assert.equal(hitBreakeven, true, 'Expected at least 1 non-triple roll within 10 attempts');
  });

  it('F2.6: /api/verify-fairness classifies deterministic triples, min/max totals, and outcomes accurately', async () => {
    const vecs = findDeterministicFairVectors();
    const checks = [
      { key: 'triple_1', total: 3, isTriple: true, outcome: 'TRIPLE' },
      { key: 'triple_6', total: 18, isTriple: true, outcome: 'TRIPLE' },
      { key: 'total_4', total: 4, isTriple: false, outcome: 'XIU' },
      { key: 'total_17', total: 17, isTriple: false, outcome: 'TAI' },
      { key: 'double_2', total: 9, isTriple: false, outcome: 'XIU' },
      { key: 'distinct_123', total: 6, isTriple: false, outcome: 'XIU' },
    ];

    for (const c of checks) {
      const v = vecs[c.key];
      const res = await client.post('/api/verify-fairness', {
        serverSeed: v.serverSeed,
        clientSeed: v.clientSeed,
        nonce: v.nonce,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.dice, v.expectedDice);
      assert.equal(res.json.total, c.total);
      assert.equal(res.json.isTriple, c.isTriple);
      assert.equal(res.json.outcome, c.outcome);
    }
  });
});

describe('Tier 1 — F3: Provably Fair Web Crypto Parity & Serverless Live Clock', () => {
  let vectors;

  before(() => {
    vectors = findDeterministicFairVectors();
  });

  it('F3.1: browser Web Crypto HMAC-SHA256 matches server /api/verify-fairness for all 6 triples', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      for (let face = 1; face <= 6; face++) {
        const vec = vectors[`triple_${face}`];
        const browserDice = await webCryptoDeriveFairDice(vec.serverSeed, vec.clientSeed, vec.nonce);
        assert.deepEqual(browserDice, [face, face, face]);

        const res = await client.post('/api/verify-fairness', {
          serverSeed: vec.serverSeed,
          clientSeed: vec.clientSeed,
          nonce: vec.nonce,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.dice, browserDice);
        assert.equal(res.json.isTriple, true);
      }
    } finally {
      await server.close();
    }
  });

  it('F3.2: browser Web Crypto parity holds on rejection-sampling byte >= 252 and extreme totals', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      for (const vec of [vectors.total_4, vectors.total_17, vectors.double_2, vectors.rejectionSamplingCase]) {
        const browserDice = await webCryptoDeriveFairDice(vec.serverSeed, vec.clientSeed, vec.nonce);
        const res = await client.post('/api/verify-fairness', {
          serverSeed: vec.serverSeed,
          clientSeed: vec.clientSeed,
          nonce: vec.nonce,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.dice, browserDice);
        assert.deepEqual(res.json.dice, vec.expectedDice);
      }
    } finally {
      await server.close();
    }
  });

  it('F3.3: /api/roll -> /api/fairness/rotate -> /api/verify-fairness + Web Crypto round-trip', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f3_fair_roundtrip',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const meBefore = await client.get('/api/auth/me');
      const initialHash = meBefore.json.fairness.serverSeedHash;
      const initialClientSeed = meBefore.json.fairness.clientSeed;

      const rolledRecords = [];
      for (let i = 0; i < 3; i++) {
        const r = await client.post('/api/roll', { bets: { tai: 10_000 } });
        assert.equal(r.status, 200);
        assert.equal(r.json.fairness.serverSeedHash, initialHash);
        rolledRecords.push({
          dice: r.json.dice,
          clientSeed: r.json.fairness.clientSeed || initialClientSeed,
          nonce: r.json.fairness.nonce,
        });
      }
      // Verify monotonic +1 nonce progression
      assert.equal(rolledRecords[1].nonce, rolledRecords[0].nonce + 1);
      assert.equal(rolledRecords[2].nonce, rolledRecords[1].nonce + 1);

      const rot = await client.post('/api/fairness/rotate', { clientSeed: 'sovereign-rotated-777' });
      assert.equal(rot.status, 200);
      assert.equal(rot.json.previous.serverSeedHash, initialHash);
      assert.equal(typeof rot.json.previous.serverSeed, 'string');
      assert.equal(await webCryptoSha256Hex(rot.json.previous.serverSeed), initialHash);
      assert.notEqual(rot.json.current.serverSeedHash, initialHash);
      assert.equal(rot.json.current.clientSeed, 'sovereign-rotated-777');
      assert.equal(rot.json.current.nonce, 0);

      for (const rec of rolledRecords) {
        const browserDice = await webCryptoDeriveFairDice(
          rot.json.previous.serverSeed,
          rec.clientSeed,
          rec.nonce
        );
        assert.deepEqual(browserDice, rec.dice);

        const srvVerify = await client.post('/api/verify-fairness', {
          serverSeed: rot.json.previous.serverSeed,
          clientSeed: rec.clientSeed,
          nonce: rec.nonce,
        });
        assert.equal(srvVerify.status, 200);
        assert.deepEqual(srvVerify.json.dice, rec.dice);
      }
    } finally {
      await server.close();
    }
  });

  it('F3.4: clocked Live Room BETTING phase (elapsed=0 & 14999) hides dice, allows bet, rejects settle', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const expectedRoundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({ initialNowMs: roundStart });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f3_live_betting',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const s0 = await client.get('/api/live/state');
      assert.equal(s0.status, 200);
      assert.equal(s0.json.liveRoundId, expectedRoundId);
      assert.equal(s0.json.phase, 'BETTING');
      assert.equal(s0.json.betRemainingMs, 15000);
      assert.equal(s0.json.dice, undefined, 'BETTING phase must NEVER leak dice');
      assert.equal(s0.json.outcome, undefined, 'BETTING phase must NEVER leak outcome');
      assert.match(s0.json.roundSeedHash, /^[0-9a-f]{64}$/i);

      await server.setTime(roundStart + 14999);
      const sEnd = await client.get('/api/live/state');
      assert.equal(sEnd.status, 200);
      assert.equal(sEnd.json.phase, 'BETTING');
      assert.equal(sEnd.json.betRemainingMs, 1);
      assert.equal(sEnd.json.dice, undefined);

      const betRes = await client.post('/api/live/bet', {
        bets: { tai: 20_000, xiu: 20_000, triple_any: 10_000 },
        liveRoundId: expectedRoundId,
      });
      assert.equal(betRes.status, 200);
      assert.equal(betRes.json.newBalance, 10_000_000 - 50_000);

      const earlySettle = await client.post('/api/live/settle', { liveRoundId: expectedRoundId });
      assert.ok([400, 425].includes(earlySettle.status), `Premature settle must be 400/425, got ${earlySettle.status}`);
    } finally {
      await server.close();
    }
  });

  it('F3.5: clocked Live Room REVEAL phase (elapsed=15000) reveals dice, rejects bet, settles once', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const expectedRoundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({ initialNowMs: roundStart + 2000 });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f3_live_reveal',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const bets = { tai: 20_000, xiu: 20_000, triple_any: 10_000 };
      const betRes = await client.post('/api/live/bet', {
        bets,
        liveRoundId: expectedRoundId,
      });
      assert.equal(betRes.status, 200);

      await server.setTime(roundStart + 15000);
      const revState = await client.get('/api/live/state');
      assert.equal(revState.status, 200);
      assert.equal(revState.json.liveRoundId, expectedRoundId);
      assert.equal(revState.json.phase, 'REVEAL');
      assert.ok(Array.isArray(revState.json.dice) && revState.json.dice.length === 3);
      assert.equal(typeof revState.json.outcome, 'string');

      const lateBet = await client.post('/api/live/bet', {
        bets: { tai: 10_000 },
        liveRoundId: expectedRoundId,
      });
      assert.equal(lateBet.status, 400, 'Betting during REVEAL must be rejected with 400');

      const settle1 = await client.post('/api/live/settle', { liveRoundId: expectedRoundId });
      assert.equal(settle1.status, 200);
      const expectedEval = referenceEvaluateRoll(revState.json.dice, bets);
      assert.deepEqual(settle1.json.dice, revState.json.dice);
      assert.equal(settle1.json.totalWin, expectedEval.totalWin);
      assert.equal(settle1.json.newBalance, 10_000_000 - 50_000 + expectedEval.totalWin);

      // Second settle call must not double-credit winnings
      const settle2 = await client.post('/api/live/settle', { liveRoundId: expectedRoundId });
      assert.ok([200, 400].includes(settle2.status));
      const meAfter = await client.get('/api/auth/me');
      assert.equal(meAfter.json.user.balance, settle1.json.newBalance);
    } finally {
      await server.close();
    }
  });

  it('F3.6: clocked Live Room rollover (elapsed=20000) advances liveRoundId, resets phase, and rejects stale roundId', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const round1Id = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({ initialNowMs: roundStart + 19999 });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f3_live_rollover',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const before = await client.get('/api/live/state');
      assert.equal(before.json.liveRoundId, round1Id);
      assert.equal(before.json.phase, 'REVEAL');

      await server.setTime(roundStart + 20000);
      const after = await client.get('/api/live/state');
      assert.equal(after.status, 200);
      assert.equal(after.json.liveRoundId, round1Id + 1);
      assert.equal(after.json.phase, 'BETTING');
      assert.equal(after.json.dice, undefined);
      assert.notEqual(after.json.roundSeedHash, before.json.roundSeedHash);

      const staleBet = await client.post('/api/live/bet', {
        bets: { tai: 10_000 },
        liveRoundId: round1Id,
      });
      assert.equal(staleBet.status, 400);
    } finally {
      await server.close();
    }
  });
});

describe('Tier 1 — F7: Express Routes, Fairness Rotate, Security Headers & Multi-Instance Live Parity', () => {
  it('F7.1: GET /api/state works unauthenticated and enriches response when authenticated', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const anonClient = createClient(server.baseUrl);
      const anonState = await anonClient.get('/api/state');
      assert.equal(anonState.status, 200);
      assert.ok(anonState.json && typeof anonState.json === 'object');
      assert.ok(anonState.json.live || anonState.json.liveRoundId !== undefined);

      const reg = await anonClient.post('/api/auth/register', {
        username: 'f7_state_user',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      const authState = await anonClient.get('/api/state');
      assert.equal(authState.status, 200);
      assert.equal(authState.json.user.username, 'f7_state_user');
      assert.equal(authState.json.user.balance, 10_000_000);
    } finally {
      await server.close();
    }
  });

  it('F7.2: POST /api/roll returns full contract payload and appends personalHistory & globalHistory', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f7_roll_contract',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const res = await client.post('/api/roll', { bets: { tai: 10_000 } });
      assert.equal(res.status, 200);
      const b = res.json;
      assert.ok(b.roundId);
      assert.equal(b.mode, 'manual');
      assert.ok(Array.isArray(b.dice) && b.dice.length === 3);
      assert.equal(typeof b.total, 'number');
      assert.equal(typeof b.isTriple, 'boolean');
      assert.ok(['TAI', 'XIU', 'TRIPLE'].includes(b.outcome));
      assert.equal(b.totalBet, 10_000);
      assert.equal(typeof b.totalWin, 'number');
      assert.equal(b.netProfit, b.totalWin - b.totalBet);
      assert.equal(typeof b.newBalance, 'number');
      assert.ok(b.winningDetails && typeof b.winningDetails === 'object');
      assert.ok(b.fairness && typeof b.fairness.serverSeedHash === 'string');

      const state = await client.get('/api/state');
      assert.equal(state.status, 200);
      assert.ok(Array.isArray(state.json.personalHistory) && state.json.personalHistory.length >= 1);
      assert.ok(Array.isArray(state.json.globalHistory) && state.json.globalHistory.length >= 1);
    } finally {
      await server.close();
    }
  });

  it('F7.3: POST /api/fairness/rotate works with explicit clientSeed and default fallback clientSeed', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'f7_rotate_opts',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);

      const r1 = await client.post('/api/fairness/rotate', { clientSeed: 'custom-alpha' });
      assert.equal(r1.status, 200);
      assert.equal(r1.json.current.clientSeed, 'custom-alpha');
      assert.equal(r1.json.current.nonce, 0);

      const r2 = await client.post('/api/fairness/rotate', {});
      assert.equal(r2.status, 200);
      assert.equal(r2.json.previous.serverSeedHash, r1.json.current.serverSeedHash);
      assert.equal(typeof r2.json.current.clientSeed, 'string');
      assert.ok(r2.json.current.clientSeed.length > 0);
      assert.equal(r2.json.current.nonce, 0);
    } finally {
      await server.close();
    }
  });

  it('F7.4: un-mocked real-time GET /api/live/state obeys wall-clock 20s round formula', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const beforeNow = Date.now();
      const res = await createClient(server.baseUrl).get('/api/live/state');
      const afterNow = Date.now();
      assert.equal(res.status, 200);

      const s = res.json;
      assert.ok(s.serverTime >= beforeNow - 2000 && s.serverTime <= afterNow + 2000);
      assert.equal(s.liveRoundId, Math.floor(s.serverTime / LIVE_ROUND_MS));
      const expectedPhase = (s.serverTime % LIVE_ROUND_MS) < 15000 ? 'BETTING' : 'REVEAL';
      assert.equal(s.phase, expectedPhase);
      assert.match(s.roundSeedHash, /^[0-9a-f]{64}$/i);
    } finally {
      await server.close();
    }
  });

  it('F7.5: two independent Vercel-style server processes sharing LIVE_MASTER_SECRET produce identical live dice', async () => {
    const sharedSecret = crypto.randomBytes(32).toString('hex');
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const revealNow = roundStart + 16000;

    let s1 = null;
    let s2 = null;
    try {
      s1 = await startClockedServer({
        initialNowMs: revealNow,
        vercel: true,
        env: { LIVE_MASTER_SECRET: sharedSecret, JWT_SECRET: crypto.randomBytes(32).toString('hex') },
      });
      s2 = await startClockedServer({
        initialNowMs: revealNow,
        vercel: true,
        env: { LIVE_MASTER_SECRET: sharedSecret, JWT_SECRET: crypto.randomBytes(32).toString('hex') },
      });

      const r1 = await createClient(s1.baseUrl).get('/api/live/state');
      const r2 = await createClient(s2.baseUrl).get('/api/live/state');
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r1.json.liveRoundId, r2.json.liveRoundId);
      assert.equal(r1.json.phase, 'REVEAL');
      assert.equal(r1.json.roundSeedHash, r2.json.roundSeedHash);
      assert.deepEqual(r1.json.dice, r2.json.dice);
      assert.equal(r1.json.outcome, r2.json.outcome);
    } finally {
      await Promise.allSettled([s1?.close(), s2?.close()]);
    }
  });

  it('F7.6: security headers are set and X-Powered-By is suppressed on API and HTML responses', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      for (const route of ['/api/state', '/api/live/state', '/']) {
        const res = await client.get(route);
        assert.equal(res.status, 200, `${route} returned ${res.status}`);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        assert.equal(res.headers.get('x-powered-by'), null);
      }
    } finally {
      await server.close();
    }
  });
});
