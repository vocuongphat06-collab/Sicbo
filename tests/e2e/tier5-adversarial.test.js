'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  DEFAULT_PROJECT_ROOT,
  LIVE_ROUND_MS,
  LIVE_BET_MS,
  webCryptoSha256Hex,
  webCryptoDeriveFairDice,
  startTestServer,
  startClockedServer,
  createClient,
  rawHttpRequest,
} = require('./helpers');

function forgeJwt({ header, payload, secret = '' }) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  if (header.alg === 'none') {
    return `${h}.${p}.`;
  }
  if (header.alg === 'HS512') {
    const sig = crypto.createHmac('sha512', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
  }
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function extractBalancedJsFunction(source, fnName) {
  const fnDeclIdx = source.search(new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`));
  const varDeclIdx = source.search(new RegExp(`(?:const|let|var)\\s+${fnName}\\s*=`));
  const startIdx = fnDeclIdx !== -1 ? fnDeclIdx : varDeclIdx;
  if (startIdx === -1) return null;

  let searchFrom = startIdx;
  if (fnDeclIdx !== -1) {
    const parenStart = source.indexOf('(', startIdx);
    let pDepth = 1;
    let p = parenStart + 1;
    while (p < source.length && pDepth > 0) {
      if (source[p] === '(') pDepth++;
      else if (source[p] === ')') pDepth--;
      p++;
    }
    searchFrom = p;
  }

  const braceStart = source.indexOf('{', searchFrom);
  if (braceStart === -1) return null;
  let depth = 1;
  let i = braceStart + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(startIdx, i);
}

// =============================================================================
// T5-1: Input, Protocol & CORS Hardening
// =============================================================================
describe('Tier 5 — T5-1: Input, Protocol & CORS Hardening', () => {
  let server;
  let adminClient;
  let playerClient;
  let playerId;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't5_proto_admin' },
    });
    adminClient = createClient(server.baseUrl);
    const rAdmin = await adminClient.post('/api/auth/register', {
      username: 't5_proto_admin',
      password: 'AdminPassword!123',
    });
    assert.equal(rAdmin.status, 201);

    playerClient = createClient(server.baseUrl);
    const rPlayer = await playerClient.post('/api/auth/register', {
      username: 't5_proto_player',
      password: 'PlayerPassword!123',
    });
    assert.equal(rPlayer.status, 201);
    playerId = rPlayer.json.user.id;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T5-1.1: rejects __proto__, constructor, prototype in nested objects, nested arrays, and top-level arrays with 400', async () => {
    const evilPayloads = [
      '{"bets":{"tai":1000},"__proto__":{"polluted":true}}',
      '{"bets":{"tai":1000},"nested":{"constructor":{"prototype":{"polluted":true}}}}',
      '{"bets":{"tai":1000},"arr":[{"constructor":{"polluted":true}}]}',
      '[{"prototype":{"polluted":true}}]',
      '{"__proto__":{"polluted":true}}',
    ];

    for (const rawBody of evilPayloads) {
      for (const route of ['/api/roll', '/api/live/bet', '/api/fairness/rotate']) {
        const res = await playerClient.post(route, undefined, { rawBody });
        assert.equal(res.status, 400, `Expected 400 on ${route} for ${rawBody}, got ${res.status}`);
      }
      const regRes = await createClient(server.baseUrl).post('/api/auth/register', undefined, { rawBody });
      assert.equal(regRes.status, 400, `Expected 400 on /api/auth/register for ${rawBody}`);

      const adjRes = await adminClient.post(`/api/admin/users/${playerId}/adjust-balance`, undefined, { rawBody });
      assert.equal(adjRes.status, 400, `Expected 400 on adjust-balance for ${rawBody}`);
    }

    assert.equal(({}).polluted, undefined);
  });

  it('T5-1.2: enforces exact 16384-byte JSON boundary (200 vs 413), rejects text/plain, utf-16, and array JSON bodies', async () => {
    const cookie = playerClient.snapshotCookie();

    // Exact 16384 bytes -> 200
    const baseObj = { bets: { tai: 1000 }, pad: '' };
    const baseLen = Buffer.byteLength(JSON.stringify(baseObj), 'utf8');
    const exact16384 = JSON.stringify({ bets: { tai: 1000 }, pad: 'a'.repeat(16384 - baseLen) });
    assert.equal(Buffer.byteLength(exact16384, 'utf8'), 16384);

    const res16384 = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: cookie },
      body: exact16384,
    });
    assert.equal(res16384.status, 200);

    // Exact 16385 bytes -> 413 JSON
    const exact16385 = JSON.stringify({ bets: { tai: 1000 }, pad: 'a'.repeat(16385 - baseLen) });
    assert.equal(Buffer.byteLength(exact16385, 'utf8'), 16385);

    const res16385 = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: cookie },
      body: exact16385,
    });
    assert.equal(res16385.status, 413);
    assert.equal(res16385.json?.code, 'PAYLOAD_TOO_LARGE');

    // Wrong Content-Type -> 400
    const resText = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ bets: { tai: 1000 } }),
    });
    assert.equal(resText.status, 400);

    // Unsupported charset utf-16 -> 400/415
    const resUtf16 = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: cookie, 'Content-Type': 'application/json; charset=utf-16' },
      body: JSON.stringify({ bets: { tai: 1000 } }),
    });
    assert.ok([400, 415].includes(resUtf16.status));

    // Top-level JSON array [] -> 400
    const resArr = await playerClient.post('/api/roll', []);
    assert.equal(resArr.status, 400);
  });

  it('T5-1.3: blocks CORS Origin bypasses (null, prefix/suffix, subdomain, external) while allowing exact same-origin', async () => {
    const parsed = new URL(server.baseUrl);
    const badOrigins = [
      'null',
      `${server.baseUrl}.evil.com`,
      `http://evil.${parsed.host}`,
      'https://evil.example.com',
    ];

    for (const origin of badOrigins) {
      const opt = await playerClient.request('OPTIONS', '/api/roll', { headers: { Origin: origin } });
      assert.equal(opt.status, 403, `OPTIONS with Origin=${origin} must be 403`);
      assert.equal(opt.headers.get('access-control-allow-origin'), null);

      const getRes = await playerClient.get('/api/state', { headers: { Origin: origin } });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.get('access-control-allow-origin'), null);
      assert.match(String(getRes.headers.get('vary') || ''), /Origin/i);
    }

    const sameOpt = await playerClient.request('OPTIONS', '/api/roll', { headers: { Origin: server.baseUrl } });
    assert.equal(sameOpt.status, 204);
    assert.equal(sameOpt.headers.get('access-control-allow-origin'), server.baseUrl);
    assert.equal(sameOpt.headers.get('access-control-allow-credentials'), 'true');
  });

  it('T5-1.4: rejects NoSQL object injection on login and clamps query bounds on leaderboard/admin', async () => {
    const nosql = await createClient(server.baseUrl).post('/api/auth/login', {
      username: { $ne: '' },
      password: { $ne: '' },
    });
    assert.equal(nosql.status, 400);

    for (const qs of ['?limit=-5', '?limit=999999', '?limit[]=2']) {
      const lb = await adminClient.get(`/api/leaderboard${qs}`);
      assert.equal(lb.status, 200);
      assert.ok(Array.isArray(lb.json.byBalance));
      assert.ok(lb.json.byBalance.length <= 50);
    }

    const admQ = await adminClient.get('/api/admin/users?q[]=x&limit=-1&offset=-10');
    assert.equal(admQ.status, 200);
    assert.ok(Array.isArray(admQ.json.users));
  });
});

// =============================================================================
// T5-2: JWT Attacks, Session Revocation, Auth Edges & Admin RBAC
// =============================================================================
describe('Tier 5 — T5-2: JWT Attacks, Session Revocation, Auth Edges & Admin RBAC', () => {
  let server;
  let adminClient;
  let adminId;
  const jwtSecret = 't5_fixed_jwt_secret_for_forged_vector_testing_0123456789';

  before(async () => {
    server = await startTestServer({
      env: {
        ADMIN_USERNAME: 't5_rbac_admin',
        JWT_SECRET: jwtSecret,
        LIVE_MASTER_SECRET: 't5_fixed_live_secret_0123456789',
      },
    });
    adminClient = createClient(server.baseUrl);
    const regAdmin = await adminClient.post('/api/auth/register', {
      username: 't5_rbac_admin',
      password: 'AdminPassword!123',
    });
    assert.equal(regAdmin.status, 201);
    adminId = regAdmin.json.user.id;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T5-2.1: rejects alg:none, HS512, forged role, and expired JWTs; supports Bearer token and revokes on change-password', async () => {
    const c = createClient(server.baseUrl);
    const reg = await c.post('/api/auth/register', {
      username: 't5_jwt_victim',
      password: 'OldPassword!123',
    });
    assert.equal(reg.status, 201);
    const uid = reg.json.user.id;

    // alg: none forged token
    const noneTok = forgeJwt({
      header: { alg: 'none', typ: 'JWT' },
      payload: { sub: uid, sv: 1, role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
    });
    assert.equal((await createClient(server.baseUrl).get('/api/auth/me', {
      noCookies: true,
      headers: { Authorization: `Bearer ${noneTok}` },
    })).status, 401);

    // HS512 forged token
    const hs512Tok = forgeJwt({
      header: { alg: 'HS512', typ: 'JWT' },
      payload: { sub: uid, sv: 1, role: 'user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      secret: jwtSecret,
    });
    assert.equal((await createClient(server.baseUrl).get('/api/auth/me', {
      noCookies: true,
      headers: { Authorization: `Bearer ${hs512Tok}` },
    })).status, 401);

    // Expired JWT
    const expiredTok = forgeJwt({
      header: { alg: 'HS256', typ: 'JWT' },
      payload: { sub: uid, sv: 1, role: 'user', iat: 1000, exp: 2000 },
      secret: jwtSecret,
    });
    assert.equal((await createClient(server.baseUrl).get('/api/auth/me', {
      noCookies: true,
      headers: { Authorization: `Bearer ${expiredTok}` },
    })).status, 401);

    // Valid Bearer token works, and forged admin role with valid sig still gets 403 on DB role check
    const bearerTok = c.getCookie('sicbo_token');
    assert.equal((await createClient(server.baseUrl).get('/api/auth/me', {
      noCookies: true,
      headers: { Authorization: `Bearer ${bearerTok}` },
    })).status, 200);

    const forgedRoleTok = forgeJwt({
      header: { alg: 'HS256', typ: 'JWT' },
      payload: { sub: uid, sv: 1, role: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      secret: jwtSecret,
    });
    assert.equal((await createClient(server.baseUrl).get('/api/admin/users', {
      noCookies: true,
      headers: { Authorization: `Bearer ${forgedRoleTok}` },
    })).status, 403);

    // change-password revokes old Bearer token immediately
    const ch = await c.post('/api/auth/change-password', {
      currentPassword: 'OldPassword!123',
      newPassword: 'NewPassword!456',
    });
    assert.equal(ch.status, 200);
    assert.equal((await createClient(server.baseUrl).get('/api/auth/me', {
      noCookies: true,
      headers: { Authorization: `Bearer ${bearerTok}` },
    })).status, 401);
  });

  it('T5-2.2: post-recover revokes active JWT, supports lowercase/trimmed code rotation, and blocks guest change-pw / real upgrade / locked recover', async () => {
    const u = createClient(server.baseUrl);
    const reg = await u.post('/api/auth/register', {
      username: 't5_rec_edge',
      password: 'InitPassword!123',
    });
    assert.equal(reg.status, 201);
    const uid = reg.json.user.id;
    const code1 = reg.json.recoveryCode;
    const staleCookie = u.snapshotCookie();

    // Real user calling /api/auth/upgrade -> 400
    assert.equal((await u.post('/api/auth/upgrade', { username: 'x_up', password: 'Password!123' })).status, 400);

    // Lowercase + whitespace padded recovery code works
    const rec1 = await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 't5_rec_edge',
      recoveryCode: `  ${code1.toLowerCase()}  `,
      newPassword: 'RecoveredPass!111',
    });
    assert.equal(rec1.status, 200);
    const code2 = rec1.json.recoveryCode;
    assert.ok(code2 && code2 !== code1);

    // Active token captured before recover is immediately revoked (401)
    const staleClient = createClient(server.baseUrl);
    staleClient.setRawCookieHeader(staleCookie);
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);

    // Replaying code1 returns 401; code2 works
    assert.equal((await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 't5_rec_edge',
      recoveryCode: code1,
      newPassword: 'ReplayPass!999',
    })).status, 401);

    const rec2 = await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 't5_rec_edge',
      recoveryCode: code2,
      newPassword: 'RecoveredPass!222',
    });
    assert.equal(rec2.status, 200);

    // Lock user -> /api/auth/recover returns 403
    await adminClient.post(`/api/admin/users/${uid}/toggle-lock`, { locked: true });
    assert.equal((await createClient(server.baseUrl).post('/api/auth/recover', {
      username: 't5_rec_edge',
      recoveryCode: rec2.json.recoveryCode,
      newPassword: 'LockedPass!333',
    })).status, 403);

    // Guest calling /api/auth/change-password -> 400
    const guest = createClient(server.baseUrl);
    await guest.post('/api/auth/guest', {});
    assert.equal((await guest.post('/api/auth/change-password', {
      currentPassword: 'any',
      newPassword: 'NewPassword!123',
    })).status, 400);
  });

  it('T5-2.3: blocks role:admin payload escalation, MAX_SAFE_INTEGER adjust-balance overflow, admin self-lock (BUG-4), and guest reset-password (BUG-5)', async () => {
    const rbacSrv = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't5_rbac_isolated_admin' },
    });
    try {
      const isoAdmin = createClient(rbacSrv.baseUrl);
      const regA = await isoAdmin.post('/api/auth/register', {
        username: 't5_rbac_isolated_admin',
        password: 'AdminPassword!123',
      });
      assert.equal(regA.status, 201);
      const isoAdminId = regA.json.user.id;

      const regEscal = createClient(rbacSrv.baseUrl);
      const reg = await regEscal.post('/api/auth/register', {
        username: 't5_escal_reg',
        password: 'Password!123',
        role: 'admin',
      });
      assert.equal(reg.status, 201);
      assert.equal(reg.json.user.role, 'user');
      assert.equal((await regEscal.get('/api/admin/users')).status, 403);

      const guestEscal = createClient(rbacSrv.baseUrl);
      const gReg = await guestEscal.post('/api/auth/guest', {});
      assert.equal(gReg.status, 201);
      const guestId = gReg.json.user.id;

      // BUG-5: Guest reset-password rejected 400 NOT_REGISTERED
      const guestReset = await isoAdmin.post(`/api/admin/users/${guestId}/reset-password`, {});
      assert.equal(guestReset.status, 400);
      assert.equal(guestReset.json.code, 'NOT_REGISTERED');

      // Guest upgrade with role: 'admin' is forced to 'user'
      const up = await guestEscal.post('/api/auth/upgrade', {
        username: 't5_escal_up',
        password: 'Password!123',
        role: 'admin',
      });
      assert.equal(up.status, 200);
      assert.equal(up.json.user.role, 'user');
      assert.equal((await guestEscal.get('/api/admin/users')).status, 403);

      // BUG-3: MAX_SAFE_INTEGER positive overflow & negative overdraft rejected 400 without mutating balance
      const uid = reg.json.user.id;
      const preBal = reg.json.user.balance;
      const overRes = await isoAdmin.post(`/api/admin/users/${uid}/adjust-balance`, {
        amount: Number.MAX_SAFE_INTEGER,
        reason: 'Overflow probe',
      });
      assert.equal(overRes.status, 400);
      const negRes = await isoAdmin.post(`/api/admin/users/${uid}/adjust-balance`, {
        amount: -(preBal + 1),
        reason: 'Overdraft probe',
      });
      assert.equal(negRes.status, 400);
      assert.equal((await regEscal.get('/api/auth/me')).json.user.balance, preBal);

      // BUG-4: Admin self-lock rejected 400 CANNOT_LOCK_SELF
      const selfLock = await isoAdmin.post(`/api/admin/users/${isoAdminId}/toggle-lock`, { locked: true });
      assert.equal(selfLock.status, 400);
      assert.equal(selfLock.json.code, 'CANNOT_LOCK_SELF');
      assert.equal((await isoAdmin.get('/api/auth/me')).status, 200);
    } finally {
      await rbacSrv.close();
    }
  });
});

// =============================================================================
// T5-3: Concurrency Races, Idempotency & Live Round Settlement
// =============================================================================
describe('Tier 5 — T5-3: Concurrency Races, Idempotency & Live Round Settlement', () => {
  it('T5-3.1 & T5-3.2: 10-way /api/live/bet stampede, 5-way Idempotency-Key dedup, 409 conflict & 600M cap race', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const roundId = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({
      initialNowMs: roundStart + 1000,
      env: { ADMIN_USERNAME: 't5_race_admin' },
    });
    try {
      const admin = createClient(server.baseUrl);
      await admin.post('/api/auth/register', { username: 't5_race_admin', password: 'AdminPass!123' });

      // T5-3.1: 10x parallel 2M live bets on 10M balance -> 5x 200, 5x 400, balance === 0
      const u1 = createClient(server.baseUrl);
      await u1.post('/api/auth/register', { username: 't5_live_stampede', password: 'Password!123' });
      const stampede = await Promise.all(
        Array.from({ length: 10 }, () =>
          u1.post('/api/live/bet', { bets: { tai: 2_000_000 }, liveRoundId: roundId })
        )
      );
      assert.equal(stampede.filter((r) => r.status === 200).length, 5);
      assert.equal(stampede.filter((r) => r.status === 400).length, 5);
      const u1State = await u1.get('/api/live/state');
      assert.equal(u1State.json.ticket.totalBet, 10_000_000);
      assert.equal((await u1.get('/api/auth/me')).json.user.balance, 0);

      // T5-3.2a: 5x parallel identical Idempotency-Key on /api/live/bet
      const u2 = createClient(server.baseUrl);
      await u2.post('/api/auth/register', { username: 't5_live_idem', password: 'Password!123' });
      const idem5 = await Promise.all(
        Array.from({ length: 5 }, () =>
          u2.post(
            '/api/live/bet',
            { bets: { xiu: 1_000_000 }, liveRoundId: roundId },
            { headers: { 'Idempotency-Key': 't5-live-idem-key' } }
          )
        )
      );
      for (const r of idem5) assert.equal(r.status, 200);
      assert.equal(idem5.filter((r) => r.json.replayed === false).length, 1);
      assert.equal(idem5.filter((r) => r.json.replayed === true).length, 4);
      assert.equal((await u2.get('/api/auth/me')).json.user.balance, 9_000_000);

      // Same key + differing payload -> 409 IDEMPOTENCY_CONFLICT (both /api/live/bet and /api/roll)
      const liveConflict = await u2.post(
        '/api/live/bet',
        { bets: { tai: 1_000_000 }, liveRoundId: roundId },
        { headers: { 'Idempotency-Key': 't5-live-idem-key' } }
      );
      assert.equal(liveConflict.status, 409);

      const roll1 = await u2.post(
        '/api/roll',
        { bets: { tai: 50_000 } },
        { headers: { 'Idempotency-Key': 't5-roll-idem-key' } }
      );
      assert.equal(roll1.status, 200);
      const rollConflict = await u2.post(
        '/api/roll',
        { bets: { xiu: 50_000 } },
        { headers: { 'Idempotency-Key': 't5-roll-idem-key' } }
      );
      assert.equal(rollConflict.status, 409);
      assert.equal((await u2.get('/api/auth/me')).json.user.balance, roll1.json.newBalance);

      // T5-3.2b: 2x parallel 600M bets on same gate -> 1x 200, 1x 400 (MAX_SINGLE_BET 1B cap)
      const u3 = createClient(server.baseUrl);
      const reg3 = await u3.post('/api/auth/register', { username: 't5_cap_whale', password: 'Password!123' });
      await admin.post(`/api/admin/users/${reg3.json.user.id}/adjust-balance`, {
        amount: 2_000_000_000,
        reason: 'Whale test fund',
      });
      const capRace = await Promise.all([
        u3.post('/api/live/bet', { bets: { tai: 600_000_000 }, liveRoundId: roundId }),
        u3.post('/api/live/bet', { bets: { tai: 600_000_000 }, liveRoundId: roundId }),
      ]);
      assert.deepEqual(capRace.map((r) => r.status).sort((a, b) => a - b), [200, 400]);
    } finally {
      await server.close();
    }
  });

  it('T5-3.3 & T5-3.4: 8x parallel daily-bonus / bankruptcy-aid, 2x guest upgrade, and 2x parallel /api/auth/recover (BUG-1)', async () => {
    const server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't5_bonus_admin' },
    });
    try {
      const admin = createClient(server.baseUrl);
      await admin.post('/api/auth/register', { username: 't5_bonus_admin', password: 'AdminPass!123' });

      // 8x parallel daily-bonus -> 1x 200, 7x 429
      const bonusUser = createClient(server.baseUrl);
      const regB = await bonusUser.post('/api/auth/register', { username: 't5_bonus_race', password: 'Password!123' });
      const bRace = await Promise.all(
        Array.from({ length: 8 }, () => bonusUser.post('/api/wallet/daily-bonus', {}))
      );
      assert.equal(bRace.filter((r) => r.status === 200).length, 1);
      assert.equal(bRace.filter((r) => r.status === 429).length, 7);
      assert.equal((await bonusUser.get('/api/auth/me')).json.user.balance, 12_000_000);

      // 8x parallel bankruptcy-aid -> 1x 200, 7x 400/429
      await admin.post(`/api/admin/users/${regB.json.user.id}/adjust-balance`, {
        amount: -(12_000_000 - 5_000),
        reason: 'Drain to 5000',
      });
      const aidRace = await Promise.all(
        Array.from({ length: 8 }, () => bonusUser.post('/api/wallet/bankruptcy-aid', {}))
      );
      assert.equal(aidRace.filter((r) => r.status === 200).length, 1);
      assert.equal(aidRace.filter((r) => r.status === 400 || r.status === 429).length, 7);
      assert.equal((await bonusUser.get('/api/auth/me')).json.user.balance, 505_000);

      // 2x parallel guest upgrade -> 1x 200, 1x 400, old guest cookie 401
      const guest = createClient(server.baseUrl);
      await guest.post('/api/auth/guest', {});
      const oldGuestCookie = guest.snapshotCookie();
      const upRace = await Promise.all([
        guest.post('/api/auth/upgrade', { username: 't5_up_race_a', password: 'Password!123' }),
        guest.post('/api/auth/upgrade', { username: 't5_up_race_b', password: 'Password!123' }),
      ]);
      assert.deepEqual(upRace.map((r) => r.status).sort((a, b) => a - b), [200, 400]);
      const staleGuest = createClient(server.baseUrl);
      staleGuest.setRawCookieHeader(oldGuestCookie);
      assert.equal((await staleGuest.get('/api/auth/me')).status, 401);

      // BUG-1: 2x parallel /api/auth/recover with same recoveryCode -> 1x 200, 1x 401
      const recUser = createClient(server.baseUrl);
      const regRec = await recUser.post('/api/auth/register', { username: 't5_rec_race', password: 'Password!123' });
      const code = regRec.json.recoveryCode;
      const recRace = await Promise.all([
        createClient(server.baseUrl).post('/api/auth/recover', {
          username: 't5_rec_race',
          recoveryCode: code,
          newPassword: 'NewPassword!111',
        }),
        createClient(server.baseUrl).post('/api/auth/recover', {
          username: 't5_rec_race',
          recoveryCode: code,
          newPassword: 'NewPassword!222',
        }),
      ]);
      assert.deepEqual(recRace.map((r) => r.status).sort((a, b) => a - b), [200, 401]);
    } finally {
      await server.close();
    }
  });

  it('T5-3.5 & T5-3.6: Clocked Live settle races, missed-REVEAL unsettledTickets, invalid roundId & full mixed wallet_ledger invariant', async () => {
    const roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    const round1 = Math.floor(roundStart / LIVE_ROUND_MS);
    const server = await startClockedServer({
      initialNowMs: roundStart + 1000,
      env: { ADMIN_USERNAME: 't5_clock_admin' },
    });
    try {
      const admin = createClient(server.baseUrl);
      await admin.post('/api/auth/register', { username: 't5_clock_admin', password: 'AdminPass!123' });

      const player = createClient(server.baseUrl);
      const regP = await player.post('/api/auth/register', { username: 't5_mixed_player', password: 'Password!123' });
      const pid = regP.json.user.id;
      const bystander = createClient(server.baseUrl);
      await bystander.post('/api/auth/register', { username: 't5_bystander', password: 'Password!123' });

      // 1. Place bet in round1, advance into REVEAL, 5-way parallel settle -> 1 settledNow, 4 alreadySettled
      await player.post('/api/live/bet', { bets: { tai: 20_000 }, liveRoundId: round1 });
      await server.setTime(roundStart + LIVE_BET_MS + 500);

      const settles = await Promise.all(
        Array.from({ length: 5 }, () => player.post('/api/live/settle', { liveRoundId: round1 }))
      );
      for (const s of settles) assert.equal(s.status, 200);
      assert.equal(settles.filter((s) => s.json.settledNow === true).length, 1);
      assert.equal(settles.filter((s) => s.json.alreadySettled === true).length, 4);

      // Future round -> 400; missing ticket -> 404; invalid liveRoundId -> 400
      assert.equal((await player.post('/api/live/settle', { liveRoundId: round1 + 1 })).status, 400);
      assert.equal((await bystander.post('/api/live/settle', { liveRoundId: round1 })).status, 404);
      for (const badId of [-1, 1.5, '100']) {
        assert.equal((await player.post('/api/live/settle', { liveRoundId: badId })).status, 400);
      }

      // 2. Missed-REVEAL unsettledTickets flow: bet in round2, skip REVEAL directly to round3 BETTING
      const round2 = round1 + 1;
      await server.setTime(roundStart + LIVE_ROUND_MS + 1000);
      assert.equal((await player.post('/api/live/bet', { bets: { xiu: 10_000 }, liveRoundId: round2 })).status, 200);

      await server.setTime(roundStart + 2 * LIVE_ROUND_MS + 1000);
      const stateR3 = await player.get('/api/state');
      const liveR3 = await player.get('/api/live/state');
      assert.equal(stateR3.json.live.liveRoundId, round2 + 1);
      assert.ok(stateR3.json.unsettledLiveTickets.some((t) => t.liveRoundId === round2 && !t.settled));
      assert.ok(liveR3.json.unsettledTickets.some((t) => t.liveRoundId === round2 && !t.settled));

      // Settle past round2 from round3
      const pastSettle = await player.post('/api/live/settle', { liveRoundId: round2 });
      assert.equal(pastSettle.status, 200);
      assert.equal(pastSettle.json.settledNow, true);

      // 3. T5-3.6 Mixed-sequence wallet_ledger invariant across all modes
      await player.post('/api/wallet/daily-bonus', {});
      await player.post('/api/roll', { bets: { tai: 20_000, double_2: 5_000 } });
      await player.post('/api/roll', { bets: { tai: 10_000, xiu: 10_000 } }); // breakeven when non-triple

      const round3 = round2 + 1;
      await player.post('/api/live/bet', { bets: { even: 15_000 }, liveRoundId: round3 });
      await player.post('/api/live/bet', { bets: { odd: 15_000 }, liveRoundId: round3 });
      await server.setTime(roundStart + 2 * LIVE_ROUND_MS + LIVE_BET_MS + 500);
      await player.post('/api/live/settle', { liveRoundId: round3 });

      const curBal = (await player.get('/api/auth/me')).json.user.balance;
      await admin.post(`/api/admin/users/${pid}/adjust-balance`, {
        amount: -(curBal - 5_000),
        reason: 'Drain below 10k for mixed ledger test',
      });
      await player.post('/api/wallet/bankruptcy-aid', {});
      await player.post('/api/roll', { bets: { tai: 5_000, xiu: 5_000 } });

      const meFinal = await player.get('/api/auth/me');
      const ledger = meFinal.json.ledger;
      assert.ok(ledger.length >= 9 && ledger.length < 50);
      const chrono = ledger.slice().reverse();
      let running = 10_000_000;
      for (let i = 0; i < chrono.length; i++) {
        assert.equal(chrono[i].balanceBefore, running);
        assert.equal(chrono[i].balanceBefore + chrono[i].amount, chrono[i].balanceAfter);
        running = chrono[i].balanceAfter;
      }
      assert.equal(running, meFinal.json.user.balance);
    } finally {
      await server.close();
    }
  });
});

// =============================================================================
// T5-4: Fairness, clientSeed, VERCEL=1 & Frontend Contracts
// =============================================================================
describe('Tier 5 — T5-4: Fairness, clientSeed, VERCEL=1 & Frontend State/Security Contracts', () => {
  it('T5-4.1: clientSeed edge cases (whitespace, 64/65 chars, Unicode+HTML) & WebCrypto parity across edge nonces', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      await client.post('/api/auth/register', { username: 't5_fair_edge', password: 'Password!123' });

      // Whitespace-only falls back to active seed
      const wsRoll = await client.post('/api/roll', { bets: { tai: 1000 }, clientSeed: '    ' });
      assert.equal(wsRoll.status, 200);
      assert.equal(wsRoll.json.fairness.clientSeed, 'sovereign-vip-888');

      // 64-char clientSeed accepted, 65-char rejected 400 on /api/roll & /api/fairness/rotate
      const seed64 = 'A'.repeat(64);
      const seed65 = 'A'.repeat(65);
      assert.equal((await client.post('/api/roll', { bets: { tai: 1000 }, clientSeed: seed64 })).status, 200);
      assert.equal((await client.post('/api/roll', { bets: { tai: 1000 }, clientSeed: seed65 })).status, 400);
      assert.equal((await client.post('/api/fairness/rotate', { clientSeed: seed65 })).status, 400);

      // Unicode + HTML payload accepted & verified
      const xssSeed = '<img src=x onerror=1>🎲VIP';
      const rot = await client.post('/api/fairness/rotate', { clientSeed: xssSeed });
      assert.equal(rot.status, 200);
      assert.equal(rot.json.current.clientSeed, xssSeed);
      assert.equal(rot.json.current.nonce, 0);

      const xssRoll = await client.post('/api/roll', { bets: { tai: 1000 } });
      assert.equal(xssRoll.status, 200);
      assert.equal(xssRoll.json.fairness.clientSeed, xssSeed);
      assert.equal(xssRoll.json.fairness.nonce, 0);

      const rot2 = await client.post('/api/fairness/rotate', {});
      assert.equal(rot2.status, 200);
      const wcDice = await webCryptoDeriveFairDice(rot2.json.previous.serverSeed, xssSeed, 0);
      assert.deepEqual(wcDice, xssRoll.json.dice);

      // Edge-seed + edge-nonce WebCrypto vs /api/verify-fairness vs public/app.js deriveFairDice
      const appJs = (await client.get('/app.js')).text;
      const deriveFn = extractBalancedJsFunction(appJs, 'deriveFairDice');
      const hmacFn = extractBalancedJsFunction(appJs, 'hmacSha256Bytes');
      assert.ok(deriveFn && hmacFn);

      const vmCtx = {
        TextEncoder,
        Uint8Array,
        Array,
        String,
        Number,
        TypeError,
        RangeError,
        window: { crypto: globalThis.crypto },
      };
      vm.runInNewContext(`${hmacFn}\n${deriveFn}\nthis.appDeriveFairDice = deriveFairDice;`, vmCtx);

      for (const vec of [
        { serverSeed: 'edge-s1', clientSeed: '', nonce: 0 },
        { serverSeed: 'edge-s1', clientSeed: '   ', nonce: 0 },
        { serverSeed: 'edge-s2', clientSeed: '<script>alert(1)</script>', nonce: 2 ** 32 },
        { serverSeed: 'edge-s3', clientSeed: '🎲 Tài Xỉu VIP 888 🔥', nonce: Number.MAX_SAFE_INTEGER },
      ]) {
        const srvRes = await client.post('/api/verify-fairness', vec);
        assert.equal(srvRes.status, 200);
        const appRes = await vmCtx.appDeriveFairDice(vec.serverSeed, vec.clientSeed, vec.nonce);
        const wcDiceVec = await webCryptoDeriveFairDice(vec.serverSeed, vec.clientSeed, vec.nonce);
        assert.deepEqual([...appRes.dice], srvRes.json.dice);
        assert.deepEqual(wcDiceVec, srvRes.json.dice);
      }

      // Invalid nonces rejected 400 server-side and throw client-side
      for (const badNonce of [-1, 1.5, 'abc', null, Number.MAX_SAFE_INTEGER + 1]) {
        const srvBad = await client.post('/api/verify-fairness', {
          serverSeed: 'edge-s1',
          clientSeed: 'abc',
          nonce: badNonce,
        });
        assert.equal(srvBad.status, 400);
        await assert.rejects(() => vmCtx.appDeriveFairDice('edge-s1', 'abc', badNonce));
      }
    } finally {
      await server.close();
    }
  });

  it('T5-4.2: VERCEL=1 with partial/whitespace secrets boots 200, warns, sets Secure cookie, and preserves repo data/', async () => {
    const projectDataDir = path.join(DEFAULT_PROJECT_ROOT, 'data');
    const beforeData = fs.readdirSync(projectDataDir).sort().map((f) => {
      const st = fs.statSync(path.join(projectDataDir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    });

    for (const envCase of [
      { JWT_SECRET: 'only-jwt-secret-set-0123456789abcdef', LIVE_MASTER_SECRET: undefined },
      { JWT_SECRET: '   ', LIVE_MASTER_SECRET: '   ' },
    ]) {
      const vs = await startTestServer({
        vercel: true,
        stripSecrets: true,
        clearCloudEnv: true,
        env: envCase,
      });
      try {
        const c = createClient(vs.baseUrl);
        assert.equal((await c.get('/api/state')).status, 200);
        const reg = await c.post('/api/auth/register', { username: 't5_v_edge', password: 'Password!123' });
        assert.equal(reg.status, 201);
        assert.equal(c.getCookieMeta('sicbo_token')?.secure, true);
        assert.equal((await c.post('/api/roll', { bets: { tai: 1000 } })).status, 200);

        const logs = `${vs.getLogs().stdout}\n${vs.getLogs().stderr}`;
        assert.match(logs, /warn|ephemeral|degraded|JWT_SECRET|LIVE_MASTER_SECRET/i);
      } finally {
        await vs.close();
      }
    }

    const afterData = fs.readdirSync(projectDataDir).sort().map((f) => {
      const st = fs.statSync(path.join(projectDataDir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    });
    assert.deepEqual(afterData, beforeData);
  });

  it('T5-4.3: Frontend app.js/style.css/index.html enforce missed-REVEAL auto-settle, 401 no-guest-switch, logout/login isolation, REVEAL guard, double-click locks, localStorage & modal cursor', async () => {
    const server = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(server.baseUrl);
      const [rHtml, rCss, rApp] = await Promise.all([
        client.get('/'),
        client.get('/style.css'),
        client.get('/app.js'),
      ]);
      const html = rHtml.text;
      const css = rCss.text;
      const appJs = rApp.text;

      // 1. Finding 1: auto-settle unsettled past-round Live tickets
      assert.match(appJs, /async function settleUnsettledPastLiveTickets/);
      assert.match(appJs, /settlingPastRounds/);
      assert.match(appJs, /await settleUnsettledPastLiveTickets\(data\.unsettledLiveTickets/);
      assert.match(appJs, /await settleUnsettledPastLiveTickets\(json\.unsettledTickets/);

      // 2. Finding 2: startRoll & submitLiveBet must NOT call ensureGuestSessionIfNeeded on 401
      const startRollCode = extractBalancedJsFunction(appJs, 'startRoll');
      assert.ok(startRollCode);
      assert.match(startRollCode, /hadUserSession\s*\?\s*true\s*:\s*await ensureGuestSessionIfNeeded/);
      assert.match(startRollCode, /if\s*\(res\.status\s*===\s*401\)\s*\{\s*openAuthModal\('authPaneLogin'\);\s*return false;\s*\}/);

      const submitLiveCode = extractBalancedJsFunction(appJs, 'submitLiveBet');
      assert.ok(submitLiveCode);
      assert.match(submitLiveCode, /if\s*\(res\.status\s*===\s*401\)\s*\{\s*openAuthModal\('authPaneLogin'\);\s*return false;\s*\}/);

      // 3. Finding 3: resetClientSessionState on login/register/logout/data.user===null + spectator fallback on 404 settle
      assert.match(appJs, /function resetClientSessionState/);
      assert.match(appJs, /state\.liveTicket\s*=\s*null;/);
      assert.match(appJs, /state\.liveRevealedRoundId\s*=\s*null;/);
      const revealCode = extractBalancedJsFunction(appJs, 'handleLiveRoundReveal');
      assert.ok(revealCode);
      assert.match(revealCode, /const totalBet\s*=\s*settledRes\s*\?\s*settledRes\.totalBet\s*:\s*0;/);

      // 4. Finding 4: syncLiveStateFromServer defers liveRevealedRoundId until handleLiveRoundReveal passes guard
      const syncCode = extractBalancedJsFunction(appJs, 'syncLiveStateFromServer');
      assert.ok(syncCode);
      assert.equal(/state\.liveRevealedRoundId\s*=\s*json\.liveRoundId/.test(syncCode), false);
      assert.match(revealCode, /if\s*\(state\.isRolling\s*\|\|\s*state\.isSubmittingRoll\s*\|\|\s*state\.isSqueezeActive\)\s*return false;\s*state\.liveRevealedRoundId\s*=\s*liveState\.liveRoundId;/);

      // 5. Finding 5 & 6: in-flight guards, MAX_SINGLE_BET cap on btnDouble, Number.isSafeInteger adminAdjust, Object.hasOwn, setAuthFeedback class reset
      assert.match(appJs, /async function withInFlightGuard/);
      for (const opKey of ['rotateClientSeed', 'dailyBonus', 'bankruptcyAid', 'authLogin', 'authGuest', 'authRegister', 'authUpgrade', 'authChangePassword', 'authRecover']) {
        assert.ok(appJs.includes(`'${opKey}'`), `Missing withInFlightGuard key ${opKey}`);
      }
      assert.match(appJs, /Object\.hasOwn\(BET_LABELS/);
      assert.match(appJs, /Object\.hasOwn\(TYPE_LABELS/);
      assert.match(appJs, /Number\.isSafeInteger\(parsedAmount\)/);
      assert.match(appJs, /el\.adminModal\.classList\.contains\('open'\)\)\s*\{\s*closeModal\(el\.adminModal\)/);
      assert.match(appJs, /v\s*\*\s*2\s*>\s*MAX_SINGLE_BET/);

      const setFbCode = extractBalancedJsFunction(appJs, 'setAuthFeedback');
      const fbEl = { className: 'auth-feedback is-error', textContent: 'err' };
      vm.runInNewContext(
        `${setFbCode}\nsetAuthFeedback('');`,
        { el: { authFormFeedback: fbEl }, String }
      );
      assert.equal(fbEl.className, 'auth-feedback hidden');
      assert.equal(fbEl.textContent, '');

      // 6. localStorage corruption / QuotaExceededError safety
      const readPrefCode = extractBalancedJsFunction(appJs, 'readPref');
      const writePrefCode = extractBalancedJsFunction(appJs, 'writePref');
      const lsCtx = {
        localStorage: {
          getItem() { throw new Error('SecurityError'); },
          setItem() { throw new Error('QuotaExceededError'); },
        },
        String,
        outRead: null,
      };
      vm.runInNewContext(`${readPrefCode}\n${writePrefCode}\noutRead = readPref('sicbo_graphics_quality', 'high'); writePref('k', 'v');`, lsCtx);
      assert.equal(lsCtx.outRead, 'high');

      // 7. All 6 modals in ALL_MODAL_IDS exist in HTML and CSS restores cursor on body.modal-open
      const modalMatch = appJs.match(/const\s+ALL_MODAL_IDS\s*=\s*(\[[^\]]+\])/);
      assert.ok(modalMatch);
      const modalIds = vm.runInNewContext(modalMatch[1]);
      assert.equal(modalIds.length, 6);
      for (const id of modalIds) {
        assert.ok(html.includes(`id="${id}"`), `Missing modal #${id} in index.html`);
      }
      assert.match(css, /body\.modal-open[^}]*cursor\s*:\s*auto/);

      // 8. Real VM behavioral execution of full /app.js in an isolated DOM + fetch sandbox
      const pendingTimers = new Set();
      const pendingIntervals = new Set();

      function createClassList(initial = []) {
        const set = new Set(initial);
        return {
          add(...cls) { cls.forEach(c => set.add(c)); },
          remove(...cls) { cls.forEach(c => set.delete(c)); },
          toggle(c, force) {
            if (force === undefined) {
              if (set.has(c)) { set.delete(c); return false; }
              set.add(c); return true;
            }
            if (force) set.add(c);
            else set.delete(c);
            return Boolean(force);
          },
          contains(c) { return set.has(c); },
          toString() { return Array.from(set).join(' '); },
        };
      }

      function createMockElement(tagName = 'div', id = '') {
        const listeners = new Map();
        const attrs = new Map();
        if (id) attrs.set('id', id);
        let _className = '';
        const classList = createClassList();
        const children = [];
        const subElements = new Map();

        const elem = {
          tagName: tagName.toUpperCase(),
          id,
          value: '',
          textContent: '',
          _innerHTML: '',
          get innerHTML() { return this._innerHTML; },
          set innerHTML(val) {
            this._innerHTML = String(val ?? '');
            if (this._innerHTML === '') children.length = 0;
          },
          get className() { return _className || classList.toString(); },
          set className(val) {
            _className = String(val ?? '');
            for (const c of _className.split(/\s+/).filter(Boolean)) classList.add(c);
            // Replace classList contents to match className assignment semantics
            const keep = new Set(_className.split(/\s+/).filter(Boolean));
            for (const existing of classList.toString().split(/\s+/).filter(Boolean)) {
              if (!keep.has(existing)) classList.remove(existing);
            }
          },
          disabled: false,
          checked: false,
          selectedIndex: 0,
          options: [{ text: 'Cao' }],
          style: {},
          dataset: {},
          scrollLeft: 0,
          scrollWidth: 100,
          parentNode: null,
          children,
          classList,
          appendChild(child) {
            child.parentNode = this;
            children.push(child);
            return child;
          },
          removeChild(child) {
            const idx = children.indexOf(child);
            if (idx !== -1) children.splice(idx, 1);
            child.parentNode = null;
            return child;
          },
          setAttribute(k, v) {
            attrs.set(k, String(v));
            if (k === 'id') this.id = String(v);
          },
          getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
          addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          },
          dispatchEvent(evt) {
            const list = listeners.get(evt.type) || [];
            const results = [];
            for (const fn of list) {
              results.push(fn({ preventDefault() {}, stopPropagation() {}, target: elem, ...evt }));
            }
            return results;
          },
          click() {
            if (this.disabled) return;
            return this.dispatchEvent({ type: 'click' });
          },
          // Force-invoke click listeners even if disabled=true to prove inFlightOps Set guard works independently
          invokeClickBypassingDisabled() {
            return this.dispatchEvent({ type: 'click' });
          },
          select() {},
          getBoundingClientRect() { return { left: 10, top: 10, width: 60, height: 40 }; },
          querySelector(sel) {
            if (!subElements.has(sel)) {
              const sub = createMockElement('div');
              subElements.set(sel, sub);
            }
            return subElements.get(sel);
          },
          querySelectorAll(sel) {
            if (sel === '.zen-chip') return chipsList;
            if (sel === '.auth-pane' && this.id === 'authModal') {
              return [getEl('authPaneLogin'), getEl('authPaneRegister'), getEl('authPaneRecover'), getEl('authPaneProfile')];
            }
            return [];
          },
        };
        return elem;
      }

      const elementsById = new Map();
      function getEl(id, tag = 'div') {
        if (!elementsById.has(id)) elementsById.set(id, createMockElement(tag, id));
        return elementsById.get(id);
      }

      const chip10k = createMockElement('button');
      chip10k.setAttribute('data-val', '10000');
      chip10k.classList.add('zen-chip', 'active');
      const chip5m = createMockElement('button');
      chip5m.setAttribute('data-val', '5000000');
      chip5m.classList.add('zen-chip');
      const chipAllIn = getEl('chipAllIn', 'button');
      chipAllIn.classList.add('zen-chip');
      const chipsList = [chip10k, chip5m, chipAllIn];
      getEl('chipsSelector');

      const spotTai = createMockElement('div');
      spotTai.setAttribute('data-bet', 'tai');
      spotTai.classList.add('bet-spot');
      const spotXiu = createMockElement('div');
      spotXiu.setAttribute('data-bet', 'xiu');
      spotXiu.classList.add('bet-spot');
      const betSpots = [spotTai, spotXiu];

      const docBody = createMockElement('body');
      const docListeners = new Map();
      const winListeners = new Map();

      let fetchHandler = async () => ({ status: 200, ok: true, async json() { return { history: [] }; } });
      const fetchCalls = [];
      const mockEngine = {
        callbacks: {},
        shakeCb: null,
        openCb: null,
        setBowlOpaqueForSqueeze() {},
        setGraphicsQuality() {},
        setDiceFacesInstant() {},
        shakeAndRoll(dice, onShake, onComplete) {
          mockEngine.shakeCb = onComplete;
        },
        openBowlQuick(cb) {
          mockEngine.openCb = cb;
          if (cb) cb();
        },
      };

      const sandboxDoc = {
        hidden: false,
        activeElement: null,
        body: docBody,
        getElementById(id) { return getEl(id); },
        createElement(tag) { return createMockElement(tag); },
        querySelector(sel) {
          const m = sel.match(/^\.bet-spot\[data-bet="([^"]+)"\]$/);
          if (m) return betSpots.find(s => s.getAttribute('data-bet') === m[1]) || null;
          return null;
        },
        querySelectorAll(sel) {
          if (sel === '.bet-spot') return betSpots;
          return [];
        },
        addEventListener(type, fn) {
          if (!docListeners.has(type)) docListeners.set(type, []);
          docListeners.get(type).push(fn);
        },
      };

      const sandboxWin = {
        crypto: {
          getRandomValues: (arr) => crypto.randomFillSync(arr),
          randomUUID: () => crypto.randomUUID(),
          subtle: crypto.webcrypto.subtle,
        },
        matchMedia: () => ({ matches: false }),
        innerWidth: 1280,
        innerHeight: 800,
        soundFX: {
          enabled: true,
          toggle() { this.enabled = !this.enabled; },
          playTick() {}, playChip() {}, playChipRemove() {},
          playWin() {}, playBigWin() {}, playLoss() {}, playBreakeven() {},
          playBonus() {}, playToast() {}, playDiceShake() {}, playDiceBounce() {},
          playSqueezeTension() {},
        },
        gsap: null,
        confetti: null,
        ThreeUIFX: { setGraphicsQuality() {} },
        addEventListener(type, fn) {
          if (!winListeners.has(type)) winListeners.set(type, []);
          winListeners.get(type).push(fn);
        },
      };

      const sandbox = {
        window: sandboxWin,
        document: sandboxDoc,
        navigator: { clipboard: { writeText: async () => {} } },
        localStorage: {
          _store: new Map(),
          getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
          setItem(k, v) { this._store.set(k, String(v)); },
        },
        Sicbo3DEngine: function Sicbo3DEngine() { return mockEngine; },
        TextEncoder,
        fetch: async (url, opts) => {
          fetchCalls.push({ url, opts });
          return fetchHandler(url, opts);
        },
        setTimeout(fn, ms) {
          const t = setTimeout(() => { pendingTimers.delete(t); fn(); }, Math.min(ms || 0, 50));
          pendingTimers.add(t);
          return t;
        },
        clearTimeout(t) { pendingTimers.delete(t); clearTimeout(t); },
        setInterval(fn, ms) {
          const i = setInterval(fn, Math.max(ms || 50, 50));
          pendingIntervals.add(i);
          return i;
        },
        clearInterval(i) { pendingIntervals.delete(i); clearInterval(i); },
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() {},
        console,
        Date, Math, Number, String, Boolean, Array, Object, Set, Map, Promise, Error, TypeError, RangeError, JSON,
        encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
      };
      sandboxWin.window = sandboxWin;
      sandbox.globalThis = sandbox;

      try {
        vm.runInNewContext(appJs, sandbox);
        const domReadyCbs = docListeners.get('DOMContentLoaded') || [];
        assert.equal(domReadyCbs.length, 1);
        domReadyCbs[0]();
        await new Promise(r => setImmediate(r));

        function deferred() {
          let resolve;
          const promise = new Promise(r => { resolve = r; });
          return { promise, resolve };
        }
        function jsonResp(status, data) {
          return { status, ok: status >= 200 && status < 300, async json() { return data; } };
        }

        // 8a. Double-click in-flight guards on Admin Ops + Seed Rotate + Daily Bonus + Bankruptcy Aid
        let stateBalance = 1500000000;
        let activeDefer = null;
        fetchHandler = async (url) => {
          if (url === '/api/auth/login') {
            return jsonResp(200, { user: { id: 'adm_1', username: 'admin', displayName: 'Admin', role: 'admin', balance: stateBalance } });
          }
          if (url === '/api/state') {
            return jsonResp(200, {
              serverTime: Date.now(),
              user: { id: 'adm_1', username: 'admin', displayName: 'Admin', role: 'admin', balance: stateBalance },
              history: [{ id: 1001, dice: [4, 5, 6], total: 15, outcome: 'TAI', isTriple: false }],
              personalHistory: [{ roundId: 900, timestamp: new Date().toISOString(), dice: [1, 2, 3], total: 6, outcome: 'XIU', bets: { xiu: 10000 }, totalBet: 10000, netProfit: 10000 }],
              ledger: [{ id: 'l1', type: 'daily_bonus', amount: 2000000, balanceBefore: 0, balanceAfter: 2000000, reason: 'bonus', timestamp: new Date().toISOString() }],
              fairness: { serverSeedHash: 'a'.repeat(64), clientSeed: 'seed-1', nonce: 1 },
              live: { liveRoundId: 500, ticket: { liveRoundId: 500, totalBet: 10000, settled: false } },
              unsettledLiveTickets: [],
            });
          }
          if (url.startsWith('/api/admin/users?q=')) {
            if (activeDefer) return activeDefer.promise;
            return jsonResp(200, { users: [{ id: 'u_tgt', username: 'target', displayName: 'Target', role: 'user', balance: 500000, locked: false }] });
          }
          if (activeDefer) return activeDefer.promise;
          return jsonResp(200, { ok: true });
        };

        getEl('loginUsername').value = 'admin';
        getEl('loginPassword').value = 'AdminPass!123';
        await Promise.all(getEl('btnLoginSubmit').click());

        // Open admin panel & verify row buttons
        getEl('btnOpenAdmin').click();
        await new Promise(r => setImmediate(r));
        assert.equal(getEl('adminUsersTableBody').children.length, 1);

        // Double-click #btnAdminSearch
        fetchCalls.length = 0;
        activeDefer = deferred();
        getEl('btnAdminSearch').click();
        assert.equal(getEl('btnAdminSearch').disabled, true);
        getEl('btnAdminSearch').click();
        getEl('btnAdminSearch').invokeClickBypassingDisabled();
        assert.equal(fetchCalls.filter(c => c.url.startsWith('/api/admin/users?q=')).length, 1);
        activeDefer.resolve(jsonResp(200, { users: [{ id: 'u_tgt', username: 'target', displayName: 'Target', role: 'user', balance: 500000, locked: false }] }));
        activeDefer = null;
        await new Promise(r => setImmediate(r));
        assert.equal(getEl('btnAdminSearch').disabled, false);

        // Double-click #btnAdminAdjustSubmit
        fetchCalls.length = 0;
        getEl('adminAdjustUserId').value = 'u_tgt';
        getEl('adminAdjustAmount').value = '1000000';
        getEl('adminAdjustReason').value = 'audit dbl';
        activeDefer = deferred();
        getEl('btnAdminAdjustSubmit').click();
        assert.equal(getEl('btnAdminAdjustSubmit').disabled, true);
        getEl('btnAdminAdjustSubmit').click();
        getEl('btnAdminAdjustSubmit').invokeClickBypassingDisabled();
        assert.equal(fetchCalls.filter(c => c.url === '/api/admin/users/u_tgt/adjust-balance').length, 1);
        activeDefer.resolve(jsonResp(200, { ok: true }));
        activeDefer = null;
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.equal(getEl('btnAdminAdjustSubmit').disabled, false);

        // Double-click .btn-adm-lock and .btn-adm-reset
        const row0 = getEl('adminUsersTableBody').children[0];
        const lockBtn = row0.querySelector('.btn-adm-lock');
        const resetBtn = row0.querySelector('.btn-adm-reset');

        fetchCalls.length = 0;
        activeDefer = deferred();
        lockBtn.click();
        assert.equal(lockBtn.disabled, true);
        lockBtn.click();
        lockBtn.invokeClickBypassingDisabled();
        assert.equal(fetchCalls.filter(c => c.url === '/api/admin/users/u_tgt/toggle-lock').length, 1);
        activeDefer.resolve(jsonResp(200, { ok: true }));
        activeDefer = null;
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        const row0After = getEl('adminUsersTableBody').children[0];
        const resetBtnAfter = row0After.querySelector('.btn-adm-reset');
        fetchCalls.length = 0;
        activeDefer = deferred();
        resetBtnAfter.click();
        assert.equal(resetBtnAfter.disabled, true);
        resetBtnAfter.click();
        resetBtnAfter.invokeClickBypassingDisabled();
        assert.equal(fetchCalls.filter(c => c.url === '/api/admin/users/u_tgt/reset-password').length, 1);
        activeDefer.resolve(jsonResp(200, { tempPassword: 'Temp!1234' }));
        activeDefer = null;
        await new Promise(r => setImmediate(r));
        assert.equal(resetBtnAfter.disabled, false);
        // Clean up unused initial resetBtn reference
        assert.ok(resetBtn);

        // Double-click #btnRotateClientSeed & #btnDailyBonus
        for (const [btnId, endpoint, respData] of [
          ['btnRotateClientSeed', '/api/fairness/rotate', { current: { serverSeedHash: 'b'.repeat(64), clientSeed: 'new-seed', nonce: 0 } }],
          ['btnDailyBonus', '/api/wallet/daily-bonus', { balance: 1502000000, bonusAmount: 2000000 }],
        ]) {
          fetchCalls.length = 0;
          activeDefer = deferred();
          getEl(btnId).click();
          assert.equal(getEl(btnId).disabled, true);
          getEl(btnId).click();
          getEl(btnId).invokeClickBypassingDisabled();
          await Promise.resolve();
          await Promise.resolve();
          assert.equal(fetchCalls.filter(c => c.url === endpoint).length, 1);
          activeDefer.resolve(jsonResp(200, respData));
          activeDefer = null;
          await new Promise(r => setImmediate(r));
          await new Promise(r => setImmediate(r));
          assert.equal(getEl(btnId).disabled, false);
        }

        // Double-click #btnBankruptcyAid when balance < 10000 and verify disabled stays true afterward
        stateBalance = 5000;
        getEl('loginUsername').value = 'poor';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());
        assert.equal(getEl('btnBankruptcyAid').disabled, false);
        fetchCalls.length = 0;
        activeDefer = deferred();
        getEl('btnBankruptcyAid').click();
        assert.equal(getEl('btnBankruptcyAid').disabled, true);
        getEl('btnBankruptcyAid').invokeClickBypassingDisabled();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(fetchCalls.filter(c => c.url === '/api/wallet/bankruptcy-aid').length, 1);
        stateBalance = 505000;
        activeDefer.resolve(jsonResp(200, { balance: 505000, aidAmount: 500000 }));
        activeDefer = null;
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.equal(getEl('btnBankruptcyAid').disabled, true);

        // 8b. placeOrRemoveChip MAX_SINGLE_BET + btnDouble MAX_SINGLE_BET + btnUndo/btnRemoveMode/btnRebet
        stateBalance = 1500000000;
        getEl('loginUsername').value = 'whale';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());

        // ALL-IN (> 1B) must be rejected without mutating bets
        chipAllIn.click();
        getEl('toastContainer').children.length = 0;
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, '');
        assert.ok(getEl('toastContainer').children.some(t => t.textContent.includes('1,000,000,000')));

        // 5M chip: add 2x -> 10M, Undo -> 5M, RemoveMode -> 0, Rebet after roll
        chip5m.click();
        spotTai.click();
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (10000000).toLocaleString('vi-VN'));
        getEl('btnUndo').click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (5000000).toLocaleString('vi-VN'));
        getEl('btnRemoveMode').click();
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, '');
        getEl('btnRemoveMode').click();

        // 8c. Wallet timing invariant: pre-shake deduction vs post-reveal credit + Rebet
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (5000000).toLocaleString('vi-VN'));
        fetchHandler = async (url) => {
          if (url === '/api/roll') {
            return jsonResp(200, {
              roundId: 2001,
              dice: [4, 5, 6],
              total: 15,
              isTriple: false,
              outcome: 'TAI',
              totalBet: 5000000,
              totalWin: 10000000,
              netProfit: 5000000,
              newBalance: 1505000000,
              winningDetails: [],
            });
          }
          return jsonResp(200, { history: [] });
        };
        const rollPromise = getEl('btnRoll').click();
        await Promise.all(rollPromise);
        // Before shake completes (bowl still closed), displayedBalance must be deducted and NOT credited
        assert.equal(getEl('userBalance').textContent, (1495000000).toLocaleString('vi-VN'));
        mockEngine.shakeCb();
        assert.equal(getEl('userBalance').textContent, (1505000000).toLocaleString('vi-VN'));
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, '');

        // Rebet restores lastBets (5M on tai)
        getEl('btnRebet').click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (5000000).toLocaleString('vi-VN'));
        getEl('btnClear').click();

        // Build 600M on tai (120 x 5M), verify btnDouble rejects > MAX_SINGLE_BET; build 1B, verify next 5M rejects
        for (let i = 0; i < 120; i++) spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (600000000).toLocaleString('vi-VN'));
        getEl('toastContainer').children.length = 0;
        getEl('btnDouble').click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (600000000).toLocaleString('vi-VN'));
        assert.ok(getEl('toastContainer').children.some(t => t.textContent.includes('1,000,000,000')));
        for (let i = 0; i < 80; i++) spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (1000000000).toLocaleString('vi-VN'));
        getEl('toastContainer').children.length = 0;
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (1000000000).toLocaleString('vi-VN'));
        assert.ok(getEl('toastContainer').children.some(t => t.textContent.includes('1,000,000,000')));

        // 8d. apiFetch 401 reset: direct #adminModal close via #btnAdminSearch, plus #btnRoll & live submitLiveBet 401 with wager <= 2M
        stateBalance = 42000000;
        let adminUsersReturn401 = false;
        const fixedBettingServerTime = Math.floor(Date.now() / 20000) * 20000 + 2000;
        fetchHandler = async (url) => {
          if (url === '/api/auth/login') return jsonResp(200, { user: { id: 'adm_2', username: 'adm2', role: 'admin', balance: 42000000 } });
          if (url === '/api/state') {
            return jsonResp(200, {
              serverTime: fixedBettingServerTime,
              user: { id: 'adm_2', username: 'adm2', role: 'admin', balance: 42000000 },
              history: [{ id: 1002, dice: [1, 2, 3], total: 6, outcome: 'XIU', isTriple: false }],
              personalHistory: [{ roundId: 901, timestamp: new Date().toISOString(), dice: [1, 2, 3], total: 6, outcome: 'XIU', bets: { xiu: 10000 }, totalBet: 10000, netProfit: 10000 }],
              ledger: [{ id: 'l2', type: 'win', amount: 20000, balanceBefore: 10000, balanceAfter: 30000, reason: 'win', timestamp: new Date().toISOString() }],
              live: { liveRoundId: 501, ticket: { liveRoundId: 501, totalBet: 10000, settled: false } },
              unsettledLiveTickets: [],
            });
          }
          if (url === '/api/live/state') {
            return jsonResp(200, {
              serverTime: fixedBettingServerTime,
              liveRoundId: Math.floor(fixedBettingServerTime / 20000),
              phase: 'BETTING',
              roundSeedHash: 'c'.repeat(64),
              ticket: null,
              unsettledTickets: [],
            });
          }
          if (url.startsWith('/api/admin/users?q=')) {
            if (adminUsersReturn401) return jsonResp(401, { error: 'Session revoked' });
            return jsonResp(200, { users: [] });
          }
          if (url === '/api/roll' || url === '/api/live/bet') return jsonResp(401, { error: 'Session revoked' });
          return jsonResp(200, { history: [] });
        };

        // 8d-1: Direct apiFetch 401 inside #adminModal via #btnAdminSearch (without calling startRoll/closeAllModals)
        getEl('loginUsername').value = 'adm2';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());
        getEl('btnOpenAdmin').click();
        await new Promise(r => setImmediate(r));
        assert.equal(getEl('adminModal').classList.contains('open'), true);
        assert.equal(getEl('userBalance').textContent, (42000000).toLocaleString('vi-VN'));

        adminUsersReturn401 = true;
        fetchCalls.length = 0;
        await Promise.all(getEl('btnAdminSearch').click());
        assert.equal(getEl('adminModal').classList.contains('open'), false);
        assert.equal(getEl('userBalance').textContent, (10000000).toLocaleString('vi-VN'));
        assert.equal(getEl('navUserBadge').textContent, 'Đăng nhập');
        assert.match(getEl('personalLedgerBody').innerHTML, /empty-ledger-cell/);
        assert.match(getEl('walletLedgerBody').innerHTML, /empty-ledger-cell/);
        assert.equal(fetchCalls.filter(c => c.url === '/api/auth/guest').length, 0);

        // 8d-2: Manual #btnRoll 401 with wager <= 2,000,000 (10,000 chip) must NOT call /api/auth/guest, opens authPaneLogin, preserves bets
        adminUsersReturn401 = false;
        getEl('loginUsername').value = 'adm2';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());
        assert.equal(getEl('userBalance').textContent, (42000000).toLocaleString('vi-VN'));
        getEl('btnAuthModal').click();
        assert.equal(getEl('authPaneLogin').classList.contains('active'), false);
        getEl('btnCloseAuth').click();
        assert.equal(getEl('authModal').classList.contains('open'), false);

        getEl('btnClear').click();
        chip10k.click();
        spotXiu.click();
        assert.equal(spotXiu.querySelector('.wager-chip-counter').textContent, (10000).toLocaleString('vi-VN'));
        fetchCalls.length = 0;
        await Promise.all(getEl('btnRoll').click());

        assert.equal(fetchCalls.some(c => c.url === '/api/roll'), true);
        assert.equal(fetchCalls.filter(c => c.url === '/api/auth/guest').length, 0);
        assert.equal(getEl('authModal').classList.contains('open'), true);
        assert.equal(getEl('authPaneLogin').classList.contains('active'), true);
        assert.equal(spotXiu.querySelector('.wager-chip-counter').textContent, (10000).toLocaleString('vi-VN'));
        assert.equal(getEl('userBalance').textContent, (10000000).toLocaleString('vi-VN'));
        assert.equal(getEl('navUserBadge').textContent, 'Đăng nhập');
        assert.match(getEl('personalLedgerBody').innerHTML, /empty-ledger-cell/);
        assert.match(getEl('walletLedgerBody').innerHTML, /empty-ledger-cell/);

        // 8d-3: Live mode submitLiveBet 401 with wager <= 2,000,000 (10,000 chip) must NOT call /api/auth/guest, opens authPaneLogin, preserves bets
        getEl('btnCloseAuth').click();
        getEl('loginUsername').value = 'adm2';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());
        assert.equal(getEl('userBalance').textContent, (42000000).toLocaleString('vi-VN'));
        getEl('btnModeLive').click();
        await new Promise(r => setImmediate(r));
        getEl('btnAuthModal').click();
        assert.equal(getEl('authPaneLogin').classList.contains('active'), false);
        getEl('btnCloseAuth').click();
        assert.equal(getEl('authModal').classList.contains('open'), false);

        chip10k.click();
        spotXiu.click();
        assert.equal(spotXiu.querySelector('.wager-chip-counter').textContent, (10000).toLocaleString('vi-VN'));
        fetchCalls.length = 0;
        await Promise.all(getEl('btnRoll').click());

        assert.equal(fetchCalls.some(c => c.url === '/api/live/bet'), true);
        assert.equal(fetchCalls.filter(c => c.url === '/api/auth/guest').length, 0);
        assert.equal(getEl('authModal').classList.contains('open'), true);
        assert.equal(getEl('authPaneLogin').classList.contains('active'), true);
        assert.equal(spotXiu.querySelector('.wager-chip-counter').textContent, (10000).toLocaleString('vi-VN'));
        assert.equal(getEl('userBalance').textContent, (10000000).toLocaleString('vi-VN'));
        assert.equal(getEl('navUserBadge').textContent, 'Đăng nhập');
        assert.match(getEl('personalLedgerBody').innerHTML, /empty-ledger-cell/);
        assert.match(getEl('walletLedgerBody').innerHTML, /empty-ledger-cell/);

        getEl('btnCloseAuth').click();
        getEl('btnClear').click();
        getEl('btnModeManual').click();

        // 8e. Direct VM execution of resetClientSessionState verifying liveTicket/liveRevealedRoundId/personalHistory/walletLedger clearing
        const resetFnCode = extractBalancedJsFunction(appJs, 'resetClientSessionState');
        assert.ok(resetFnCode);
        const resetState = {
          liveTicket: { liveRoundId: 500, totalBet: 10000, settled: false },
          liveRevealedRoundId: 500,
          pendingResult: { roundId: 500 },
          personalHistory: [{ roundId: 1 }],
          walletLedger: [{ id: 'w1' }],
          provablyFair: { lastRevealed: { roundId: 1 } },
          currentBets: { tai: 10000 },
          lastBets: { tai: 10000 },
          betUndoStack: [{ type: 'add', betKey: 'tai', delta: 10000 }],
        };
        let renderSpotsCalled = 0;
        let renderPersonalCalled = 0;
        let renderWalletCalled = 0;
        vm.runInNewContext(
          `${resetFnCode}\nresetClientSessionState({ clearBets: true });`,
          {
            state: resetState,
            el: {},
            renderAllBetSpots: () => { renderSpotsCalled++; },
            renderPersonalLedger: () => { renderPersonalCalled++; },
            renderWalletLedger: () => { renderWalletCalled++; },
          }
        );
        assert.equal(resetState.liveTicket, null);
        assert.equal(resetState.liveRevealedRoundId, null);
        assert.equal(resetState.pendingResult, null);
        assert.equal(resetState.personalHistory.length, 0);
        assert.equal(resetState.walletLedger.length, 0);
        assert.equal(Object.keys(resetState.currentBets).length, 0);
        assert.equal(renderSpotsCalled, 1);
        assert.equal(renderPersonalCalled, 1);
        assert.equal(renderWalletCalled, 1);

        // 8f. btnLogout clears currentBets + resets displayedBalance + clears ledgers
        getEl('loginUsername').value = 'adm2';
        getEl('loginPassword').value = 'Pass!123';
        await Promise.all(getEl('btnLoginSubmit').click());
        assert.equal(getEl('userBalance').textContent, (42000000).toLocaleString('vi-VN'));
        chip5m.click();
        spotTai.click();
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, (5000000).toLocaleString('vi-VN'));
        await Promise.all(getEl('btnLogout').click());
        assert.equal(getEl('userBalance').textContent, (10000000).toLocaleString('vi-VN'));
        assert.equal(spotTai.querySelector('.wager-chip-counter').textContent, '');
        assert.equal(getEl('navUserBadge').textContent, 'Đăng nhập');
        assert.match(getEl('personalLedgerBody').innerHTML, /empty-ledger-cell/);
        assert.match(getEl('walletLedgerBody').innerHTML, /empty-ledger-cell/);
      } finally {
        for (const t of pendingTimers) clearTimeout(t);
        for (const i of pendingIntervals) clearInterval(i);
      }
    } finally {
      await server.close();
    }
  });
});
