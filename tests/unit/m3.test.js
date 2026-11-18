'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { loadConfig } = require('../../lib/config');
const {
  sha256Hex,
  evaluateRoll,
  deriveLiveRoundDice,
  computeLiveCommitmentHash,
  LIVE_ROUND_MS,
  LIVE_BET_MS
} = require('../../lib/sicbo-engine');
const { createDb } = require('../../lib/db');
const serverApp = require('../../server');

const { createApp } = serverApp;

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

let initialDataSnapshot = null;
const activeCleanups = [];

function snapshotDataDir() {
  const entries = fs.readdirSync(DATA_DIR).sort();
  return entries.map((name) => {
    const stat = fs.statSync(path.join(DATA_DIR, name));
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
    this.rawOverride = null;
  }

  ingest(setCookieHeaders = []) {
    for (const raw of setCookieHeaders) {
      if (!raw) continue;
      const parts = String(raw).split(';').map((p) => p.trim());
      const [nv, ...attrs] = parts;
      if (!nv || !nv.includes('=')) continue;
      const eqIdx = nv.indexOf('=');
      const name = nv.slice(0, eqIdx).trim();
      const value = nv.slice(eqIdx + 1).trim();
      const meta = {
        name,
        value,
        raw,
        httpOnly: false,
        secure: false,
        sameSite: null,
        path: null,
        cleared: value === ''
      };
      for (const attr of attrs) {
        const lower = attr.toLowerCase();
        if (lower === 'httponly') meta.httpOnly = true;
        else if (lower === 'secure') meta.secure = true;
        else if (lower.startsWith('samesite=')) meta.sameSite = attr.slice(9).trim();
        else if (lower.startsWith('path=')) meta.path = attr.slice(5).trim();
        else if (lower.startsWith('max-age=')) {
          const n = Number(attr.slice(8).trim());
          if (Number.isFinite(n) && n <= 0) meta.cleared = true;
        }
      }
      this.cookies.set(name, meta);
      this.rawOverride = null;
    }
  }

  header() {
    if (this.rawOverride !== null) return this.rawOverride;
    const out = [];
    for (const c of this.cookies.values()) {
      if (!c.cleared && c.value) {
        out.push(`${c.name}=${c.value}`);
      }
    }
    return out.join('; ');
  }

  getMeta(name) {
    return this.cookies.get(name) || null;
  }

  clone() {
    const copy = new CookieJar();
    for (const [k, v] of this.cookies.entries()) {
      copy.cookies.set(k, { ...v });
    }
    copy.rawOverride = this.rawOverride;
    return copy;
  }
}

function createClient(baseUrl, initialJar = null) {
  const jar = initialJar || new CookieJar();

  async function req(method, urlPath, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!opts.noCookies) {
      const cookieHdr = jar.header();
      if (cookieHdr && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
        headers.Cookie = cookieHdr;
      }
    }
    let body;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body
    });

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    if (!opts.skipCookieSave && setCookies.length > 0) {
      jar.ingest(setCookies);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json, setCookies };
  }

  return {
    jar,
    req,
    get: (p, opts) => req('GET', p, opts),
    post: (p, body, opts = {}) => req('POST', p, { ...opts, body }),
    options: (p, opts) => req('OPTIONS', p, opts),
    clone: () => createClient(baseUrl, jar.clone())
  };
}

function rawHttpRequest(baseUrl, { method = 'POST', path: reqPath = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const finalHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      ...headers
    };
    const r = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: reqPath,
        method,
        headers: finalHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function startTestServer(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sicbo-m3-test-'));
  const env = {
    NODE_ENV: 'test',
    JWT_SECRET: opts.omitSecrets ? '' : crypto.randomBytes(32).toString('hex'),
    LIVE_MASTER_SECRET: opts.omitSecrets ? '' : crypto.randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'bossadmin',
    ...(opts.env || {})
  };
  if (opts.omitSecrets) {
    delete env.JWT_SECRET;
    delete env.LIVE_MASTER_SECRET;
  }

  const cfg = loadConfig({
    env,
    dataDir: tmpDir,
    loadDotEnv: false,
    silent: true,
    fresh: true
  });

  const db = createDb(cfg, { seedLegacyHistory: opts.seedLegacyHistory ?? false });
  await db.init();

  let fakeNow = opts.initialNow ?? 1_700_000_000_000;
  const app = createApp({
    config: cfg,
    db,
    now: () => fakeNow,
    enableRateLimiterTimer: Boolean(opts.enableRateLimiterTimer),
    authRateLimitMax: opts.authRateLimitMax,
    betRateLimitMax: opts.betRateLimitMax,
    allowedOrigins: opts.allowedOrigins
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    await app.close();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  activeCleanups.push(cleanup);

  return {
    app,
    cfg,
    db,
    server,
    baseUrl,
    tmpDir,
    getNow: () => fakeNow,
    setNow: (ms) => { fakeNow = ms; },
    advanceNow: (deltaMs) => { fakeNow += deltaMs; return fakeNow; },
    close: cleanup
  };
}

before(() => {
  initialDataSnapshot = snapshotDataDir();
});

afterEach(async () => {
  while (activeCleanups.length > 0) {
    const fn = activeCleanups.pop();
    try {
      await fn();
    } catch (_) {
      // ignore double-cleanup
    }
  }
});

after(() => {
  const afterSnapshot = snapshotDataDir();
  assert.deepEqual(afterSnapshot, initialDataSnapshot, 'Repo data/ directory must remain completely untouched');
});

// =============================================================================
// Suite 1: Exports, Security Headers, Same-Origin CORS, Body Limit & VERCEL=1
// =============================================================================
describe('M3 Suite 1 — Exports, Security Headers, CORS, Body Limit & VERCEL=1', () => {
  it('1.1: server.js exports Express app function + createApp with zero data/ side effects and cleans up timers', async () => {
    assert.equal(typeof serverApp, 'function');
    assert.equal(typeof createApp, 'function');
    assert.equal(fs.existsSync(path.join(DATA_DIR, '.secrets.json')), false);
    assert.equal(fs.existsSync(path.join(DATA_DIR, 'db.json')), false);

    const srv = await startTestServer({ enableRateLimiterTimer: true });
    const res = await createClient(srv.baseUrl).get('/api/state');
    assert.equal(res.status, 200);
    await srv.close();
  });

  it('1.2: VERCEL=1 without secrets boots cleanly, sets trust proxy, and marks sicbo_token Secure', async () => {
    const srv = await startTestServer({
      omitSecrets: true,
      env: { VERCEL: '1' }
    });
    assert.equal(srv.cfg.isVercel, true);
    assert.equal(srv.cfg.secretsDegraded, true);
    assert.equal(srv.app.get('trust proxy'), 1);

    const client = createClient(srv.baseUrl);
    const stateRes = await client.get('/api/state');
    assert.equal(stateRes.status, 200);

    const reg = await client.post('/api/auth/register', {
      username: 'vercel_user_1',
      password: 'Password!123'
    });
    assert.equal(reg.status, 201);
    const meta = client.jar.getMeta('sicbo_token');
    assert.ok(meta);
    assert.equal(meta.httpOnly, true);
    assert.equal(meta.sameSite?.toLowerCase(), 'lax');
    assert.equal(meta.secure, true);
  });

  it('1.3: Security headers set and X-Powered-By suppressed on HTML, API, and 404 responses', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);

    for (const p of ['/', '/api/state', '/api/live/state', '/api/unknown-route']) {
      const res = await client.get(p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(res.headers.get('x-powered-by'), null);
    }

    const notFound = await client.get('/api/unknown-route');
    assert.equal(notFound.status, 404);
    assert.ok(notFound.json && typeof notFound.json.error === 'string');
  });

  it('1.4: Same-origin CORS allows matching Origin and blocks cross-origin preflight without wildcard *', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);

    const sameOriginOpt = await client.options('/api/state', {
      headers: { Origin: srv.baseUrl }
    });
    assert.equal(sameOriginOpt.status, 204);
    assert.equal(sameOriginOpt.headers.get('access-control-allow-origin'), srv.baseUrl);
    assert.notEqual(sameOriginOpt.headers.get('access-control-allow-origin'), '*');

    const crossOriginOpt = await client.options('/api/state', {
      headers: { Origin: 'https://evil.example.com' }
    });
    assert.equal(crossOriginOpt.status, 403);
    assert.equal(crossOriginOpt.headers.get('access-control-allow-origin'), null);

    const crossOriginGet = await client.get('/api/state', {
      headers: { Origin: 'https://evil.example.com' }
    });
    assert.equal(crossOriginGet.status, 200);
    assert.equal(crossOriginGet.headers.get('access-control-allow-origin'), null);
  });

  it('1.5: Enforces 16kb JSON body limit (413), rejects malformed JSON (400), and rejects non-object JSON body (400)', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);
    await client.post('/api/auth/register', { username: 'body_limit_u', password: 'Password!123' });

    const bigPayload = JSON.stringify({ bets: { tai: 1000 }, pad: 'a'.repeat(18 * 1024) });
    const res413 = await rawHttpRequest(srv.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: client.jar.header() },
      body: bigPayload
    });
    assert.equal(res413.status, 413);
    assert.equal(res413.json?.code, 'PAYLOAD_TOO_LARGE');

    const okPayload = JSON.stringify({ bets: { tai: 1000 }, pad: 'b'.repeat(10 * 1024) });
    const res200 = await rawHttpRequest(srv.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: client.jar.header() },
      body: okPayload
    });
    assert.equal(res200.status, 200);

    const badJson = await rawHttpRequest(srv.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: client.jar.header() },
      body: '{"bets": {broken'
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json?.code, 'INVALID_JSON');

    const arrBody = await client.post('/api/roll', [1, 2, 3]);
    assert.equal(arrBody.status, 400);
  });

  it('1.6: Rejects prototype-pollution keys (__proto__, constructor, prototype) with 400 across POST routes', async () => {
    const srv = await startTestServer();
    const admin = createClient(srv.baseUrl);
    await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });

    const player = createClient(srv.baseUrl);
    const regP = await player.post('/api/auth/register', { username: 'proto_player', password: 'Password!123' });
    const pid = regP.json.user.id;

    const guest = createClient(srv.baseUrl);
    await guest.post('/api/auth/guest', {});

    const protoPayloads = [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"prototype":{"polluted":true}}',
      '{"nested":[{"__proto__":{"polluted":true}}]}',
      '{"bets":{"tai":1000},"__proto__":{"polluted":true}}',
      '{"bets":{"tai":1000},"extra":{"constructor":{"prototype":{"polluted":true}}}}'
    ];

    const playerTargets = [
      '/api/fairness/rotate',
      '/api/verify-fairness',
      '/api/roll',
      '/api/live/bet',
      '/api/live/settle',
      '/api/auth/change-password',
      '/api/wallet/daily-bonus',
      '/api/wallet/bankruptcy-aid'
    ];

    for (const p of playerTargets) {
      for (const rawBody of protoPayloads) {
        const res = await player.post(p, undefined, { rawBody });
        assert.equal(res.status, 400, `Expected 400 on ${p} for ${rawBody}, got ${res.status}`);
        assert.equal(res.json?.code, 'INVALID_BODY');
      }
    }

    const adminTargets = [
      `/api/admin/users/${pid}/adjust-balance`,
      `/api/admin/users/${pid}/toggle-lock`,
      `/api/admin/users/${pid}/reset-password`
    ];
    for (const p of adminTargets) {
      for (const rawBody of protoPayloads.slice(0, 4)) {
        const res = await admin.post(p, undefined, { rawBody });
        assert.equal(res.status, 400, `Expected 400 on ${p} for ${rawBody}, got ${res.status}`);
        assert.equal(res.json?.code, 'INVALID_BODY');
      }
    }

    for (const [cli, p, rawBody] of [
      [createClient(srv.baseUrl), '/api/auth/register', '{"username":"proto_reg","password":"Password!123","__proto__":{"role":"admin"}}'],
      [createClient(srv.baseUrl), '/api/auth/login', '{"username":"proto_player","password":"Password!123","constructor":{"prototype":{"polluted":true}}}'],
      [createClient(srv.baseUrl), '/api/auth/recover', '{"username":"proto_player","recoveryCode":"SOV-0000-0000-0000","newPassword":"Password!123","prototype":{"x":1}}'],
      [guest, '/api/auth/upgrade', '{"username":"proto_up","password":"Password!123","__proto__":{"role":"admin"}}'],
      [createClient(srv.baseUrl), '/api/auth/guest', '{"__proto__":{"polluted":true}}'],
      [player, '/api/auth/logout', '{"__proto__":{"polluted":true}}']
    ]) {
      const res = await cli.post(p, undefined, { rawBody });
      assert.equal(res.status, 400, `Expected 400 on ${p}, got ${res.status}`);
      assert.equal(res.json?.code, 'INVALID_BODY');
    }

    assert.equal(({}).polluted, undefined);

    // Optional-body endpoints still accept empty / omitted bodies
    assert.equal((await player.post('/api/fairness/rotate', {})).status, 200);
    assert.equal((await admin.post(`/api/admin/users/${pid}/toggle-lock`, undefined)).status, 200);
    assert.equal((await admin.post(`/api/admin/users/${pid}/toggle-lock`, { locked: false })).status, 200);
  });

  it('1.7: createApp({ configOptions: { env: { VERCEL: "1" } } }) enables trust proxy cleanly on first request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sicbo-m3-tp-'));
    const app = createApp({
      configOptions: {
        env: { VERCEL: '1' },
        dataDir: tmpDir,
        loadDotEnv: false,
        silent: true,
        fresh: true
      }
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    activeCleanups.push(async () => {
      await app.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const client = createClient(baseUrl);
    const res = await client.get('/api/state');
    assert.equal(res.status, 200);
    assert.equal(app.get('trust proxy'), 1);
  });
});

// =============================================================================
// Suite 2: Auth Lifecycle, Guest Upgrade & Session Revocation
// =============================================================================
describe('M3 Suite 2 — Auth Lifecycle, Guest Upgrade & Session Revocation', () => {
  it('2.1: Register, duplicate 409, guest_ prefix rejection, login, /me sanitization & logout', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);

    const badGuestPrefix = await client.post('/api/auth/register', {
      username: 'guest_hacker',
      password: 'Password!123'
    });
    assert.equal(badGuestPrefix.status, 400);

    const reg = await client.post('/api/auth/register', {
      username: 'bossadmin',
      password: 'AdminPass!123',
      displayName: 'Salon Boss'
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.role, 'admin');
    assert.equal(reg.json.user.passwordHash, undefined);
    assert.equal(reg.json.user.recoveryCodeHash, undefined);
    assert.equal(reg.json.user.fairness?.serverSeed, undefined);
    assert.match(reg.json.recoveryCode, /^SOV-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);

    const dup = await createClient(srv.baseUrl).post('/api/auth/register', {
      username: 'BossAdmin',
      password: 'AnotherPass!123'
    });
    assert.equal(dup.status, 409);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'bossadmin');
    assert.ok(Array.isArray(me.json.ledger));
    assert.ok(Array.isArray(me.json.personalHistory));
    assert.equal(me.json.fairness.serverSeed, undefined);

    const logout = await client.post('/api/auth/logout', {});
    assert.equal(logout.status, 200);
    assert.equal(logout.json.ok, true);
    assert.equal((await client.get('/api/auth/me')).status, 401);

    const badLogin = await client.post('/api/auth/login', {
      username: 'bossadmin',
      password: 'WrongPassword!'
    });
    assert.equal(badLogin.status, 401);

    const okLogin = await client.post('/api/auth/login', {
      username: 'bossadmin',
      password: 'AdminPass!123'
    });
    assert.equal(okLogin.status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 200);
  });

  it('2.2: change-password verifies currentPassword, rotates sessionVersion, revokes old tokens, and keeps caller logged in', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);
    await client.post('/api/auth/register', {
      username: 'pw_changer',
      password: 'OldPassword!123'
    });
    const staleClient = client.clone();

    const wrongCur = await client.post('/api/auth/change-password', {
      currentPassword: 'WrongCurrent!123',
      newPassword: 'NewPassword!456'
    });
    assert.equal(wrongCur.status, 401);

    const ch = await client.post('/api/auth/change-password', {
      currentPassword: 'OldPassword!123',
      newPassword: 'NewPassword!456'
    });
    assert.equal(ch.status, 200);
    assert.equal(ch.json.ok, true);
    assert.equal(ch.json.user.passwordHash, undefined);

    // Caller's fresh cookie remains valid
    assert.equal((await client.get('/api/auth/me')).status, 200);
    // Captured pre-change cookie is immediately revoked
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);
    assert.equal((await staleClient.post('/api/roll', { bets: { tai: 1000 } })).status, 401);

    // Old password rejected, new password accepted
    assert.equal((await createClient(srv.baseUrl).post('/api/auth/login', {
      username: 'pw_changer',
      password: 'OldPassword!123'
    })).status, 401);
    assert.equal((await createClient(srv.baseUrl).post('/api/auth/login', {
      username: 'pw_changer',
      password: 'NewPassword!456'
    })).status, 200);
  });

  it('2.3: recover resets password with 1-time recoveryCode rotation and revokes prior JWTs', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 'recover_user',
      password: 'InitPassword!123'
    });
    const code1 = reg.json.recoveryCode;
    const staleClient = client.clone();

    const badRec = await createClient(srv.baseUrl).post('/api/auth/recover', {
      username: 'recover_user',
      recoveryCode: 'SOV-0000-0000-0000',
      newPassword: 'Recovered!999'
    });
    assert.equal(badRec.status, 401);

    const okRec = await createClient(srv.baseUrl).post('/api/auth/recover', {
      username: 'recover_user',
      recoveryCode: code1,
      newPassword: 'Recovered!999'
    });
    assert.equal(okRec.status, 200);
    assert.equal(okRec.json.ok, true);
    assert.ok(okRec.json.recoveryCode && okRec.json.recoveryCode !== code1);

    // Old cookie revoked
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);

    // Replaying old recoveryCode fails
    const replay = await createClient(srv.baseUrl).post('/api/auth/recover', {
      username: 'recover_user',
      recoveryCode: code1,
      newPassword: 'Hijacked!999'
    });
    assert.equal(replay.status, 401);

    // New password works
    const login = await createClient(srv.baseUrl).post('/api/auth/login', {
      username: 'recover_user',
      password: 'Recovered!999'
    });
    assert.equal(login.status, 200);
  });

  it('2.4: Guest creation & upgrade preserves exact balance, ledger, personalHistory, and fairness', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);

    const g = await client.post('/api/auth/guest', {});
    assert.equal(g.status, 201);
    assert.equal(g.json.user.isGuest, true);
    assert.equal(g.json.user.balance, 2_000_000);

    const roll = await client.post('/api/roll', { bets: { tai: 50_000, double_2: 10_000 } });
    assert.equal(roll.status, 200);
    const balAfterRoll = roll.json.newBalance;

    const beforeUpgrade = await client.get('/api/auth/me');
    const up = await client.post('/api/auth/upgrade', {
      username: 'upgraded_member',
      password: 'Upgraded!123',
      displayName: 'Upgraded Member'
    });
    assert.equal(up.status, 200);
    assert.equal(up.json.user.isGuest, false);
    assert.equal(up.json.user.username, 'upgraded_member');
    assert.equal(up.json.user.balance, balAfterRoll);
    assert.equal(up.json.user.passwordHash, undefined);
    assert.ok(up.json.recoveryCode);

    // Calling upgrade again as non-guest fails 400
    const upAgain = await client.post('/api/auth/upgrade', {
      username: 'another_name',
      password: 'Upgraded!123'
    });
    assert.equal(upAgain.status, 400);

    const afterUpgrade = await client.get('/api/auth/me');
    assert.equal(afterUpgrade.status, 200);
    assert.equal(afterUpgrade.json.user.balance, balAfterRoll);
    assert.equal(afterUpgrade.json.ledger.length, beforeUpgrade.json.ledger.length);
    assert.equal(afterUpgrade.json.personalHistory.length, beforeUpgrade.json.personalHistory.length);
    assert.equal(afterUpgrade.json.fairness.serverSeedHash, beforeUpgrade.json.fairness.serverSeedHash);
  });
});

// =============================================================================
// Suite 3: Wallet Ops, Leaderboard & Admin RBAC
// =============================================================================
describe('M3 Suite 3 — Wallet Ops, Leaderboard & Admin RBAC', () => {
  it('3.1: Daily bonus (+2M, 24h cooldown) and Bankruptcy aid (<10k -> +500k, 1h cooldown) enforce mock clock', async () => {
    const srv = await startTestServer();
    const admin = createClient(srv.baseUrl);
    const regAdmin = await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });
    assert.equal(regAdmin.status, 201);

    const player = createClient(srv.baseUrl);
    const regP = await player.post('/api/auth/register', { username: 'wallet_player', password: 'Password!123' });
    const pid = regP.json.user.id;

    // Daily bonus
    const b1 = await player.post('/api/wallet/daily-bonus', {});
    assert.equal(b1.status, 200);
    assert.equal(b1.json.bonusAmount, 2_000_000);
    assert.equal(b1.json.balance, 12_000_000);
    assert.equal(b1.json.ledgerEntry.type, 'daily_bonus');

    const b2 = await player.post('/api/wallet/daily-bonus', {});
    assert.equal(b2.status, 429);
    assert.equal(b2.json.code, 'COOLDOWN_ACTIVE');
    assert.ok(typeof b2.json.nextEligibleAt === 'number');

    srv.advanceNow(24 * 60 * 60 * 1000);
    const b3 = await player.post('/api/wallet/daily-bonus', {});
    assert.equal(b3.status, 200);
    assert.equal(b3.json.balance, 14_000_000);

    // Bankruptcy aid boundary
    const aidFail = await player.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(aidFail.status, 400);

    await admin.post(`/api/admin/users/${pid}/adjust-balance`, {
      amount: -(14_000_000 - 9_999),
      reason: 'Drain below 10k'
    });

    const aid1 = await player.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(aid1.status, 200);
    assert.equal(aid1.json.aidAmount, 500_000);
    assert.equal(aid1.json.balance, 509_999);
    assert.equal(aid1.json.ledgerEntry.type, 'bankruptcy_aid');

    await admin.post(`/api/admin/users/${pid}/adjust-balance`, {
      amount: -509_999,
      reason: 'Drain to 0 for cooldown test'
    });

    const aidCooldown = await player.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(aidCooldown.status, 429);
    assert.equal(aidCooldown.json.code, 'COOLDOWN_ACTIVE');

    srv.advanceNow(60 * 60 * 1000);
    const aid2 = await player.post('/api/wallet/bankruptcy-aid', {});
    assert.equal(aid2.status, 200);
    assert.equal(aid2.json.balance, 500_000);
  });

  it('3.2: Leaderboard sorting, totalRounds field, locked exclusion & Admin RBAC ops', async () => {
    const srv = await startTestServer({
      env: { ADMIN_USERNAME: 'seeded_admin', ADMIN_PASSWORD: 'SeededPassword!123' }
    });

    // Seeded admin login works directly without prior register
    const admin = createClient(srv.baseUrl);
    const adminLogin = await admin.post('/api/auth/login', {
      username: 'seeded_admin',
      password: 'SeededPassword!123'
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.json.user.role, 'admin');

    const u1 = createClient(srv.baseUrl);
    const u2 = createClient(srv.baseUrl);
    const r1 = await u1.post('/api/auth/register', { username: 'lb_alpha', password: 'Password!123' });
    const r2 = await u2.post('/api/auth/register', { username: 'lb_beta', password: 'Password!123' });
    const u1Id = r1.json.user.id;
    const u2Id = r2.json.user.id;

    await u1.post('/api/roll', { bets: { tai: 20_000 } });

    // RBAC checks
    assert.equal((await createClient(srv.baseUrl).get('/api/admin/users')).status, 401);
    assert.equal((await u1.get('/api/admin/users')).status, 403);
    assert.equal((await u1.post(`/api/admin/users/${u2Id}/toggle-lock`, { locked: true })).status, 403);

    // Search users
    const search = await admin.get('/api/admin/users?q=lb_');
    assert.equal(search.status, 200);
    assert.equal(search.json.total, 2);

    // Adjust balance validation & negative prevention
    assert.equal((await admin.post(`/api/admin/users/${u2Id}/adjust-balance`, { amount: 0, reason: 'x' })).status, 400);
    assert.equal((await admin.post(`/api/admin/users/${u2Id}/adjust-balance`, { amount: 1000, reason: '' })).status, 400);
    assert.equal((await admin.post(`/api/admin/users/${u2Id}/adjust-balance`, { amount: -99_000_000, reason: 'over' })).status, 400);

    const boost = await admin.post(`/api/admin/users/${u2Id}/adjust-balance`, {
      amount: 15_000_000,
      reason: 'VIP bonus'
    });
    assert.equal(boost.status, 200);
    assert.equal(boost.json.user.balance, 25_000_000);

    // Lock u2 -> excluded from leaderboard, token revoked, login 403
    const lockRes = await admin.post(`/api/admin/users/${u2Id}/toggle-lock`, { locked: true });
    assert.equal(lockRes.status, 200);
    assert.equal(lockRes.json.user.locked, true);
    assert.equal(lockRes.json.user.passwordHash, undefined);
    assert.equal((await u2.get('/api/auth/me')).status, 401);
    assert.equal((await createClient(srv.baseUrl).post('/api/auth/login', {
      username: 'lb_beta',
      password: 'Password!123'
    })).status, 403);

    const lb = await createClient(srv.baseUrl).get('/api/leaderboard');
    assert.equal(lb.status, 200);
    assert.equal(lb.json.byBalance.some((r) => r.username === 'lb_beta'), false);
    const alphaRow = lb.json.byBalance.find((r) => r.username === 'lb_alpha');
    assert.ok(alphaRow);
    assert.equal(alphaRow.totalRounds, 1);
    assert.equal(alphaRow.passwordHash, undefined);
    assert.equal(alphaRow.serverSeed, undefined);

    // Unlock u2 & reset password -> old u1 token revoked after reset-password
    await admin.post(`/api/admin/users/${u2Id}/toggle-lock`, { locked: false });
    const u1Stale = u1.clone();
    const rst = await admin.post(`/api/admin/users/${u1Id}/reset-password`, {});
    assert.equal(rst.status, 200);
    assert.equal(typeof rst.json.tempPassword, 'string');
    assert.equal(rst.json.user.passwordHash, undefined);
    assert.equal((await u1Stale.get('/api/auth/me')).status, 401);

    const u1Login = await createClient(srv.baseUrl).post('/api/auth/login', {
      username: 'lb_alpha',
      password: rst.json.tempPassword
    });
    assert.equal(u1Login.status, 200);
  });
});

// =============================================================================
// Suite 4: Fairness, POST /api/roll, Concurrency & Idempotency
// =============================================================================
describe('M3 Suite 4 — Fairness, /api/roll, Parallel Race & Idempotency', () => {
  it('4.1: GET /api/state shapes (anon vs auth) and no dice leak during BETTING', async () => {
    const srv = await startTestServer();
    const anon = createClient(srv.baseUrl);
    const sAnon = await anon.get('/api/state');
    assert.equal(sAnon.status, 200);
    assert.equal(sAnon.json.user, null);
    assert.ok(Array.isArray(sAnon.json.history));
    assert.ok(Array.isArray(sAnon.json.globalHistory));
    assert.equal(sAnon.json.live.phase, 'BETTING');
    assert.equal('dice' in sAnon.json.live, false);
    assert.equal('outcome' in sAnon.json.live, false);

    const player = createClient(srv.baseUrl);
    await player.post('/api/auth/register', { username: 'state_player', password: 'Password!123' });
    const sAuth = await player.get('/api/state');
    assert.equal(sAuth.status, 200);
    assert.equal(sAuth.json.user.username, 'state_player');
    assert.equal(sAuth.json.balance, 10_000_000);
    assert.equal(sAuth.json.fairness.serverSeed, undefined);
    assert.match(sAuth.json.fairness.serverSeedHash, /^[0-9a-f]{64}$/);
  });

  it('4.2: /api/roll validation, Idempotency-Key replay/conflict/failure-isolation, rotate & verify-fairness', async () => {
    const srv = await startTestServer();
    const client = createClient(srv.baseUrl);
    await client.post('/api/auth/register', { username: 'fair_roller', password: 'Password!123' });

    // Invalid bets
    for (const bad of [{}, { unknown_gate: 1000 }, { pair_3_1: 1000 }, { tai: 0 }, { tai: 10.5 }]) {
      const r = await client.post('/api/roll', { bets: bad });
      assert.equal(r.status, 400);
    }

    // Failed 400 must not poison Idempotency-Key
    const failIkey = await client.post(
      '/api/roll',
      { bets: { tai: 50_000_000 } },
      { headers: { 'Idempotency-Key': 'reuse-after-fail' } }
    );
    assert.equal(failIkey.status, 400);

    const okAfterFail = await client.post(
      '/api/roll',
      { bets: { double_3: 10_000, pair_1_4: 10_000 }, clientSeed: '<raw&seed>' },
      { headers: { 'Idempotency-Key': 'reuse-after-fail' } }
    );
    assert.equal(okAfterFail.status, 200);
    assert.equal(okAfterFail.json.replayed, false);
    assert.equal(okAfterFail.json.fairness.clientSeed, '<raw&seed>');
    assert.equal(okAfterFail.json.fairness.nonce, 0);
    assert.equal(okAfterFail.json.fairness.nextNonce, 1);

    // Identical Idempotency-Key replay
    const replay = await client.post(
      '/api/roll',
      { bets: { double_3: 10_000, pair_1_4: 10_000 }, clientSeed: '<raw&seed>' },
      { headers: { 'Idempotency-Key': 'reuse-after-fail' } }
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.roundId, okAfterFail.json.roundId);
    assert.equal(replay.json.newBalance, okAfterFail.json.newBalance);

    // Conflicting payload with same key -> 409
    const conflict = await client.post(
      '/api/roll',
      { bets: { tai: 10_000 }, clientSeed: '<raw&seed>' },
      { headers: { 'Idempotency-Key': 'reuse-after-fail' } }
    );
    assert.equal(conflict.status, 409);

    // Rotate fairness & verify previous roll
    const initHash = (await client.get('/api/auth/me')).json.fairness.serverSeedHash;
    const rot = await client.post('/api/fairness/rotate', { clientSeed: 'next-seed-888' });
    assert.equal(rot.status, 200);
    assert.equal(sha256Hex(rot.json.previous.serverSeed), initHash);
    assert.equal(rot.json.current.clientSeed, 'next-seed-888');
    assert.equal(rot.json.current.nonce, 0);
    assert.equal(rot.json.current.serverSeed, undefined);

    const verify = await client.post('/api/verify-fairness', {
      serverSeed: rot.json.previous.serverSeed,
      clientSeed: okAfterFail.json.fairness.clientSeed,
      nonce: okAfterFail.json.fairness.nonce,
      expectedHash: initHash
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.json.valid, true);
    assert.deepEqual(verify.json.dice, okAfterFail.json.dice);
    assert.equal(verify.json.outcome, okAfterFail.json.outcome);

    const badVerify = await client.post('/api/verify-fairness', { serverSeed: '' });
    assert.equal(badVerify.status, 400);
  });

  it('4.3: 10 parallel HTTP POST /api/roll requests exceeding balance enforce atomic serialization & ledger integrity', async () => {
    const srv = await startTestServer();
    const admin = createClient(srv.baseUrl);
    await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });

    const racer = createClient(srv.baseUrl);
    const reg = await racer.post('/api/auth/register', { username: 'http_racer', password: 'Password!123' });
    const racerId = reg.json.user.id;

    await admin.post(`/api/admin/users/${racerId}/adjust-balance`, {
      amount: -(10_000_000 - 100_000),
      reason: 'Set exact 100k bankroll'
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        racer.post(
          '/api/roll',
          { bets: { triple_6: 30_000 } },
          { headers: { 'Idempotency-Key': `http-race-${idx}` } }
        )
      )
    );

    let accepted = 0;
    let totalBet = 0;
    let totalWin = 0;
    for (const r of responses) {
      assert.ok([200, 400].includes(r.status), `Unexpected status ${r.status}`);
      if (r.status === 200) {
        accepted++;
        totalBet += r.json.totalBet;
        totalWin += r.json.totalWin;
      }
    }
    assert.ok(accepted >= 3);

    const me = await racer.get('/api/auth/me');
    assert.ok(me.json.user.balance >= 0);
    assert.equal(me.json.user.balance, 100_000 - totalBet + totalWin);

    let reconciled = 10_000_000;
    for (const entry of me.json.ledger) {
      reconciled += entry.balanceAfter - entry.balanceBefore;
    }
    assert.equal(reconciled, me.json.user.balance);
  });
});

// =============================================================================
// Suite 5: Serverless Live Room (Mock-Clock Deterministic Lifecycle)
// =============================================================================
describe('M3 Suite 5 — Serverless Live Room Lifecycle', () => {
  it('5.1: Enforces BETTING non-disclosure, round mismatch, REVEAL transition, flattened settle & cross-round settle', async () => {
    const baseTime = 1_700_000_000_000; // divisible by 20_000 -> elapsedMs = 0
    const round1 = Math.floor(baseTime / LIVE_ROUND_MS);
    const srv = await startTestServer({ initialNow: baseTime });

    const player = createClient(srv.baseUrl);
    await player.post('/api/auth/register', { username: 'live_vip', password: 'Password!123' });
    const bystander = createClient(srv.baseUrl);
    await bystander.post('/api/auth/register', { username: 'live_bystander', password: 'Password!123' });

    // BETTING phase checks
    const sBet = await player.get('/api/live/state');
    assert.equal(sBet.status, 200);
    assert.equal(sBet.json.liveRoundId, round1);
    assert.equal(sBet.json.phase, 'BETTING');
    assert.equal('dice' in sBet.json, false);
    assert.equal('total' in sBet.json, false);
    assert.equal('isTriple' in sBet.json, false);
    assert.equal('outcome' in sBet.json, false);
    assert.equal(
      sBet.json.roundSeedHash,
      computeLiveCommitmentHash(srv.cfg.liveMasterSecret, round1)
    );

    // Premature settle rejected
    const earlySettle = await player.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(earlySettle.status, 400);

    // Mismatched liveRoundId rejected
    const mismatchBet = await player.post('/api/live/bet', {
      bets: { tai: 10_000 },
      liveRoundId: round1 + 1
    });
    assert.equal(mismatchBet.status, 400);

    // Place live bet with Idempotency-Key + merge second bet
    const b1 = await player.post(
      '/api/live/bet',
      { bets: { tai: 30_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'live-bet-1' } }
    );
    assert.equal(b1.status, 200);
    assert.equal(b1.json.newBalance, 9_970_000);

    const b1Replay = await player.post(
      '/api/live/bet',
      { bets: { tai: 30_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'live-bet-1' } }
    );
    assert.equal(b1Replay.status, 200);
    assert.equal(b1Replay.json.replayed, true);
    assert.equal(b1Replay.json.newBalance, 9_970_000);

    const b1Conflict = await player.post(
      '/api/live/bet',
      { bets: { xiu: 30_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'live-bet-1' } }
    );
    assert.equal(b1Conflict.status, 409);

    const b2 = await player.post('/api/live/bet', {
      bets: { triple_any: 20_000 },
      liveRoundId: round1
    });
    assert.equal(b2.status, 200);
    assert.equal(b2.json.newBalance, 9_950_000);
    assert.equal(b2.json.ticket.totalBet, 50_000);

    // Advance into REVEAL phase (elapsedMs = 15_000)
    srv.setNow(baseTime + LIVE_BET_MS);

    const lateBet = await player.post('/api/live/bet', {
      bets: { xiu: 10_000 },
      liveRoundId: round1
    });
    assert.equal(lateBet.status, 400);
    assert.equal(lateBet.json.code, 'LIVE_BETTING_CLOSED');

    const sRev = await player.get('/api/live/state');
    assert.equal(sRev.status, 200);
    assert.equal(sRev.json.phase, 'REVEAL');
    const expectedDerived = deriveLiveRoundDice(srv.cfg.liveMasterSecret, round1);
    assert.deepEqual(sRev.json.dice, expectedDerived.dice);
    assert.equal(sRev.json.ticket.settled, false); // read-only GET did not auto-settle

    // Future round settle rejected
    assert.equal((await player.post('/api/live/settle', { liveRoundId: round1 + 1 })).status, 400);

    // Bystander with no ticket gets 404
    assert.equal((await bystander.post('/api/live/settle', { liveRoundId: round1 })).status, 404);

    // Settle current round and verify top-level flattened payload
    const expectedEval = evaluateRoll(expectedDerived.dice, { tai: 30_000, triple_any: 20_000 });
    const settle1 = await player.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(settle1.status, 200);
    assert.equal(settle1.json.settled, true);
    assert.equal(settle1.json.settledNow, true);
    assert.deepEqual(settle1.json.dice, expectedDerived.dice);
    assert.equal(settle1.json.total, expectedEval.total);
    assert.equal(settle1.json.outcome, expectedEval.outcome);
    assert.equal(settle1.json.totalBet, 50_000);
    assert.equal(settle1.json.totalWin, expectedEval.totalWin);
    assert.equal(settle1.json.netProfit, expectedEval.netProfit);
    assert.equal(settle1.json.newBalance, 9_950_000 + expectedEval.totalWin);
    assert.ok(Array.isArray(settle1.json.winningDetails));

    // Repeat settle is idempotent without double payout
    const settle2 = await player.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(settle2.status, 200);
    assert.equal(settle2.json.alreadySettled, true);
    assert.equal(settle2.json.settledNow, false);
    assert.equal(settle2.json.newBalance, settle1.json.newBalance);

    // Cross-round late settlement: bet in round2, advance to round3 BETTING, settle round2
    srv.setNow(baseTime + LIVE_ROUND_MS);
    const round2 = round1 + 1;
    const betR2 = await bystander.post('/api/live/bet', { bets: { odd: 10_000 }, liveRoundId: round2 });
    assert.equal(betR2.status, 200);

    srv.setNow(baseTime + 2 * LIVE_ROUND_MS);
    const lateSettleR2 = await bystander.post('/api/live/settle', { liveRoundId: round2 });
    assert.equal(lateSettleR2.status, 200);
    assert.equal(lateSettleR2.json.liveRoundId, round2);
    assert.equal(lateSettleR2.json.settledNow, true);
  });

  it('5.2: Live Room enforces MAX_SINGLE_BET on merged & concurrent bets while preserving Idempotency-Key replay and REVEAL settle', async () => {
    const baseTime = 1_700_000_000_000;
    const round1 = Math.floor(baseTime / LIVE_ROUND_MS);
    const srv = await startTestServer({ initialNow: baseTime });

    const admin = createClient(srv.baseUrl);
    await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });

    // Sequential multi-bet merge cap + Idempotency-Key replay + exact 1B boundary + REVEAL settle
    const whale = createClient(srv.baseUrl);
    const regW = await whale.post('/api/auth/register', { username: 'live_whale', password: 'Password!123' });
    await admin.post(`/api/admin/users/${regW.json.user.id}/adjust-balance`, {
      amount: 3_000_000_000,
      reason: 'High-roller test bankroll'
    });

    const bet1 = await whale.post(
      '/api/live/bet',
      { bets: { tai: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'whale-800m-k1' } }
    );
    assert.equal(bet1.status, 200);
    assert.equal(bet1.json.replayed, false);
    assert.equal(bet1.json.ticket.bets.tai, 800_000_000);

    // Replaying the exact same Idempotency-Key must still succeed as replay (not 400)
    const bet1Replay = await whale.post(
      '/api/live/bet',
      { bets: { tai: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'whale-800m-k1' } }
    );
    assert.equal(bet1Replay.status, 200);
    assert.equal(bet1Replay.json.replayed, true);
    assert.equal(bet1Replay.json.ticket.bets.tai, 800_000_000);

    // Second new bet of 800M on tai would merge to 1.6B > MAX_SINGLE_BET -> rejected 400
    const bet2Over = await whale.post(
      '/api/live/bet',
      { bets: { tai: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'whale-800m-k2' } }
    );
    assert.equal(bet2Over.status, 400);
    assert.equal(bet2Over.json.code, 'INVALID_BETS');

    // Exact 1B boundary (800M + 200M) succeeds, and balance wasn't debited for rejected bet2Over
    const bet2Exact = await whale.post(
      '/api/live/bet',
      { bets: { tai: 200_000_000 }, liveRoundId: round1 }
    );
    assert.equal(bet2Exact.status, 200);
    assert.equal(bet2Exact.json.ticket.bets.tai, 1_000_000_000);
    assert.equal(bet2Exact.json.newBalance, 2_010_000_000);

    // Concurrent Promise.all pair of 800M bets from a second high-roller -> exactly 1 succeeds (200), 1 fails (400)
    const whale2 = createClient(srv.baseUrl);
    const regW2 = await whale2.post('/api/auth/register', { username: 'live_whale_2', password: 'Password!123' });
    await admin.post(`/api/admin/users/${regW2.json.user.id}/adjust-balance`, {
      amount: 3_000_000_000,
      reason: 'Concurrent high-roller test bankroll'
    });

    const [c1, c2] = await Promise.all([
      whale2.post('/api/live/bet', { bets: { tai: 800_000_000 }, liveRoundId: round1 }),
      whale2.post('/api/live/bet', { bets: { tai: 800_000_000 }, liveRoundId: round1 })
    ]);
    const statuses = [c1.status, c2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 400]);

    // Advance to REVEAL and settle both high-rollers -> must return 200 (never 500)
    srv.setNow(baseTime + LIVE_BET_MS);
    const settleW1 = await whale.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(settleW1.status, 200);
    assert.equal(settleW1.json.settled, true);
    assert.equal(settleW1.json.totalBet, 1_000_000_000);

    const settleW2 = await whale2.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(settleW2.status, 200);
    assert.equal(settleW2.json.settled, true);
    assert.equal(settleW2.json.totalBet, 800_000_000);
  });

  it('5.3: Cross-instance cold-start shares DB authority for Idempotency-Key replay and concurrent MAX_SINGLE_BET merge', async () => {
    const baseTime = 1_700_000_000_000;
    const round1 = Math.floor(baseTime / LIVE_ROUND_MS);
    const srv1 = await startTestServer({ initialNow: baseTime });

    // Mount a second independent createApp() instance sharing the same cfg & db (simulating two Vercel Lambdas)
    let fakeNow2 = baseTime;
    const app2 = createApp({
      config: srv1.cfg,
      db: srv1.db,
      now: () => fakeNow2,
      enableRateLimiterTimer: false
    });
    const server2 = http.createServer(app2);
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;
    activeCleanups.push(async () => {
      await app2.close();
      if (typeof server2.closeAllConnections === 'function') {
        server2.closeAllConnections();
      }
      await new Promise((resolve) => server2.close(resolve));
    });

    const admin = createClient(srv1.baseUrl);
    await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });

    const whale1 = createClient(srv1.baseUrl);
    const reg1 = await whale1.post('/api/auth/register', { username: 'cross_whale_1', password: 'Password!123' });
    await admin.post(`/api/admin/users/${reg1.json.user.id}/adjust-balance`, {
      amount: 3_000_000_000,
      reason: 'Cross-instance test bankroll'
    });

    // Instance 1 places 800M with key k1
    const firstBet = await whale1.post(
      '/api/live/bet',
      { bets: { tai: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'k1' } }
    );
    assert.equal(firstBet.status, 200);
    assert.equal(firstBet.json.replayed, false);
    assert.equal(firstBet.json.ticket.bets.tai, 800_000_000);
    assert.equal(firstBet.json.newBalance, 2_210_000_000);

    // Fresh Instance 2 sharing DB replays k1 -> must return 200 replayed: true (NOT false 400)
    const whale1OnInst2 = createClient(baseUrl2, whale1.jar.clone());
    const replayOnInst2 = await whale1OnInst2.post(
      '/api/live/bet',
      { bets: { tai: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'k1' } }
    );
    assert.equal(replayOnInst2.status, 200);
    assert.equal(replayOnInst2.json.replayed, true);
    assert.equal(replayOnInst2.json.ticket.bets.tai, 800_000_000);
    assert.equal(replayOnInst2.json.newBalance, 2_210_000_000);

    // Fresh Instance 2 with k1 + different payload -> must return 409 IDEMPOTENCY_CONFLICT
    const conflictOnInst2 = await whale1OnInst2.post(
      '/api/live/bet',
      { bets: { xiu: 800_000_000 }, liveRoundId: round1 },
      { headers: { 'Idempotency-Key': 'k1' } }
    );
    assert.equal(conflictOnInst2.status, 409);
    assert.equal(conflictOnInst2.json.code, 'IDEMPOTENCY_CONFLICT');

    // Cross-instance concurrent 800M + 800M on a second user -> one 200, one 400 INVALID_BETS
    const whale2Inst1 = createClient(srv1.baseUrl);
    const reg2 = await whale2Inst1.post('/api/auth/register', { username: 'cross_whale_2', password: 'Password!123' });
    await admin.post(`/api/admin/users/${reg2.json.user.id}/adjust-balance`, {
      amount: 3_000_000_000,
      reason: 'Cross-instance concurrent test bankroll'
    });
    const whale2Inst2 = createClient(baseUrl2, whale2Inst1.jar.clone());

    const [inst1Res, inst2Res] = await Promise.all([
      whale2Inst1.post('/api/live/bet', { bets: { tai: 800_000_000 }, liveRoundId: round1 }, { headers: { 'Idempotency-Key': 'cw2-a' } }),
      whale2Inst2.post('/api/live/bet', { bets: { tai: 800_000_000 }, liveRoundId: round1 }, { headers: { 'Idempotency-Key': 'cw2-b' } })
    ]);
    const crossStatuses = [inst1Res.status, inst2Res.status].sort((a, b) => a - b);
    assert.deepEqual(crossStatuses, [200, 400]);

    // Advance to REVEAL on Instance 2 and settle -> 200
    fakeNow2 = baseTime + LIVE_BET_MS;
    const settleCross = await whale2Inst2.post('/api/live/settle', { liveRoundId: round1 });
    assert.equal(settleCross.status, 200);
    assert.equal(settleCross.json.settled, true);
    assert.equal(settleCross.json.totalBet, 800_000_000);
  });
});

// =============================================================================
// Suite 6: HTTP Rate Limiting
// =============================================================================
describe('M3 Suite 6 — HTTP Rate Limiting (Auth IP & Roll User+IP)', () => {
  it('6.1: /api/auth/* enforces IP rate limit (429 + Retry-After) and /api/roll enforces per-user+IP limit', async () => {
    const srv = await startTestServer({
      authRateLimitMax: 5,
      betRateLimitMax: 3
    });

    const u1 = createClient(srv.baseUrl);
    const u2 = createClient(srv.baseUrl);

    // Register u1 & u2 (2 auth requests)
    assert.equal((await u1.post('/api/auth/register', { username: 'rl_user_1', password: 'Password!123' })).status, 201);
    assert.equal((await u2.post('/api/auth/register', { username: 'rl_user_2', password: 'Password!123' })).status, 201);

    // Unauthenticated /api/roll returns 401 before betLimiter (does not touch betLimiter)
    assert.equal((await createClient(srv.baseUrl).post('/api/roll', { bets: { tai: 1000 } })).status, 401);

    // u1 hits betRateLimitMax=3 -> 4th returns 429 with Retry-After
    for (let i = 0; i < 3; i++) {
      assert.equal((await u1.post('/api/roll', { bets: { tai: 1000 } })).status, 200);
    }
    const u1Limited = await u1.post('/api/roll', { bets: { tai: 1000 } });
    assert.equal(u1Limited.status, 429);
    assert.ok(Number(u1Limited.headers.get('retry-after')) >= 1);
    assert.equal(u1Limited.headers.get('x-ratelimit-remaining'), '0');

    // u2 has isolated user+IP bucket and still succeeds
    assert.equal((await u2.post('/api/roll', { bets: { tai: 1000 } })).status, 200);

    // Exceed authRateLimitMax=5 on /api/auth/login (2 already used above -> 3 more allowed, 4th 429)
    for (let i = 0; i < 3; i++) {
      assert.equal((await u1.post('/api/auth/login', { username: 'rl_user_1', password: 'wrong' })).status, 401);
    }
    const auth429 = await u1.post('/api/auth/login', { username: 'rl_user_1', password: 'wrong' });
    assert.equal(auth429.status, 429);
    assert.ok(Number(auth429.headers.get('retry-after')) >= 1);
  });

  it('6.2: BUG-1..5 & NOTE-6 regressions (parallel recover CAS, live/bet lock TOCTOU, admin self-lock, guest reset-pw, VERCEL betLimiter user-key)', async () => {
    const baseTime = 1_700_000_000_000;
    const round1 = Math.floor(baseTime / LIVE_ROUND_MS);
    const srv = await startTestServer({
      initialNow: baseTime,
      betRateLimitMax: 2,
      env: { VERCEL: '1', ADMIN_USERNAME: 'bossadmin' }
    });

    const admin = createClient(srv.baseUrl);
    const regA = await admin.post('/api/auth/register', { username: 'bossadmin', password: 'AdminPass!123' });
    assert.equal(regA.status, 201);
    const adminId = regA.json.user.id;

    // BUG-4: Admin self-lock rejected 400 CANNOT_LOCK_SELF
    const selfLock = await admin.post(`/api/admin/users/${adminId}/toggle-lock`, { locked: true });
    assert.equal(selfLock.status, 400);
    assert.equal(selfLock.json.code, 'CANNOT_LOCK_SELF');
    assert.equal((await admin.get('/api/auth/me')).status, 200);

    // BUG-5: Guest reset-password rejected 400 NOT_REGISTERED
    const guest = createClient(srv.baseUrl);
    const regG = await guest.post('/api/auth/guest', {});
    assert.equal(regG.status, 201);
    const guestReset = await admin.post(`/api/admin/users/${regG.json.user.id}/reset-password`, {});
    assert.equal(guestReset.status, 400);
    assert.equal(guestReset.json.code, 'NOT_REGISTERED');

    // BUG-1: Parallel /api/auth/recover with same recoveryCode -> exactly 1x 200 and 1x 401
    const player = createClient(srv.baseUrl);
    const regP = await player.post('/api/auth/register', { username: 'recover_race_u', password: 'InitPass!123' });
    assert.equal(regP.status, 201);
    const recCode = regP.json.recoveryCode;
    const [rec1, rec2] = await Promise.all([
      createClient(srv.baseUrl).post('/api/auth/recover', { username: 'recover_race_u', recoveryCode: recCode, newPassword: 'NewPass!111' }),
      createClient(srv.baseUrl).post('/api/auth/recover', { username: 'recover_race_u', recoveryCode: recCode, newPassword: 'NewPass!222' })
    ]);
    assert.deepEqual([rec1.status, rec2.status].sort((a, b) => a - b), [200, 401]);

    // Post-recover old cookie for player is immediately revoked (401)
    assert.equal((await player.get('/api/auth/me')).status, 401);

    // BUG-2: Phase-boundary TOCTOU inside withLiveBetLock rejects 2nd request if clock enters REVEAL during 1st DB call
    const origPlaceLive = srv.db.placeLiveBetAtomic.bind(srv.db);
    let flippedToReveal = false;
    srv.db.placeLiveBetAtomic = async (params) => {
      if (!flippedToReveal) {
        flippedToReveal = true;
        srv.setNow(baseTime + LIVE_BET_MS);
      }
      return origPlaceLive(params);
    };
    const bettor = createClient(srv.baseUrl);
    await bettor.post('/api/auth/register', { username: 'toctou_bettor', password: 'Password!123' });
    const [b1, b2] = await Promise.all([
      bettor.post('/api/live/bet', { bets: { tai: 10_000 }, liveRoundId: round1 }),
      bettor.post('/api/live/bet', { bets: { xiu: 10_000 }, liveRoundId: round1 })
    ]);
    assert.deepEqual([b1.status, b2.status].sort((a, b) => a - b), [200, 400]);
    const rejectedBet = b1.status === 400 ? b1 : b2;
    assert.equal(rejectedBet.json.code, 'LIVE_BETTING_CLOSED');

    // NOTE-6: Under VERCEL=1 trust proxy, rotating X-Forwarded-For does NOT bypass betLimiter for same user
    // (1st /api/live/bet already used 1 of betRateLimitMax=2 for bettor; note 2nd /api/live/bet also passed betLimiter -> total 2!)
    // So test with a fresh user roll_limit_u: 2 rolls pass with different X-Forwarded-For, 3rd returns 429!
    const rlUser = createClient(srv.baseUrl);
    await rlUser.post('/api/auth/register', { username: 'note6_user', password: 'Password!123' });
    const r1 = await rlUser.post('/api/roll', { bets: { tai: 1000 } }, { headers: { 'X-Forwarded-For': '10.0.0.1' } });
    const r2 = await rlUser.post('/api/roll', { bets: { tai: 1000 } }, { headers: { 'X-Forwarded-For': '10.0.0.2' } });
    const r3 = await rlUser.post('/api/roll', { bets: { tai: 1000 } }, { headers: { 'X-Forwarded-For': '10.0.0.3' } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
  });
});
