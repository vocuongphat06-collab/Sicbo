'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  getTargetRoot,
  DEFAULT_PROJECT_ROOT,
  startTestServer,
  spawnDirectEntrypoint,
  inspectServerModuleExport,
  createClient,
  waitForLivePhase,
} = require('./helpers');

describe('Tier 1 — F1: Env & Secrets Configuration', () => {
  it('F1.1: .env.example exists and documents required Vercel & security variables', () => {
    const envExamplePath = path.join(getTargetRoot(), '.env.example');
    assert.equal(fs.existsSync(envExamplePath), true, '.env.example must exist');
    const content = fs.readFileSync(envExamplePath, 'utf8');
    for (const key of [
      'JWT_SECRET',
      'LIVE_MASTER_SECRET',
      'ADMIN_USERNAME',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ]) {
      assert.match(content, new RegExp(`^#?\\s*${key}\\s*=`, 'm'), `.env.example must document ${key}`);
    }
  });

  it('F1.2: local startup auto-generates high-entropy CSPRNG data/.secrets.json', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const warm = await createClient(server.baseUrl).get('/api/state');
      assert.equal(warm.status, 200);
      const secretsPath = path.join(server.dataDir, '.secrets.json');
      assert.equal(fs.existsSync(secretsPath), true, 'data/.secrets.json should be created locally');
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      const jwtVal = secrets.jwtSecret || secrets.JWT_SECRET;
      const liveVal = secrets.liveMasterSecret || secrets.LIVE_MASTER_SECRET;
      assert.equal(typeof jwtVal, 'string');
      assert.equal(typeof liveVal, 'string');
      assert.ok(jwtVal.length >= 32, 'JWT secret must be >= 32 chars');
      assert.ok(liveVal.length >= 32, 'LIVE_MASTER_SECRET must be >= 32 chars');
      assert.notEqual(jwtVal, liveVal);
      for (const weak of ['dev-secret', 'secret', 'changeme', '123456']) {
        assert.notEqual(jwtVal, weak);
        assert.notEqual(liveVal, weak);
      }
    } finally {
      await server.close();
    }
  });

  it('F1.3: local restart reuses persisted data/.secrets.json and keeps JWT sessions valid', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'persist_vip_1',
        password: 'Password!234',
        displayName: 'Persist VIP',
      });
      assert.equal(reg.status, 201);
      const secretsBefore = fs.readFileSync(path.join(server.dataDir, '.secrets.json'), 'utf8');

      await server.restart({ stripSecrets: true });

      const meClient = createClient(server.baseUrl, client.jar.clone());
      const me = await meClient.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.json.user.username, 'persist_vip_1');

      const secretsAfter = fs.readFileSync(path.join(server.dataDir, '.secrets.json'), 'utf8');
      assert.equal(secretsAfter, secretsBefore, '.secrets.json must persist across restarts');
    } finally {
      await server.close();
    }
  });

  it('F1.4: explicit env overrides (JWT_SECRET, ADMIN_USERNAME) take precedence over .secrets.json', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'before_override',
        password: 'Password!234',
      });
      assert.equal(reg.status, 201);

      const newJwtSecret = crypto.randomBytes(32).toString('hex');
      await server.restart({
        stripSecrets: false,
        env: {
          JWT_SECRET: newJwtSecret,
          LIVE_MASTER_SECRET: crypto.randomBytes(32).toString('hex'),
          ADMIN_USERNAME: 'boss_override',
        },
      });

      const oldTokenCheck = createClient(server.baseUrl, client.jar.clone());
      const oldMe = await oldTokenCheck.get('/api/auth/me');
      assert.equal(oldMe.status, 401, 'Old JWT must be invalid after JWT_SECRET env override');

      const adminClient = createClient(server.baseUrl);
      const adminReg = await adminClient.post('/api/auth/register', {
        username: 'Boss_Override',
        password: 'AdminPass!234',
      });
      assert.equal(adminReg.status, 201);
      assert.equal(adminReg.json.user.role, 'admin');
    } finally {
      await server.close();
    }
  });

  it('F1.5: VERCEL=1 without secret/DB env does not crash, logs warning, and uses ephemeral CSPRNG', async () => {
    let v1 = null;
    let v2 = null;
    try {
      v1 = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });
      v2 = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });

      const stateRes = await createClient(v1.baseUrl).get('/api/state');
      assert.equal(stateRes.status, 200);

      const logs = v1.getLogs();
      const combinedLogs = `${logs.stdout}\n${logs.stderr}`;
      assert.match(
        combinedLogs,
        /warn|ephemeral|degraded|JWT_SECRET|LIVE_MASTER_SECRET/i,
        'VERCEL=1 with missing secrets must emit an explicit warning'
      );

      const c1 = createClient(v1.baseUrl);
      const reg1 = await c1.post('/api/auth/register', {
        username: 'vercel_ephemeral_u1',
        password: 'Password!234',
      });
      assert.equal(reg1.status, 201);

      // Token signed by instance V1 must be rejected by independent ephemeral instance V2
      const c2 = createClient(v2.baseUrl, c1.jar.clone());
      const meOnV2 = await c2.get('/api/auth/me');
      assert.equal(meOnV2.status, 401, 'Ephemeral CSPRNG secrets must differ across cold-start instances');
    } finally {
      await Promise.allSettled([v1?.close(), v2?.close()]);
    }
  });

  it('F1.6: server.js exports app function and VERCEL=1 direct execution skips app.listen()', async () => {
    const exp = await inspectServerModuleExport();
    assert.equal(exp.code, 0, `require('./server.js') failed: ${exp.stderr}`);
    assert.equal(exp.stdout, 'function', 'module.exports must be Express app function');

    const directVercel = await spawnDirectEntrypoint({ vercel: true, stripSecrets: true, timeoutMs: 10000 });
    assert.equal(directVercel.timedOut, false, 'node server.js with VERCEL=1 must not hang on app.listen()');
    assert.equal(directVercel.code, 0, `node server.js with VERCEL=1 exited with ${directVercel.code}: ${directVercel.stderr}`);
  });
});

describe('Tier 1 — F5a: Auth Register, Login & Logout Lifecycle', () => {
  let server;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't1_f5a_admin' },
    });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F5.1: register creates user, omits secret hashes, sets HttpOnly/SameSite=Lax cookie, and /me succeeds', async () => {
    const client = createClient(server.baseUrl);
    const res = await client.post('/api/auth/register', {
      username: 'vip_alpha',
      password: 'StrongPass!123',
      displayName: 'Alpha VIP',
    });
    assert.equal(res.status, 201);
    assert.ok(res.json.user, 'Response must include user');
    assert.equal(res.json.user.username, 'vip_alpha');
    assert.equal(res.json.user.balance, 0);
    assert.equal(res.json.user.welcomeBonusClaimed, false);
    assert.equal(typeof res.json.recoveryCode, 'string');
    assert.ok(res.json.recoveryCode.length >= 6);
    assert.equal(res.json.user.passwordHash, undefined);
    assert.equal(res.json.user.recoveryCodeHash, undefined);
    assert.equal(res.json.user.serverSeed, undefined);

    const cookieMeta = client.getCookieMeta('sicbo_token');
    assert.ok(cookieMeta, 'sicbo_token Set-Cookie must be present');
    assert.equal(cookieMeta.httpOnly, true);
    assert.equal(cookieMeta.sameSite?.toLowerCase(), 'lax');
    assert.equal(cookieMeta.path, '/');

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'vip_alpha');
    assert.ok(Array.isArray(me.json.ledger));
    assert.ok(Array.isArray(me.json.personalHistory));
    assert.ok(me.json.fairness && typeof me.json.fairness.serverSeedHash === 'string');
  });

  it('F5.2: logout clears sicbo_token cookie and login restores authenticated session', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'vip_logout_login',
      password: 'Password!999',
    });
    assert.equal(reg.status, 201);

    const logout = await client.post('/api/auth/logout', {});
    assert.equal(logout.status, 200);
    assert.equal(logout.json.ok, true);
    const clearedMeta = client.getCookieMeta('sicbo_token');
    assert.ok(!clearedMeta || clearedMeta.cleared, 'Cookie must be cleared on logout');

    const meAfterLogout = await client.get('/api/auth/me');
    assert.equal(meAfterLogout.status, 401);

    const login = await client.post('/api/auth/login', {
      username: 'vip_logout_login',
      password: 'Password!999',
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.username, 'vip_logout_login');

    const meAfterLogin = await client.get('/api/auth/me');
    assert.equal(meAfterLogin.status, 200);
  });
});

describe('Tier 1 — F5b: Password Change & Recovery Code Lifecycle', () => {
  let server;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't1_f5b_admin' },
    });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F5.3: change-password updates credentials and rejects old password on subsequent login', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'vip_changepw',
      password: 'OldPass!123',
    });
    assert.equal(reg.status, 201);

    const ch = await client.post('/api/auth/change-password', {
      currentPassword: 'OldPass!123',
      newPassword: 'NewPass!456',
    });
    assert.equal(ch.status, 200);
    assert.equal(ch.json.ok, true);

    const oldLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'vip_changepw',
      password: 'OldPass!123',
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'vip_changepw',
      password: 'NewPass!456',
    });
    assert.equal(newLogin.status, 200);
  });

  it('F5.4: recover resets password using 1-time recoveryCode and cannot replay same code', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'vip_recover',
      password: 'InitPass!123',
    });
    assert.equal(reg.status, 201);
    const recoveryCode = reg.json.recoveryCode;

    const rec = await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 'vip_recover',
      recoveryCode,
      newPassword: 'Recovered!789',
    });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.ok, true);

    const oldLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'vip_recover',
      password: 'InitPass!123',
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'vip_recover',
      password: 'Recovered!789',
    });
    assert.equal(newLogin.status, 200);

    const replay = await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 'vip_recover',
      recoveryCode,
      newPassword: 'HackedAgain!999',
    });
    assert.ok([400, 401].includes(replay.status), `Reused recoveryCode must be rejected, got ${replay.status}`);
  });
});

describe('Tier 1 — F5c: Guest Upgrade & Auth Guard Rejections', () => {
  let server;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't1_f5c_admin' },
    });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F5.5: POST /api/auth/guest is disabled (403) and anonymous /api/state reports zeroed user/session', async () => {
    const client = createClient(server.baseUrl);
    const guestRes = await client.post('/api/auth/guest', {});
    assert.equal(guestRes.status, 403);
    assert.equal(guestRes.json.code, 'GUEST_DISABLED');

    const anonState = await client.get('/api/state');
    assert.equal(anonState.status, 200);
    assert.equal(anonState.json.user, null);
  });

  it('F5.6: duplicate username, unauthenticated protected routes, and wrong password fail cleanly', async () => {
    const first = await createClient(server.baseUrl).post('/api/auth/register', {
      username: 'vip_dup_check',
      password: 'StrongPass!123',
    });
    assert.equal(first.status, 201);

    const dup = await createClient(server.baseUrl).post('/api/auth/register', {
      username: 'VIP_DUP_CHECK',
      password: 'AnotherPass!123',
    });
    assert.ok([400, 409].includes(dup.status), `Duplicate username expected 400/409, got ${dup.status}`);

    const anonMe = await createClient(server.baseUrl).get('/api/auth/me');
    assert.equal(anonMe.status, 401);

    const anonRoll = await createClient(server.baseUrl).post('/api/roll', { bets: { tai: 10_000 } });
    assert.equal(anonRoll.status, 401);

    const badLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'vip_dup_check',
      password: 'WrongPassword!000',
    });
    assert.equal(badLogin.status, 401);
  });
});

describe('Tier 1 — F4: Atomic DB Adapter, Financial Ledger & Idempotency', () => {
  let server;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't1_f4_admin' },
    });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F4.1: manual bet records valid wallet_ledger bet entry with balanceBefore/amount/balanceAfter', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'f4_ledger_bet',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    const rollRes = await client.post('/api/roll', {
      bets: { triple_6: 10_000 },
    }, { headers: { 'Idempotency-Key': 'f4-bet-1' } });
    assert.equal(rollRes.status, 200);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    const betEntry = me.json.ledger.find((e) => e.type === 'bet');
    assert.ok(betEntry, 'wallet_ledger must contain a bet entry');
    assert.equal(typeof betEntry.id, 'string');
    assert.equal(betEntry.balanceBefore, 2_000_000);
    assert.equal(Math.abs(betEntry.amount), 10_000);
    assert.equal(betEntry.balanceAfter, 1_990_000);
    assert.ok(betEntry.timestamp, 'Ledger entry must include timestamp');
  });

  it('F4.2: covering bet guarantees win ledger entry and exact balanceBefore/amount/balanceAfter continuity', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'f4_ledger_win',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    // tai + xiu + triple_any covers 100% of 216 dice outcomes
    const rollRes = await client.post('/api/roll', {
      bets: { tai: 10_000, xiu: 10_000, triple_any: 10_000 },
    }, { headers: { 'Idempotency-Key': 'f4-win-1' } });
    assert.equal(rollRes.status, 200);
    assert.ok(rollRes.json.totalWin > 0);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    const betEntry = me.json.ledger.find((e) => e.type === 'bet');
    const winEntry = me.json.ledger.find((e) => e.type === 'win');
    assert.ok(betEntry && winEntry, 'Both bet and win ledger entries must exist');
    assert.equal(winEntry.balanceBefore, betEntry.balanceAfter);
    assert.equal(winEntry.amount, rollRes.json.totalWin);
    assert.equal(winEntry.balanceAfter, winEntry.balanceBefore + rollRes.json.totalWin);
    assert.equal(me.json.user.balance, winEntry.balanceAfter);
  });

  it('F4.4: Idempotency-Key on POST /api/roll replays cached outcome without double debit', async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'f4_idem_roll',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    const first = await client.post(
      '/api/roll',
      { bets: { tai: 50_000 } },
      { headers: { 'Idempotency-Key': 'idem-roll-unique-1' } }
    );
    const second = await client.post(
      '/api/roll',
      { bets: { tai: 50_000 } },
      { headers: { 'Idempotency-Key': 'idem-roll-unique-1' } }
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.roundId, first.json.roundId);
    assert.deepEqual(second.json.dice, first.json.dice);
    assert.equal(second.json.newBalance, first.json.newBalance);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    const betEntries = me.json.ledger.filter((e) => e.type === 'bet');
    assert.equal(betEntries.length, 1, 'Idempotent replay must create only 1 bet ledger entry');
  });

  it('F4.5: Idempotency-Key on POST /api/live/bet during BETTING charges balance only once', { timeout: 45000 }, async () => {
    const client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'f4_idem_live',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    await client.post('/api/wallet/welcome-bonus', {});

    const liveState = await waitForLivePhase(client, 'BETTING', 3500);
    const r1 = await client.post(
      '/api/live/bet',
      { bets: { tai: 40_000 }, liveRoundId: liveState.liveRoundId },
      { headers: { 'Idempotency-Key': 'idem-live-unique-1' } }
    );
    const r2 = await client.post(
      '/api/live/bet',
      { bets: { tai: 40_000 }, liveRoundId: liveState.liveRoundId },
      { headers: { 'Idempotency-Key': 'idem-live-unique-1' } }
    );
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.json.newBalance, 2_000_000 - 40_000);
    assert.equal(r2.json.newBalance, r1.json.newBalance);
  });

  it('F4.6: VERCEL=1 persists data inside os.tmpdir()/sicbo-data and never writes to project data/', async () => {
    const projectDataDir = path.join(DEFAULT_PROJECT_ROOT, 'data');
    const beforeSnapshot = fs.existsSync(projectDataDir)
      ? fs.readdirSync(projectDataDir).map((f) => `${f}:${fs.statSync(path.join(projectDataDir, f)).mtimeMs}`)
      : [];

    const vServer = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });
    try {
      const client = createClient(vServer.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'vercel_tmp_user',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      await client.post('/api/wallet/welcome-bonus', {});

      const roll = await client.post('/api/roll', { bets: { tai: 10_000 } });
      assert.equal(roll.status, 200);

      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.json.user.balance, roll.json.newBalance);

      const vercelTmpData = path.join(vServer.tmpDir, 'sicbo-data');
      assert.equal(fs.existsSync(vercelTmpData), true, 'VERCEL=1 fallback must write to os.tmpdir()/sicbo-data');

      const afterSnapshot = fs.existsSync(projectDataDir)
        ? fs.readdirSync(projectDataDir).map((f) => `${f}:${fs.statSync(path.join(projectDataDir, f)).mtimeMs}`)
        : [];
      assert.deepEqual(afterSnapshot, beforeSnapshot, 'Project data/ directory must remain completely untouched');
    } finally {
      await vServer.close();
    }
  });
});

describe('Tier 1 — F6 & F4.3: Admin Ops RBAC, Wallet Ops, Leaderboard & Ledger Types', () => {
  let server;
  let adminClient;
  let player1Client;
  let player1Id;
  let player2Client;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 'SovereignAdmin' },
    });

    adminClient = createClient(server.baseUrl);
    const adminReg = await adminClient.post('/api/auth/register', {
      username: 'sovereignadmin',
      password: 'AdminPassword!123',
      displayName: 'Salon Boss',
    });
    assert.equal(adminReg.status, 201);

    player1Client = createClient(server.baseUrl);
    const p1Reg = await player1Client.post('/api/auth/register', {
      username: 'whale_player1',
      password: 'PlayerPassword!123',
      displayName: 'Whale One',
    });
    assert.equal(p1Reg.status, 201);
    player1Id = p1Reg.json.user.id;

    player2Client = createClient(server.baseUrl);
    const p2Reg = await player2Client.post('/api/auth/register', {
      username: 'shark_player2',
      password: 'PlayerPassword!123',
      displayName: 'Shark Two',
    });
    assert.equal(p2Reg.status, 201);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('F6.1: ADMIN_USERNAME grants admin role case-insensitively and standard users get role user', async () => {
    const adminMe = await adminClient.get('/api/auth/me');
    assert.equal(adminMe.status, 200);
    assert.equal(adminMe.json.user.role, 'admin');

    const p1Me = await player1Client.get('/api/auth/me');
    assert.equal(p1Me.status, 200);
    assert.equal(p1Me.json.user.role, 'user');
  });

  it('F6.2: GET /api/admin/users?q= filters users and strips sensitive hashes/seeds', async () => {
    const allRes = await adminClient.get('/api/admin/users');
    assert.equal(allRes.status, 200);
    assert.ok(Array.isArray(allRes.json.users));
    assert.ok(allRes.json.users.length >= 3);

    const searchRes = await adminClient.get('/api/admin/users?q=whale_player1');
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.json.users.length, 1);
    const u = searchRes.json.users[0];
    assert.equal(u.username, 'whale_player1');
    assert.equal(u.passwordHash, undefined);
    assert.equal(u.recoveryCodeHash, undefined);
    assert.equal(u.serverSeed, undefined);
  });

  it('F6.3: POST /api/admin/users/:id/adjust-balance credits and debits with reason and admin_adjust ledger', async () => {
    const addRes = await adminClient.post(`/api/admin/users/${player1Id}/adjust-balance`, {
      amount: 500_000,
      reason: 'VIP Admin Top-up',
    });
    assert.equal(addRes.status, 200);
    assert.equal(addRes.json.user.balance, 500_000);
    assert.equal(addRes.json.ledgerEntry.type, 'admin_adjust');
    assert.equal(addRes.json.ledgerEntry.balanceBefore, 0);
    assert.equal(addRes.json.ledgerEntry.amount, 500_000);
    assert.equal(addRes.json.ledgerEntry.balanceAfter, 500_000);

    const subRes = await adminClient.post(`/api/admin/users/${player1Id}/adjust-balance`, {
      amount: -200_000,
      reason: 'Audit correction',
    });
    assert.equal(subRes.status, 200);
    assert.equal(subRes.json.user.balance, 300_000);
    assert.equal(subRes.json.ledgerEntry.type, 'admin_adjust');
    assert.equal(subRes.json.ledgerEntry.balanceBefore, 500_000);
    assert.equal(subRes.json.ledgerEntry.balanceAfter, 300_000);
  });

  it('F6.4: toggle-lock blocks/unblocks login and reset-password issues working tempPassword', async () => {
    const lockRes = await adminClient.post(`/api/admin/users/${player1Id}/toggle-lock`, { locked: true });
    assert.equal(lockRes.status, 200);
    assert.equal(lockRes.json.user.locked, true);

    const lockedLogin = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'whale_player1',
      password: 'PlayerPassword!123',
    });
    assert.equal(lockedLogin.status, 403);

    const unlockRes = await adminClient.post(`/api/admin/users/${player1Id}/toggle-lock`, { locked: false });
    assert.equal(unlockRes.status, 200);
    assert.equal(unlockRes.json.user.locked, false);

    const resetRes = await adminClient.post(`/api/admin/users/${player1Id}/reset-password`, {});
    assert.equal(resetRes.status, 200);
    assert.equal(typeof resetRes.json.tempPassword, 'string');
    assert.ok(resetRes.json.tempPassword.length >= 6);

    const tempLogin = await player1Client.post('/api/auth/login', {
      username: 'whale_player1',
      password: resetRes.json.tempPassword,
    });
    assert.equal(tempLogin.status, 200);
  });

  it('F6.5: POST /api/wallet/welcome-bonus awards +2,000,000 once per account and rejects repeat with 409', async () => {
    const beforeMe = await player2Client.get('/api/auth/me');
    const beforeBal = beforeMe.json.user.balance;
    assert.equal(beforeBal, 0);

    const bonusRes = await player2Client.post('/api/wallet/welcome-bonus', {});
    assert.equal(bonusRes.status, 200);
    assert.equal(bonusRes.json.bonusAmount, 2_000_000);
    assert.equal(bonusRes.json.balance, 2_000_000);
    assert.equal(bonusRes.json.welcomeBonusClaimed, true);
    assert.equal(bonusRes.json.ledgerEntry.type, 'welcome_bonus');

    const repeatRes = await player2Client.post('/api/wallet/welcome-bonus', {});
    assert.equal(repeatRes.status, 409);
    assert.equal(repeatRes.json.code, 'WELCOME_BONUS_ALREADY_CLAIMED');
  });

  it('F6.6: retired daily-bonus & bankruptcy-aid return 410 and GET /api/leaderboard ranks by balance', async () => {
    const dailyDisabled = await player1Client.post('/api/wallet/daily-bonus', {});
    assert.equal(dailyDisabled.status, 410);
    assert.equal(dailyDisabled.json.code, 'FEATURE_DISABLED');

    const aidDisabled = await player1Client.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(aidDisabled.status, 410);
    assert.equal(aidDisabled.json.code, 'FEATURE_DISABLED');

    const lbRes = await createClient(server.baseUrl).get('/api/leaderboard');
    assert.equal(lbRes.status, 200);
    assert.ok(Array.isArray(lbRes.json.byBalance));
    assert.ok(Array.isArray(lbRes.json.byNetProfit));
    assert.ok(lbRes.json.byBalance.length >= 2);
    for (let i = 0; i < lbRes.json.byBalance.length - 1; i++) {
      assert.ok(lbRes.json.byBalance[i].balance >= lbRes.json.byBalance[i + 1].balance);
    }
    for (const row of [...lbRes.json.byBalance, ...lbRes.json.byNetProfit]) {
      assert.equal(row.passwordHash, undefined);
      assert.equal(row.recoveryCodeHash, undefined);
      assert.equal(row.serverSeed, undefined);
    }
  });

  it('F4.3: wallet_ledger records welcome_bonus and admin_adjust with valid schema and 0 + sum(ledger) === balance', async () => {
    const allowedTypes = new Set(['bet', 'win', 'refund', 'welcome_bonus', 'daily_bonus', 'bankruptcy_aid', 'admin_adjust']);
    const p1Me = await player1Client.get('/api/auth/me');
    const p2Me = await player2Client.get('/api/auth/me');

    const p1Types = new Set(p1Me.json.ledger.map((e) => e.type));
    const p2Types = new Set(p2Me.json.ledger.map((e) => e.type));
    assert.ok(p1Types.has('admin_adjust'), 'p1 ledger must contain admin_adjust');
    assert.ok(p2Types.has('welcome_bonus'), 'p2 ledger must contain welcome_bonus');

    for (const uMe of [p1Me.json, p2Me.json]) {
      let sum = 0;
      for (const entry of uMe.ledger) {
        assert.ok(allowedTypes.has(entry.type), `Invalid ledger type: ${entry.type}`);
        assert.equal(typeof entry.balanceBefore, 'number');
        assert.equal(typeof entry.amount, 'number');
        assert.equal(typeof entry.balanceAfter, 'number');
        assert.ok(entry.timestamp !== undefined);
        sum += entry.amount;
      }
      assert.equal(sum, uMe.user.balance);
    }
  });
});
