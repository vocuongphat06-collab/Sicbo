'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PROJECT_ROOT,
  LIVE_ROUND_MS,
  referenceEvaluateRoll,
  webCryptoSha256Hex,
  webCryptoDeriveFairDice,
  startTestServer,
  startClockedServer,
  createClient,
  waitForLivePhase,
  extractAncestorChainZIndex,
  getMatrixBackdropOpenState,
  parseCssRules,
} = require('./helpers');

describe('Tier 4 — Real-World End-to-End Workloads & VERCEL=1 Serverless', () => {
  it('T4.1: Complete VIP Player Session (register -> daily-bonus -> Macau rolls -> rotate/WebCrypto -> drain/aid -> change-pw/recover -> ledger reconcile)', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const vip = createClient(server.baseUrl);
      const reg = await vip.post('/api/auth/register', {
        username: 't4_vip_whale',
        password: 'VipPassword!123',
        displayName: 'Sovereign Whale',
      });
      assert.equal(reg.status, 201);
      const recoveryCode = reg.json.recoveryCode;
      assert.equal(reg.json.user.balance, 10_000_000);

      // 1. Claim 24h daily bonus (+2M -> 12M)
      const bonus = await vip.post('/api/wallet/daily-bonus', {});
      assert.equal(bonus.status, 200);
      assert.equal(bonus.json.balance, 12_000_000);

      // 2. Play diverse Macau bets and record fairness nonces
      const initialHash = (await vip.get('/api/auth/me')).json.fairness.serverSeedHash;
      const rolls = [];
      for (const bets of [
        { tai: 50_000, double_3: 10_000, pair_2_5: 10_000 },
        { xiu: 40_000, total_10: 10_000, single_6: 10_000, triple_any: 5_000 },
      ]) {
        const r = await vip.post('/api/roll', { bets });
        assert.equal(r.status, 200);
        const evalRef = referenceEvaluateRoll(r.json.dice, bets);
        assert.equal(r.json.totalWin, evalRef.totalWin);
        rolls.push(r.json);
      }

      // 3. Rotate seed & verify all prior rolls via Web Crypto + /api/verify-fairness
      const rot = await vip.post('/api/fairness/rotate', { clientSeed: 'vip-session-seed-888' });
      assert.equal(rot.status, 200);
      assert.equal(await webCryptoSha256Hex(rot.json.previous.serverSeed), initialHash);
      for (const r of rolls) {
        const wcDice = await webCryptoDeriveFairDice(
          rot.json.previous.serverSeed,
          r.fairness.clientSeed,
          r.fairness.nonce
        );
        assert.deepEqual(wcDice, r.dice);
      }

      // 4. Drain below 10,000 naturally (stake balance - 5,000 on triple_6) and claim bankruptcy aid
      let curBal = rolls[rolls.length - 1].newBalance;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (curBal < 10_000) break;
        const drainStake = curBal - 5_000;
        const drainRoll = await vip.post('/api/roll', { bets: { triple_6: drainStake } });
        assert.equal(drainRoll.status, 200);
        curBal = drainRoll.json.newBalance;
      }
      const preAidBal = curBal;
      assert.ok(preAidBal < 10_000, 'Player balance should be drained below 10,000');

      const aid = await vip.post('/api/wallet/bankruptcy-aid', {});
      assert.equal(aid.status, 200);
      assert.equal(aid.json.balance, preAidBal + 500_000);

      // 5. Change password -> old token returns 401 -> recover using Recovery Code -> login
      const oldCookie = vip.snapshotCookie();
      const ch = await vip.post('/api/auth/change-password', {
        currentPassword: 'VipPassword!123',
        newPassword: 'VipPassword!456',
      });
      assert.equal(ch.status, 200);

      const stale = createClient(server.baseUrl);
      stale.setRawCookieHeader(oldCookie);
      assert.equal((await stale.get('/api/auth/me')).status, 401);

      const rec = await createClient(server.baseUrl).post('/api/auth/recover', {
        username: 't4_vip_whale',
        recoveryCode,
        newPassword: 'VipRecovered!789',
      });
      assert.equal(rec.status, 200);

      const relogin = createClient(server.baseUrl);
      const loginRes = await relogin.post('/api/auth/login', {
        username: 't4_vip_whale',
        password: 'VipRecovered!789',
      });
      assert.equal(loginRes.status, 200);

      // 6. Full wallet_ledger reconciliation
      const finalMe = await relogin.get('/api/auth/me');
      let reconciled = 10_000_000;
      for (const entry of finalMe.json.ledger) {
        reconciled += entry.balanceAfter - entry.balanceBefore;
      }
      assert.equal(reconciled, finalMe.json.user.balance);
    } finally {
      await server.close();
    }
  });

  it('T4.2: Complete Admin Moderation & Audit Session (search -> adjust -> ledger/leaderboard -> reset-pw -> lock)', async () => {
    const server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 'salon_owner' },
    });
    try {
      const admin = createClient(server.baseUrl);
      const p1 = createClient(server.baseUrl);
      const p2 = createClient(server.baseUrl);

      const aReg = await admin.post('/api/auth/register', { username: 'salon_owner', password: 'OwnerPass!123' });
      const r1 = await p1.post('/api/auth/register', { username: 'audit_p1', password: 'PlayerPass!123' });
      const r2 = await p2.post('/api/auth/register', { username: 'audit_p2', password: 'PlayerPass!123' });
      assert.equal(aReg.status, 201);
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      assert.equal(aReg.json.user.role, 'admin');
      const p1Id = r1.json.user.id;
      const p2Id = r2.json.user.id;

      await p1.post('/api/roll', { bets: { tai: 50_000 } });
      await p2.post('/api/roll', { bets: { xiu: 50_000 } });

      const search = await admin.get('/api/admin/users?q=audit_p');
      assert.equal(search.status, 200);
      assert.equal(search.json.users.length, 2);

      const boost = await admin.post(`/api/admin/users/${p1Id}/adjust-balance`, {
        amount: 5_000_000,
        reason: 'VIP tier promotion',
      });
      assert.equal(boost.status, 200);

      const deduct = await admin.post(`/api/admin/users/${p2Id}/adjust-balance`, {
        amount: -1_000_000,
        reason: 'Chargeback clawback',
      });
      assert.equal(deduct.status, 200);

      const lb = await admin.get('/api/leaderboard');
      assert.equal(lb.status, 200);
      assert.equal(lb.json.byBalance[0].username, 'audit_p1');

      // Reset p1 password -> old p1 cookie 401 -> login with tempPassword 200
      const p1OldCookie = p1.snapshotCookie();
      const rst = await admin.post(`/api/admin/users/${p1Id}/reset-password`, {});
      assert.equal(rst.status, 200);
      const p1Stale = createClient(server.baseUrl);
      p1Stale.setRawCookieHeader(p1OldCookie);
      assert.equal((await p1Stale.get('/api/auth/me')).status, 401);

      const p1FreshLogin = await p1Stale.post('/api/auth/login', {
        username: 'audit_p1',
        password: rst.json.tempPassword,
      });
      assert.equal(p1FreshLogin.status, 200);

      // Lock p2 -> active cookie 401 -> login 403
      const p2OldCookie = p2.snapshotCookie();
      await admin.post(`/api/admin/users/${p2Id}/toggle-lock`, { locked: true });
      const p2Stale = createClient(server.baseUrl);
      p2Stale.setRawCookieHeader(p2OldCookie);
      assert.equal((await p2Stale.get('/api/auth/me')).status, 401);
      assert.equal(
        (await createClient(server.baseUrl).post('/api/auth/login', { username: 'audit_p2', password: 'PlayerPass!123' })).status,
        403
      );
    } finally {
      await server.close();
    }
  });

  it('T4.3: Full VERCEL=1 Cold-Start Serverless Session without Cloud DB or Secret Env Vars', { timeout: 45000 }, async () => {
    const projectDataDir = path.join(DEFAULT_PROJECT_ROOT, 'data');
    const beforeData = fs.existsSync(projectDataDir)
      ? fs.readdirSync(projectDataDir).map((f) => `${f}:${fs.statSync(path.join(projectDataDir, f)).mtimeMs}`)
      : [];

    const vServer = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });
    try {
      const client = createClient(vServer.baseUrl);

      assert.equal((await client.get('/')).status, 200);
      assert.equal((await client.get('/api/state')).status, 200);

      const reg = await client.post('/api/auth/register', {
        username: 'vercel_cold_vip',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      const cookieMeta = client.getCookieMeta('sicbo_token');
      assert.equal(cookieMeta.httpOnly, true);
      assert.equal(cookieMeta.sameSite?.toLowerCase(), 'lax');
      assert.equal(cookieMeta.secure, true);

      // Verify CookieJar sends Secure cookie over local loopback HTTP
      assert.equal((await client.get('/api/auth/me')).status, 200);

      const roll = await client.post('/api/roll', { bets: { tai: 25_000, double_4: 5_000 } });
      assert.equal(roll.status, 200);

      const liveBetPhase = await waitForLivePhase(client, 'BETTING', 2500);
      const liveBet = await client.post('/api/live/bet', {
        bets: { xiu: 10_000 },
        liveRoundId: liveBetPhase.liveRoundId,
      });
      assert.equal(liveBet.status, 200);

      assert.equal((await client.get('/api/leaderboard')).status, 200);
      assert.equal(fs.existsSync(path.join(vServer.tmpDir, 'sicbo-data')), true);

      const logs = `${vServer.getLogs().stdout}\n${vServer.getLogs().stderr}`;
      assert.match(logs, /warn|ephemeral|degraded|JWT_SECRET|LIVE_MASTER_SECRET/i);

      const afterData = fs.existsSync(projectDataDir)
        ? fs.readdirSync(projectDataDir).map((f) => `${f}:${fs.statSync(path.join(projectDataDir, f)).mtimeMs}`)
        : [];
      assert.deepEqual(afterData, beforeData);
    } finally {
      await vServer.close();
    }
  });

  it('T4.4: Multi-Player Concurrent Salon Session (3 players, parallel rolls + live round + leaderboard)', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const roundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({ initialNowMs: roundStart + 1000 });
    try {
      const players = [
        createClient(server.baseUrl),
        createClient(server.baseUrl),
        createClient(server.baseUrl),
      ];
      const regs = await Promise.all(
        players.map((c, i) =>
          c.post('/api/auth/register', { username: `salon_p_${i}`, password: 'Password!123' })
        )
      );
      for (const r of regs) assert.equal(r.status, 201);

      // Each player fires 5 concurrent manual rolls (15 total)
      const manualResults = await Promise.all(
        players.flatMap((c, pIdx) =>
          Array.from({ length: 5 }, (_, rIdx) =>
            c.post(
              '/api/roll',
              { bets: { tai: 10_000, single_1: 5_000 } },
              { headers: { 'Idempotency-Key': `mp-${pIdx}-${rIdx}` } }
            )
          )
        )
      );
      for (const res of manualResults) {
        assert.equal(res.status, 200);
      }

      // All 3 bet on the same Live Round, then settle in REVEAL
      await Promise.all(
        players.map((c, idx) =>
          c.post('/api/live/bet', { bets: { [idx === 0 ? 'tai' : 'xiu']: 20_000 }, liveRoundId: roundId })
        )
      );
      await server.setTime(roundStart + 15500);
      const settlements = await Promise.all(
        players.map((c) => c.post('/api/live/settle', { liveRoundId: roundId }))
      );
      for (const s of settlements) {
        assert.equal(s.status, 200);
        assert.deepEqual(s.json.dice, settlements[0].json.dice);
      }

      for (const c of players) {
        const me = await c.get('/api/auth/me');
        assert.ok(me.json.user.balance >= 0);
        let sum = 10_000_000;
        for (const e of me.json.ledger) sum += e.balanceAfter - e.balanceBefore;
        assert.equal(sum, me.json.user.balance);
      }

      const lb = await players[0].get('/api/leaderboard');
      assert.equal(lb.status, 200);
      assert.ok(lb.json.byBalance.length >= 3);
    } finally {
      await server.close();
    }
  });

  it('T4.5: Frontend-Backend HTTP Asset Parity (API_BASE, fullMatrixModal z-index, Web Crypto roll verify)', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const [rHtml, rCss, rApp] = await Promise.all([
        client.get('/'),
        client.get('/style.css'),
        client.get('/app.js'),
      ]);
      assert.equal(rHtml.status, 200);
      assert.equal(rCss.status, 200);
      assert.equal(rApp.status, 200);
      assert.match(rApp.text, /const\s+API_BASE\s*=\s*['"]['"]\s*;/);

      const cssRules = parseCssRules(rCss.text);
      const matrixChain = extractAncestorChainZIndex(rHtml.text, cssRules, 'fullMatrixModal');
      assert.ok(matrixChain && matrixChain.length >= 1);
      const rollChain = extractAncestorChainZIndex(rHtml.text, cssRules, 'btnRoll');
      const { matrixZ, matrixOpenPointerEvents } = getMatrixBackdropOpenState(cssRules);
      const rollZ = rollChain.find((n) => n.zIndex !== null)?.zIndex ?? 0;
      assert.ok(rollZ > matrixZ || matrixOpenPointerEvents === 'none');

      // Real roll + rotate + WebCrypto verification against HTTP-served app
      const reg = await client.post('/api/auth/register', { username: 't4_parity_u', password: 'Password!123' });
      assert.equal(reg.status, 201);
      const roll = await client.post('/api/roll', { bets: { double_2: 5_000, pair_1_3: 5_000 } });
      assert.equal(roll.status, 200);

      const rot = await client.post('/api/fairness/rotate', { clientSeed: 'parity-seed' });
      assert.equal(rot.status, 200);

      const wcDice = await webCryptoDeriveFairDice(
        rot.json.previous.serverSeed,
        roll.json.fairness.clientSeed,
        roll.json.fairness.nonce
      );
      assert.deepEqual(wcDice, roll.json.dice);

      const srvVerify = await client.post('/api/verify-fairness', {
        serverSeed: rot.json.previous.serverSeed,
        clientSeed: roll.json.fairness.clientSeed,
        nonce: roll.json.fairness.nonce,
      });
      assert.equal(srvVerify.status, 200);
      assert.deepEqual(srvVerify.json.dice, wcDice);
    } finally {
      await server.close();
    }
  });
});
