'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  MACAU_BET_KEYS,
  startTestServer,
  createClient,
  parseCssRules,
  stripCssImportant,
  selectorMatchesNode,
  getMatrixBackdropOpenState,
  extractHtmlDataBets,
  extractElementAndAncestors,
  extractAncestorChainZIndex,
  hasPlaywright,
} = require('./helpers');

function extractBalancedJsFunction(source, fnName) {
  const fnDeclIdx = source.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
  const varDeclIdx = source.search(new RegExp(`(?:const|let|var)\\s+${fnName}\\s*=`));
  const startIdx = fnDeclIdx !== -1 ? fnDeclIdx : varDeclIdx;
  if (startIdx === -1) return null;

  const arrowIdx = source.indexOf('=>', startIdx);
  const braceStart = source.indexOf('{', startIdx);

  // Handle concise arrow function without block body: const escapeHtml = (s) => ...;
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
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  const snippet = source.slice(startIdx, i);
  return fnDeclIdx !== -1 ? snippet : `${snippet};`;
}

describe('Tier 1 — F8, F9, F10: Frontend Assets, UI Overhaul, Chips, Mobile & 3D', () => {
  let server;
  let client;
  let html;
  let css;
  let appJs;
  let threeEngineJs;
  let threeUiJs;
  let audioJs;
  let cssRules;

  before(async () => {
    server = await startTestServer({ stripSecrets: true });
    client = createClient(server.baseUrl);

    const [rHtml, rCss, rApp, rThree, rUi, rAudio] = await Promise.all([
      client.get('/'),
      client.get('/style.css'),
      client.get('/app.js'),
      client.get('/three-engine.js'),
      client.get('/threeui-fx.js'),
      client.get('/audio.js'),
    ]);

    assert.equal(rHtml.status, 200);
    assert.equal(rCss.status, 200);
    assert.equal(rApp.status, 200);
    assert.equal(rThree.status, 200);
    assert.equal(rUi.status, 200);
    assert.equal(rAudio.status, 200);

    html = rHtml.text;
    css = rCss.text;
    appJs = rApp.text;
    threeEngineJs = rThree.text;
    threeUiJs = rUi.text;
    audioJs = rAudio.text;
    cssRules = parseCssRules(css);
  });

  after(async () => {
    if (server) await server.close();
  });

  // ---------------------------------------------------------------------------
  // F8: UI Overhaul, Z-Index & Modals (6 tests)
  // ---------------------------------------------------------------------------
  describe('F8: UI Overhaul, Z-Index, Modals, Toast, Banner & Cursor', () => {
    it('F8.1: all 6 frontend assets serve 200 OK while server secrets/code are not publicly exposed', async () => {
      assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'));
      assert.ok(css.length > 500);
      assert.ok(appJs.length > 500);
      assert.ok(threeEngineJs.length > 500);
      assert.ok(threeUiJs.length > 100);
      assert.ok(audioJs.length > 100);

      for (const secretPath of ['/.env.example', '/.env', '/server.js', '/data/.secrets.json']) {
        const res = await client.get(secretPath);
        assert.notEqual(res.status, 200, `${secretPath} must never be served as 200 OK`);
      }
    });

    it('F8.2: Hero promo block, legacy +5M topup & manual solo toggle are removed; Live 45s & ? Luat & Ty le modal are present', () => {
      assert.equal(/class=["'][^"']*editorial-hero-block/.test(html), false, 'Hero promo block must be removed');
      assert.equal(/Step into the private salon/i.test(html), false, 'Legacy Hero promo text must be removed from play table');
      assert.equal(/id=["']btnTopup["']/.test(html), false, 'Legacy infinite +5M topup button must be removed');
      assert.equal(/\/api\/topup/.test(appJs), false, 'Legacy /api/topup endpoint call must be removed');
      assert.equal(/id=["']btnModeManual["']/.test(html), false, 'Manual solo toggle #btnModeManual must be removed');
      assert.equal(/TỰ LẮC/.test(html), false, 'Legacy TỰ LẮC mode text must be removed');

      assert.match(html, /id=["']btnModeLive["']/);
      assert.match(html, /LIVE 45S/);
      assert.match(appJs, /LIVE_ROUND_MS\s*=\s*45000/);
      assert.match(appJs, /LIVE_BET_MS\s*=\s*37000/);
      assert.match(appJs, /LIVE_REVEAL_MS\s*=\s*8000/);

      assert.match(html, /id=["']btnOpenRules["']/);
      assert.match(html, /id=["']rulesModal["']/);
      assert.match(html, /1\s*:\s*180/);
      assert.match(html, /1\s*:\s*10/);
      assert.match(html, /1\s*:\s*5/);
      assert.match(html, /1\s*:\s*30/);
    });

    it('F8.3: Auth, Admin, Leaderboard, Wallet Ledger, 1-Time Welcome Bonus & 0 ₫ unauthenticated default exist', () => {
      const requiredIds = [
        'btnAuthModal',
        'authModal',
        'btnOpenAdmin',
        'adminModal',
        'adminStorageWarning',
        'btnOpenLeaderboard',
        'leaderboardModal',
        'tabWalletLedger',
        'btnWelcomeBonus',
        'userBalance',
      ];
      for (const id of requiredIds) {
        assert.ok(
          extractElementAndAncestors(html, id),
          `Required UI element #${id} must exist in index.html`
        );
      }
      assert.equal(extractElementAndAncestors(html, 'btnDailyBonus'), null, 'Obsolete daily bonus button must be removed');
      assert.equal(extractElementAndAncestors(html, 'btnBankruptcyAid'), null, 'Obsolete bankruptcy aid button must be removed');
      assert.equal(extractElementAndAncestors(html, 'btnPlayAsGuest'), null, 'Obsolete guest login button must be removed');
      assert.match(html, /<span id="userBalance">0<\/span>/);
    });

    it('F8.4: fullMatrixModal z-index stacking does not block chips, action controls, wager summary, or btnRoll', () => {
      const matrixChain = extractAncestorChainZIndex(html, cssRules, 'fullMatrixModal');
      assert.ok(matrixChain && matrixChain.length >= 1, '#fullMatrixModal must exist in HTML');
      const { matrixZ, matrixOpenPointerEvents } = getMatrixBackdropOpenState(cssRules);

      const criticalControlIds = ['chipsSelector', 'btnUndo', 'btnClear', 'btnDouble', 'btnRebet', 'currentWagerSummary', 'btnRoll'];
      for (const ctrlId of criticalControlIds) {
        const chain = extractAncestorChainZIndex(html, cssRules, ctrlId);
        assert.ok(chain, `Control #${ctrlId} must exist in HTML`);

        // Effective root stacking z-index is the first positioned ancestor with numeric z-index
        const stackingContexts = chain.filter((n) => n.zIndex !== null);
        const topContextZ = stackingContexts.length > 0 ? stackingContexts[0].zIndex : 0;

        const nonBlockingByPointer = matrixOpenPointerEvents === 'none';
        const nonBlockingByZ = topContextZ > matrixZ;
        assert.ok(
          nonBlockingByZ || nonBlockingByPointer,
          `Control #${ctrlId} (stacking z=${topContextZ}) must remain interactive above #fullMatrixModal (z=${matrixZ}, pointer-events=${matrixOpenPointerEvents})`
        );
      }
    });

    it('F8.5: Toast Notification (#toastContainer) & Round Result Banner (#roundResultBanner) exist and are wired', () => {
      assert.ok(extractElementAndAncestors(html, 'toastContainer'), '#toastContainer must exist');
      assert.ok(extractElementAndAncestors(html, 'roundResultBanner'), '#roundResultBanner must exist');
      assert.match(css, /#toastContainer|\.toast-container|\.toast/);
      assert.match(css, /#roundResultBanner|\.round-result-banner/);
      assert.match(appJs, /toastContainer|showToast/);
      assert.match(appJs, /roundResultBanner/);
    });

    it('F8.6: system cursor is restored when modals or text inputs are active', () => {
      let hasUnguardedGlobalCursorNone = false;
      let hasModalCursorRestore = false;
      let hasInputCursorRestore = false;
      let hidesCustomCursorOnModal = false;

      for (const rule of cssRules) {
        const cursorVal = rule.props.has('cursor')
          ? stripCssImportant(rule.props.get('cursor')).toLowerCase()
          : null;

        for (const sel of rule.selectors) {
          const trimmed = sel.trim();
          const lowerSel = trimmed.toLowerCase();

          if (cursorVal === 'none') {
            const targetsUniversal = /(?:^|[\s>+~])\*/.test(trimmed);
            const guardedByNotModal = /:not\(\s*\.modal-open\s*\)/i.test(trimmed);
            if (targetsUniversal && !guardedByNotModal) {
              hasUnguardedGlobalCursorNone = true;
            }
          }

          if (
            (lowerSel.includes('modal-open') || lowerSel.includes('.modal.open')) &&
            !lowerSel.includes('cursor-dot') &&
            !lowerSel.includes('cursor-ring') &&
            (cursorVal === 'auto' || cursorVal === 'default')
          ) {
            hasModalCursorRestore = true;
          }

          if (
            /(?:^|[\s,+~>])(input|textarea|select)(?:$|[\s.:,\[>+~])/.test(lowerSel) &&
            (cursorVal === 'text' || cursorVal === 'auto' || cursorVal === 'pointer' || cursorVal === 'default')
          ) {
            hasInputCursorRestore = true;
          }

          if (
            lowerSel.includes('modal-open') &&
            (lowerSel.includes('cursor-dot') || lowerSel.includes('cursor-ring'))
          ) {
            const disp = stripCssImportant(rule.props.get('display')).toLowerCase();
            const opa = stripCssImportant(rule.props.get('opacity')).toLowerCase();
            const vis = stripCssImportant(rule.props.get('visibility')).toLowerCase();
            if (disp === 'none' || opa === '0' || vis === 'hidden') {
              hidesCustomCursorOnModal = true;
            }
          }
        }
      }

      if (hasUnguardedGlobalCursorNone) {
        assert.ok(
          hasModalCursorRestore,
          'Unguarded global * { cursor: none } requires explicit modal cursor: auto/default restoration'
        );
      } else {
        assert.ok(
          hasModalCursorRestore || hidesCustomCursorOnModal,
          'style.css must restore system cursor when modals are open'
        );
      }
      assert.ok(
        hasInputCursorRestore,
        'style.css must restore text/auto cursor on input/textarea/select elements'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F9: Macau Table UI, Chips, Wallet Timing & Browser Crypto (6 tests)
  // ---------------------------------------------------------------------------
  describe('F9: Macau Table UI, Chips, Wallet Timing, Breakeven & Web Crypto', () => {
    it('F9.1: all 52 Macau betting gates (>=49) including double_1..6 and pair_1_2..5_6 are in HTML & app.js', () => {
      const htmlBets = new Set(extractHtmlDataBets(html));
      assert.ok(htmlBets.size >= 49, `Expected >=49 bet gates in HTML, got ${htmlBets.size}`);
      for (const key of MACAU_BET_KEYS) {
        assert.ok(htmlBets.has(key), `Missing [data-bet="${key}"] in index.html`);
      }
      assert.match(appJs, /double_/);
      assert.match(appJs, /pair_/);
    });

    it('F9.2: chip Undo (#btnUndo), right-click contextmenu removal, and Gỡ từng cửa (#btnRemoveMode) exist', () => {
      assert.ok(extractElementAndAncestors(html, 'btnUndo'), '#btnUndo must exist');
      assert.ok(extractElementAndAncestors(html, 'btnRemoveMode'), '#btnRemoveMode must exist');
      assert.match(appJs, /btnUndo/);
      assert.match(appJs, /btnRemoveMode/);
      assert.match(appJs, /contextmenu/);
      assert.match(appJs, /preventDefault\s*\(\)/);
    });

    it('F9.3: 6 chip denominations (10K..5M) have distinct colors and flying chip placement animation', () => {
      for (const denom of ['10000', '50000', '100000', '500000', '1000000', '5000000']) {
        assert.match(html, new RegExp(`data-val=["']${denom}["']`), `Missing chip denom ${denom}`);
      }
      assert.match(css, /chip-10k|denom-10k|data-denom=["']10000["']|10000/i);
      assert.match(css, /chip-5m|denom-5m|data-denom=["']5000000["']|5000000/i);
      assert.match(appJs, /fly|flying|animateChip|createFlyingChip/i);
      assert.match(css, /flying-chip|chip-fly|@keyframes/i);
    });

    it('F9.4: exact breakeven literal "HÒA VỐN • ±0 ₫" is rendered for netProfit === 0', () => {
      assert.ok(
        appJs.includes('HÒA VỐN • ±0 ₫'),
        'app.js must contain exact breakeven text "HÒA VỐN • ±0 ₫"'
      );
      assert.match(appJs, /netProfit\s*===\s*0[\s\S]{0,400}HÒA VỐN • ±0 ₫/);
    });

    it('F9.5: wallet deducts wager pre-shake and updates winnings via count-up only after bowl reveal', () => {
      assert.match(appJs, /pre-shake|deduct|displayedBalance|animateBalance|countUp/i);
      // Verify finishReveal (after bowl opens) performs final balance count-up/update
      const finishIdx = appJs.indexOf('function finishReveal');
      assert.ok(finishIdx !== -1, 'app.js must define function finishReveal');
      const finishSnippet = appJs.slice(finishIdx, finishIdx + 3000);
      assert.match(finishSnippet, /newBalance|balance|animate/i);
    });

    it('F9.6: API_BASE is empty string, Web Crypto HMAC-SHA256 (<252) is used, and escapeHtml blocks XSS', () => {
      assert.match(appJs, /const\s+API_BASE\s*=\s*['"]['"]\s*;/);
      assert.equal(/http:\/\/localhost:3000/.test(appJs), false, 'app.js must not hardcode localhost:3000');

      assert.match(appJs, /crypto\.subtle/);
      assert.match(appJs, /HMAC/);
      assert.match(appJs, /252/);

      const escapeFnCode = extractBalancedJsFunction(appJs, 'escapeHtml');
      assert.ok(escapeFnCode, 'app.js must define escapeHtml');
      const sandbox = { result: null };
      vm.runInNewContext(`${escapeFnCode}\nresult = escapeHtml('<script>alert("xss")</script> & \\'quote\\'');`, sandbox);
      assert.equal(sandbox.result.includes('<script>'), false);
      assert.equal(sandbox.result.includes('>'), false);
      assert.ok(sandbox.result.includes('&lt;script&gt;'));
      assert.ok(sandbox.result.includes('&amp;'));
      assert.ok(sandbox.result.includes('&quot;'));
      assert.ok(
        sandbox.result.includes('&#39;') ||
        sandbox.result.includes('&#039;') ||
        sandbox.result.includes('&#x27;') ||
        sandbox.result.includes('&apos;')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F10: Mobile < 980px, 3D Touch, localStorage & document.hidden Pause (6 tests)
  // ---------------------------------------------------------------------------
  describe('F10: Mobile < 980px, 3D Touch, localStorage & WebGL Pause', () => {
    it('F10.1: @media (max-width: 980px) keeps critical Live controls visible, removes unused #chkSqueeze, and frames 3D stage cleanly', () => {
      assert.equal(extractElementAndAncestors(html, 'chkSqueeze'), null, 'Unused #chkSqueeze must be removed in Live-only 45s mode');

      const mobileRules = cssRules.filter((r) => r.media && /max-width\s*:\s*980px/.test(r.media));
      assert.ok(mobileRules.length > 0, 'style.css must define @media (max-width: 980px) rules');

      for (const criticalId of ['btnModeLive', 'userBalance', 'btnAuthModal', 'btnRoll', 'chipsSelector']) {
        const info = extractElementAndAncestors(html, criticalId);
        assert.ok(info, `#${criticalId} must exist in index.html`);
        const chain = [...info.ancestors, info.element];
        for (const node of chain) {
          let mobileDisplay = null;
          let mobileVisibility = null;
          let mobileOpacity = null;
          for (const r of mobileRules) {
            const hit = r.selectors.some((sel) => selectorMatchesNode(sel, node));
            if (!hit) continue;
            if (r.props.has('display')) mobileDisplay = stripCssImportant(r.props.get('display')).toLowerCase();
            if (r.props.has('visibility')) mobileVisibility = stripCssImportant(r.props.get('visibility')).toLowerCase();
            if (r.props.has('opacity')) mobileOpacity = stripCssImportant(r.props.get('opacity')).toLowerCase();
          }
          assert.notEqual(mobileDisplay, 'none', `#${criticalId} ancestor chain must not hide on <=980px`);
          assert.notEqual(mobileVisibility, 'hidden', `#${criticalId} ancestor chain must not be hidden on <=980px`);
          assert.notEqual(mobileOpacity, '0', `#${criticalId} ancestor chain must not be opacity:0 on <=980px`);
        }
      }

      assert.ok(extractElementAndAncestors(html, 'selectRevealMode'), '#selectRevealMode must exist in index.html');
      assert.match(html, /value="auto"/);
      assert.match(html, /value="manual"/);
      assert.match(threeEngineJs, /computeCameraFraming/);
      assert.match(threeEngineJs, /isAnimatingBowl/);
      assert.match(threeEngineJs, /getClosestQuaternionForFace/);
      assert.match(appJs, /lastRenderedDiceRoundId/);
      assert.match(appJs, /visibilitychange/);
      assert.match(appJs, /pointerdown/);
    });

    it('F10.7: three-engine.js stepDicePhysics executes all 120 frames (0..1.6s) without ReferenceError and fires onComplete', () => {
      const vm = require('node:vm');
      class Vec3 {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
        copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
        clone() { return new Vec3(this.x, this.y, this.z); }
        length() { return Math.hypot(this.x, this.y, this.z); }
        divideScalar(s) { this.x /= s; this.y /= s; this.z /= s; return this; }
        multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
        subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
        addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
        lerpVectors(a, b, t) {
          this.x = a.x + (b.x - a.x) * t;
          this.y = a.y + (b.y - a.y) * t;
          this.z = a.z + (b.z - a.z) * t;
          return this;
        }
      }
      class Quat {
        constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
        copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
        clone() { return new Quat(this.x, this.y, this.z, this.w); }
        lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w; }
        normalize() {
          const l = Math.sqrt(this.lengthSq()) || 1;
          this.x /= l; this.y /= l; this.z /= l; this.w /= l;
          return this;
        }
        invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
        setFromAxisAngle(axis, angle) {
          const s = Math.sin(angle / 2);
          this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(angle / 2);
          return this;
        }
        setFromUnitVectors() { return this; }
        multiply(q) {
          const ax = this.x, ay = this.y, az = this.z, aw = this.w;
          this.x = aw * q.x + ax * q.w + ay * q.z - az * q.y;
          this.y = aw * q.y - ax * q.z + ay * q.w + az * q.x;
          this.z = aw * q.z + ax * q.y - ay * q.x + az * q.w;
          this.w = aw * q.w - ax * q.x - ay * q.y - az * q.z;
          return this;
        }
        premultiply(q) { return q.clone().multiply(this); }
        slerp(qb, t) {
          this.x += (qb.x - this.x) * t;
          this.y += (qb.y - this.y) * t;
          this.z += (qb.z - this.z) * t;
          this.w += (qb.w - this.w) * t;
          return this.normalize();
        }
      }
      const ctx = vm.createContext({
        THREE: { Vector3: Vec3, Quaternion: Quat },
        performance,
        Math,
        gsap: { killTweensOf() {}, to(_t, opts) { if (opts && opts.onComplete) opts.onComplete(); } },
        window: {},
      });
      vm.runInContext(`${threeEngineJs}\nthis.__Sicbo3DEngine = Sicbo3DEngine;`, ctx);
      const Proto = ctx.__Sicbo3DEngine.prototype;
      let completed = false;
      let bounces = 0;
      const fake = Object.create(Proto);
      fake.diceSize = 1.24;
      fake.trayCenter = { x: 0, z: -0.6 };
      fake.floorY = 1.06;
      fake.bowlGroup = { position: new Vec3(0, 0.35, -0.6), rotation: new Vec3(0, 0, 0) };
      fake.diceBodies = [0, 1, 2].map(() => {
        const pos = new Vec3();
        return { mesh: { position: pos, quaternion: new Quat(), userData: {} }, pos, vel: new Vec3(), angVel: new Vec3(), lastBounceMs: 0 };
      });
      fake.closeBowl = (cb) => { if (cb) cb(); };
      fake.shakeAndRoll([3, 5, 6], () => {}, () => { completed = true; }, () => { bounces++; }, false);
      for (let f = 0; f < 120 && fake.physicsState; f++) {
        fake.stepDicePhysics(0.016);
      }
      assert.equal(completed, true, 'stepDicePhysics must finish cleanly and invoke onComplete');
      assert.equal(fake.isRolling, false);
      assert.equal(fake.physicsState, null);
      assert.ok(bounces >= 1, 'Dice physics should trigger at least one bounce sound');
      for (const b of fake.diceBodies) {
        assert.equal(b.pos.y, fake.floorY);
        assert.equal(Number.isFinite(b.pos.x), true);
        assert.equal(Number.isFinite(b.pos.z), true);
      }
    });

    it('F10.2: three-engine.js uses touchmove { passive: false } and calls preventDefault() while dragging bowl', () => {
      assert.match(threeEngineJs, /addEventListener\s*\(\s*['"]touchmove['"][^)]*passive\s*:\s*false/);
      assert.match(threeEngineJs, /preventDefault\s*\(\)/);
    });

    it('F10.3: app.js persists sicbo_sound_enabled, sicbo_squeeze_enabled & sicbo_graphics_quality in localStorage', () => {
      for (const key of ['sicbo_sound_enabled', 'sicbo_squeeze_enabled', 'sicbo_graphics_quality']) {
        assert.ok(appJs.includes(key), `app.js must persist ${key} in localStorage`);
      }
      assert.match(appJs, /localStorage\.getItem/);
      assert.match(appJs, /localStorage\.setItem/);
      assert.match(appJs, /['"]high['"]/);
      assert.match(appJs, /['"]balanced['"]/);
      assert.match(appJs, /['"]eco['"]/);
    });

    it('F10.4: three-engine.js pauses WebGL render loop when document.hidden is true', () => {
      assert.match(threeEngineJs, /document\.hidden/);
      assert.match(threeEngineJs, /visibilitychange/);
    });

    it('F10.5: threeui-fx.js pauses background WebGL2 render loop when document.hidden is true', () => {
      assert.match(threeUiJs, /document\.hidden/);
      assert.match(threeUiJs, /visibilitychange/);
    });

    it('F10.6: mobile CSS adapts layout cleanly (<980px) and runs optional Playwright browser check if installed', async () => {
      const mobileRules = cssRules.filter((r) => r.media && /max-width\s*:\s*980px/.test(r.media));
      assert.ok(mobileRules.length >= 3, 'Mobile stylesheet should have responsive layout rules under 980px');

      if (hasPlaywright()) {
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
          const rollVisible = await page.locator('#btnRoll').isVisible();
          assert.equal(rollVisible, true);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      }
    });
    it('F10.7: Live reveal prevents double-shake when unauthenticated, includes roll watchdog, and serves no-cache headers', async () => {
      assert.match(appJs, /preserveLiveReveal:\s*true/, 'fetchServerState(user===null) must preserve liveRevealedRoundId');
      assert.match(appJs, /armRollWatchdog\s*\(/, 'app.js must arm a watchdog to prevent stuck isRolling state');
      assert.match(threeEngineJs, /forceFinishRoll\s*\(/, 'three-engine.js must expose forceFinishRoll recovery');
      assert.match(html, /three-engine\.js\?v=/, 'index.html must include cache-busting query on three-engine.js');
      assert.match(html, /app\.js\?v=/, 'index.html must include cache-busting query on app.js');

      const res = await fetch(`${server.baseUrl}/three-engine.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') || '', /no-cache/i, 'Static JS must send Cache-Control: no-cache');
    });
  });
});
