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
      assert.match(appJs, /LIVE_BET_MS\s*=\s*40000/);

      assert.match(html, /id=["']btnOpenRules["']/);
      assert.match(html, /id=["']rulesModal["']/);
      assert.match(html, /1\s*:\s*180/);
      assert.match(html, /1\s*:\s*10/);
      assert.match(html, /1\s*:\s*5/);
      assert.match(html, /1\s*:\s*30/);
    });

    it('F8.3: Auth, Admin, Leaderboard, Wallet Ledger, Daily Bonus & Bankruptcy Aid UI elements exist', () => {
      const requiredIds = [
        'btnAuthModal',
        'authModal',
        'btnOpenAdmin',
        'adminModal',
        'btnOpenLeaderboard',
        'leaderboardModal',
        'tabWalletLedger',
        'btnDailyBonus',
        'btnBankruptcyAid',
      ];
      for (const id of requiredIds) {
        assert.ok(
          extractElementAndAncestors(html, id),
          `Required UI element #${id} must exist in index.html`
        );
      }
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
    it('F10.1: @media (max-width: 980px) keeps #chkSqueeze ("Nặn Bát 3D") visible on mobile', () => {
      const squeezeInfo = extractElementAndAncestors(html, 'chkSqueeze');
      assert.ok(squeezeInfo, '#chkSqueeze must exist in index.html');

      const mobileRules = cssRules.filter((r) => r.media && /max-width\s*:\s*980px/.test(r.media));
      assert.ok(mobileRules.length > 0, 'style.css must define @media (max-width: 980px) rules');

      // Check none of chkSqueeze's ancestors are hidden via display:none, visibility:hidden, or opacity:0 in max-width:980px
      const chain = [...squeezeInfo.ancestors, squeezeInfo.element];
      for (const node of chain) {
        let mobileDisplay = null;
        let mobileDisplayImportant = false;
        let mobileVisibility = null;
        let mobileVisibilityImportant = false;
        let mobileOpacity = null;
        let mobileOpacityImportant = false;

        for (const r of mobileRules) {
          const hit = r.selectors.some((sel) => selectorMatchesNode(sel, node));
          if (!hit) continue;
          if (r.props.has('display')) {
            const raw = r.props.get('display');
            const isImp = /!important/i.test(raw);
            if (isImp || !mobileDisplayImportant) {
              mobileDisplay = stripCssImportant(raw).toLowerCase();
              if (isImp) mobileDisplayImportant = true;
            }
          }
          if (r.props.has('visibility')) {
            const raw = r.props.get('visibility');
            const isImp = /!important/i.test(raw);
            if (isImp || !mobileVisibilityImportant) {
              mobileVisibility = stripCssImportant(raw).toLowerCase();
              if (isImp) mobileVisibilityImportant = true;
            }
          }
          if (r.props.has('opacity')) {
            const raw = r.props.get('opacity');
            const isImp = /!important/i.test(raw);
            if (isImp || !mobileOpacityImportant) {
              mobileOpacity = stripCssImportant(raw).toLowerCase();
              if (isImp) mobileOpacityImportant = true;
            }
          }
        }
        assert.notEqual(
          mobileDisplay,
          'none',
          `Ancestor <${node.tag} id="${node.id}" class="${node.classes.join(' ')}"> of #chkSqueeze must NOT have display:none under @media (max-width: 980px)`
        );
        assert.notEqual(
          mobileVisibility,
          'hidden',
          `Ancestor <${node.tag} id="${node.id}" class="${node.classes.join(' ')}"> of #chkSqueeze must NOT have visibility:hidden under @media (max-width: 980px)`
        );
        assert.notEqual(
          mobileOpacity,
          '0',
          `Ancestor <${node.tag} id="${node.id}" class="${node.classes.join(' ')}"> of #chkSqueeze must NOT have opacity:0 under @media (max-width: 980px)`
        );
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
          const squeezeVisible = await page.locator('#chkSqueeze').isVisible();
          assert.equal(squeezeVisible, true);
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
        }
      }
    });
  });
});
