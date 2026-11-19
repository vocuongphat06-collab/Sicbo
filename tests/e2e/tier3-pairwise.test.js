'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  LIVE_ROUND_MS,
  LIVE_BET_MS,
  referenceEvaluateRoll,
  webCryptoSha256Hex,
  webCryptoDeriveFairDice,
  startTestServer,
  startClockedServer,
  createClient,
} = require('./helpers');

function extractEscapeHtml(appJs) {
  const fnDeclIdx = appJs.search(/function\s+escapeHtml\s*\(/);
  const varDeclIdx = appJs.search(/(?:const|let|var)\s+escapeHtml\s*=/);
  const startIdx = fnDeclIdx !== -1 ? fnDeclIdx : varDeclIdx;
  if (startIdx === -1) return null;
  const arrowIdx = appJs.indexOf('=>', startIdx);
  const braceStart = appJs.indexOf('{', startIdx);
  if (fnDeclIdx === -1 && arrowIdx !== -1 && (braceStart === -1 || arrowIdx < braceStart)) {
    const afterArrow = appJs.slice(arrowIdx + 2).match(/^\s*(.)/);
    if (afterArrow && afterArrow[1] !== '{') {
      const semiIdx = appJs.indexOf(';', arrowIdx + 2);
      const nlIdx = appJs.indexOf('\n', arrowIdx + 2);
      const endIdx = semiIdx !== -1 ? semiIdx + 1 : (nlIdx !== -1 ? nlIdx : appJs.length);
      return appJs.slice(startIdx, endIdx);
    }
  }
  let depth = 1;
  let i = braceStart + 1;
  while (i < appJs.length && depth > 0) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') depth--;
    i++;
  }
  const snippet = appJs.slice(startIdx, i);
  return fnDeclIdx !== -1 ? snippet : `${snippet};`;
}

describe('Tier 3A — Cross-Feature Pairwise: Guest Upgrade, Admin Leaderboard & Parallel Race', () => {
  let server;
  let adminClient;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't3_pairwise_admin_a' },
    });
    adminClient = createClient(server.baseUrl);
    const reg = await adminClient.post('/api/auth/register', {
      username: 't3_pairwise_admin_a',
      password: 'AdminPassword!123',
    });
    assert.equal(reg.status, 201);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T3.1: POST /api/auth/guest returns 403; Register -> Welcome Bonus -> Manual Rolls -> Logout -> Re-Login preserves state', async () => {
    const anon = createClient(server.baseUrl);
    const gReg = await anon.post('/api/auth/guest', {});
    assert.equal(gReg.status, 403);
    assert.equal(gReg.json.code, 'GUEST_DISABLED');

    const reg = await anon.post('/api/auth/register', { username: 't3_member_vip', password: 'UpgradedPass!123', displayName: 'T3 VIP' });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.balance, 0);
    await anon.post('/api/wallet/welcome-bonus', {});

    const r1 = await anon.post('/api/roll', { bets: { tai: 20_000 } });
    const r2 = await anon.post('/api/roll', { bets: { xiu: 15_000 } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const meBefore = await anon.get('/api/auth/me');
    assert.equal(meBefore.status, 200);
    const balBefore = meBefore.json.user.balance;
    const ledgerLenBefore = meBefore.json.ledger.length;
    const histRoundIds = meBefore.json.personalHistory.map((h) => h.roundId);
    assert.equal(histRoundIds.length, 2);

    const logoutRes = await anon.post('/api/auth/logout', {});
    assert.equal(logoutRes.status, 200);
    const reLogin = await anon.post('/api/auth/login', {
      username: 't3_member_vip',
      password: 'UpgradedPass!123',
    });
    assert.equal(reLogin.status, 200);

    const meAfter = await anon.get('/api/auth/me');
    assert.equal(meAfter.status, 200);
    assert.equal(meAfter.json.user.balance, balBefore);
    assert.equal(meAfter.json.ledger.length, ledgerLenBefore);
    assert.deepEqual(meAfter.json.personalHistory.map((h) => h.roundId), histRoundIds);
  });

  it('T3.2: Admin Adjust -> wallet_ledger -> Leaderboard ranking separates balance from netProfit', async () => {
    const u1 = createClient(server.baseUrl);
    const u2 = createClient(server.baseUrl);
    const reg1 = await u1.post('/api/auth/register', { username: 't3_lb_u1', password: 'Password!123' });
    const reg2 = await u2.post('/api/auth/register', { username: 't3_lb_u2', password: 'Password!123' });
    assert.equal(reg1.status, 201);
    assert.equal(reg2.status, 201);
    const u2Id = reg2.json.user.id;

    const adj = await adminClient.post(`/api/admin/users/${u2Id}/adjust-balance`, {
      amount: 25_000_000,
      reason: 'Tournament grand prize',
    });
    assert.equal(adj.status, 200);
    assert.equal(adj.json.ledgerEntry.type, 'admin_adjust');
    assert.equal(adj.json.ledgerEntry.balanceBefore, 0);
    assert.equal(adj.json.ledgerEntry.balanceAfter, 25_000_000);

    const lb = await createClient(server.baseUrl).get('/api/leaderboard');
    assert.equal(lb.status, 200);
    assert.equal(lb.json.byBalance[0].username, 't3_lb_u2');
    assert.equal(lb.json.byBalance[0].balance, 25_000_000);

    const u2ProfitRow = lb.json.byNetProfit.find((r) => r.username === 't3_lb_u2');
    assert.ok(u2ProfitRow);
    assert.ok((u2ProfitRow.netProfit ?? 0) < 25_000_000, 'admin_adjust must not inflate gambling netProfit');
  });

  it('T3.3: 10 parallel /api/roll requests exceeding balance (T3-Race) enforce atomic CAS & ledger integrity', async () => {
    const raceServer = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't3_race_admin' },
    });
    try {
      const rAdmin = createClient(raceServer.baseUrl);
      const aReg = await rAdmin.post('/api/auth/register', { username: 't3_race_admin', password: 'AdminPassword!123' });
      assert.equal(aReg.status, 201);

      const racer = createClient(raceServer.baseUrl);
      const rReg = await racer.post('/api/auth/register', { username: 't3_racer', password: 'Password!123' });
      assert.equal(rReg.status, 201);
      const racerId = rReg.json.user.id;

      // Set exact balance = 100,000
      const adj = await rAdmin.post(`/api/admin/users/${racerId}/adjust-balance`, {
        amount: 100_000,
        reason: 'Set exact 100k race bankroll',
      });
      assert.equal(adj.status, 200);
      assert.equal(adj.json.user.balance, 100_000);

      // Fire 10 simultaneous 30,000-chip bets (300,000 attempted > 100,000 balance)
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          racer.post(
            '/api/roll',
            { bets: { triple_6: 30_000 } },
            { headers: { 'Idempotency-Key': `race-key-${idx}` } }
          )
        )
      );

      let acceptedCount = 0;
      let rejectedCount = 0;
      let sumAcceptedBet = 0;
      let sumAcceptedWin = 0;

      for (const res of responses) {
        assert.notEqual(res.status, 500, `Race request caused 500: ${res.text}`);
        assert.notEqual(res.status, 429, 'Race server must not rate-limit 10 requests');
        assert.ok([200, 400].includes(res.status), `Unexpected status ${res.status}: ${res.text}`);
        if (res.status === 200) {
          acceptedCount++;
          sumAcceptedBet += res.json.totalBet;
          sumAcceptedWin += res.json.totalWin;
        } else {
          rejectedCount++;
        }
      }

      assert.ok(acceptedCount >= 3, `Expected at least 3 accepted bets from 100k bankroll, got ${acceptedCount}`);
      if (sumAcceptedWin === 0) {
        assert.ok(rejectedCount >= 1, 'Expected insufficient balance rejections when total > 100k and no roll won');
      }

      const meAfter = await racer.get('/api/auth/me');
      assert.equal(meAfter.status, 200);
      const finalBalance = meAfter.json.user.balance;
      assert.ok(finalBalance >= 0, `Balance went negative: ${finalBalance}`);
      assert.equal(finalBalance, 100_000 - sumAcceptedBet + sumAcceptedWin);

      // Reconcile entire wallet_ledger (including initial admin_adjust)
      let ledgerSum = 0;
      for (const entry of meAfter.json.ledger) {
        ledgerSum += entry.balanceAfter - entry.balanceBefore;
      }
      assert.equal(ledgerSum, finalBalance, 'wallet_ledger must reconcile 100% with finalBalance after parallel race');
    } finally {
      await raceServer.close();
    }
  });
});

describe('Tier 3B — Cross-Feature Pairwise: Fairness, Live Clock & Lock/Aid Lifecycle', () => {
  let server;
  let adminClient;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't3_pairwise_admin_b' },
    });
    adminClient = createClient(server.baseUrl);
    const reg = await adminClient.post('/api/auth/register', {
      username: 't3_pairwise_admin_b',
      password: 'AdminPassword!123',
    });
    assert.equal(reg.status, 201);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T3.4: Roll x2 -> Fairness Rotate -> WebCrypto SHA-256 & HMAC-SHA256 verification', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', { username: 't3_fair_player', password: 'Password!123' });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    const meInit = await client.get('/api/auth/me');
    assert.equal(meInit.status, 200);
    const initialHash = meInit.json.fairness.serverSeedHash;
    const r1 = await client.post('/api/roll', { bets: { tai: 5_000 } });
    const r2 = await client.post('/api/roll', { bets: { xiu: 5_000 } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const rot = await client.post('/api/fairness/rotate', { clientSeed: 'pairwise-seed-99' });
    assert.equal(rot.status, 200);
    assert.equal(await webCryptoSha256Hex(rot.json.previous.serverSeed), initialHash);
    assert.equal(rot.json.current.clientSeed, 'pairwise-seed-99');
    assert.equal(rot.json.current.nonce, 0);

    for (const r of [r1.json, r2.json]) {
      const wcDice = await webCryptoDeriveFairDice(
        rot.json.previous.serverSeed,
        r.fairness.clientSeed,
        r.fairness.nonce
      );
      assert.deepEqual(wcDice, r.dice);
      const srv = await client.post('/api/verify-fairness', {
        serverSeed: rot.json.previous.serverSeed,
        clientSeed: r.fairness.clientSeed,
        nonce: r.fairness.nonce,
      });
      assert.equal(srv.status, 200);
      assert.deepEqual(srv.json.dice, r.dice);
    }
  });

  it('T3.5: Clocked Live Bet -> Premature Settle Reject -> Advance Reveal -> Settle -> Ledger', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const roundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const clocked = await startClockedServer({ initialNowMs: roundStart + 1000 });
    try {
      const client = createClient(clocked.baseUrl);
      const reg = await client.post('/api/auth/register', { username: 't3_live_player', password: 'Password!123' });
      assert.equal(reg.status, 201);
      await client.post('/api/wallet/welcome-bonus', {});

      const bets = { tai: 20_000, xiu: 20_000, triple_any: 10_000 };
      const betRes = await client.post('/api/live/bet', { bets, liveRoundId: roundId });
      assert.equal(betRes.status, 200);
      assert.equal(betRes.json.newBalance, 2_000_000 - 50_000);

      const early = await client.post('/api/live/settle', { liveRoundId: roundId });
      assert.ok([400, 425].includes(early.status));

      await clocked.setTime(roundStart + LIVE_BET_MS + 500);
      const settle = await client.post('/api/live/settle', { liveRoundId: roundId });
      assert.equal(settle.status, 200);
      const expected = referenceEvaluateRoll(settle.json.dice, bets);
      assert.equal(settle.json.totalWin, expected.totalWin);
      assert.equal(settle.json.newBalance, 2_000_000 - 50_000 + expected.totalWin);

      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.ok(me.json.ledger.some((e) => e.type === 'bet'));
      assert.ok(me.json.ledger.some((e) => e.type === 'win'));
      assert.equal(me.json.user.balance, settle.json.newBalance);
    } finally {
      await clocked.close();
    }
  });

  it('T3.6: Admin Lock -> Immediate Session Revocation -> Unlock -> Resume with balance intact', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', { username: 't3_lock_resume', password: 'Password!123' });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});
    const uid = reg.json.user.id;

    const r1 = await client.post('/api/roll', { bets: { tai: 10_000 } });
    assert.equal(r1.status, 200);
    const savedBal = r1.json.newBalance;

    const lockRes = await adminClient.post(`/api/admin/users/${uid}/toggle-lock`, { locked: true });
    assert.equal(lockRes.status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 401);
    assert.equal((await client.post('/api/roll', { bets: { tai: 1000 } })).status, 401);

    const unlockRes = await adminClient.post(`/api/admin/users/${uid}/toggle-lock`, { locked: false });
    assert.equal(unlockRes.status, 200);
    const login = await client.post('/api/auth/login', { username: 't3_lock_resume', password: 'Password!123' });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.balance, savedBal);
  });

  it('T3.7: Register (0 ₫) -> Claim 1-Time Welcome Bonus (+2M) -> Roll -> Retired Aid 410 -> Ledger & Leaderboard', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', { username: 't3_aid_roller', password: 'Password!123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.balance, 0);

    const wb = await client.post('/api/wallet/welcome-bonus', {});
    assert.equal(wb.status, 200);
    assert.equal(wb.json.balance, 2_000_000);

    const retiredAid = await client.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(retiredAid.status, 410);

    const roll = await client.post('/api/roll', { bets: { tai: 5_000 } });
    assert.equal(roll.status, 200);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.ok(me.json.ledger.some((e) => e.type === 'welcome_bonus'));
    assert.ok(me.json.ledger.some((e) => e.type === 'bet'));

    const lb = await createClient(server.baseUrl).get('/api/leaderboard');
    assert.equal(lb.status, 200);
    assert.ok(lb.json.byBalance.some((r) => r.username === 't3_aid_roller'));
  });
});

describe('Tier 3C — Cross-Feature Pairwise: Idempotency/Revocation, Breakeven, Live Concurrency & XSS', () => {
  let server;

  before(async () => {
    server = await startTestServer({ stripSecrets: true });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T3.8: Roll with Idempotency-Key -> change-password -> Old Token 401 vs New Token Idempotent Replay', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', { username: 't3_idem_pw', password: 'OldPassword!123' });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    const r1 = await client.post(
      '/api/roll',
      { bets: { tai: 20_000 } },
      { headers: { 'Idempotency-Key': 'pw-idem-1' } }
    );
    assert.equal(r1.status, 200);
    const oldCookie = client.snapshotCookie();

    const ch = await client.post('/api/auth/change-password', {
      currentPassword: 'OldPassword!123',
      newPassword: 'NewPassword!456',
    });
    assert.equal(ch.status, 200);

    // Old token must fail with 401 even when carrying valid Idempotency-Key
    const stale = createClient(server.baseUrl);
    stale.setRawCookieHeader(oldCookie);
    const staleReplay = await stale.post(
      '/api/roll',
      { bets: { tai: 20_000 } },
      { headers: { 'Idempotency-Key': 'pw-idem-1' } }
    );
    assert.equal(staleReplay.status, 401);

    // Re-login and replay same Idempotency-Key -> cached outcome, zero double charge
    const loginRes = await stale.post('/api/auth/login', { username: 't3_idem_pw', password: 'NewPassword!456' });
    assert.equal(loginRes.status, 200);
    const freshReplay = await stale.post(
      '/api/roll',
      { bets: { tai: 20_000 } },
      { headers: { 'Idempotency-Key': 'pw-idem-1' } }
    );
    assert.equal(freshReplay.status, 200);
    assert.equal(freshReplay.json.roundId, r1.json.roundId);
    assert.equal(freshReplay.json.newBalance, r1.json.newBalance);
  });

  it('T3.9: Breakeven Hedge Roll (tai + xiu) -> Ledger & personalHistory netProfit === 0', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', { username: 't3_breakeven', password: 'Password!123' });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    let before = (await client.get('/api/auth/me')).json.user.balance;
    let found = false;
    for (let i = 0; i < 10; i++) {
      const r = await client.post('/api/roll', { bets: { tai: 10_000, xiu: 10_000 } });
      assert.equal(r.status, 200);
      if (!r.json.isTriple) {
        assert.equal(r.json.netProfit, 0);
        assert.equal(r.json.newBalance, before);
        const me = await client.get('/api/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.json.personalHistory[0].netProfit, 0);
        found = true;
        break;
      }
      before = r.json.newBalance;
    }
    assert.equal(found, true);
  });

  it('T3.10: Concurrent Multi-User Live Round Settlement produces identical dice & isolated payouts', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const roundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const clocked = await startClockedServer({ initialNowMs: roundStart + 1000 });
    try {
      const p1 = createClient(clocked.baseUrl);
      const p2 = createClient(clocked.baseUrl);
      const [reg1, reg2] = await Promise.all([
        p1.post('/api/auth/register', { username: 't3_live_p1', password: 'Password!123' }),
        p2.post('/api/auth/register', { username: 't3_live_p2', password: 'Password!123' }),
      ]);
      assert.equal(reg1.status, 201);
      assert.equal(reg2.status, 201);
      await p1.post('/api/wallet/welcome-bonus', {});
      await p2.post('/api/wallet/welcome-bonus', {});

      const b1 = { tai: 50_000 };
      const b2 = { xiu: 30_000 };
      const [bet1, bet2] = await Promise.all([
        p1.post('/api/live/bet', { bets: b1, liveRoundId: roundId }),
        p2.post('/api/live/bet', { bets: b2, liveRoundId: roundId }),
      ]);
      assert.equal(bet1.status, 200);
      assert.equal(bet2.status, 200);

      await clocked.setTime(roundStart + LIVE_BET_MS + 1000);
      const [s1, s2] = await Promise.all([
        p1.post('/api/live/settle', { liveRoundId: roundId }),
        p2.post('/api/live/settle', { liveRoundId: roundId }),
      ]);
      assert.equal(s1.status, 200);
      assert.equal(s2.status, 200);
      assert.deepEqual(s1.json.dice, s2.json.dice);
      assert.equal(s1.json.outcome, s2.json.outcome);

      const e1 = referenceEvaluateRoll(s1.json.dice, b1);
      const e2 = referenceEvaluateRoll(s2.json.dice, b2);
      assert.equal(s1.json.newBalance, 2_000_000 - 50_000 + e1.totalWin);
      assert.equal(s2.json.newBalance, 2_000_000 - 30_000 + e2.totalWin);
    } finally {
      await clocked.close();
    }
  });

  it('T3.11: XSS displayName -> Leaderboard API -> app.js escapeHtml neutralizes HTML injection', async () => {
    const xssPayload = '<img src=x onerror=alert(1)>';
    const xssUser = createClient(server.baseUrl);
    const reg = await xssUser.post('/api/auth/register', {
      username: 't3_xss_safe',
      password: 'Password!123',
      displayName: xssPayload,
    });
    assert.ok([201, 400].includes(reg.status));

    const appJs = (await xssUser.get('/app.js')).text;
    const escapeFnCode = extractEscapeHtml(appJs);
    assert.ok(escapeFnCode);

    const lb = await xssUser.get('/api/leaderboard');
    assert.equal(lb.status, 200);
    const row = lb.json.byBalance.find((u) => u.username === 't3_xss_safe');
    const targetName = row ? row.displayName : xssPayload;

    const sandbox = { escaped: '' };
    vm.runInNewContext(`${escapeFnCode}\nescaped = escapeHtml(${JSON.stringify(targetName)});`, sandbox);
    assert.equal(/<img|<script/i.test(sandbox.escaped), false, 'Rendered displayName must not contain raw HTML tags');
  });
});
