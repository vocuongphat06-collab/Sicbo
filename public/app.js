// app.js - SOVEREIGN Private 3D Sicbo Salon Master Controller (Production Big Update)
document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '';

  const LS_KEYS = Object.freeze({
    sound: 'sicbo_sound_enabled',
    squeeze: 'sicbo_squeeze_enabled',
    quality: 'sicbo_graphics_quality'
  });

  const LIVE_ROUND_MS = 45000;
  const LIVE_BET_MS = 40000;
  const GUEST_MAX_BALANCE = 2000000;
  const MAX_SINGLE_BET = 1000000000;

  function readPref(key, fallback) {
    try {
      const val = localStorage.getItem(key);
      return val === null ? fallback : val;
    } catch (_) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (_) {}
  }

  function randomHex(len = 64) {
    if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(Math.ceil(len / 2));
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
    }
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  function generateIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `ik-${Date.now()}-${randomHex(16)}`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createInitialHistory() {
    const presetDice = [
      [4, 5, 6], [2, 3, 4], [5, 5, 6], [1, 2, 3], [3, 4, 6], [6, 6, 5],
      [2, 2, 4], [1, 3, 5], [2, 3, 3], [4, 4, 5], [5, 6, 4], [3, 3, 3],
      [2, 5, 6], [4, 5, 5], [1, 2, 4], [2, 2, 3], [3, 5, 6], [1, 4, 4],
      [5, 5, 4], [2, 3, 2], [4, 6, 5], [3, 4, 5], [5, 6, 6], [2, 4, 3],
      [1, 3, 4], [2, 2, 5], [4, 4, 6], [5, 5, 3], [6, 4, 5], [2, 3, 4],
      [1, 5, 2], [4, 4, 4], [3, 5, 6], [4, 5, 3], [6, 5, 4], [4, 5, 6]
    ];
    return presetDice.map((d, idx) => {
      const total = d[0] + d[1] + d[2];
      const isTriple = (d[0] === d[1] && d[1] === d[2]);
      const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');
      return { id: 1001 + idx, dice: d, total, outcome, isTriple };
    });
  }

  const state = {
    user: null,
    balance: 0,
    displayedBalance: 0,
    selectedChip: 10000,
    currentBets: {},
    lastBets: {},
    betUndoStack: [],
    removeMode: false,
    mode: 'live',
    cardRoadView: 'bead',
    serverTimeOffsetMs: 0,
    liveRoundId: null,
    livePhase: 'BETTING',
    liveLastSecTick: 40,
    liveIntervalId: null,
    liveRevealedRoundId: null,
    lastRenderedDiceRoundId: null,
    liveLastCommittedHashRoundId: null,
    liveRoundSeedHash: '',
    liveTicket: null,
    isSyncingLiveReveal: false,
    settlingPastRounds: new Set(),
    inFlightOps: new Set(),
    squeezeAutoOpenTimer: null,
    isRolling: false,
    isSubmittingRoll: false,
    isSqueezeActive: false,
    revealMode: 'auto',
    isBalanceTweening: false,
    balanceTween: null,
    pendingResult: null,
    history: createInitialHistory(),
    personalHistory: [],
    walletLedger: [],
    leaderboardTab: 'byBalance',
    leaderboardData: { byBalance: [], byNetProfit: [] },
    localPendingServerSeed: randomHex(64),
    provablyFair: {
      nextServerSeedHash: randomHex(64),
      nextNonce: 1,
      clientSeed: 'sovereign-vip-888',
      lastRevealed: null
    }
  };

  const sound = window.soundFX;
  const engine = new Sicbo3DEngine('threeContainer');

  const el = {
    userBalance: document.getElementById('userBalance'),
    btnAudioToggle: document.getElementById('btnAudioToggle'),
    btnModeLive: document.getElementById('btnModeLive'),
    liveTimerBadge: document.getElementById('liveTimerBadge'),
    liveProgressTrack: document.getElementById('liveProgressTrack'),
    liveProgressFill: document.getElementById('liveProgressFill'),
    hudModeLabel: document.getElementById('hudModeLabel'),

    btnOpenLeaderboard: document.getElementById('btnOpenLeaderboard'),
    btnOpenRules: document.getElementById('btnOpenRules'),
    btnWelcomeBonus: document.getElementById('btnWelcomeBonus'),
    btnAuthModal: document.getElementById('btnAuthModal'),
    navUserBadge: document.getElementById('navUserBadge'),
    btnOpenAdmin: document.getElementById('btnOpenAdmin'),
    selectRevealMode: document.getElementById('selectRevealMode'),
    selectGraphicsQuality: document.getElementById('selectGraphicsQuality'),

    centerLiveBanner: document.getElementById('centerLiveBanner'),
    centerLiveText: document.getElementById('centerLiveText'),
    centerLiveRoundId: document.getElementById('centerLiveRoundId'),
    centerLiveSec: document.getElementById('centerLiveSec'),
    liveTicketBadge: document.getElementById('liveTicketBadge'),
    centerLivePhaseBadge: document.getElementById('centerLivePhaseBadge'),

    fairnessCommitBar: document.getElementById('fairnessCommitBar'),
    nextHashPreview: document.getElementById('nextHashPreview'),
    nextNoncePreview: document.getElementById('nextNoncePreview'),
    btnTelemetryFair: document.getElementById('btnTelemetryFair'),

    resultBanner: document.getElementById('resultBanner'),
    resBadgeOutcome: document.getElementById('resBadgeOutcome'),
    resBadgeTotal: document.getElementById('resBadgeTotal'),
    resDiceStrip: document.getElementById('resDiceStrip'),
    resWinText: document.getElementById('resWinText'),
    roundCounterLabel: document.getElementById('roundCounterLabel'),

    squeezePrompt: document.getElementById('squeezePrompt'),
    squeezePctLabel: document.getElementById('squeezePctLabel'),
    btnQuickOpen: document.getElementById('btnQuickOpen'),

    statusPill: document.getElementById('statusPill'),
    chipsSelector: document.getElementById('chipsSelector'),
    chipAllIn: document.getElementById('chipAllIn'),
    btnUndo: document.getElementById('btnUndo'),
    btnRemoveMode: document.getElementById('btnRemoveMode'),
    btnClear: document.getElementById('btnClear'),
    btnDouble: document.getElementById('btnDouble'),
    btnRebet: document.getElementById('btnRebet'),

    btnRoll: document.getElementById('btnRoll'),
    btnRollLabel: document.getElementById('btnRollLabel'),
    btnQuickTopRoll: document.getElementById('btnQuickTopRoll'),
    btnCardRollTrigger: document.getElementById('btnCardRollTrigger'),
    currentWagerSummary: document.getElementById('currentWagerSummary'),

    cardRoadTitle: document.getElementById('cardRoadTitle'),
    btnSwitchBead: document.getElementById('btnSwitchBead'),
    btnSwitchBigRoad: document.getElementById('btnSwitchBigRoad'),
    roadmapMatrix: document.getElementById('roadmapMatrix'),
    cardBigRoadMatrix: document.getElementById('cardBigRoadMatrix'),
    miniStreakHint: document.getElementById('miniStreakHint'),
    btnCardOpenBigRoad: document.getElementById('btnCardOpenBigRoad'),
    statTaiCount: document.getElementById('statTaiCount'),
    statTaiPct: document.getElementById('statTaiPct'),
    statXiuCount: document.getElementById('statXiuCount'),
    statXiuPct: document.getElementById('statXiuPct'),
    statTripleCount: document.getElementById('statTripleCount'),

    cursorDot: document.getElementById('cursorDot'),
    cursorRing: document.getElementById('cursorRing'),

    fullMatrixModal: document.getElementById('fullMatrixModal'),
    btnOpenDrawer: document.getElementById('btnOpenDrawer'),
    btnExpandMatrix: document.getElementById('btnExpandMatrix'),
    btnCloseDrawer: document.getElementById('btnCloseDrawer'),

    chroniclesModal: document.getElementById('chroniclesModal'),
    btnOpenChronicles: document.getElementById('btnOpenChronicles'),
    btnCloseChronicles: document.getElementById('btnCloseChronicles'),
    bigRoadGrid: document.getElementById('bigRoadGrid'),
    bigRoadPatternBadge: document.getElementById('bigRoadPatternBadge'),
    fullBeadGrid: document.getElementById('fullBeadGrid'),

    kpiTotalRounds: document.getElementById('kpiTotalRounds'),
    kpiWinRounds: document.getElementById('kpiWinRounds'),
    kpiTotalWagered: document.getElementById('kpiTotalWagered'),
    personalLedgerBody: document.getElementById('personalLedgerBody'),
    walletLedgerBody: document.getElementById('walletLedgerBody'),

    inputNextHash: document.getElementById('inputNextHash'),
    btnCopyNextHash: document.getElementById('btnCopyNextHash'),
    inputClientSeed: document.getElementById('inputClientSeed'),
    btnRotateClientSeed: document.getElementById('btnRotateClientSeed'),
    rotatedSeedRevealBox: document.getElementById('rotatedSeedRevealBox'),
    inputNextNonce: document.getElementById('inputNextNonce'),
    verifyServerSeed: document.getElementById('verifyServerSeed'),
    verifyExpectedHash: document.getElementById('verifyExpectedHash'),
    verifyClientSeed: document.getElementById('verifyClientSeed'),
    verifyNonce: document.getElementById('verifyNonce'),
    btnRunVerify: document.getElementById('btnRunVerify'),
    verifyResultBox: document.getElementById('verifyResultBox'),

    authModal: document.getElementById('authModal'),
    btnCloseAuth: document.getElementById('btnCloseAuth'),
    tabBtnProfile: document.getElementById('tabBtnProfile'),
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    btnLoginSubmit: document.getElementById('btnLoginSubmit'),
    regUsername: document.getElementById('regUsername'),
    regDisplayName: document.getElementById('regDisplayName'),
    regPassword: document.getElementById('regPassword'),
    btnRegisterSubmit: document.getElementById('btnRegisterSubmit'),
    recoveryCodeRevealBox: document.getElementById('recoveryCodeRevealBox'),
    recoveryCodeValue: document.getElementById('recoveryCodeValue'),
    btnCopyRecoveryCode: document.getElementById('btnCopyRecoveryCode'),
    recoverUsername: document.getElementById('recoverUsername'),
    recoverCode: document.getElementById('recoverCode'),
    recoverNewPassword: document.getElementById('recoverNewPassword'),
    btnRecoverSubmit: document.getElementById('btnRecoverSubmit'),
    profileSummaryText: document.getElementById('profileSummaryText'),
    btnLogout: document.getElementById('btnLogout'),
    authUpgradePanel: document.getElementById('authUpgradePanel'),
    upgradeUsername: document.getElementById('upgradeUsername'),
    upgradeDisplayName: document.getElementById('upgradeDisplayName'),
    upgradePassword: document.getElementById('upgradePassword'),
    btnUpgradeGuestSubmit: document.getElementById('btnUpgradeGuestSubmit'),
    cpCurrentPassword: document.getElementById('cpCurrentPassword'),
    cpNewPassword: document.getElementById('cpNewPassword'),
    btnChangePasswordSubmit: document.getElementById('btnChangePasswordSubmit'),
    authFormFeedback: document.getElementById('authFormFeedback'),

    adminModal: document.getElementById('adminModal'),
    adminStorageWarning: document.getElementById('adminStorageWarning'),
    btnCloseAdmin: document.getElementById('btnCloseAdmin'),
    adminSearchInput: document.getElementById('adminSearchInput'),
    btnAdminSearch: document.getElementById('btnAdminSearch'),
    adminAdjustUserId: document.getElementById('adminAdjustUserId'),
    adminAdjustAmount: document.getElementById('adminAdjustAmount'),
    adminAdjustReason: document.getElementById('adminAdjustReason'),
    btnAdminAdjustSubmit: document.getElementById('btnAdminAdjustSubmit'),
    adminActionResult: document.getElementById('adminActionResult'),
    adminUsersTableBody: document.getElementById('adminUsersTableBody'),

    leaderboardModal: document.getElementById('leaderboardModal'),
    btnCloseLeaderboard: document.getElementById('btnCloseLeaderboard'),
    btnLbByBalance: document.getElementById('btnLbByBalance'),
    btnLbByProfit: document.getElementById('btnLbByProfit'),
    leaderboardTableBody: document.getElementById('leaderboardTableBody'),

    rulesModal: document.getElementById('rulesModal'),
    btnCloseRules: document.getElementById('btnCloseRules'),

    toastContainer: document.getElementById('toastContainer'),
    roundResultBanner: document.getElementById('roundResultBanner')
  };

  const DICE_SYMBOLS = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

  const CHIP_DENOMS = [
    { val: 5000000, cls: 'chip-5m' },
    { val: 1000000, cls: 'chip-1m' },
    { val: 500000, cls: 'chip-500k' },
    { val: 100000, cls: 'chip-100k' },
    { val: 50000, cls: 'chip-50k' },
    { val: 10000, cls: 'chip-10k' }
  ];

  const BET_LABELS = {
    tai: 'Tài',
    xiu: 'Xỉu',
    even: 'Chẵn',
    odd: 'Lẻ',
    triple_any: 'Bão Bất Kỳ'
  };

  const PAYOUT_RATES = {
    tai: 1,
    xiu: 1,
    even: 1,
    odd: 1,
    triple_any: 30,
    total_4: 60,
    total_5: 30,
    total_6: 18,
    total_7: 12,
    total_8: 8,
    total_9: 6,
    total_10: 6,
    total_11: 6,
    total_12: 6,
    total_13: 8,
    total_14: 12,
    total_15: 18,
    total_16: 30,
    total_17: 60
  };

  for (let i = 1; i <= 6; i++) {
    BET_LABELS[`triple_${i}`] = `Bão ${i}`;
    PAYOUT_RATES[`triple_${i}`] = 180;
    BET_LABELS[`double_${i}`] = `Đôi ${i}`;
    PAYOUT_RATES[`double_${i}`] = 10;
    BET_LABELS[`single_${i}`] = `Đơn ${i}`;
    PAYOUT_RATES[`single_${i}`] = 1;
  }
  for (let a = 1; a <= 5; a++) {
    for (let b = a + 1; b <= 6; b++) {
      BET_LABELS[`pair_${a}_${b}`] = `Cặp ${a}-${b}`;
      PAYOUT_RATES[`pair_${a}_${b}`] = 5;
    }
  }
  for (let t = 4; t <= 17; t++) {
    BET_LABELS[`total_${t}`] = `Tổng ${t}`;
  }

  const ALLOWED_BET_KEYS = new Set(Object.keys(PAYOUT_RATES));

  function formatBetName(key) {
    if (Object.hasOwn(BET_LABELS, key)) return BET_LABELS[key];
    if (/^triple_[1-6]$/.test(key)) return `Bão ${key.slice(7)}`;
    if (/^double_[1-6]$/.test(key)) return `Đôi ${key.slice(7)}`;
    if (/^pair_[1-6]_[1-6]$/.test(key)) {
      const parts = key.split('_');
      return `Cặp ${parts[1]}-${parts[2]}`;
    }
    if (/^total_(4|5|6|7|8|9|10|11|12|13|14|15|16|17)$/.test(key)) return `Tổng ${key.slice(6)}`;
    if (/^single_[1-6]$/.test(key)) return `Đơn ${key.slice(7)}`;
    return String(key || '');
  }

  // ==================== 0. TOAST, STATUS & RESULT BANNER ====================
  let roundBannerTimer = null;
  function showToast(msg, type = 'info', duration = 3500) {
    if (!el.toastContainer) return;
    const item = document.createElement('div');
    item.className = `toast-item toast-${type}`;
    item.textContent = String(msg || '');
    el.toastContainer.appendChild(item);
    if (sound && sound.playToast) sound.playToast(type);
    setTimeout(() => {
      if (item.parentNode) item.parentNode.removeChild(item);
    }, duration);
  }

  function showStatus(msg) {
    if (el.statusPill) el.statusPill.textContent = String(msg || '');
  }

  function showRoundResultBanner(res, outcomeLabel) {
    if (!el.roundResultBanner) return;
    const totalWin = res.totalWin ?? res.totalPayout ?? 0;
    const netProfit = typeof res.netProfit === 'number' ? res.netProfit : (totalWin - (res.totalBet || 0));
    const diceIcons = (res.dice || []).map(d => DICE_SYMBOLS[Number(d)] || '').join(' ');

    el.roundResultBanner.className = 'round-result-banner active';
    let summaryText = '';
    if (res.spectator || (res.totalBet || 0) === 0) {
      el.roundResultBanner.classList.add('is-neutral');
      summaryText = `PHIÊN #${Number(res.roundId)} • ${diceIcons} (${Number(res.total)} • ${outcomeLabel})`;
    } else if (netProfit > 0) {
      el.roundResultBanner.classList.add('is-win');
      summaryText = `${diceIcons} (${Number(res.total)} • ${outcomeLabel}) • THẮNG +${formatVND(netProfit)} ₫`;
    } else if (netProfit === 0) {
      el.roundResultBanner.classList.add('is-breakeven');
      summaryText = `${diceIcons} (${Number(res.total)} • ${outcomeLabel}) • HÒA VỐN • ±0 ₫`;
    } else {
      el.roundResultBanner.classList.add('is-loss');
      summaryText = `${diceIcons} (${Number(res.total)} • ${outcomeLabel}) • -${formatVND(Math.abs(netProfit))} ₫`;
    }

    el.roundResultBanner.textContent = summaryText;
    if (roundBannerTimer) clearTimeout(roundBannerTimer);
    roundBannerTimer = setTimeout(() => {
      el.roundResultBanner.classList.remove('active');
    }, 3800);
  }

  // ==================== 1. CUSTOM DOUBLE-RING CURSOR & MODAL MANAGER ====================
  const isFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let ringX = mouseX;
  let ringY = mouseY;
  let cursorRafId = null;

  function shouldAnimateCursor() {
    return isFinePointer && !document.hidden && !document.body.classList.contains('modal-open');
  }

  function scheduleCursor() {
    if (cursorRafId === null && shouldAnimateCursor()) {
      cursorRafId = requestAnimationFrame(renderCursor);
    }
  }

  function pauseCursorLoop() {
    if (cursorRafId !== null) {
      cancelAnimationFrame(cursorRafId);
      cursorRafId = null;
    }
  }

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (el.cursorDot && shouldAnimateCursor()) {
      el.cursorDot.style.left = `${mouseX}px`;
      el.cursorDot.style.top = `${mouseY}px`;
    }
  });

  function renderCursor() {
    cursorRafId = null;
    if (!shouldAnimateCursor()) return;
    ringX += (mouseX - ringX) * 0.22;
    ringY += (mouseY - ringY) * 0.22;
    if (el.cursorRing) {
      el.cursorRing.style.left = `${ringX}px`;
      el.cursorRing.style.top = `${ringY}px`;
    }
    scheduleCursor();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseCursorLoop();
    } else {
      ringX = mouseX;
      ringY = mouseY;
      scheduleCursor();
    }
  });
  scheduleCursor();

  function bindHoverTargets() {
    document.querySelectorAll('button, .bet-spot, .zen-chip, a, label, .alabaster-card, .fairness-commit-bar').forEach(target => {
      target.addEventListener('mouseenter', () => el.cursorRing && el.cursorRing.classList.add('active-hover'));
      target.addEventListener('mouseleave', () => el.cursorRing && el.cursorRing.classList.remove('active-hover'));
    });
  }
  bindHoverTargets();

  const ALL_MODAL_IDS = ['fullMatrixModal', 'chroniclesModal', 'authModal', 'adminModal', 'leaderboardModal', 'rulesModal'];

  function syncModalOpenState() {
    const anyOpen = ALL_MODAL_IDS.some(id => {
      const m = document.getElementById(id);
      return Boolean(m && m.classList.contains('open'));
    });
    const matrixOpen = Boolean(el.fullMatrixModal && el.fullMatrixModal.classList.contains('open'));
    document.body.classList.toggle('modal-open', anyOpen);
    document.body.classList.toggle('matrix-open', matrixOpen);
    if (anyOpen) {
      pauseCursorLoop();
    } else {
      ringX = mouseX;
      ringY = mouseY;
      scheduleCursor();
    }
  }

  function closeAllModals(exceptId = null) {
    ALL_MODAL_IDS.forEach(id => {
      if (id !== exceptId) {
        const m = document.getElementById(id);
        if (m) m.classList.remove('open');
      }
    });
    syncModalOpenState();
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    closeAllModals(modalEl.id);
    modalEl.classList.add('open');
    syncModalOpenState();
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.remove('open');
    syncModalOpenState();
  }

  // ==================== 2. PREFERENCES (SOUND, SQUEEZE, GRAPHICS QUALITY) ====================
  function syncAudioUI() {
    if (!el.btnAudioToggle || !sound) return;
    el.btnAudioToggle.style.opacity = sound.enabled ? '1' : '0.45';
    const txt = el.btnAudioToggle.querySelector('.audio-text');
    if (txt) txt.textContent = sound.enabled ? 'SOUND' : 'MUTED';
  }
  syncAudioUI();

  if (el.btnAudioToggle) {
    el.btnAudioToggle.addEventListener('click', () => {
      if (sound && sound.toggle) {
        sound.toggle();
      } else if (sound) {
        sound.enabled = !sound.enabled;
        writePref(LS_KEYS.sound, sound.enabled);
      }
      syncAudioUI();
    });
  }

  function applyRevealMode(mode) {
    const valid = mode === 'manual' ? 'manual' : 'auto';
    state.revealMode = valid;
    writePref(LS_KEYS.squeeze, valid === 'manual');
    if (el.selectRevealMode) el.selectRevealMode.value = valid;
    if (engine && engine.setBowlOpaqueForSqueeze) {
      engine.setBowlOpaqueForSqueeze(valid === 'manual' && state.isSqueezeActive);
    }
  }

  const savedRevealMode = readPref(LS_KEYS.squeeze, 'false') === 'true' ? 'manual' : 'auto';
  applyRevealMode(savedRevealMode);

  if (el.selectRevealMode) {
    el.selectRevealMode.addEventListener('change', () => {
      sound.playTick();
      applyRevealMode(el.selectRevealMode.value);
      const isManual = state.revealMode === 'manual';
      showToast(
        isManual
          ? 'Chế độ Tự kéo bát 3D: Hết giờ cược, giữ & kéo trượt bát để nặn xúc xắc!'
          : 'Chế độ Tự động mở bát: Bát sẽ tự động mở sau khi lắc xong.',
        'info',
        2600
      );
    });
  }

  const unlockAudioOnFirstGesture = () => {
    if (sound && sound.enabled && sound.init) {
      sound.init();
    }
  };
  window.addEventListener('pointerdown', unlockAudioOnFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', unlockAudioOnFirstGesture, { once: true, passive: true });

  function applyGraphicsQuality(mode) {
    const valid = (mode === 'high' || mode === 'balanced' || mode === 'eco') ? mode : 'high';
    writePref(LS_KEYS.quality, valid);
    if (el.selectGraphicsQuality) el.selectGraphicsQuality.value = valid;
    document.body.dataset.graphicsQuality = valid;
    if (engine && engine.setGraphicsQuality) engine.setGraphicsQuality(valid);
    if (window.ThreeUIFX && window.ThreeUIFX.setGraphicsQuality) {
      window.ThreeUIFX.setGraphicsQuality(valid);
    }
  }

  const initialQuality = readPref(LS_KEYS.quality, 'high');
  applyGraphicsQuality(initialQuality);

  if (el.selectGraphicsQuality) {
    el.selectGraphicsQuality.addEventListener('change', () => {
      sound.playTick();
      applyGraphicsQuality(el.selectGraphicsQuality.value);
      showToast(`Đồ họa 3D: ${el.selectGraphicsQuality.options[el.selectGraphicsQuality.selectedIndex].text}`, 'info', 2200);
    });
  }

  // ==================== 3. ON-CARD ROADMAP & DRAWER TRIGGERS ====================
  function setCardRoadView(view) {
    state.cardRoadView = view;
    if (el.btnSwitchBead) el.btnSwitchBead.classList.toggle('active', view === 'bead');
    if (el.btnSwitchBigRoad) el.btnSwitchBigRoad.classList.toggle('active', view === 'bigroad');
    if (el.roadmapMatrix) el.roadmapMatrix.classList.toggle('hidden', view !== 'bead');
    if (el.cardBigRoadMatrix) el.cardBigRoadMatrix.classList.toggle('hidden', view !== 'bigroad');
    if (el.cardRoadTitle) {
      el.cardRoadTitle.textContent = view === 'bigroad' ? 'Bảng Cầu Dây' : 'Biểu Đồ Cầu Hạt';
    }
  }

  if (el.btnSwitchBead) {
    el.btnSwitchBead.addEventListener('click', (e) => {
      e.stopPropagation();
      sound.playTick();
      setCardRoadView('bead');
    });
  }
  if (el.btnSwitchBigRoad) {
    el.btnSwitchBigRoad.addEventListener('click', (e) => {
      e.stopPropagation();
      sound.playTick();
      setCardRoadView('bigroad');
    });
  }

  function toggleMatrixDrawer(open) {
    sound.playTick();
    if (open) openModal(el.fullMatrixModal);
    else closeModal(el.fullMatrixModal);
  }

  function openChroniclesDrawer(tabId = 'tabBigRoad') {
    sound.playTick();
    openModal(el.chroniclesModal);
    switchChroniclesTab(tabId);
  }

  function closeChroniclesDrawer() {
    sound.playTick();
    closeModal(el.chroniclesModal);
  }

  function switchChroniclesTab(tabId) {
    if (el.chroniclesModal) {
      el.chroniclesModal.querySelectorAll('.chron-tab').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
      });
      el.chroniclesModal.querySelectorAll('.chron-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === tabId);
      });
    }
  }

  if (el.btnOpenDrawer) el.btnOpenDrawer.addEventListener('click', () => toggleMatrixDrawer(true));
  if (el.btnExpandMatrix) el.btnExpandMatrix.addEventListener('click', () => toggleMatrixDrawer(true));
  if (el.btnCloseDrawer) el.btnCloseDrawer.addEventListener('click', () => toggleMatrixDrawer(false));
  if (el.fullMatrixModal) {
    el.fullMatrixModal.addEventListener('click', (e) => {
      if (e.target === el.fullMatrixModal) toggleMatrixDrawer(false);
    });
  }

  if (el.btnOpenChronicles) el.btnOpenChronicles.addEventListener('click', () => openChroniclesDrawer('tabBigRoad'));
  if (el.btnCardOpenBigRoad) el.btnCardOpenBigRoad.addEventListener('click', () => openChroniclesDrawer('tabBigRoad'));
  if (el.fairnessCommitBar) el.fairnessCommitBar.addEventListener('click', () => openChroniclesDrawer('tabFairness'));
  if (el.btnTelemetryFair) el.btnTelemetryFair.addEventListener('click', () => openChroniclesDrawer('tabFairness'));
  if (el.btnCloseChronicles) el.btnCloseChronicles.addEventListener('click', closeChroniclesDrawer);
  if (el.chroniclesModal) {
    el.chroniclesModal.addEventListener('click', (e) => {
      if (e.target === el.chroniclesModal) closeChroniclesDrawer();
    });
    el.chroniclesModal.querySelectorAll('.chron-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        sound.playTick();
        switchChroniclesTab(tabBtn.getAttribute('data-tab'));
      });
    });
  }

  if (el.btnOpenRules) {
    el.btnOpenRules.addEventListener('click', () => {
      sound.playTick();
      openModal(el.rulesModal);
    });
  }
  if (el.btnCloseRules) {
    el.btnCloseRules.addEventListener('click', () => {
      sound.playTick();
      closeModal(el.rulesModal);
    });
  }
  if (el.rulesModal) {
    el.rulesModal.addEventListener('click', (e) => {
      if (e.target === el.rulesModal) closeModal(el.rulesModal);
    });
  }

  // ==================== 4. API FETCH & AUTH LIFECYCLE ====================
  async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...options,
      headers
    });

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      json = null;
    }

    if (res.status === 401 && state.user && !options.skipAuthReset) {
      state.user = null;
      state.balance = 0;
      state.displayedBalance = 0;
      state.liveTicket = null;
      state.liveRevealedRoundId = null;
      state.personalHistory = [];
      state.walletLedger = [];
      renderPersonalLedger();
      renderWalletLedger();
      renderAllBetSpots();
      if (el.adminModal && el.adminModal.classList.contains('open')) {
        closeModal(el.adminModal);
      }
      updateAuthUI();
      updateUI();
      showToast('Phiên đăng nhập đã hết hạn hoặc bị thu hồi.', 'error');
    }

    return { res, json };
  }

  async function withInFlightGuard(opKey, btnEl, fn) {
    if (state.inFlightOps.has(opKey)) return undefined;
    state.inFlightOps.add(opKey);
    const wasDisabled = btnEl ? btnEl.disabled : false;
    if (btnEl) btnEl.disabled = true;
    try {
      return await fn();
    } finally {
      state.inFlightOps.delete(opKey);
      if (btnEl) {
        if (opKey === 'welcomeBonus') {
          btnEl.disabled = Boolean(!state.user || state.user.welcomeBonusClaimed);
        } else {
          btnEl.disabled = wasDisabled;
        }
      }
    }
  }

  function resetClientSessionState({ clearBets = true } = {}) {
    state.liveTicket = null;
    state.liveRevealedRoundId = null;
    state.pendingResult = null;
    state.personalHistory = [];
    state.walletLedger = [];
    state.provablyFair.lastRevealed = null;
    if (clearBets) {
      state.currentBets = {};
      state.lastBets = {};
      state.betUndoStack = [];
      renderAllBetSpots();
    }
    renderPersonalLedger();
    renderWalletLedger();
    if (el.rotatedSeedRevealBox) {
      el.rotatedSeedRevealBox.classList.add('hidden');
      el.rotatedSeedRevealBox.innerHTML = '';
    }
    if (el.verifyResultBox) {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Hoàn tất 1 phiên mở bát hoặc nhập Seed bất kỳ để kiểm chứng toán học.';
    }
    if (el.adminActionResult) {
      el.adminActionResult.classList.add('hidden');
      el.adminActionResult.textContent = '';
    }
  }

  function setAuthFeedback(msg, type = 'info') {
    if (!el.authFormFeedback) return;
    if (!msg) {
      el.authFormFeedback.className = 'auth-feedback hidden';
      el.authFormFeedback.textContent = '';
      return;
    }
    el.authFormFeedback.className = `auth-feedback ${type === 'error' ? 'is-error' : (type === 'success' ? 'is-success' : '')}`;
    el.authFormFeedback.textContent = String(msg);
  }

  function switchAuthPane(paneId) {
    if (!el.authModal) return;
    el.authModal.querySelectorAll('.auth-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-auth-pane') === paneId);
    });
    el.authModal.querySelectorAll('.auth-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === paneId);
    });
    setAuthFeedback('');
  }

  function updateAuthUI() {
    const u = state.user;
    if (el.navUserBadge) {
      el.navUserBadge.textContent = u
        ? (u.isGuest ? `Khách • ${u.displayName || u.username}` : (u.displayName || u.username))
        : 'Đăng nhập';
    }
    if (el.btnOpenAdmin) {
      el.btnOpenAdmin.classList.toggle('hidden', !(u && u.role === 'admin'));
    }
    if (el.btnWelcomeBonus) {
      const canClaimWelcome = Boolean(u && !u.welcomeBonusClaimed);
      el.btnWelcomeBonus.classList.toggle('hidden', !canClaimWelcome);
      el.btnWelcomeBonus.disabled = !canClaimWelcome;
    }
    if (el.tabBtnProfile) {
      el.tabBtnProfile.classList.toggle('hidden', !u);
    }
    if (el.authUpgradePanel) {
      el.authUpgradePanel.classList.toggle('hidden', !(u && u.isGuest));
    }
    if (el.profileSummaryText) {
      if (u) {
        const tag = u.isGuest ? 'Tài khoản Khách' : (u.role === 'admin' ? 'Quản trị viên (Admin)' : 'Hội viên VIP');
        el.profileSummaryText.textContent = `${u.displayName || u.username} (@${u.username}) • ${tag} • Số dư: ${formatVND(state.balance)} ₫`;
      } else {
        el.profileSummaryText.textContent = 'Chưa đăng nhập.';
      }
    }
  }

  function openAuthModal(paneId = null) {
    sound.playTick();
    if (el.recoveryCodeRevealBox) el.recoveryCodeRevealBox.classList.add('hidden');
    updateAuthUI();
    openModal(el.authModal);
    const targetPane = paneId || (state.user ? 'authPaneProfile' : 'authPaneLogin');
    switchAuthPane(targetPane);
  }

  if (el.btnAuthModal) el.btnAuthModal.addEventListener('click', () => openAuthModal());
  if (el.btnCloseAuth) el.btnCloseAuth.addEventListener('click', () => closeModal(el.authModal));
  if (el.authModal) {
    el.authModal.addEventListener('click', (e) => {
      if (e.target === el.authModal) closeModal(el.authModal);
    });
    el.authModal.querySelectorAll('.auth-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        sound.playTick();
        switchAuthPane(btn.getAttribute('data-auth-pane'));
      });
    });
  }

  if (el.btnCopyRecoveryCode) {
    el.btnCopyRecoveryCode.addEventListener('click', async () => {
      const code = el.recoveryCodeValue ? el.recoveryCodeValue.textContent : '';
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        el.btnCopyRecoveryCode.textContent = 'Đã Copy ✓';
        setTimeout(() => { el.btnCopyRecoveryCode.textContent = 'Copy Mã'; }, 1500);
      } catch (_) {}
    });
  }

  function requireAuthenticatedSession(actionHint = 'Vui lòng đăng nhập hoặc đăng ký tài khoản để đặt cược!') {
    if (state.user) return true;
    showToast(actionHint, 'info', 2800);
    openAuthModal('authPaneLogin');
    return false;
  }

  if (el.btnLoginSubmit) {
    el.btnLoginSubmit.addEventListener('click', () => withInFlightGuard('authLogin', el.btnLoginSubmit, async () => {
      const username = (el.loginUsername?.value || '').trim();
      const password = el.loginPassword?.value || '';
      if (!username || !password) {
        setAuthFeedback('Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.', 'error');
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
          skipAuthReset: true
        });
        if (!res.ok || !json || !json.user) {
          setAuthFeedback((json && json.error) || 'Đăng nhập thất bại.', 'error');
          return;
        }
        resetClientSessionState({ clearBets: true });
        state.user = json.user;
        state.balance = json.user.balance;
        state.displayedBalance = json.user.balance;
        if (el.loginPassword) el.loginPassword.value = '';
        updateAuthUI();
        updateUI();
        closeModal(el.authModal);
        showToast(`Chào mừng trở lại, ${json.user.displayName || json.user.username}!`, 'success');
        if (sound && sound.playBonus) sound.playBonus();
        await fetchServerState();
      } catch (err) {
        setAuthFeedback('Không kết nối được máy chủ đăng nhập.', 'error');
      }
    }));
  }

  if (el.btnRegisterSubmit) {
    el.btnRegisterSubmit.addEventListener('click', () => withInFlightGuard('authRegister', el.btnRegisterSubmit, async () => {
      const username = (el.regUsername?.value || '').trim();
      const displayName = (el.regDisplayName?.value || '').trim();
      const password = el.regPassword?.value || '';
      if (!username || !password) {
        setAuthFeedback('Vui lòng nhập tên đăng nhập và mật khẩu.', 'error');
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, password, displayName: displayName || undefined }),
          skipAuthReset: true
        });
        if (!res.ok || !json || !json.user) {
          setAuthFeedback((json && json.error) || 'Đăng ký không thành công.', 'error');
          return;
        }
        resetClientSessionState({ clearBets: true });
        state.user = json.user;
        state.balance = json.user.balance;
        state.displayedBalance = json.user.balance;
        if (el.regPassword) el.regPassword.value = '';
        updateAuthUI();
        updateUI();
        if (json.recoveryCode && el.recoveryCodeRevealBox && el.recoveryCodeValue) {
          el.recoveryCodeValue.textContent = json.recoveryCode;
          el.recoveryCodeRevealBox.classList.remove('hidden');
        }
        setAuthFeedback('Đăng ký thành công! Hãy sao chép Mã Khôi Phục và nhấn "🎁 Nhận 2M Tân Thủ" ở thanh trên.', 'success');
        showToast('Tạo tài khoản thành công (0 ₫)! Nhấn "🎁 Nhận 2M Tân Thủ" để nhận ưu đãi 1 lần!', 'success', 3800);
        if (sound && sound.playBonus) sound.playBonus();
        await fetchServerState();
      } catch (_) {
        setAuthFeedback('Không kết nối được máy chủ đăng ký.', 'error');
      }
    }));
  }

  if (el.btnUpgradeGuestSubmit) {
    el.btnUpgradeGuestSubmit.addEventListener('click', () => withInFlightGuard('authUpgrade', el.btnUpgradeGuestSubmit, async () => {
      const username = (el.upgradeUsername?.value || '').trim();
      const displayName = (el.upgradeDisplayName?.value || '').trim();
      const password = el.upgradePassword?.value || '';
      if (!username || !password) {
        setAuthFeedback('Nhập tên đăng nhập và mật khẩu mới để nâng cấp tài khoản.', 'error');
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/auth/upgrade', {
          method: 'POST',
          body: JSON.stringify({ username, password, displayName: displayName || undefined })
        });
        if (!res.ok || !json || !json.user) {
          setAuthFeedback((json && json.error) || 'Nâng cấp tài khoản thất bại.', 'error');
          return;
        }
        state.user = json.user;
        state.balance = json.user.balance;
        state.displayedBalance = json.user.balance;
        if (el.upgradePassword) el.upgradePassword.value = '';
        updateAuthUI();
        updateUI();
        if (json.recoveryCode && el.recoveryCodeRevealBox && el.recoveryCodeValue) {
          el.recoveryCodeValue.textContent = json.recoveryCode;
          el.recoveryCodeRevealBox.classList.remove('hidden');
        }
        setAuthFeedback('Nâng cấp thành công! Số dư và lịch sử cược đã được bảo toàn.', 'success');
        showToast('Nâng cấp tài khoản thành công!', 'success');
        if (sound && sound.playBonus) sound.playBonus();
        await fetchServerState();
      } catch (_) {
        setAuthFeedback('Lỗi kết nối khi nâng cấp tài khoản.', 'error');
      }
    }));
  }

  if (el.btnChangePasswordSubmit) {
    el.btnChangePasswordSubmit.addEventListener('click', () => withInFlightGuard('authChangePassword', el.btnChangePasswordSubmit, async () => {
      const currentPassword = el.cpCurrentPassword?.value || '';
      const newPassword = el.cpNewPassword?.value || '';
      if (!currentPassword || !newPassword) {
        setAuthFeedback('Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.', 'error');
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (!res.ok) {
          setAuthFeedback((json && json.error) || 'Đổi mật khẩu thất bại.', 'error');
          return;
        }
        if (el.cpCurrentPassword) el.cpCurrentPassword.value = '';
        if (el.cpNewPassword) el.cpNewPassword.value = '';
        setAuthFeedback('Đổi mật khẩu thành công. Toàn bộ phiên đăng nhập cũ đã bị thu hồi.', 'success');
        showToast('Đã đổi mật khẩu & thu hồi phiên cũ.', 'success');
      } catch (_) {
        setAuthFeedback('Lỗi kết nối khi đổi mật khẩu.', 'error');
      }
    }));
  }

  if (el.btnRecoverSubmit) {
    el.btnRecoverSubmit.addEventListener('click', () => withInFlightGuard('authRecover', el.btnRecoverSubmit, async () => {
      const username = (el.recoverUsername?.value || '').trim();
      const recoveryCode = (el.recoverCode?.value || '').trim();
      const newPassword = el.recoverNewPassword?.value || '';
      if (!username || !recoveryCode || !newPassword) {
        setAuthFeedback('Nhập đầy đủ Username, Recovery Code và mật khẩu mới.', 'error');
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/auth/recover', {
          method: 'POST',
          body: JSON.stringify({ username, recoveryCode, newPassword }),
          skipAuthReset: true
        });
        if (!res.ok) {
          setAuthFeedback((json && json.error) || 'Khôi phục mật khẩu thất bại.', 'error');
          return;
        }
        if (el.recoverNewPassword) el.recoverNewPassword.value = '';
        if (json && json.recoveryCode && el.recoveryCodeRevealBox && el.recoveryCodeValue) {
          el.recoveryCodeValue.textContent = json.recoveryCode;
          el.recoveryCodeRevealBox.classList.remove('hidden');
        }
        setAuthFeedback('Khôi phục mật khẩu thành công! Bạn có thể đăng nhập bằng mật khẩu mới.', 'success');
        showToast('Khôi phục mật khẩu thành công.', 'success');
      } catch (_) {
        setAuthFeedback('Lỗi kết nối khi khôi phục mật khẩu.', 'error');
      }
    }));
  }

  if (el.btnLogout) {
    el.btnLogout.addEventListener('click', async () => {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST', skipAuthReset: true });
      } catch (_) {}
      state.user = null;
      resetClientSessionState({ clearBets: true });
      state.balance = 0;
      state.displayedBalance = 0;
      updateAuthUI();
      updateUI();
      closeModal(el.authModal);
      showToast('Đã đăng xuất khỏi Salon.', 'info');
    });
  }

  // ==================== 5. WALLET OPS, LEADERBOARD & ADMIN OPS ====================
  if (el.btnWelcomeBonus) {
    el.btnWelcomeBonus.addEventListener('click', () => withInFlightGuard('welcomeBonus', el.btnWelcomeBonus, async () => {
      sound.playTick();
      if (!requireAuthenticatedSession('Đăng nhập hoặc đăng ký tài khoản để nhận ưu đãi Tân Thủ +2,000,000 ₫!')) {
        return;
      }
      if (state.user && state.user.welcomeBonusClaimed) {
        updateAuthUI();
        showToast('Tài khoản của bạn đã nhận ưu đãi Tân Thủ +2,000,000 ₫ rồi.', 'info');
        return;
      }
      try {
        const ikey = generateIdempotencyKey();
        const { res, json } = await apiFetch('/api/wallet/welcome-bonus', {
          method: 'POST',
          idempotencyKey: ikey
        });
        if (!res.ok || !json) {
          showToast((json && json.error) || 'Không thể nhận ưu đãi Tân Thủ.', 'error');
          if (res.status === 409 && state.user) {
            state.user.welcomeBonusClaimed = true;
            updateAuthUI();
          }
          return;
        }
        if (json.user) state.user = json.user;
        else if (state.user) state.user.welcomeBonusClaimed = true;
        state.balance = json.balance;
        state.displayedBalance = json.balance;
        updateAuthUI();
        updateUI();
        if (sound && sound.playBonus) sound.playBonus();
        showToast(`Đã nhận Ưu đãi Tân Thủ: +${formatVND(json.bonusAmount || 2000000)} ₫ (duy nhất 1 lần)!`, 'success');
        await fetchServerState();
      } catch (_) {
        showToast('Không thể kết nối máy chủ khi nhận ưu đãi.', 'error');
      }
    }));
  }

  function renderLeaderboardRows() {
    if (!el.leaderboardTableBody) return;
    const rows = state.leaderboardTab === 'byNetProfit'
      ? (state.leaderboardData.byNetProfit || [])
      : (state.leaderboardData.byBalance || []);
    el.leaderboardTableBody.innerHTML = '';
    if (rows.length === 0) {
      el.leaderboardTableBody.innerHTML = '<tr><td colspan="5" class="empty-ledger-cell">Chưa có dữ liệu xếp hạng.</td></tr>';
      return;
    }
    rows.forEach((u, idx) => {
      const tr = document.createElement('tr');
      const profit = Number(u.netProfit || 0);
      const profitClass = profit > 0 ? 'profit-pos' : (profit === 0 ? 'profit-even' : 'profit-neg');
      const profitText = profit > 0 ? `+${formatVND(profit)} ₫` : (profit === 0 ? '±0 ₫' : `-${formatVND(Math.abs(profit))} ₫`);
      tr.innerHTML = `
        <td>#${idx + 1}</td>
        <td><strong>${escapeHtml(u.displayName || u.username)}</strong> <span style="opacity:0.6">@${escapeHtml(u.username)}</span></td>
        <td>${formatVND(u.balance)} ₫</td>
        <td class="${profitClass}">${escapeHtml(profitText)}</td>
        <td>${Number(u.totalRounds || 0)}</td>
      `;
      el.leaderboardTableBody.appendChild(tr);
    });
  }

  async function loadLeaderboard() {
    openModal(el.leaderboardModal);
    try {
      const { res, json } = await apiFetch('/api/leaderboard');
      if (res.ok && json) {
        state.leaderboardData = {
          byBalance: Array.isArray(json.byBalance) ? json.byBalance : [],
          byNetProfit: Array.isArray(json.byNetProfit) ? json.byNetProfit : []
        };
        renderLeaderboardRows();
      }
    } catch (_) {
      showToast('Không tải được bảng xếp hạng.', 'error');
    }
  }

  if (el.btnOpenLeaderboard) el.btnOpenLeaderboard.addEventListener('click', () => { sound.playTick(); loadLeaderboard(); });
  if (el.btnCloseLeaderboard) el.btnCloseLeaderboard.addEventListener('click', () => { sound.playTick(); closeModal(el.leaderboardModal); });
  if (el.leaderboardModal) {
    el.leaderboardModal.addEventListener('click', (e) => {
      if (e.target === el.leaderboardModal) closeModal(el.leaderboardModal);
    });
  }
  if (el.btnLbByBalance) {
    el.btnLbByBalance.addEventListener('click', () => {
      state.leaderboardTab = 'byBalance';
      el.btnLbByBalance.classList.add('active');
      if (el.btnLbByProfit) el.btnLbByProfit.classList.remove('active');
      renderLeaderboardRows();
    });
  }
  if (el.btnLbByProfit) {
    el.btnLbByProfit.addEventListener('click', () => {
      state.leaderboardTab = 'byNetProfit';
      el.btnLbByProfit.classList.add('active');
      if (el.btnLbByBalance) el.btnLbByBalance.classList.remove('active');
      renderLeaderboardRows();
    });
  }

  // Admin Ops
  async function loadAdminUsers(query = '') {
    if (!el.adminUsersTableBody) return;
    try {
      const { res, json } = await apiFetch(`/api/admin/users?q=${encodeURIComponent(query)}`);
      if (!res.ok || !json) {
        showToast((json && json.error) || 'Không có quyền Admin.', 'error');
        return;
      }
      if (el.adminStorageWarning) {
        el.adminStorageWarning.classList.toggle('hidden', json.storageMode !== 'ephemeral_tmp');
      }
      const users = Array.isArray(json.users) ? json.users : [];
      el.adminUsersTableBody.innerHTML = '';
      if (users.length === 0) {
        el.adminUsersTableBody.innerHTML = '<tr><td colspan="7" class="empty-ledger-cell">Không tìm thấy hội viên nào.</td></tr>';
        return;
      }
      users.forEach(u => {
        const tr = document.createElement('tr');
        const statusText = u.locked ? 'Đã Khóa' : 'Hoạt Động';
        tr.innerHTML = `
          <td><code>${escapeHtml(u.id)}</code></td>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.displayName || '')}</td>
          <td>${escapeHtml(u.role)}</td>
          <td>${formatVND(u.balance)} ₫</td>
          <td>${escapeHtml(statusText)}</td>
          <td style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-fair-sm btn-adm-pick" type="button">Chọn</button>
            <button class="btn-fair-sm btn-adm-lock" type="button">${u.locked ? 'Mở khóa' : 'Khóa'}</button>
            <button class="btn-fair-sm btn-adm-reset" type="button">Reset MK</button>
          </td>
        `;
        tr.querySelector('.btn-adm-pick').addEventListener('click', () => {
          if (el.adminAdjustUserId) el.adminAdjustUserId.value = u.id;
        });
        const lockBtn = tr.querySelector('.btn-adm-lock');
        lockBtn.addEventListener('click', () => withInFlightGuard(`adminLock:${u.id}`, lockBtn, async () => {
          try {
            const { res: r2, json: j2 } = await apiFetch(`/api/admin/users/${encodeURIComponent(u.id)}/toggle-lock`, {
              method: 'POST',
              body: JSON.stringify({ locked: !u.locked })
            });
            if (r2.ok) {
              showToast(`Đã ${!u.locked ? 'khóa' : 'mở khóa'} tài khoản @${u.username}`, 'success');
              await loadAdminUsers(el.adminSearchInput?.value || '');
            } else {
              showToast((j2 && j2.error) || 'Thao tác thất bại.', 'error');
            }
          } catch (_) {
            showToast('Thao tác thất bại.', 'error');
          }
        }));
        const resetBtn = tr.querySelector('.btn-adm-reset');
        resetBtn.addEventListener('click', () => withInFlightGuard(`adminReset:${u.id}`, resetBtn, async () => {
          try {
            const { res: r2, json: j2 } = await apiFetch(`/api/admin/users/${encodeURIComponent(u.id)}/reset-password`, {
              method: 'POST',
              body: JSON.stringify({})
            });
            if (r2.ok && j2) {
              if (el.adminActionResult) {
                el.adminActionResult.classList.remove('hidden');
                el.adminActionResult.textContent = `Mật khẩu tạm thời mới của @${u.username}: ${j2.tempPassword || '(đã đặt lại)'}`;
              }
              showToast(`Đã cấp lại mật khẩu cho @${u.username}`, 'success');
            } else {
              showToast((j2 && j2.error) || 'Reset mật khẩu thất bại.', 'error');
            }
          } catch (_) {
            showToast('Reset mật khẩu thất bại.', 'error');
          }
        }));
        el.adminUsersTableBody.appendChild(tr);
      });
    } catch (_) {
      showToast('Không tải được danh sách Admin.', 'error');
    }
  }

  if (el.btnOpenAdmin) {
    el.btnOpenAdmin.addEventListener('click', () => {
      sound.playTick();
      openModal(el.adminModal);
      loadAdminUsers(el.adminSearchInput?.value || '');
    });
  }
  if (el.btnCloseAdmin) el.btnCloseAdmin.addEventListener('click', () => closeModal(el.adminModal));
  if (el.adminModal) {
    el.adminModal.addEventListener('click', (e) => {
      if (e.target === el.adminModal) closeModal(el.adminModal);
    });
  }
  if (el.btnAdminSearch) {
    el.btnAdminSearch.addEventListener('click', () => withInFlightGuard('adminSearch', el.btnAdminSearch, async () => {
      await loadAdminUsers(el.adminSearchInput?.value || '');
    }));
  }
  if (el.btnAdminAdjustSubmit) {
    el.btnAdminAdjustSubmit.addEventListener('click', () => {
      const uid = (el.adminAdjustUserId?.value || '').trim();
      const rawAmountStr = (el.adminAdjustAmount?.value || '').trim();
      const parsedAmount = rawAmountStr === '' ? NaN : Number(rawAmountStr);
      const reason = (el.adminAdjustReason?.value || '').trim();
      if (!uid || !Number.isSafeInteger(parsedAmount) || parsedAmount === 0 || !reason) {
        showToast('Nhập User ID, số tiền nguyên hợp lệ khác 0 và lý do điều chỉnh.', 'error');
        return;
      }
      return withInFlightGuard(`adminAdjust:${uid}`, el.btnAdminAdjustSubmit, async () => {
        try {
          const amount = parsedAmount;
          const { res, json } = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/adjust-balance`, {
            method: 'POST',
            body: JSON.stringify({ amount, reason })
          });
          if (!res.ok) {
            showToast((json && json.error) || 'Điều chỉnh số dư thất bại.', 'error');
            return;
          }
          showToast('Điều chỉnh số dư thành công!', 'success');
          if (el.adminAdjustAmount) el.adminAdjustAmount.value = '';
          if (el.adminAdjustReason) el.adminAdjustReason.value = '';
          await Promise.all([
            loadAdminUsers(el.adminSearchInput?.value || ''),
            fetchServerState()
          ]);
        } catch (_) {
          showToast('Lỗi kết nối khi điều chỉnh số dư.', 'error');
        }
      });
    });
  }

  // ==================== 6. DETERMINISTIC LIVE ROOM (45S SERVER CLOCK) ====================
  function getClientLiveClock() {
    const nowMs = Math.floor(Date.now() + state.serverTimeOffsetMs);
    const liveRoundId = Math.floor(nowMs / LIVE_ROUND_MS);
    const elapsedMs = nowMs % LIVE_ROUND_MS;
    const phase = elapsedMs < LIVE_BET_MS ? 'BETTING' : 'REVEAL';
    const betRemainingMs = phase === 'BETTING' ? (LIVE_BET_MS - elapsedMs) : 0;
    const roundRemainingMs = LIVE_ROUND_MS - elapsedMs;
    return { nowMs, liveRoundId, elapsedMs, phase, betRemainingMs, roundRemainingMs };
  }

  function initLiveRoomUI() {
    state.mode = 'live';
    if (el.btnModeLive) el.btnModeLive.classList.add('active');
    if (el.liveProgressTrack) el.liveProgressTrack.classList.add('active');
    if (el.centerLiveBanner) el.centerLiveBanner.classList.add('active');
    if (el.hudModeLabel) el.hudModeLabel.textContent = 'LIVE 45S • VIP 08';
    updateLiveTimerUI();
    startLiveLoop();
    showStatus('⚡ Phòng Live 45s đồng bộ (40s nhận cược • 5s khóa sổ mở bát).');
  }

  if (el.btnModeLive) {
    el.btnModeLive.addEventListener('click', () => {
      sound.playTick();
      syncLiveStateFromServer(false);
      showToast('Phòng Live 45s đang đồng bộ trực tiếp theo đồng hồ máy chủ.', 'info', 2000);
    });
  }

  function restoreLiveTicketFromServer(ticket, unsettledTickets, activeRoundId) {
    let candidate = (ticket && !ticket.settled) ? ticket : null;
    if (!candidate && Array.isArray(unsettledTickets) && typeof activeRoundId === 'number') {
      candidate = unsettledTickets.find(t => t && !t.settled && t.liveRoundId === activeRoundId) || null;
    }
    if (candidate && !candidate.settled) {
      state.liveTicket = {
        liveRoundId: candidate.liveRoundId,
        totalBet: Number(candidate.totalBet) || 0,
        bets: candidate.bets ? { ...candidate.bets } : {},
        settled: false
      };
    } else if (ticket && ticket.settled && state.liveTicket && state.liveTicket.liveRoundId === ticket.liveRoundId) {
      state.liveTicket.settled = true;
    } else if (Array.isArray(unsettledTickets) && state.liveTicket) {
      const stillUnsettled = unsettledTickets.some(
        t => t && !t.settled && t.liveRoundId === state.liveTicket.liveRoundId
      );
      if (!stillUnsettled) {
        state.liveTicket = null;
      }
    }
  }

  async function settleUnsettledPastLiveTickets(unsettledTickets, currentRoundId) {
    if (!state.user || typeof currentRoundId !== 'number') return false;
    const roundIds = new Set();
    if (Array.isArray(unsettledTickets)) {
      for (const t of unsettledTickets) {
        if (t && !t.settled && Number.isSafeInteger(t.liveRoundId) && t.liveRoundId < currentRoundId) {
          roundIds.add(t.liveRoundId);
        }
      }
    }
    if (
      state.liveTicket &&
      !state.liveTicket.settled &&
      Number.isSafeInteger(state.liveTicket.liveRoundId) &&
      state.liveTicket.liveRoundId < currentRoundId
    ) {
      roundIds.add(state.liveTicket.liveRoundId);
    }
    if (roundIds.size === 0) return false;

    const orderedRounds = Array.from(roundIds).sort((a, b) => a - b);
    let settledCount = 0;
    let lastSettled = null;

    for (const rid of orderedRounds) {
      if (!state.user) break;
      if (state.settlingPastRounds.has(rid)) continue;
      state.settlingPastRounds.add(rid);
      try {
        const { res, json } = await apiFetch('/api/live/settle', {
          method: 'POST',
          body: JSON.stringify({ liveRoundId: rid })
        });
        if (res.ok && json) {
          settledCount++;
          lastSettled = json;
          if (typeof json.newBalance === 'number') {
            state.balance = json.newBalance;
            if (!state.isBalanceTweening && !state.isRolling && !state.isSqueezeActive) {
              state.displayedBalance = json.newBalance;
            }
          }
          if (state.liveTicket && state.liveTicket.liveRoundId === rid) {
            state.liveTicket = null;
          }
        } else if (res.status === 404 || res.status === 401) {
          if (state.liveTicket && state.liveTicket.liveRoundId === rid) {
            state.liveTicket = null;
          }
        }
      } catch (_) {
        // leave for retry on next sync
      } finally {
        state.settlingPastRounds.delete(rid);
      }
    }

    if (settledCount > 0) {
      updateUI();
      updateAuthUI();
      if (lastSettled) {
        const netProfit = Number(lastSettled.netProfit || 0);
        if (netProfit > 0) {
          showToast(`Đã kết toán phiên Live #${lastSettled.liveRoundId}: +${formatVND(netProfit)} ₫!`, 'success');
        } else if (netProfit === 0) {
          showToast(`Đã kết toán phiên Live #${lastSettled.liveRoundId}: HÒA VỐN • ±0 ₫`, 'info');
        } else {
          showToast(`Đã kết toán phiên Live #${lastSettled.liveRoundId}: -${formatVND(Math.abs(netProfit))} ₫`, 'info');
        }
      }
      await fetchServerState({ skipPastSettle: true });
    }
    return settledCount > 0;
  }

  function syncStaticDiceForRound(roundObj) {
    if (!roundObj || !Array.isArray(roundObj.dice)) return;
    if (state.isRolling || state.isSqueezeActive) return;
    const rid = Number(roundObj.id ?? roundObj.liveRoundId);
    if (Number.isFinite(rid) && state.lastRenderedDiceRoundId === rid) return;
    if (Number.isFinite(rid)) state.lastRenderedDiceRoundId = rid;
    engine.setDiceFacesInstant(roundObj.dice, {
      preserveYaw: false,
      yawSeed: Number.isFinite(rid) ? rid : 0
    });
  }

  async function syncLiveStateFromServer(triggerReveal = false) {
    if (triggerReveal && state.isSyncingLiveReveal) return null;
    if (triggerReveal) state.isSyncingLiveReveal = true;
    try {
      const { res, json } = await apiFetch('/api/live/state');
      if (!res.ok || !json) return null;
      if (typeof json.serverTime === 'number') {
        state.serverTimeOffsetMs = json.serverTime - Date.now();
      }
      if (json.roundSeedHash) {
        state.liveRoundSeedHash = json.roundSeedHash;
      }
      if (typeof json.liveRoundId === 'number') {
        state.liveRoundId = json.liveRoundId;
      }
      if (Array.isArray(json.recentHistory) && json.recentHistory.length > 0 && !state.isRolling && !state.isSqueezeActive) {
        const prevLastId = state.history.length > 0 ? state.history[state.history.length - 1].id : null;
        const nextLast = json.recentHistory[json.recentHistory.length - 1];
        state.history = json.recentHistory;
        syncStaticDiceForRound(nextLast);
        if (prevLastId !== nextLast.id) {
          if (el.roundCounterLabel) el.roundCounterLabel.textContent = `MACAU LIVE • #${nextLast.id}`;
          renderRoadmapAndBigRoad();
        }
      }
      restoreLiveTicketFromServer(json.ticket, json.unsettledTickets, json.liveRoundId);
      updateLiveTimerUI();
      renderAllBetSpots();
      updateUI();
      updateFairnessCommitUI();
      if (state.user && typeof json.liveRoundId === 'number') {
        await settleUnsettledPastLiveTickets(json.unsettledTickets, json.liveRoundId);
      }
      if (triggerReveal && json.phase === 'REVEAL' && Array.isArray(json.dice) && state.liveRevealedRoundId !== json.liveRoundId) {
        await handleLiveRoundReveal(json);
      }
      return json;
    } catch (_) {
      return null;
    } finally {
      if (triggerReveal) state.isSyncingLiveReveal = false;
    }
  }

  async function handleLiveRoundReveal(liveState) {
    if (state.isRolling || state.isSubmittingRoll || state.isSqueezeActive) return false;
    state.liveRevealedRoundId = liveState.liveRoundId;
    state.lastRenderedDiceRoundId = liveState.liveRoundId;

    if (state.user && typeof liveState.liveRoundId === 'number') {
      await settleUnsettledPastLiveTickets(liveState.unsettledTickets, liveState.liveRoundId);
    }

    let settledRes = null;
    if (state.liveTicket && state.liveTicket.liveRoundId === liveState.liveRoundId && !state.liveTicket.settled) {
      try {
        const { res, json } = await apiFetch('/api/live/settle', {
          method: 'POST',
          body: JSON.stringify({ liveRoundId: liveState.liveRoundId })
        });
        if (res.ok && json) {
          settledRes = json;
          state.liveTicket.settled = true;
        } else {
          state.liveTicket = null;
        }
      } catch (_) {
        state.liveTicket = null;
      }
    }

    const totalBet = settledRes ? settledRes.totalBet : 0;
    const totalWin = settledRes ? (settledRes.totalWin ?? 0) : 0;
    const netProfit = settledRes ? settledRes.netProfit : 0;
    const newBalance = settledRes && typeof settledRes.newBalance === 'number' ? settledRes.newBalance : state.balance;

    state.pendingResult = {
      roundId: liveState.liveRoundId,
      dice: liveState.dice,
      total: liveState.total,
      isTriple: liveState.isTriple,
      outcome: liveState.outcome,
      totalBet,
      totalWin,
      netProfit,
      newBalance,
      spectator: totalBet === 0
    };

    state.isRolling = true;
    if (el.btnRoll) el.btnRoll.disabled = true;
    document.querySelectorAll('.bet-spot').forEach(s => s.classList.remove('winner'));
    const isManualOpen = state.revealMode === 'manual';
    engine.shakeAndRoll(
      liveState.dice,
      () => sound.playDiceShake(),
      () => {
        if (isManualOpen) {
          state.isSqueezeActive = true;
          if (el.squeezePrompt) el.squeezePrompt.classList.add('active');
          if (el.squeezePctLabel) el.squeezePctLabel.textContent = '0%';
          engine.callbacks.onSqueezeProgress = (progress) => {
            if (el.squeezePctLabel) el.squeezePctLabel.textContent = `${Math.round(progress * 100)}%`;
          };
          engine.callbacks.onBowlOpened = () => finishReveal();
          clearSqueezeAutoTimer();
          state.squeezeAutoOpenTimer = setTimeout(() => {
            if (state.isSqueezeActive) {
              engine.openBowlQuick(() => finishReveal());
            }
          }, 8000);
        } else {
          engine.openBowlQuick(() => finishReveal());
        }
      },
      (intensity) => sound.playDiceBounce(intensity),
      isManualOpen
    );
    return true;
  }

  function updateLiveTimerUI() {
    const prevRoundId = state.liveRoundId;
    const clk = getClientLiveClock();
    state.liveRoundId = clk.liveRoundId;
    state.livePhase = clk.phase;
    if (prevRoundId !== null && prevRoundId !== clk.liveRoundId) {
      renderAllBetSpots();
    }

    const sec = clk.phase === 'BETTING'
      ? Math.max(0, Math.ceil(clk.betRemainingMs / 1000))
      : Math.max(0, Math.ceil(clk.roundRemainingMs / 1000));
    const pct = clk.phase === 'BETTING'
      ? Math.max(0, Math.min(100, (clk.betRemainingMs / LIVE_BET_MS) * 100))
      : 0;

    if (el.liveTimerBadge) {
      el.liveTimerBadge.textContent = `${sec}s`;
      el.liveTimerBadge.classList.toggle('urgent', clk.phase === 'BETTING' && sec <= 5 && sec > 0);
    }
    if (el.liveProgressFill) el.liveProgressFill.style.width = `${pct}%`;

    if (el.centerLiveRoundId) el.centerLiveRoundId.textContent = String(clk.liveRoundId);
    if (el.centerLiveSec) el.centerLiveSec.textContent = `${sec}s`;
    if (el.centerLivePhaseBadge) {
      el.centerLivePhaseBadge.textContent = clk.phase === 'BETTING' ? 'NHẬN CƯỢC' : 'KHÓA SỔ • MỞ BÁT';
      el.centerLivePhaseBadge.classList.toggle('reveal', clk.phase === 'REVEAL');
    }

    const hasActiveTicket = Boolean(
      state.liveTicket &&
      !state.liveTicket.settled &&
      state.liveTicket.liveRoundId === clk.liveRoundId &&
      state.liveTicket.totalBet > 0
    );
    if (el.liveTicketBadge) {
      if (hasActiveTicket) {
        el.liveTicketBadge.textContent = `Đã chốt ${formatVND(state.liveTicket.totalBet)} ₫`;
        el.liveTicketBadge.classList.remove('hidden');
      } else {
        el.liveTicketBadge.textContent = '';
        el.liveTicketBadge.classList.add('hidden');
      }
    }

    if (!state.isRolling && !state.isSqueezeActive && el.btnRollLabel) {
      el.btnRollLabel.textContent = clk.phase === 'BETTING'
        ? (hasActiveTicket ? `Cược Thêm (${sec}s)` : `Đặt Cược Live (${sec}s)`)
        : `Mở Bát (${sec}s)`;
    }
    return clk;
  }

  function startLiveLoop() {
    stopLiveLoop();
    syncLiveStateFromServer(false);
    state.liveIntervalId = setInterval(() => {
      const clk = updateLiveTimerUI();

      if (clk.phase === 'BETTING') {
        const sec = Math.ceil(clk.betRemainingMs / 1000);
        if (sec !== state.liveLastSecTick) {
          state.liveLastSecTick = sec;
          if (sec > 0 && sec <= 5) sound.playTimerTick(sec <= 3);
        }
        if (state.liveLastCommittedHashRoundId !== clk.liveRoundId) {
          state.liveLastCommittedHashRoundId = clk.liveRoundId;
          syncLiveStateFromServer(false);
        }
      } else if (clk.phase === 'REVEAL' && state.liveRevealedRoundId !== clk.liveRoundId && !state.isRolling && !state.isSubmittingRoll && !state.isSqueezeActive && !state.isSyncingLiveReveal) {
        syncLiveStateFromServer(true);
      }
    }, 100);
  }

  function stopLiveLoop() {
    if (state.liveIntervalId) {
      clearInterval(state.liveIntervalId);
      state.liveIntervalId = null;
    }
  }

  // ==================== 7. FORMATTING, PROVABLY FAIR CRYPTO & FALLBACK ====================
  function formatVND(num) {
    return Number(num || 0).toLocaleString('vi-VN');
  }

  function truncateHash(h) {
    if (!h || h.length < 20) return h || '---';
    return `${h.slice(0, 14)}...${h.slice(-10)}`;
  }

  function updateUI() {
    if (el.userBalance) el.userBalance.textContent = formatVND(state.displayedBalance);
    if (el.chipAllIn && el.chipAllIn.classList.contains('active')) {
      state.selectedChip = state.balance;
    }
    const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
    if (el.currentWagerSummary) {
      const hasTicket = state.liveTicket && !state.liveTicket.settled && state.liveTicket.liveRoundId === state.liveRoundId && state.liveTicket.totalBet > 0;
      el.currentWagerSummary.textContent = totalWager > 0
        ? `${formatVND(totalWager)} ₫`
        : (hasTicket ? `Đã chốt ${formatVND(state.liveTicket.totalBet)} ₫` : '0 ₫');
    }
  }

  function updateFairnessCommitUI() {
    const hash = state.liveRoundSeedHash || state.provablyFair.nextServerSeedHash || '';
    const nonce = state.provablyFair.nextNonce ?? 1;
    if (el.nextHashPreview) el.nextHashPreview.textContent = truncateHash(hash);
    if (el.nextNoncePreview) {
      el.nextNoncePreview.textContent = typeof state.liveRoundId === 'number'
        ? `LIVE #${state.liveRoundId}`
        : `NONCE #${nonce}`;
    }
    if (el.inputNextHash) el.inputNextHash.value = state.provablyFair.nextServerSeedHash || hash;
    if (el.inputNextNonce) el.inputNextNonce.value = nonce;
    if (el.inputClientSeed && document.activeElement !== el.inputClientSeed) {
      el.inputClientSeed.value = state.provablyFair.clientSeed || 'sovereign-vip-888';
    }
  }

  async function browserSha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) return randomHex(64);
    const enc = new TextEncoder().encode(String(text));
    const buf = await window.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hmacSha256Bytes(keyStr, messageStr) {
    const enc = new TextEncoder();
    const key = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(String(keyStr)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await window.crypto.subtle.sign('HMAC', key, enc.encode(String(messageStr)));
    return new Uint8Array(sig);
  }

  async function deriveFairDice(serverSeed, clientSeed, nonce) {
    if (typeof serverSeed !== 'string' || serverSeed.trim().length === 0) {
      throw new TypeError('serverSeed must be a non-empty string');
    }
    const cleanClientSeed = String(clientSeed ?? '').trim() || 'sovereign-vip-888';
    let cleanNonce = 0;
    if (nonce !== undefined) {
      if (nonce === null || typeof nonce === 'boolean' || typeof nonce === 'symbol' || typeof nonce === 'object') {
        throw new TypeError('nonce must be a non-negative safe integer');
      }
      if (typeof nonce === 'string') {
        const trimmed = nonce.trim();
        if (!/^\d+$/.test(trimmed)) {
          throw new RangeError('nonce must be a non-negative safe integer');
        }
        const parsed = Number(trimmed);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new RangeError('nonce must be a non-negative safe integer');
        }
        cleanNonce = parsed === 0 ? 0 : parsed;
      } else if (typeof nonce === 'number') {
        if (!Number.isSafeInteger(nonce) || nonce < 0) {
          throw new RangeError('nonce must be a non-negative safe integer');
        }
        cleanNonce = nonce === 0 ? 0 : nonce;
      } else {
        throw new TypeError('nonce must be a non-negative safe integer');
      }
    }
    const baseMessage = `${cleanClientSeed}:${cleanNonce}`;

    const dice = [];
    let attempt = 0;
    let primaryHmacHex = '';

    while (dice.length < 3) {
      const msg = attempt === 0 ? baseMessage : `${baseMessage}:${attempt}`;
      const bytes = await hmacSha256Bytes(serverSeed, msg);
      if (attempt === 0) {
        primaryHmacHex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      }
      for (let i = 0; i < bytes.length && dice.length < 3; i++) {
        const byte = bytes[i];
        if (byte < 252) {
          dice.push((byte % 6) + 1);
        }
      }
      attempt += 1;
    }

    return { dice, clientSeed: cleanClientSeed, nonce: cleanNonce, hmacHex: primaryHmacHex, attempts: attempt };
  }

  renderRoadmapAndBigRoad();
  updateUI();
  updateFairnessCommitUI();
  updateAuthUI();

  async function fetchServerState(opts = {}) {
    try {
      const { res, json: data } = await apiFetch('/api/state', { skipAuthReset: true });
      if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
      if (typeof data.serverTime === 'number') {
        state.serverTimeOffsetMs = data.serverTime - Date.now();
      }
      if (data.user) {
        state.user = data.user;
        state.balance = data.user.balance;
        if (!state.isBalanceTweening && !state.isRolling && !state.isSqueezeActive) {
          state.displayedBalance = data.user.balance;
        }
      } else {
        state.user = null;
        state.balance = 0;
        state.displayedBalance = 0;
        resetClientSessionState({ clearBets: !state.isRolling && !state.isSqueezeActive });
      }
      if (Array.isArray(data.history) && data.history.length > 0) {
        state.history = data.history;
        const latest = data.history[data.history.length - 1];
        if (el.roundCounterLabel) el.roundCounterLabel.textContent = `MACAU LIVE • #${latest.id}`;
        syncStaticDiceForRound(latest);
        renderRoadmapAndBigRoad();
      }
      if (Array.isArray(data.personalHistory)) {
        state.personalHistory = data.personalHistory;
        renderPersonalLedger();
      }
      if (Array.isArray(data.ledger)) {
        state.walletLedger = data.ledger;
        renderWalletLedger();
      }
      const pf = data.fairness || data.provablyFair;
      if (pf) {
        if (pf.serverSeedHash || pf.nextServerSeedHash) {
          state.provablyFair.nextServerSeedHash = pf.serverSeedHash || pf.nextServerSeedHash;
        }
        if (pf.nonce !== undefined || pf.nextNonce !== undefined) {
          state.provablyFair.nextNonce = pf.nonce ?? pf.nextNonce;
        }
        if (pf.clientSeed) {
          state.provablyFair.clientSeed = pf.clientSeed;
        }
        if (pf.lastRevealed) {
          populateVerifierInputs(pf.lastRevealed, false);
        }
      }
      if (data.live) {
        if (data.live.roundSeedHash) state.liveRoundSeedHash = data.live.roundSeedHash;
        if (typeof data.live.liveRoundId === 'number') state.liveRoundId = data.live.liveRoundId;
      }
      if (data.live || Array.isArray(data.unsettledLiveTickets)) {
        restoreLiveTicketFromServer(
          data.live ? data.live.ticket : null,
          data.unsettledLiveTickets,
          data.live ? data.live.liveRoundId : undefined
        );
      }
      updateFairnessCommitUI();
      updateLiveTimerUI();
      updateAuthUI();
      updateUI();
      if (data.user && !opts.skipPastSettle && data.live && typeof data.live.liveRoundId === 'number') {
        await settleUnsettledPastLiveTickets(data.unsettledLiveTickets, data.live.liveRoundId);
      }
    } catch (_) {
      const hash = await browserSha256Hex(state.localPendingServerSeed);
      state.provablyFair.nextServerSeedHash = hash;
      updateFairnessCommitUI();
    }
  }

  // ==================== 8. CHIPS, STACKS, FLYING CHIPS, UNDO & REMOVE MODE ====================
  function getChipClassForValue(val) {
    for (const d of CHIP_DENOMS) {
      if (val >= d.val) return d.cls;
    }
    return 'chip-10k';
  }

  function decomposeChipStack(amount) {
    const stack = [];
    let rem = Math.max(0, Math.floor(amount));
    for (const d of CHIP_DENOMS) {
      while (rem >= d.val && stack.length < 6) {
        stack.push(d.cls);
        rem -= d.val;
      }
      if (stack.length >= 6) break;
    }
    if (stack.length === 0 && amount > 0) stack.push('chip-10k');
    return stack;
  }

  function animateFlyingChip(targetSpot, chipVal) {
    if (!targetSpot || !window.gsap) return;
    const sourceChip = (el.chipsSelector && el.chipsSelector.querySelector('.zen-chip.active')) || el.chipsSelector;
    if (!sourceChip) return;
    const srcRect = sourceChip.getBoundingClientRect();
    const dstRect = targetSpot.getBoundingClientRect();
    if (!dstRect.width || !dstRect.height) return;

    const fly = document.createElement('div');
    fly.className = `flying-chip ${getChipClassForValue(chipVal)}`;
    document.body.appendChild(fly);

    const startX = srcRect.left + srcRect.width / 2 - 12;
    const startY = srcRect.top + srcRect.height / 2 - 12;
    const endX = dstRect.left + dstRect.width / 2 - 12;
    const endY = dstRect.top + dstRect.height / 2 - 12;

    gsap.fromTo(
      fly,
      { left: startX, top: startY, scale: 1.15, opacity: 0.95 },
      {
        left: endX,
        top: endY,
        scale: 0.72,
        opacity: 0.1,
        duration: 0.26,
        ease: 'power2.out',
        onComplete: () => {
          if (fly.parentNode) fly.parentNode.removeChild(fly);
        }
      }
    );
  }

  function renderBetSpot(spot, betKey) {
    if (!spot) return;
    const amount = state.currentBets[betKey] || 0;
    const committed = (
      state.liveTicket &&
      state.liveTicket.liveRoundId === state.liveRoundId &&
      state.liveTicket.bets
    ) ? (state.liveTicket.bets[betKey] || 0) : 0;
    const wagerEl = spot.querySelector('.wager-chip-counter');
    const chipPileEl = spot.querySelector('.spot-chip-pile');

    if (amount > 0) {
      if (wagerEl) {
        wagerEl.textContent = committed > 0 ? `+${formatVND(amount)}` : formatVND(amount);
        wagerEl.classList.add('active');
      }
      if (chipPileEl) {
        chipPileEl.innerHTML = '';
        decomposeChipStack(amount).forEach(cls => {
          const disc = document.createElement('div');
          disc.className = `mini-stacked-chip ${cls}`;
          chipPileEl.appendChild(disc);
        });
      }
    } else {
      if (wagerEl) {
        wagerEl.textContent = '';
        wagerEl.classList.remove('active');
      }
      if (chipPileEl) chipPileEl.innerHTML = '';
      if (!committed) spot.classList.remove('winner');
    }

    let committedEl = spot.querySelector('.committed-bet-badge');
    if (committed > 0) {
      if (!committedEl) {
        committedEl = document.createElement('span');
        committedEl.className = 'committed-bet-badge';
        spot.appendChild(committedEl);
      }
      committedEl.textContent = `✓ Đã chốt ${formatVND(committed)}`;
      committedEl.classList.add('active');
      spot.classList.add('has-committed');
    } else {
      if (committedEl) {
        committedEl.textContent = '';
        committedEl.classList.remove('active');
      }
      spot.classList.remove('has-committed');
    }
  }

  function renderAllBetSpots() {
    document.querySelectorAll('.bet-spot').forEach(spot => {
      renderBetSpot(spot, spot.getAttribute('data-bet'));
    });
  }

  if (el.chipsSelector) {
    el.chipsSelector.querySelectorAll('.zen-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        sound.playTick();
        el.chipsSelector.querySelectorAll('.zen-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (chip.id === 'chipAllIn') {
          state.selectedChip = state.balance;
        } else {
          state.selectedChip = parseInt(chip.getAttribute('data-val'), 10);
        }
      });
    });
  }

  function placeOrRemoveChip(betKey, spot, isRemove = false) {
    if (state.isRolling || state.isSqueezeActive) return;
    if (!isRemove && !requireAuthenticatedSession('Vui lòng đăng nhập hoặc đăng ký tài khoản để đặt cược!')) {
      return;
    }
    if (state.mode === 'live' && state.livePhase !== 'BETTING') {
      showToast('Phiên Live đang khóa sổ mở bát. Vui lòng đợi phiên kế tiếp!', 'error', 2200);
      return;
    }

    const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
    if (isRemove) {
      const cur = state.currentBets[betKey] || 0;
      if (cur <= 0) return;
      const removeStep = (el.chipAllIn && el.chipAllIn.classList.contains('active'))
        ? cur
        : Math.min(cur, state.selectedChip);
      state.betUndoStack.push({ type: 'remove', betKey, delta: removeStep });
      const nextVal = cur - removeStep;
      if (nextVal <= 0) delete state.currentBets[betKey];
      else state.currentBets[betKey] = nextVal;
      if (sound && sound.playChipRemove) sound.playChipRemove();
      else sound.playTick();
      renderBetSpot(spot, betKey);
      updateUI();
      return;
    }

    const chipVal = (el.chipAllIn && el.chipAllIn.classList.contains('active'))
      ? Math.max(0, state.balance - totalWager)
      : state.selectedChip;

    if (chipVal <= 0 || totalWager + chipVal > state.balance) {
      const bonusHint = (state.user && !state.user.welcomeBonusClaimed)
        ? ' Nhấn "🎁 Nhận 2M Tân Thủ" ở thanh trên để nhận ưu đãi!'
        : '';
      showToast(`Số dư không đủ để đặt thêm phỉnh này.${bonusHint}`, 'error');
      sound.playTick();
      return;
    }

    const nextGateVal = (state.currentBets[betKey] || 0) + chipVal;
    if (nextGateVal > MAX_SINGLE_BET) {
      showToast('Mỗi cửa cược tối đa 1,000,000,000 ₫.', 'error');
      sound.playTick();
      return;
    }

    state.betUndoStack.push({ type: 'add', betKey, delta: chipVal });
    state.currentBets[betKey] = nextGateVal;
    sound.playChip();
    animateFlyingChip(spot, chipVal);
    renderBetSpot(spot, betKey);
    updateUI();
  }

  document.querySelectorAll('.bet-spot').forEach(spot => {
    const betKey = spot.getAttribute('data-bet');
    spot.addEventListener('click', () => placeOrRemoveChip(betKey, spot, state.removeMode));
    spot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      placeOrRemoveChip(betKey, spot, true);
    });
  });

  if (el.btnRemoveMode) {
    el.btnRemoveMode.addEventListener('click', () => {
      sound.playTick();
      state.removeMode = !state.removeMode;
      el.btnRemoveMode.classList.toggle('active-mode', state.removeMode);
      document.body.classList.toggle('remove-mode-active', state.removeMode);
      showToast(state.removeMode ? 'Đang bật chế độ Gỡ từng cửa (nhấn vào cửa để trừ phỉnh).' : 'Đã tắt chế độ Gỡ từng cửa.', 'info', 2000);
    });
  }

  if (el.btnUndo) {
    el.btnUndo.addEventListener('click', () => {
      if (state.isRolling || state.isSqueezeActive) return;
      const action = state.betUndoStack.pop();
      if (!action) {
        showStatus('Không còn thao tác cược nào để hoàn tác.');
        return;
      }
      if (action.type === 'add') {
        const nextVal = (state.currentBets[action.betKey] || 0) - action.delta;
        if (nextVal <= 0) delete state.currentBets[action.betKey];
        else state.currentBets[action.betKey] = nextVal;
      } else if (action.type === 'remove') {
        state.currentBets[action.betKey] = (state.currentBets[action.betKey] || 0) + action.delta;
      } else if (action.type === 'snapshot') {
        state.currentBets = { ...action.prevBets };
      }
      if (sound && sound.playChipRemove) sound.playChipRemove();
      else sound.playTick();
      renderAllBetSpots();
      updateUI();
      showStatus('Đã hoàn tác bước đặt phỉnh vừa rồi.');
    });
  }

  if (el.btnClear) {
    el.btnClear.addEventListener('click', () => {
      if (state.isRolling || state.isSqueezeActive) return;
      if (Object.keys(state.currentBets).length > 0) {
        state.betUndoStack.push({ type: 'snapshot', prevBets: { ...state.currentBets } });
      }
      if (sound && sound.playChipRemove) sound.playChipRemove();
      else sound.playTick();
      state.currentBets = {};
      renderAllBetSpots();
      updateUI();
      showStatus('Đã thu hồi toàn bộ phỉnh cược trên bàn.');
    });
  }

  if (el.btnDouble) {
    el.btnDouble.addEventListener('click', () => {
      if (state.isRolling || state.isSqueezeActive) return;
      if (!requireAuthenticatedSession('Vui lòng đăng nhập để điều chỉnh cược!')) return;
      const currentTotal = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
      if (currentTotal <= 0) return;
      if (currentTotal * 2 > state.balance) {
        showToast('Số dư không đủ để nhân đôi cược.', 'error');
        return;
      }
      const exceedsSingleCap = Object.values(state.currentBets).some(v => v * 2 > MAX_SINGLE_BET);
      if (exceedsSingleCap) {
        showToast('Mỗi cửa cược tối đa 1,000,000,000 ₫.', 'error');
        return;
      }
      state.betUndoStack.push({ type: 'snapshot', prevBets: { ...state.currentBets } });
      sound.playChip();
      for (const k in state.currentBets) state.currentBets[k] *= 2;
      renderAllBetSpots();
      updateUI();
      showStatus('Đã nhân đôi (x2) toàn bộ phỉnh cược.');
    });
  }

  if (el.btnRebet) {
    el.btnRebet.addEventListener('click', () => {
      if (state.isRolling || state.isSqueezeActive) return;
      if (!requireAuthenticatedSession('Vui lòng đăng nhập để đặt lại cược!')) return;
      const lastTotal = Object.values(state.lastBets).reduce((a, b) => a + b, 0);
      if (lastTotal <= 0) {
        showToast('Chưa có lịch sử cược phiên trước.', 'info');
        return;
      }
      if (lastTotal > state.balance) {
        showToast('Số dư không đủ để đặt lại cược cũ.', 'error');
        return;
      }
      state.betUndoStack.push({ type: 'snapshot', prevBets: { ...state.currentBets } });
      sound.playChip();
      state.currentBets = { ...state.lastBets };
      renderAllBetSpots();
      updateUI();
      showStatus('Đã đặt lại phỉnh phiên trước.');
    });
  }

  // ==================== 9. ROLL, PRE-SHAKE DEDUCT, COUNT-UP & SQUEEZE FLOW ====================
  if (el.btnRoll) el.btnRoll.addEventListener('click', () => startRoll(state.mode));
  if (el.btnQuickTopRoll) {
    el.btnQuickTopRoll.addEventListener('click', () => {
      sound.playTick();
      closeAllModals();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      syncLiveStateFromServer(false);
      showToast('Đã đồng bộ sân khấu Live 45s.', 'info', 1800);
    });
  }
  if (el.btnCardRollTrigger) {
    el.btnCardRollTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openChroniclesDrawer('tabBigRoad');
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      closeAllModals();
      return;
    }
    if (document.body.classList.contains('modal-open')) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.isSqueezeActive) {
        clearSqueezeAutoTimer();
        engine.openBowlQuick(() => finishReveal());
      } else if (!state.isRolling && !state.isSubmittingRoll) {
        startRoll(state.mode);
      }
    }
  });

  async function submitLiveBet(totalWager) {
    let ownLock = false;
    if (!state.isSubmittingRoll) {
      if (state.isRolling || state.isSqueezeActive) return false;
      state.isSubmittingRoll = true;
      ownLock = true;
      if (el.btnRoll) el.btnRoll.disabled = true;
    }

    try {
      if (!requireAuthenticatedSession('Vui lòng đăng nhập hoặc đăng ký tài khoản để đặt cược Live!')) {
        return false;
      }
      if (totalWager <= 0) {
        showToast('Hãy đặt ít nhất 1 phỉnh vào cửa cược trước khi chốt cược Live!', 'info');
        return false;
      }
      const clk = getClientLiveClock();
      if (clk.phase !== 'BETTING') {
        showToast('Đã khóa sổ mở bát, vui lòng đợi phiên Live kế tiếp!', 'error');
        return false;
      }
      if (totalWager > state.balance) {
        showToast('Số dư không đủ để thực hiện cược này.', 'error');
        return false;
      }

      if (window.triggerLiquidRollPulse) {
        window.triggerLiquidRollPulse();
      }
      closeAllModals();

      const ikey = generateIdempotencyKey();
      const { res, json } = await apiFetch('/api/live/bet', {
        method: 'POST',
        idempotencyKey: ikey,
        body: JSON.stringify({ bets: state.currentBets, liveRoundId: clk.liveRoundId })
      });
      if (!res.ok || !json) {
        if (res.status === 401) {
          openAuthModal('authPaneLogin');
          return false;
        }
        showToast((json && json.error) || 'Không thể đặt cược Live.', 'error');
        return false;
      }
      state.lastBets = { ...state.currentBets };
      const mergedTotalBet = (json.ticket && typeof json.ticket.totalBet === 'number')
        ? json.ticket.totalBet
        : totalWager;
      state.liveTicket = {
        liveRoundId: json.liveRoundId || clk.liveRoundId,
        totalBet: mergedTotalBet,
        bets: (json.ticket && json.ticket.bets) ? { ...json.ticket.bets } : { ...state.currentBets },
        settled: Boolean(json.ticket && json.ticket.settled)
      };
      state.balance = json.newBalance;
      state.displayedBalance = json.newBalance;
      state.currentBets = {};
      state.betUndoStack = [];
      renderAllBetSpots();
      updateLiveTimerUI();
      updateUI();
      showToast(`Đã chốt cược Live phiên #${state.liveTicket.liveRoundId} (${formatVND(totalWager)} ₫)!`, 'success');
      return true;
    } catch (_) {
      showToast('Mất kết nối khi đặt cược Live.', 'error');
      return false;
    } finally {
      if (ownLock) {
        state.isSubmittingRoll = false;
        if (!state.isRolling && el.btnRoll) el.btnRoll.disabled = false;
      }
    }
  }

  async function startRoll(_triggerMode = 'live', _isRetry = false) {
    if (!_isRetry && (state.isRolling || state.isSubmittingRoll || state.isSqueezeActive)) return false;

    state.isSubmittingRoll = true;
    if (el.btnRoll) el.btnRoll.disabled = true;
    try {
      const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
      return await submitLiveBet(totalWager);
    } finally {
      state.isSubmittingRoll = false;
      if (!state.isRolling && el.btnRoll) el.btnRoll.disabled = false;
    }
  }

  function clearSqueezeAutoTimer() {
    if (state.squeezeAutoOpenTimer) {
      clearTimeout(state.squeezeAutoOpenTimer);
      state.squeezeAutoOpenTimer = null;
    }
  }

  if (el.btnQuickOpen) {
    el.btnQuickOpen.addEventListener('click', () => {
      if (state.isSqueezeActive) {
        clearSqueezeAutoTimer();
        engine.openBowlQuick(() => finishReveal());
      }
    });
  }

  function animateBalanceCountUp(fromVal, toVal) {
    if (state.balanceTween && typeof state.balanceTween.kill === 'function') {
      state.balanceTween.kill();
      state.balanceTween = null;
    }
    if (!el.userBalance) {
      state.isBalanceTweening = false;
      state.displayedBalance = toVal;
      return;
    }
    if (toVal <= fromVal) {
      state.isBalanceTweening = false;
      state.displayedBalance = toVal;
      el.userBalance.textContent = formatVND(toVal);
      return;
    }
    if (window.gsap && typeof window.gsap.to === 'function') {
      state.isBalanceTweening = true;
      const counter = { val: fromVal };
      state.balanceTween = gsap.to(counter, {
        val: toVal,
        duration: 0.85,
        ease: 'power2.out',
        onUpdate: () => {
          const nextVal = Math.min(toVal, Math.max(state.displayedBalance, Math.round(counter.val)));
          state.displayedBalance = nextVal;
          el.userBalance.textContent = formatVND(nextVal);
        },
        onComplete: () => {
          state.isBalanceTweening = false;
          state.balanceTween = null;
          const finalVal = typeof state.balance === 'number' ? state.balance : toVal;
          state.displayedBalance = finalVal;
          el.userBalance.textContent = formatVND(finalVal);
        }
      });
    } else {
      state.isBalanceTweening = false;
      state.displayedBalance = toVal;
      el.userBalance.textContent = formatVND(toVal);
    }
  }

  function finishReveal() {
    clearSqueezeAutoTimer();
    state.isSqueezeActive = false;
    if (el.squeezePrompt) el.squeezePrompt.classList.remove('active');
    engine.callbacks.onSqueezeProgress = null;
    engine.callbacks.onBowlOpened = null;

    const res = state.pendingResult;
    if (!res) {
      state.isRolling = false;
      if (el.btnRoll) el.btnRoll.disabled = false;
      return;
    }
    state.pendingResult = null;

    const fromBal = state.displayedBalance;
    const targetBal = typeof res.newBalance === 'number' ? res.newBalance : state.balance;
    state.balance = targetBal;
    animateBalanceCountUp(fromBal, targetBal);

    if (Array.isArray(res.history) && res.history.length > 0) {
      state.history = res.history;
    } else {
      const nextHist = [...state.history, { id: res.roundId, dice: res.dice, total: res.total, outcome: res.outcome, isTriple: res.isTriple }];
      if (nextHist.length > 60) nextHist.shift();
      state.history = nextHist;
    }
    if (Array.isArray(res.personalHistory)) {
      state.personalHistory = res.personalHistory;
      renderPersonalLedger();
    }

    if (res.fairness) {
      if (res.fairness.nextServerSeedHash || res.fairness.serverSeedHash) {
        state.provablyFair.nextServerSeedHash = res.fairness.nextServerSeedHash || res.fairness.serverSeedHash;
      }
      if (res.fairness.nextNonce !== undefined || res.fairness.nonce !== undefined) {
        state.provablyFair.nextNonce = res.fairness.nextNonce ?? res.fairness.nonce;
      }
      if (res.fairness.revealed) {
        state.provablyFair.lastRevealed = res.fairness.revealed;
        populateVerifierInputs(res.fairness.revealed, true);
      }
      updateFairnessCommitUI();
    }

    renderRoadmapAndBigRoad();

    const outcomeLabel = res.outcome === 'TRIPLE' ? 'BÃO' : (res.outcome === 'TAI' ? 'TÀI' : 'XỈU');
    if (el.resBadgeOutcome) {
      el.resBadgeOutcome.textContent = `${outcomeLabel} • ${res.total}`;
      el.resBadgeOutcome.className = `outcome-pill ${String(res.outcome || '').toLowerCase()}`;
    }
    if (el.resBadgeTotal) el.resBadgeTotal.textContent = (res.dice || []).join('-');
    if (el.roundCounterLabel) el.roundCounterLabel.textContent = `MACAU LIVE • #${res.roundId}`;
    if (el.resDiceStrip) {
      el.resDiceStrip.innerHTML = (res.dice || []).map(d => `<span>${DICE_SYMBOLS[Number(d)] || ''}</span>`).join(' ');
    }

    const totalWin = res.totalWin ?? res.totalPayout ?? 0;
    const netProfit = typeof res.netProfit === 'number' ? res.netProfit : (totalWin - (res.totalBet || 0));

    if (el.resWinText) {
      el.resWinText.classList.remove('res-win-even');
      if (res.spectator || (res.totalBet || 0) === 0) {
        el.resWinText.textContent = `Kết quả: ${outcomeLabel} ${res.total} điểm`;
        el.resWinText.style.color = '#191718';
        sound.playWin();
      } else if (netProfit > 0) {
        el.resWinText.textContent = `+${formatVND(netProfit)} ₫`;
        el.resWinText.style.color = '#1d6e50';
        if (netProfit >= 5000000 || res.isTriple) {
          sound.playBigWin();
          if (window.confetti) confetti({ particleCount: 95, spread: 80, origin: { y: 0.55 } });
        } else {
          sound.playWin();
          if (window.confetti) confetti({ particleCount: 45, spread: 60, origin: { y: 0.6 } });
        }
      } else if (netProfit === 0) {
        el.resWinText.textContent = 'HÒA VỐN • ±0 ₫';
        el.resWinText.style.color = '';
        el.resWinText.classList.add('res-win-even');
        if (sound && sound.playBreakeven) sound.playBreakeven();
        else sound.playTick();
      } else {
        el.resWinText.textContent = `-${formatVND(Math.abs(netProfit))} ₫`;
        el.resWinText.style.color = '#b82e43';
        if (sound && sound.playLoss) sound.playLoss();
        else sound.playTick();
      }
    }

    showRoundResultBanner({ ...res, netProfit }, outcomeLabel);

    if (el.resultBanner && window.gsap) {
      gsap.fromTo(el.resultBanner, { scale: 0.94 }, { scale: 1, duration: 0.38, ease: 'back.out(1.6)' });
    }

    state.currentBets = {};
    renderAllBetSpots();
    highlightWinners(res);
    updateUI();
    updateAuthUI();

    state.isRolling = false;
    if (el.btnRoll) el.btnRoll.disabled = false;
    updateLiveTimerUI();

    showStatus(`Phiên #${res.roundId}: [${(res.dice || []).join('-')}] = ${res.total} điểm (${outcomeLabel})`);
    fetchServerState();
  }

  function highlightWinners(res) {
    const d = res.dice || [];
    const total = res.total;
    const isTriple = Boolean(res.isTriple);
    const isEven = (total % 2 === 0);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    d.forEach(val => {
      if (val >= 1 && val <= 6) counts[val]++;
    });

    const winningKeys = [];
    if (!isTriple && total >= 11) winningKeys.push('tai');
    if (!isTriple && total <= 10) winningKeys.push('xiu');
    if (!isTriple && isEven) winningKeys.push('even');
    if (!isTriple && !isEven) winningKeys.push('odd');

    if (isTriple) {
      winningKeys.push('triple_any');
      winningKeys.push(`triple_${d[0]}`);
    }
    if (total >= 4 && total <= 17) {
      winningKeys.push(`total_${total}`);
    }

    [1, 2, 3, 4, 5, 6].forEach(val => {
      if (counts[val] >= 1) winningKeys.push(`single_${val}`);
      if (counts[val] >= 2) winningKeys.push(`double_${val}`);
    });

    for (let a = 1; a <= 5; a++) {
      for (let b = a + 1; b <= 6; b++) {
        if (counts[a] >= 1 && counts[b] >= 1) {
          winningKeys.push(`pair_${a}_${b}`);
        }
      }
    }

    winningKeys.forEach(k => {
      const spot = document.querySelector(`.bet-spot[data-bet="${k}"]`);
      if (spot) spot.classList.add('winner');
    });
  }

  // ==================== 10. BEAD ROAD & MACAU 6-ROW BIG ROAD ====================
  function renderRoadmapAndBigRoad() {
    if (!el.roadmapMatrix) return;
    el.roadmapMatrix.innerHTML = '';
    const recent48 = state.history.slice(-48);

    let taiCount = 0;
    let xiuCount = 0;
    let tripleCount = 0;

    recent48.forEach(item => {
      if (item.outcome === 'TAI') taiCount++;
      else if (item.outcome === 'XIU') xiuCount++;
      else if (item.outcome === 'TRIPLE') tripleCount++;

      const dot = document.createElement('div');
      dot.className = `road-dot ${String(item.outcome || '').toLowerCase()}`;
      dot.textContent = item.outcome === 'TRIPLE' ? 'B' : item.total;
      dot.title = `Phiên #${item.id}: [${(item.dice || []).join('-')}] = ${item.total} (${item.outcome})`;
      el.roadmapMatrix.appendChild(dot);
    });
    el.roadmapMatrix.scrollLeft = el.roadmapMatrix.scrollWidth;

    const totalValid = taiCount + xiuCount;
    const taiPct = totalValid > 0 ? Math.round((taiCount / totalValid) * 100) : 50;
    const xiuPct = totalValid > 0 ? 100 - taiPct : 50;

    if (el.statTaiCount) el.statTaiCount.textContent = taiCount;
    if (el.statTaiPct) el.statTaiPct.textContent = `${taiPct}%`;
    if (el.statXiuCount) el.statXiuCount.textContent = xiuCount;
    if (el.statXiuPct) el.statXiuPct.textContent = `${xiuPct}%`;
    if (el.statTripleCount) el.statTripleCount.textContent = tripleCount;

    if (el.fullBeadGrid) {
      el.fullBeadGrid.innerHTML = '';
      state.history.slice(-60).forEach(item => {
        const dot = document.createElement('div');
        dot.className = `road-dot ${String(item.outcome || '').toLowerCase()}`;
        dot.style.width = '22px';
        dot.style.height = '22px';
        dot.style.fontSize = '0.6rem';
        dot.textContent = item.outcome === 'TRIPLE' ? 'B' : item.total;
        dot.title = `#${item.id}: [${(item.dice || []).join('-')}] = ${item.total}`;
        el.fullBeadGrid.appendChild(dot);
      });
    }

    renderMacauBigRoad(state.history.slice(-60));
  }

  function buildBigRoadMatrix(rounds, minCols = 20) {
    const ROWS = 6;
    const grid = {};
    let maxCol = minCols - 1;
    let lastSide = null;
    let streakStartCol = -1;
    let curCol = 0;
    let curRow = 0;

    rounds.forEach(item => {
      if (item.outcome === 'TRIPLE') {
        const key = `${curCol},${curRow}`;
        if (grid[key]) {
          grid[key].triples = (grid[key].triples || 0) + 1;
        } else {
          grid['0,0'] = { outcome: 'TRIPLE', total: item.total, id: item.id, dice: item.dice, triples: 1 };
        }
        return;
      }

      const side = item.outcome;
      if (side !== lastSide) {
        streakStartCol = streakStartCol + 1;
        while (grid[`${streakStartCol},0`]) streakStartCol++;
        curCol = streakStartCol;
        curRow = 0;
        lastSide = side;
      } else {
        const nextRow = curRow + 1;
        if (nextRow < ROWS && !grid[`${curCol},${nextRow}`]) {
          curRow = nextRow;
        } else {
          curCol = curCol + 1;
        }
      }

      if (curCol > maxCol) maxCol = curCol;
      grid[`${curCol},${curRow}`] = { outcome: side, total: item.total, id: item.id, dice: item.dice, triples: 0 };
    });

    return { grid, totalCols: Math.max(minCols, maxCol + 2), ROWS };
  }

  function renderMacauBigRoad(rounds) {
    const { grid, totalCols, ROWS } = buildBigRoadMatrix(rounds, 24);

    if (el.bigRoadGrid) {
      el.bigRoadGrid.innerHTML = '';
      for (let c = 0; c < totalCols; c++) {
        for (let r = 0; r < ROWS; r++) {
          const cellDiv = document.createElement('div');
          cellDiv.className = 'bigroad-cell';
          const entry = grid[`${c},${r}`];
          if (entry) {
            const ring = document.createElement('div');
            ring.className = `bigroad-ring ${String(entry.outcome || '').toLowerCase()}`;
            ring.textContent = entry.outcome === 'TRIPLE' ? 'B' : entry.total;
            ring.title = `Phiên #${entry.id}: [${(entry.dice || []).join('-')}] = ${entry.total}`;
            cellDiv.appendChild(ring);
            if (entry.triples > 0 && entry.outcome !== 'TRIPLE') {
              const badge = document.createElement('span');
              badge.className = 'bigroad-tie-badge';
              badge.title = `Kèm ${entry.triples} phiên Bão`;
              cellDiv.appendChild(badge);
            }
          }
          el.bigRoadGrid.appendChild(cellDiv);
        }
      }
    }

    if (el.cardBigRoadMatrix) {
      el.cardBigRoadMatrix.innerHTML = '';
      const cardCols = Math.max(16, totalCols);
      for (let c = 0; c < cardCols; c++) {
        for (let r = 0; r < ROWS; r++) {
          const cellDiv = document.createElement('div');
          cellDiv.className = 'card-br-cell';
          const entry = grid[`${c},${r}`];
          if (entry) {
            const ring = document.createElement('div');
            ring.className = `card-br-ring ${String(entry.outcome || '').toLowerCase()}`;
            ring.textContent = entry.outcome === 'TRIPLE' ? 'B' : entry.total;
            ring.title = `Phiên #${entry.id}: [${(entry.dice || []).join('-')}] = ${entry.total}`;
            cellDiv.appendChild(ring);
          }
          el.cardBigRoadMatrix.appendChild(cellDiv);
        }
      }
      el.cardBigRoadMatrix.scrollLeft = el.cardBigRoadMatrix.scrollWidth;
    }

    const patternText = analyzeStreakPattern(rounds);
    if (el.miniStreakHint) el.miniStreakHint.textContent = patternText;
    if (el.bigRoadPatternBadge) el.bigRoadPatternBadge.textContent = patternText;
  }

  function analyzeStreakPattern(rounds) {
    const clean = rounds.filter(r => r.outcome === 'TAI' || r.outcome === 'XIU');
    if (clean.length < 2) return 'Đang khởi tạo dữ liệu cầu...';

    const latest = clean[clean.length - 1].outcome;
    let streakLen = 1;
    for (let i = clean.length - 2; i >= 0; i--) {
      if (clean[i].outcome === latest) streakLen++;
      else break;
    }

    const label = latest === 'TAI' ? 'TÀI' : 'XỈU';
    if (streakLen >= 4) return `🔥 Cầu Bệt ${label}: ${streakLen} tay liên tiếp`;

    let altCount = 1;
    for (let i = clean.length - 1; i > 0; i--) {
      if (clean[i].outcome !== clean[i - 1].outcome) altCount++;
      else break;
    }
    if (altCount >= 4) return `⚡ Cầu Đảo 1-1 (${altCount} nhịp liên tiếp)`;
    return `Xu hướng: ${label} (${streakLen} nhịp gần nhất)`;
  }

  // ==================== 11. PERSONAL BETTING LEDGER & WALLET LEDGER ====================
  function renderPersonalLedger() {
    if (!el.personalLedgerBody) return;
    const list = state.personalHistory || [];

    const totalRounds = list.length;
    const winRounds = list.filter(item => item.netProfit > 0).length;
    const totalWagered = list.reduce((acc, item) => acc + (item.totalBet || 0), 0);

    if (el.kpiTotalRounds) el.kpiTotalRounds.textContent = totalRounds;
    if (el.kpiWinRounds) el.kpiWinRounds.textContent = `${winRounds} / ${totalRounds}`;
    if (el.kpiTotalWagered) el.kpiTotalWagered.textContent = `${formatVND(totalWagered)} ₫`;

    if (list.length === 0) {
      el.personalLedgerBody.innerHTML = '<tr><td colspan="7" class="empty-ledger-cell">Chưa có phiên cược cá nhân nào. Hãy chọn phỉnh và đặt vào bàn!</td></tr>';
      return;
    }

    el.personalLedgerBody.innerHTML = '';
    list.forEach(item => {
      const tr = document.createElement('tr');
      const timeStr = new Date(item.timestamp).toLocaleTimeString('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const diceIcons = (item.dice || []).map(d => DICE_SYMBOLS[Number(d)] || '').join(' ');
      const outcomeVN = item.outcome === 'TRIPLE' ? 'BÃO' : (item.outcome === 'TAI' ? 'TÀI' : 'XỈU');
      const betsSummary = Object.entries(item.bets || {})
        .map(([k, v]) => `${formatBetName(k)} (${formatVND(v)})`)
        .join(', ');

      const profit = Number(item.netProfit || 0);
      let profitClass = 'profit-neg';
      let profitDisplay = `-${formatVND(Math.abs(profit))} ₫`;
      if (profit > 0) {
        profitClass = 'profit-pos';
        profitDisplay = `+${formatVND(profit)} ₫`;
      } else if (profit === 0) {
        profitClass = 'profit-even';
        profitDisplay = 'HÒA VỐN • ±0 ₫';
      }

      tr.innerHTML = `
        <td>#${escapeHtml(item.roundId)}</td>
        <td>${escapeHtml(timeStr)}</td>
        <td>${escapeHtml(diceIcons)} <strong>(${Number(item.total)} • ${escapeHtml(outcomeVN)})</strong></td>
        <td>${escapeHtml(betsSummary)}</td>
        <td>${escapeHtml(formatVND(item.totalBet))} ₫</td>
        <td class="${profitClass}">${escapeHtml(profitDisplay)}</td>
        <td><button class="btn-fair-sm btn-audit-row" style="padding:4px 8px;font-size:0.64rem;">🛡 Verify</button></td>
      `;

      const verifyBtn = tr.querySelector('.btn-audit-row');
      verifyBtn.addEventListener('click', () => {
        if (item.fairness) {
          populateVerifierInputs(item.fairness, true);
          switchChroniclesTab('tabFairness');
        }
      });

      el.personalLedgerBody.appendChild(tr);
    });
  }

  function renderWalletLedger() {
    if (!el.walletLedgerBody) return;
    const list = state.walletLedger || [];
    el.walletLedgerBody.innerHTML = '';
    if (list.length === 0) {
      el.walletLedgerBody.innerHTML = '<tr><td colspan="6" class="empty-ledger-cell">Chưa có biến động số dư nào.</td></tr>';
      return;
    }
    const TYPE_LABELS = {
      bet: 'Đặt cược',
      win: 'Trả thưởng',
      refund: 'Hoàn tiền',
      welcome_bonus: 'Ưu đãi Tân Thủ (+2M)',
      daily_bonus: 'Điểm danh 24h',
      bankruptcy_aid: 'Trợ cấp phá sản',
      admin_adjust: 'Điều chỉnh Admin'
    };
    list.forEach(entry => {
      const tr = document.createElement('tr');
      const timeStr = new Date(entry.timestamp).toLocaleTimeString('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const amt = Number(entry.amount || 0);
      const amtClass = amt > 0 ? 'profit-pos' : (amt === 0 ? 'profit-even' : 'profit-neg');
      const amtText = amt > 0 ? `+${formatVND(amt)} ₫` : (amt === 0 ? '±0 ₫' : `-${formatVND(Math.abs(amt))} ₫`);
      const typeLabel = Object.hasOwn(TYPE_LABELS, entry.type) ? TYPE_LABELS[entry.type] : String(entry.type ?? '');
      tr.innerHTML = `
        <td>${escapeHtml(timeStr)}</td>
        <td>${escapeHtml(typeLabel)}</td>
        <td>${escapeHtml(formatVND(entry.balanceBefore))} ₫</td>
        <td class="${amtClass}">${escapeHtml(amtText)}</td>
        <td>${escapeHtml(formatVND(entry.balanceAfter))} ₫</td>
        <td>${escapeHtml(entry.reason || '')}</td>
      `;
      el.walletLedgerBody.appendChild(tr);
    });
  }

  // ==================== 12. PROVABLY FAIR VERIFIER & ROTATE CLIENT SEED ====================
  function populateVerifierInputs(proof, autoRun = false) {
    if (!proof) return;
    if (el.verifyServerSeed) el.verifyServerSeed.value = proof.serverSeed || '';
    if (el.verifyExpectedHash) el.verifyExpectedHash.value = proof.serverSeedHash || '';
    if (el.verifyClientSeed) el.verifyClientSeed.value = proof.clientSeed || 'sovereign-vip-888';
    if (el.verifyNonce) el.verifyNonce.value = proof.nonce ?? 1;

    if (autoRun && proof.serverSeed) {
      runFairnessVerification();
    }
  }

  if (el.btnCopyNextHash) {
    el.btnCopyNextHash.addEventListener('click', async () => {
      const val = el.inputNextHash ? el.inputNextHash.value : '';
      if (!val) return;
      try {
        await navigator.clipboard.writeText(val);
        el.btnCopyNextHash.textContent = 'Copied ✓';
        setTimeout(() => { el.btnCopyNextHash.textContent = 'Copy'; }, 1500);
      } catch (_) {
        if (el.inputNextHash) el.inputNextHash.select();
      }
    });
  }

  if (el.btnRotateClientSeed) {
    el.btnRotateClientSeed.addEventListener('click', () => withInFlightGuard('rotateClientSeed', el.btnRotateClientSeed, async () => {
      sound.playTick();
      const newClientSeed = (el.inputClientSeed?.value || '').trim() || `vip-${randomHex(8)}`;
      if (!requireAuthenticatedSession('Đăng nhập để lưu Client Seed cá nhân trên máy chủ!')) {
        return;
      }
      try {
        const { res, json } = await apiFetch('/api/fairness/rotate', {
          method: 'POST',
          body: JSON.stringify({ clientSeed: newClientSeed })
        });
        if (!res.ok || !json) {
          showToast((json && json.error) || 'Không thể xoay Client Seed.', 'error');
          return;
        }
        if (json.current) {
          state.provablyFair.nextServerSeedHash = json.current.serverSeedHash;
          state.provablyFair.clientSeed = json.current.clientSeed;
          state.provablyFair.nextNonce = json.current.nonce ?? 0;
          updateFairnessCommitUI();
        }
        if (json.previous && json.previous.serverSeed) {
          if (el.rotatedSeedRevealBox) {
            el.rotatedSeedRevealBox.classList.remove('hidden');
            el.rotatedSeedRevealBox.innerHTML =
              `<strong>✓ Đã mở khóa Server Seed cũ để kiểm chứng:</strong>` +
              `<div>Server Seed: <code>${escapeHtml(json.previous.serverSeed)}</code></div>` +
              `<div>SHA-256 Hash: <code>${escapeHtml(json.previous.serverSeedHash || '')}</code></div>` +
              `<div>Client Seed: <code>${escapeHtml(json.previous.clientSeed || '')}</code> • Nonce cuối: <code>${Number(json.previous.finalNonce ?? 0)}</code></div>`;
          }
          populateVerifierInputs({
            serverSeed: json.previous.serverSeed,
            serverSeedHash: json.previous.serverSeedHash,
            clientSeed: json.previous.clientSeed,
            nonce: json.previous.finalNonce ?? 0
          }, true);
        }
        showToast('Đã đổi Client Seed & mở khóa Server Seed cũ!', 'success');
      } catch (_) {
        showToast('Lỗi kết nối khi xoay Client Seed.', 'error');
      }
    }));
  }

  async function runFairnessVerification() {
    if (!el.verifyResultBox) return;
    const serverSeed = (el.verifyServerSeed?.value || '').trim();
    const expectedHash = (el.verifyExpectedHash?.value || '').trim().toLowerCase();
    const clientSeed = (el.verifyClientSeed?.value || '').trim() || 'sovereign-vip-888';
    const rawNonce = el.verifyNonce ? String(el.verifyNonce.value ?? '') : '1';

    if (!serverSeed) {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Vui lòng hoàn tất ít nhất 1 phiên mở bát hoặc nhập Server Seed để kiểm chứng.';
      return;
    }
    if (rawNonce.trim() === '') {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Vui lòng nhập Nonce (số nguyên không âm, ví dụ 0 hoặc 1).';
      return;
    }

    try {
      const localHash = await browserSha256Hex(serverSeed);
      const localFair = await deriveFairDice(serverSeed, clientSeed, rawNonce);
      const nonce = localFair.nonce;
      let data = {
        computedServerSeedHash: localHash,
        hmacHex: localFair.hmacHex,
        dice: localFair.dice,
        total: localFair.dice[0] + localFair.dice[1] + localFair.dice[2],
        outcome: (localFair.dice[0] === localFair.dice[1] && localFair.dice[1] === localFair.dice[2])
          ? 'TRIPLE'
          : ((localFair.dice[0] + localFair.dice[1] + localFair.dice[2]) >= 11 ? 'TAI' : 'XIU')
      };

      try {
        const { res, json } = await apiFetch('/api/verify-fairness', {
          method: 'POST',
          body: JSON.stringify({ serverSeed, clientSeed, nonce, expectedHash }),
          skipAuthReset: true
        });
        if (res.ok && json && Array.isArray(json.dice)) {
          data = {
            ...data,
            ...json,
            computedServerSeedHash: localHash
          };
        }
      } catch (_) {}

      const computedHash = localHash || data.computedServerSeedHash || '';
      const hashMatched = !expectedHash || (computedHash === expectedHash);
      const outcomeVN = data.outcome === 'TRIPLE' ? 'BÃO' : (data.outcome === 'TAI' ? 'TÀI' : 'XỈU');
      const diceIcons = (data.dice || []).map(d => DICE_SYMBOLS[Number(d)] || '').join(' ');

      if (hashMatched && Array.isArray(data.dice)) {
        el.verifyResultBox.className = 'verify-result-box verified-ok';
        el.verifyResultBox.innerHTML =
          `<strong>✓ XÁC THỰC HMAC-SHA256 &amp; KẾT QUẢ XÚC XẮC HỢP LỆ 100%</strong><br>` +
          `• SHA-256(ServerSeed): ${escapeHtml(computedHash)}<br>` +
          `• Đối chiếu Pre-Commit: ${expectedHash ? 'TRÙNG KHỚP TUYỆT ĐỐI ✓' : 'Hợp lệ'}<br>` +
          `• HMAC Phiên (${escapeHtml(clientSeed)}:${Number(nonce)}): ${escapeHtml((data.hmacHex || '').slice(0, 32))}...<br>` +
          `• Kết quả Xúc xắc: ${escapeHtml(diceIcons)} [${escapeHtml(data.dice.map(Number).join(' - '))}] = <strong>${Number(data.total)} điểm (${escapeHtml(outcomeVN)})</strong>`;
      } else {
        el.verifyResultBox.className = 'verify-result-box';
        el.verifyResultBox.innerHTML =
          `<strong style="color:#ff7b8e;">✕ MÃ HASH KHÔNG KHỚP VỚI SERVER SEED</strong><br>` +
          `• SHA-256 tính được: ${escapeHtml(computedHash)}<br>` +
          `• Hash kỳ vọng: ${escapeHtml(expectedHash)}`;
      }
    } catch (err) {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Lỗi kiểm chứng: ' + (err && err.message ? err.message : String(err));
    }
  }

  if (el.btnRunVerify) {
    el.btnRunVerify.addEventListener('click', () => {
      sound.playTick();
      runFairnessVerification();
    });
  }

  window.__sicboDeriveFairDice = deriveFairDice;

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateLiveTimerUI();
      syncLiveStateFromServer(false);
      fetchServerState();
    }
  });

  initLiveRoomUI();
  fetchServerState();
});
