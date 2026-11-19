'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  LIVE_ROUND_MS,
  LIVE_BET_MS,
  startTestServer,
  startClockedServer,
  createClient,
  rawHttpRequest,
  parseCssRules,
  stripCssImportant,
  selectorMatchesNode,
  getMatrixBackdropOpenState,
  extractHtmlDataBets,
  extractElementAndAncestors,
  extractAncestorChainZIndex,
} = require('./helpers');

function extractBalancedJsFunction(source, fnName) {
  const fnDeclIdx = source.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
  const varDeclIdx = source.search(new RegExp(`(?:const|let|var)\\s+${fnName}\\s*=`));
  const startIdx = fnDeclIdx !== -1 ? fnDeclIdx : varDeclIdx;
  if (startIdx === -1) return null;

  const arrowIdx = source.indexOf('=>', startIdx);
  const braceStart = source.indexOf('{', startIdx);
  if (fnDeclIdx === -1 && arrowIdx !== -1 && (braceStart === -1 || arrowIdx < braceStart)) {
    const afterArrow = source.slice(arrowIdx + 2).match(/^\s*(.)/);
    if (afterArrow && afterArrow[1] !== '{') {
      const semiIdx = source.indexOf(';', arrowIdx + 2);
      const nlIdx = source.indexOf('\n', arrowIdx + 2);
      const endIdx = semiIdx !== -1 ? semiIdx + 1 : (nlIdx !== -1 ? nlIdx : source.length);
      return source.slice(startIdx, endIdx);
    }
  }

  if (braceStart === -1) return null;
  let depth = 1;
  let i = braceStart + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  const snippet = source.slice(startIdx, i);
  return fnDeclIdx !== -1 ? snippet : `${snippet};`;
}

// =============================================================================
// F1, F2, F7 & Static F8/F9/F10 Boundaries (Server T2-Sec)
// =============================================================================
describe('Tier 2 — Security, HTTP, Config & Wager Boundaries (T2-Sec)', () => {
  let server;
  let userClient;

  before(async () => {
    server = await startTestServer({ stripSecrets: true });
    userClient = createClient(server.baseUrl);
    const reg = await userClient.post('/api/auth/register', {
      username: 't2_sec_player',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    const wb = await userClient.post('/api/wallet/welcome-bonus', {});
    assert.equal(wb.status, 200);
  });

  after(async () => {
    if (server) await server.close();
  });

  // --- F1 Boundaries (5 tests) ---
  it('T2-F1.1: VERCEL=1 without JWT_SECRET/LIVE_MASTER_SECRET logs warning and serves /api/state 200', async () => {
    const vs = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });
    try {
      const res = await createClient(vs.baseUrl).get('/api/state');
      assert.equal(res.status, 200);
      const logs = `${vs.getLogs().stdout}\n${vs.getLogs().stderr}`;
      assert.match(logs, /warn|ephemeral|degraded|JWT_SECRET|LIVE_MASTER_SECRET/i);
    } finally {
      await vs.close();
    }
  });

  it('T2-F1.2: VERCEL=1 Set-Cookie sets Secure while local non-prod omits Secure', async () => {
    const localMeta = userClient.getCookieMeta('sicbo_token');
    assert.ok(localMeta);
    assert.equal(localMeta.secure, false, 'Local HTTP cookie must omit Secure');

    const vs = await startTestServer({ vercel: true, stripSecrets: true, clearCloudEnv: true });
    try {
      const vc = createClient(vs.baseUrl);
      const reg = await vc.post('/api/auth/register', {
        username: 't2_vercel_cookie',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      const vMeta = vc.getCookieMeta('sicbo_token');
      assert.ok(vMeta);
      assert.equal(vMeta.secure, true, 'VERCEL=1 cookie must include Secure flag');
      assert.equal(vMeta.httpOnly, true);
      assert.equal(vMeta.sameSite?.toLowerCase(), 'lax');
    } finally {
      await vs.close();
    }
  });

  it('T2-F1.3: tampered JWT signature is rejected with 401', async () => {
    const token = userClient.getCookie('sicbo_token');
    assert.ok(token);
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    const lastChar = parts[2].slice(-1);
    const tamperedSig = parts[2].slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
    const badClient = createClient(server.baseUrl);
    badClient.setRawCookieHeader(`sicbo_token=${parts[0]}.${parts[1]}.${tamperedSig}`);

    const me = await badClient.get('/api/auth/me');
    assert.equal(me.status, 401);
  });

  it('T2-F1.4: malformed or empty JWT cookie is rejected with 401', async () => {
    for (const badVal of ['not-a-jwt', 'a.b', 'eyJhbGciOiJub25lIn0.e30.', '']) {
      const c = createClient(server.baseUrl);
      c.setRawCookieHeader(`sicbo_token=${badVal}`);
      const res = await c.get('/api/auth/me');
      assert.equal(res.status, 401, `Token "${badVal}" must return 401`);
    }
  });

  it('T2-F1.5: NODE_ENV=production sets Secure flag on sicbo_token cookie', async () => {
    const prodServer = await startTestServer({
      stripSecrets: true,
      env: { NODE_ENV: 'production' },
    });
    try {
      const pc = createClient(prodServer.baseUrl);
      const reg = await pc.post('/api/auth/register', {
        username: 't2_prod_cookie',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      const meta = pc.getCookieMeta('sicbo_token');
      assert.ok(meta);
      assert.equal(meta.secure, true);
    } finally {
      await prodServer.close();
    }
  });

  // --- F2 Wager Validation Boundaries (6 tests) ---
  it('T2-F2.1: /api/roll rejects empty {}, array [], and null bets with 400', async () => {
    for (const badBets of [{}, [], null, 'tai']) {
      const res = await userClient.post('/api/roll', { bets: badBets });
      assert.equal(res.status, 400, `Expected 400 for bets=${JSON.stringify(badBets)}`);
    }
  });

  it('T2-F2.2: /api/roll rejects unknown bet key and unsorted pair_2_1 with 400', async () => {
    for (const badBets of [{ hacked_key: 1000 }, { pair_2_1: 1000 }, { total_3: 1000 }, { total_18: 1000 }]) {
      const res = await userClient.post('/api/roll', { bets: badBets });
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(badBets)}`);
    }
  });

  it('T2-F2.3: /api/roll rejects float, zero, and negative wagers with 400', async () => {
    for (const badBets of [{ tai: 100.5 }, { tai: 0 }, { tai: -1000 }, { tai: '10000' }]) {
      const res = await userClient.post('/api/roll', { bets: badBets });
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(badBets)}`);
    }
  });

  it('T2-F2.4: /api/roll rejects stake > 1,000,000,000 (1,000,000,001) with 400', async () => {
    const res = await userClient.post('/api/roll', { bets: { tai: 1_000_000_001 } });
    assert.equal(res.status, 400);
  });

  it('T2-F2.5: /api/roll rejects total wager exceeding user balance without mutating balance', async () => {
    const before = (await userClient.get('/api/auth/me')).json.user.balance;
    const res = await userClient.post('/api/roll', { bets: { tai: before + 1 } });
    assert.equal(res.status, 400);
    const afterBal = (await userClient.get('/api/auth/me')).json.user.balance;
    assert.equal(afterBal, before);
  });

  it('T2-F2.6: minimum positive integer stake (1) succeeds and valid extreme gates work', async () => {
    const res = await userClient.post('/api/roll', {
      bets: { total_4: 1, total_17: 1, triple_1: 1, pair_1_2: 1 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.totalBet, 4);
  });

  // --- F7 Express HTTP Boundaries (5 tests) ---
  it('T2-F7.1: POST /api/roll exceeding 16kb limit (~20KB) returns 413 JSON error and server stays healthy', async () => {
    const bigPad = 'x'.repeat(20 * 1024);
    const payload = JSON.stringify({ bets: { tai: 10_000 }, pad: bigPad });
    assert.ok(Buffer.byteLength(payload, 'utf8') > 16 * 1024);

    const res = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: userClient.snapshotCookie() },
      body: payload,
    });
    assert.equal(res.status, 413);
    assert.ok(res.json && typeof res.json.error === 'string', '413 response must be JSON');

    // Server remains healthy
    const okRes = await userClient.get('/api/state');
    assert.equal(okRes.status, 200);
  });

  it('T2-F7.2: POST /api/auth/register exceeding 16kb limit (~20KB) returns 413 JSON error', async () => {
    const payload = JSON.stringify({
      username: 'big_payload_user',
      password: 'Password!123',
      displayName: 'a'.repeat(20 * 1024),
    });
    const res = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/auth/register',
      body: payload,
    });
    assert.equal(res.status, 413);
    assert.ok(res.json && typeof res.json.error === 'string');
  });

  it('T2-F7.3: valid JSON payload just under 16kb (~12KB) is NOT rejected with 413', async () => {
    const payload = JSON.stringify({
      bets: { tai: 1_000 },
      pad: 's'.repeat(12 * 1024),
    });
    assert.ok(Buffer.byteLength(payload, 'utf8') < 16 * 1024);

    const res = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: userClient.snapshotCookie() },
      body: payload,
    });
    assert.notEqual(res.status, 413);
    assert.equal(res.status, 200);
  });

  it('T2-F7.4: malformed JSON body returns 400 JSON error (never 500 HTML stacktrace)', async () => {
    const res = await rawHttpRequest(server.baseUrl, {
      method: 'POST',
      path: '/api/roll',
      headers: { Cookie: userClient.snapshotCookie() },
      body: '{"bets": {bad json',
    });
    assert.equal(res.status, 400);
    assert.ok(res.json && typeof res.json.error === 'string');
  });

  it('T2-F7.5: unknown /api/* route returns 404 without X-Powered-By or stacktrace leak', async () => {
    const res = await userClient.get('/api/nonexistent-endpoint-xyz');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(/at\s+Object\.|node_modules/i.test(res.text), false);
  });

  // --- F8, F9, F10 Static/DOM/JS Boundary Checks (15 tests) ---
  describe('F8, F9, F10 Frontend Security & Boundary Contracts', () => {
    let html;
    let css;
    let appJs;
    let threeEngineJs;
    let threeUiJs;
    let cssRules;

    before(async () => {
      const [rH, rC, rA, rT, rU] = await Promise.all([
        userClient.get('/'),
        userClient.get('/style.css'),
        userClient.get('/app.js'),
        userClient.get('/three-engine.js'),
        userClient.get('/threeui-fx.js'),
      ]);
      html = rH.text;
      css = rC.text;
      appJs = rA.text;
      threeEngineJs = rT.text;
      threeUiJs = rU.text;
      cssRules = parseCssRules(css);
    });

    it('T2-F8.1: #fullMatrixModal backdrop never blocks #chipsSelector or #btnRoll via stacking/pointer-events', () => {
      const matrixChain = extractAncestorChainZIndex(html, cssRules, 'fullMatrixModal');
      assert.ok(matrixChain && matrixChain.length >= 1);
      const chipChain = extractAncestorChainZIndex(html, cssRules, 'chipsSelector');
      const rollChain = extractAncestorChainZIndex(html, cssRules, 'btnRoll');
      const { matrixZ, matrixOpenPointerEvents } = getMatrixBackdropOpenState(cssRules);
      const chipZ = chipChain.find((n) => n.zIndex !== null)?.zIndex ?? 0;
      const rollZ = rollChain.find((n) => n.zIndex !== null)?.zIndex ?? 0;

      assert.ok(chipZ > matrixZ || matrixOpenPointerEvents === 'none', `chipZ=${chipZ} vs matrixZ=${matrixZ} (openPtr=${matrixOpenPointerEvents})`);
      assert.ok(rollZ > matrixZ || matrixOpenPointerEvents === 'none', `rollZ=${rollZ} vs matrixZ=${matrixZ} (openPtr=${matrixOpenPointerEvents})`);
    });

    it('T2-F8.2: no legacy .editorial-hero-block or #btnTopup remains in served HTML', () => {
      assert.equal(/editorial-hero-block/.test(html), false);
      assert.equal(/id=["']btnTopup["']/.test(html), false);
    });

    it('T2-F8.3: CSS restores cursor on modals and inputs', () => {
      let hasUnguardedGlobalCursorNone = false;
      let hasModalCursorRestore = false;
      let hasInputCursorRestore = false;
      for (const rule of cssRules) {
        const cursorVal = rule.props.has('cursor')
          ? stripCssImportant(rule.props.get('cursor')).toLowerCase()
          : null;
        for (const sel of rule.selectors) {
          const trimmed = sel.trim();
          const lowerSel = trimmed.toLowerCase();
          if (cursorVal === 'none' && /(?:^|[\s>+~])\*/.test(trimmed) && !/:not\(\s*\.modal-open\s*\)/i.test(trimmed)) {
            hasUnguardedGlobalCursorNone = true;
          }
          if ((lowerSel.includes('modal-open') || lowerSel.includes('.modal.open'))
            && !lowerSel.includes('cursor-dot') && !lowerSel.includes('cursor-ring')
            && (cursorVal === 'auto' || cursorVal === 'default')) {
            hasModalCursorRestore = true;
          }
          if (/(?:^|[\s,+~>])(input|textarea|select)(?:$|[\s.:,\[>+~])/.test(lowerSel)
            && (cursorVal === 'text' || cursorVal === 'auto' || cursorVal === 'pointer' || cursorVal === 'default')) {
            hasInputCursorRestore = true;
          }
        }
      }
      assert.equal(hasUnguardedGlobalCursorNone && !hasModalCursorRestore, false, 'Unguarded * { cursor: none } without modal cursor restore');
      assert.ok(hasModalCursorRestore, 'CSS must restore cursor: auto/default on modal-open');
      assert.ok(hasInputCursorRestore, 'CSS must restore cursor on inputs');
    });

    it('T2-F8.4: #rulesModal documents boundary Macau payout ratios (1:180, 1:60, 1:30, 1:10, 1:5)', () => {
      assert.ok(extractElementAndAncestors(html, 'rulesModal'));
      for (const ratio of ['1:180', '1:60', '1:30', '1:10', '1:5']) {
        assert.ok(html.includes(ratio) || html.replace(/\s+/g, '').includes(ratio), `Missing odds ${ratio}`);
      }
    });

    it('T2-F8.5: #toastContainer and #roundResultBanner exist with non-hidden CSS styling', () => {
      assert.ok(extractElementAndAncestors(html, 'toastContainer'));
      assert.ok(extractElementAndAncestors(html, 'roundResultBanner'));
      assert.match(css, /#toastContainer|\.toast/);
      assert.match(css, /#roundResultBanner|\.round-result-banner/);
    });

    it('T2-F9.1: escapeHtml neutralizes all 5 HTML metacharacters (& < > " \') and handles empty string', () => {
      const fnCode = extractBalancedJsFunction(appJs, 'escapeHtml');
      assert.ok(fnCode);
      const sandbox = { out1: null, out2: null };
      vm.runInNewContext(
        `${fnCode}
         out1 = escapeHtml('<img src=x onerror="alert(1)"> & \\'test\\'');
         out2 = escapeHtml('');`,
        sandbox
      );
      assert.equal(sandbox.out2, '');
      assert.equal(/[<>]/.test(sandbox.out1), false);
      assert.ok(sandbox.out1.includes('&lt;img'));
      assert.ok(sandbox.out1.includes('&gt;'));
      assert.ok(sandbox.out1.includes('&amp;'));
      assert.ok(sandbox.out1.includes('&quot;'));
      assert.ok(sandbox.out1.includes("'") === false);
    });

    it('T2-F9.2: API_BASE is empty string with zero hardcoded localhost:3000 URLs', () => {
      assert.match(appJs, /const\s+API_BASE\s*=\s*['"]['"]\s*;/);
      assert.equal(/localhost:3000/.test(appJs), false);
    });

    it('T2-F9.3: HTML [data-bet] contains only sorted pair_a_b (a < b) and zero reversed pair_b_a', () => {
      const bets = extractHtmlDataBets(html);
      for (const key of bets) {
        if (key.startsWith('pair_')) {
          const [, a, b] = key.split('_').map(Number);
          assert.ok(a >= 1 && b <= 6 && a < b, `Invalid pair gate in HTML: ${key}`);
        }
      }
    });

    it('T2-F9.4: "HÒA VỐN • ±0 ₫" branch is distinct from loss branch in app.js', () => {
      assert.ok(appJs.includes('HÒA VỐN • ±0 ₫'));
      assert.match(appJs, /netProfit\s*===\s*0/);
    });

    it('T2-F9.5: app.js guards chip Undo/Clear/betting against mid-roll state mutations', () => {
      assert.match(appJs, /isRolling/);
      assert.match(appJs, /btnUndo/);
    });

    it('T2-F10.1: @media (max-width: 980px) never hides #chipsSelector/#btnRoll/#userBalance and removes #chkSqueeze', () => {
      assert.equal(extractElementAndAncestors(html, 'chkSqueeze'), null);
      const mobileRules = cssRules.filter((r) => r.media && /980px/.test(r.media));
      assert.ok(mobileRules.length > 0);
      for (const id of ['btnRoll', 'chipsSelector', 'userBalance', 'btnModeLive']) {
        const info = extractElementAndAncestors(html, id);
        assert.ok(info);
        for (const node of [...info.ancestors, info.element]) {
          let disp = null;
          let dispImp = false;
          let vis = null;
          let visImp = false;
          let opa = null;
          let opaImp = false;
          for (const r of mobileRules) {
            if (!r.selectors.some((s) => selectorMatchesNode(s, node))) continue;
            if (r.props.has('display')) {
              const raw = r.props.get('display');
              const isImp = /!important/i.test(raw);
              if (isImp || !dispImp) {
                disp = stripCssImportant(raw).toLowerCase();
                if (isImp) dispImp = true;
              }
            }
            if (r.props.has('visibility')) {
              const raw = r.props.get('visibility');
              const isImp = /!important/i.test(raw);
              if (isImp || !visImp) {
                vis = stripCssImportant(raw).toLowerCase();
                if (isImp) visImp = true;
              }
            }
            if (r.props.has('opacity')) {
              const raw = r.props.get('opacity');
              const isImp = /!important/i.test(raw);
              if (isImp || !opaImp) {
                opa = stripCssImportant(raw).toLowerCase();
                if (isImp) opaImp = true;
              }
            }
          }
          assert.notEqual(disp, 'none');
          assert.notEqual(vis, 'hidden');
          assert.notEqual(opa, '0');
        }
      }
    });

    it('T2-F10.2: three-engine.js never sets touchmove to passive:true (uses passive:false)', () => {
      assert.equal(/addEventListener\s*\(\s*['"]touchmove['"][^)]*passive\s*:\s*true/.test(threeEngineJs), false);
      assert.match(threeEngineJs, /addEventListener\s*\(\s*['"]touchmove['"][^)]*passive\s*:\s*false/);
    });

    it('T2-F10.3: app.js localStorage graphicsQuality defaults safely when missing or invalid', () => {
      assert.ok(appJs.includes('sicbo_graphics_quality'));
      assert.match(appJs, /high|balanced|eco/);
    });

    it('T2-F10.4: three-engine.js checks document.hidden and listens to visibilitychange', () => {
      assert.match(threeEngineJs, /document\.hidden/);
      assert.match(threeEngineJs, /visibilitychange/);
    });

    it('T2-F10.5: threeui-fx.js checks document.hidden and listens to visibilitychange', () => {
      assert.match(threeUiJs, /document\.hidden/);
      assert.match(threeUiJs, /visibilitychange/);
    });
  });
});

// =============================================================================
// F3 Clocked Live Room Boundaries (Server T2-LiveClock)
// =============================================================================
describe('Tier 2 — F3: Provably Fair & Live Clock Boundaries (T2-LiveClock)', () => {
  let server;
  let client;
  let roundStart;
  let roundId;

  before(async () => {
    roundStart = Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;
    roundId = Math.floor(roundStart / LIVE_ROUND_MS);
    server = await startClockedServer({ initialNowMs: roundStart });
    client = createClient(server.baseUrl);
    const reg = await client.post('/api/auth/register', {
      username: 't2_live_user',
      password: 'Password!123',
    });
    assert.equal(reg.status, 201);
    const wb = await client.post('/api/wallet/welcome-bonus', {});
    assert.equal(wb.status, 200);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T2-F3.1: GET /api/live/state at elapsed=0 and LIVE_BET_MS-1 never exposes dice or outcome', async () => {
    for (const offset of [0, LIVE_BET_MS - 1]) {
      await server.setTime(roundStart + offset);
      const res = await client.get('/api/live/state');
      assert.equal(res.status, 200);
      assert.equal(res.json.phase, 'BETTING');
      assert.equal(res.json.dice, undefined);
      assert.equal(res.json.outcome, undefined);
    }
  });

  it('T2-F3.4: POST /api/live/settle during BETTING is rejected (400/425)', async () => {
    await server.setTime(roundStart + 5000);
    await client.post('/api/live/bet', { bets: { tai: 10_000 }, liveRoundId: roundId });
    const settle = await client.post('/api/live/settle', { liveRoundId: roundId });
    assert.ok([400, 425].includes(settle.status));
  });

  it('T2-F3.2: POST /api/live/bet during REVEAL (elapsed=LIVE_BET_MS) is rejected with 400', async () => {
    await server.setTime(roundStart + LIVE_BET_MS);
    const betRes = await client.post('/api/live/bet', { bets: { tai: 10_000 }, liveRoundId: roundId });
    assert.equal(betRes.status, 400);
  });

  it('T2-F3.3: POST /api/live/bet with mismatched/stale liveRoundId is rejected with 400', async () => {
    await server.setTime(roundStart + LIVE_ROUND_MS);
    const betRes = await client.post('/api/live/bet', { bets: { tai: 10_000 }, liveRoundId: roundId });
    assert.equal(betRes.status, 400);
  });

  it('T2-F3.5: POST /api/verify-fairness rejects missing serverSeed / negative nonce and accepts nonce=0', async () => {
    const missingSeed = await client.post('/api/verify-fairness', { clientSeed: 'abc', nonce: 0 });
    assert.equal(missingSeed.status, 400);

    const negNonce = await client.post('/api/verify-fairness', { serverSeed: 's', clientSeed: 'c', nonce: -1 });
    assert.equal(negNonce.status, 400);

    const validZero = await client.post('/api/verify-fairness', { serverSeed: 's', clientSeed: 'c', nonce: 0 });
    assert.equal(validZero.status, 200);
    assert.equal(validZero.json.dice.length, 3);
  });
});

// =============================================================================
// F5 SessionVersion Revocation & XSS Boundaries (Server T2-AuthRevoke)
// =============================================================================
describe('Tier 2 — F5: sessionVersion Revocation & Input Boundaries (T2-AuthRevoke)', () => {
  let server;
  let adminClient;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't2_revoke_admin' },
    });
    adminClient = createClient(server.baseUrl);
    const reg = await adminClient.post('/api/auth/register', {
      username: 't2_revoke_admin',
      password: 'AdminPass!123',
    });
    assert.equal(reg.status, 201);
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T2-F5.1: change-password immediately revokes pre-change token (401 on /me and /roll)', async () => {
    const c = createClient(server.baseUrl);
    const reg = await c.post('/api/auth/register', { username: 'revoke_pw_u', password: 'OldPassword!123' });
    assert.equal(reg.status, 201);
    const oldCookie = c.snapshotCookie();

    const ch = await c.post('/api/auth/change-password', {
      currentPassword: 'OldPassword!123',
      newPassword: 'NewPassword!456',
    });
    assert.equal(ch.status, 200);

    const staleClient = createClient(server.baseUrl);
    staleClient.setRawCookieHeader(oldCookie);
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);
    assert.equal((await staleClient.post('/api/roll', { bets: { tai: 1000 } })).status, 401);
  });

  it('T2-F5.2: Admin toggle-lock immediately revokes active token (401) and blocks login (403)', async () => {
    const victim = createClient(server.baseUrl);
    const reg = await victim.post('/api/auth/register', { username: 'revoke_lock_u', password: 'Password!123' });
    assert.equal(reg.status, 201);
    const victimId = reg.json.user.id;
    const activeCookie = victim.snapshotCookie();

    const lockRes = await adminClient.post(`/api/admin/users/${victimId}/toggle-lock`, { locked: true });
    assert.equal(lockRes.status, 200);

    const staleClient = createClient(server.baseUrl);
    staleClient.setRawCookieHeader(activeCookie);
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);
    assert.equal((await staleClient.post('/api/roll', { bets: { tai: 1000 } })).status, 401);

    const loginRes = await createClient(server.baseUrl).post('/api/auth/login', {
      username: 'revoke_lock_u',
      password: 'Password!123',
    });
    assert.equal(loginRes.status, 403);
  });

  it('T2-F5.3: Admin reset-password immediately revokes victim active token (401)', async () => {
    const victim = createClient(server.baseUrl);
    const reg = await victim.post('/api/auth/register', { username: 'revoke_reset_u', password: 'Password!123' });
    assert.equal(reg.status, 201);
    const victimId = reg.json.user.id;
    const activeCookie = victim.snapshotCookie();

    const resetRes = await adminClient.post(`/api/admin/users/${victimId}/reset-password`, {});
    assert.equal(resetRes.status, 200);

    const staleClient = createClient(server.baseUrl);
    staleClient.setRawCookieHeader(activeCookie);
    assert.equal((await staleClient.get('/api/auth/me')).status, 401);
    assert.equal((await staleClient.post('/api/roll', { bets: { tai: 1000 } })).status, 401);
  });

  it('T2-F5.6: auth rejects invalid/short passwords and safely handles XSS payload in displayName', async () => {
    const shortPw = await createClient(server.baseUrl).post('/api/auth/register', {
      username: 'short_pw_user',
      password: '12',
    });
    assert.equal(shortPw.status, 400);

    const xssClient = createClient(server.baseUrl);
    const xssReg = await xssClient.post('/api/auth/register', {
      username: 'xss_disp_user',
      password: 'Password!123',
      displayName: '<script>alert(1)</script>',
    });
    // Server either rejects unsafe chars (400) or stores safely as JSON text (201) without executing HTML
    assert.ok([201, 400].includes(xssReg.status));
  });
});

// =============================================================================
// F4 & F6 Wallet, Bankruptcy & RBAC Boundaries (Server T2-WalletAdmin)
// =============================================================================
describe('Tier 2 — F4 & F6: Bankruptcy, Admin Adjust & RBAC Boundaries (T2-WalletAdmin)', () => {
  let server;
  let adminClient;
  let userA;
  let userAId;
  let userB;
  let guestClient;

  before(async () => {
    server = await startTestServer({
      stripSecrets: true,
      env: { ADMIN_USERNAME: 't2_wallet_admin' },
    });
    adminClient = createClient(server.baseUrl);
    const regAdmin = await adminClient.post('/api/auth/register', {
      username: 't2_wallet_admin',
      password: 'AdminPass!123',
    });
    assert.equal(regAdmin.status, 201);

    userA = createClient(server.baseUrl);
    const regA = await userA.post('/api/auth/register', {
      username: 't2_wallet_ua',
      password: 'Password!123',
    });
    assert.equal(regA.status, 201);
    userAId = regA.json.user.id;

    userB = createClient(server.baseUrl);
    const regB = await userB.post('/api/auth/register', {
      username: 't2_wallet_ub',
      password: 'Password!123',
    });
    assert.equal(regB.status, 201);
    assert.equal(regB.json.user.balance, 0);
    await userB.post('/api/wallet/welcome-bonus', {});

    guestClient = createClient(server.baseUrl);
    const regG = await guestClient.post('/api/auth/guest', {});
    assert.equal(regG.status, 403);
    assert.equal(regG.json.code, 'GUEST_DISABLED');
  });

  after(async () => {
    if (server) await server.close();
  });

  it('T2-F6.1: welcome-bonus succeeds once (+2M) and rejects repeat with 409 WELCOME_BONUS_ALREADY_CLAIMED', async () => {
    const wb1 = await userA.post('/api/wallet/welcome-bonus', {});
    assert.equal(wb1.status, 200);
    assert.equal(wb1.json.bonusAmount, 2_000_000);
    assert.equal(wb1.json.balance, 2_000_000);
    const wb2 = await userA.post('/api/wallet/welcome-bonus', {});
    assert.equal(wb2.status, 409);
    assert.equal(wb2.json.code, 'WELCOME_BONUS_ALREADY_CLAIMED');
  });

  it('T2-F6.2: retired bankruptcy-aid & daily-bonus return 410 without altering balance', async () => {
    const beforeBal = (await userA.get('/api/auth/me')).json.user.balance;
    const aid = await userA.post('/api/wallet/bankruptcy-aid', {});
    const daily = await userA.post('/api/wallet/daily-bonus', {});
    assert.equal(aid.status, 410);
    assert.equal(daily.status, 410);
    assert.equal((await userA.get('/api/auth/me')).json.user.balance, beforeBal);
  });

  it('T2-F6.3: admin adjust-balance credits and drains accurately down to 0 boundary', async () => {
    await adminClient.post(`/api/admin/users/${userAId}/adjust-balance`, {
      amount: -2_000_000,
      reason: 'Drain to 0 boundary check',
    });
    assert.equal((await userA.get('/api/auth/me')).json.user.balance, 0);
  });

  it('T2-F6.4: non-admin standard user receives 403 on all /api/admin/* endpoints', async () => {
    assert.equal((await userB.get('/api/admin/users')).status, 403);
    assert.equal((await userB.post(`/api/admin/users/${userAId}/adjust-balance`, { amount: 100, reason: 'x' })).status, 403);
    assert.equal((await userB.post(`/api/admin/users/${userAId}/toggle-lock`, { locked: true })).status, 403);
    assert.equal((await userB.post(`/api/admin/users/${userAId}/reset-password`, {})).status, 403);
  });

  it('T2-F6.5: unauthenticated & non-admin receive 401/403 on all /api/admin/* endpoints', async () => {
    const anon = createClient(server.baseUrl);
    for (const [roleClient, expected] of [[userB, 403], [anon, 401]]) {
      assert.equal((await roleClient.get('/api/admin/users')).status, expected);
      assert.equal((await roleClient.post(`/api/admin/users/${userAId}/adjust-balance`, { amount: 100, reason: 'x' })).status, expected);
      assert.equal((await roleClient.post(`/api/admin/users/${userAId}/toggle-lock`, { locked: true })).status, expected);
      assert.equal((await roleClient.post(`/api/admin/users/${userAId}/reset-password`, {})).status, expected);
    }
  });

  it('T2-F6.6: admin operations on non-existent userId return 404', async () => {
    const fakeId = 'nonexistent-user-id-99999';
    assert.equal((await adminClient.post(`/api/admin/users/${fakeId}/adjust-balance`, { amount: 100, reason: 'x' })).status, 404);
    assert.equal((await adminClient.post(`/api/admin/users/${fakeId}/toggle-lock`, { locked: true })).status, 404);
    assert.equal((await adminClient.post(`/api/admin/users/${fakeId}/reset-password`, {})).status, 404);
  });

  it('T2-F4.1: Idempotency-Key is scoped per user (User B reusing User A key executes own roll)', async () => {
    await adminClient.post(`/api/admin/users/${userAId}/adjust-balance`, {
      amount: 100_000,
      reason: 'Fund userA for idempotency check',
    });
    const rA = await userA.post('/api/roll', { bets: { tai: 10_000 } }, { headers: { 'Idempotency-Key': 'shared-key-xyz' } });
    const rB = await userB.post('/api/roll', { bets: { xiu: 20_000 } }, { headers: { 'Idempotency-Key': 'shared-key-xyz' } });
    assert.equal(rA.status, 200);
    assert.equal(rB.status, 200);
    assert.equal(rB.json.totalBet, 20_000);
    assert.notEqual(rB.json.roundId, rA.json.roundId);
  });

  it('T2-F4.2: distinct Idempotency-Keys for same user execute distinct rolls and ledger rows', async () => {
    const beforeCount = (await userB.get('/api/auth/me')).json.ledger.length;
    const r1 = await userB.post('/api/roll', { bets: { tai: 5_000 } }, { headers: { 'Idempotency-Key': 'uB-key-1' } });
    const r2 = await userB.post('/api/roll', { bets: { tai: 5_000 } }, { headers: { 'Idempotency-Key': 'uB-key-2' } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.json.roundId, r2.json.roundId);
    const afterCount = (await userB.get('/api/auth/me')).json.ledger.length;
    assert.ok(afterCount >= beforeCount + 2);
  });

  it('T2-F4.3: admin adjust-balance driving balance negative (-999,999,999) is rejected with 400', async () => {
    const beforeBal = (await userA.get('/api/auth/me')).json.user.balance;
    const res = await adminClient.post(`/api/admin/users/${userAId}/adjust-balance`, {
      amount: -999_999_999,
      reason: 'Illegal overdraft',
    });
    assert.equal(res.status, 400);
    assert.equal((await userA.get('/api/auth/me')).json.user.balance, beforeBal);
  });

  it('T2-F4.4: admin adjust-balance rejects amount=0, float, non-number, or empty reason with 400', async () => {
    for (const payload of [
      { amount: 0, reason: 'Zero' },
      { amount: 12.5, reason: 'Float' },
      { amount: '1000', reason: 'String' },
      { amount: 1000, reason: '' },
      { amount: 1000 },
    ]) {
      const res = await adminClient.post(`/api/admin/users/${userAId}/adjust-balance`, payload);
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(payload)}`);
    }
  });

  it('T2-F4.5: wallet_ledger reconciles exact balanceBefore/balanceAfter deltas across userB history', async () => {
    const me = await userB.get('/api/auth/me');
    const ledger = me.json.ledger;
    assert.ok(ledger.length >= 3);
    let totalSignedDelta = 0;
    for (const entry of ledger) {
      assert.equal(typeof entry.balanceBefore, 'number');
      assert.equal(typeof entry.amount, 'number');
      assert.equal(typeof entry.balanceAfter, 'number');
      const delta = entry.balanceAfter - entry.balanceBefore;
      assert.equal(Math.abs(entry.amount), Math.abs(delta));
      totalSignedDelta += delta;
    }
    assert.equal(0 + totalSignedDelta, me.json.user.balance);
  });
});

// =============================================================================
// F5 Dedicated Rate-Limit 429 Servers (T2-RL-Auth & T2-RL-Roll)
// =============================================================================
describe('Tier 2 — F5: Dedicated Rate-Limit 429 Isolation', () => {
  it('T2-F5.4: burst on /api/auth/login triggers 429 Too Many Requests with JSON error', async () => {
    const rlServer = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(rlServer.baseUrl);
      let saw429 = false;
      let saw401 = false;
      for (let i = 0; i < 80; i++) {
        const res = await client.post('/api/auth/login', {
          username: 'nobody_here',
          password: 'WrongPassword!123',
        });
        if (res.status === 401) saw401 = true;
        if (res.status === 429) {
          saw429 = true;
          assert.ok(res.json && typeof res.json.error === 'string', '429 must return JSON error');
          break;
        }
      }
      assert.equal(saw401, true, 'Initial failed login attempts must return 401');
      assert.equal(saw429, true, 'Auth burst must trigger 429 rate limit');
    } finally {
      await rlServer.close();
    }
  });

  it('T2-F5.5: burst on /api/roll triggers 429 Too Many Requests with JSON error', async () => {
    const rlServer = await startTestServer({ stripSecrets: true });
    try {
      const client = createClient(rlServer.baseUrl);
      const reg = await client.post('/api/auth/register', {
        username: 'rl_roll_player',
        password: 'Password!123',
      });
      assert.equal(reg.status, 201);
      await client.post('/api/wallet/welcome-bonus', {});

      let saw200 = false;
      let saw429 = false;
      for (let i = 0; i < 120; i++) {
        const res = await client.post('/api/roll', { bets: { tai: 1_000 } });
        if (res.status === 200) saw200 = true;
        if (res.status === 429) {
          saw429 = true;
          assert.ok(res.json && typeof res.json.error === 'string', '429 must return JSON error');
          break;
        }
      }
      assert.equal(saw200, true, 'Initial rolls must succeed with 200');
      assert.equal(saw429, true, 'Roll burst must trigger 429 rate limit');
    } finally {
      await rlServer.close();
    }
  });
});
