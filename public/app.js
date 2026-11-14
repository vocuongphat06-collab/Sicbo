// app.js - SOVEREIGN Private 3D Sicbo Salon Master Controller (AAA Showcase)
document.addEventListener('DOMContentLoaded', () => {
  // Automatically connect to Express server on :3000 if opened via local Live Server (e.g. :5500), otherwise use same-origin
  const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const API_BASE = (isLocalHost && window.location.port && window.location.port !== '3000')
    ? 'http://localhost:3000'
    : '';

  // Generate 36 realistic Macau rounds synchronously so Roadmap & Big Road are NEVER empty
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
      return {
        id: 1001 + idx,
        dice: d,
        total,
        outcome,
        isTriple
      };
    });
  }

  function randomHex(len = 64) {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  const state = {
    balance: 10000000,
    selectedChip: 10000,
    currentBets: {},
    lastBets: {},
    mode: 'manual', // 'manual' | 'live'
    cardRoadView: 'bead', // 'bead' | 'bigroad'
    liveDurationSec: 15,
    liveRemainingMs: 15000,
    liveLastSecTick: 15,
    liveIntervalId: null,
    squeezeAutoOpenTimer: null,
    isRolling: false,
    isSqueezeActive: false,
    pendingResult: null,
    history: createInitialHistory(),
    personalHistory: [],
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
    btnTopup: document.getElementById('btnTopup'),
    btnAudioToggle: document.getElementById('btnAudioToggle'),
    btnModeManual: document.getElementById('btnModeManual'),
    btnModeLive: document.getElementById('btnModeLive'),
    liveTimerBadge: document.getElementById('liveTimerBadge'),
    liveProgressTrack: document.getElementById('liveProgressTrack'),
    liveProgressFill: document.getElementById('liveProgressFill'),
    hudModeLabel: document.getElementById('hudModeLabel'),

    centerLiveBanner: document.getElementById('centerLiveBanner'),
    centerLiveText: document.getElementById('centerLiveText'),
    centerLiveSec: document.getElementById('centerLiveSec'),
    btnCenterRollNow: document.getElementById('btnCenterRollNow'),

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
    chkSqueeze: document.getElementById('chkSqueeze'),
    chipsSelector: document.getElementById('chipsSelector'),
    chipAllIn: document.getElementById('chipAllIn'),
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

    inputNextHash: document.getElementById('inputNextHash'),
    btnCopyNextHash: document.getElementById('btnCopyNextHash'),
    inputClientSeed: document.getElementById('inputClientSeed'),
    inputNextNonce: document.getElementById('inputNextNonce'),
    verifyServerSeed: document.getElementById('verifyServerSeed'),
    verifyExpectedHash: document.getElementById('verifyExpectedHash'),
    verifyClientSeed: document.getElementById('verifyClientSeed'),
    verifyNonce: document.getElementById('verifyNonce'),
    btnRunVerify: document.getElementById('btnRunVerify'),
    verifyResultBox: document.getElementById('verifyResultBox')
  };

  const DICE_SYMBOLS = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

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
    triple_1: 180,
    triple_2: 180,
    triple_3: 180,
    triple_4: 180,
    triple_5: 180,
    triple_6: 180,
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

  function formatBetName(key) {
    if (BET_LABELS[key]) return BET_LABELS[key];
    if (key.startsWith('triple_')) return `Bão ${key.replace('triple_', '')}`;
    if (key.startsWith('total_')) return `Tổng ${key.replace('total_', '')}`;
    if (key.startsWith('single_')) return `Đơn ${key.replace('single_', '')}`;
    return key;
  }

  // ==================== 1. CUSTOM DOUBLE-RING CURSOR ====================
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let ringX = mouseX;
  let ringY = mouseY;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (el.cursorDot) {
      el.cursorDot.style.left = `${mouseX}px`;
      el.cursorDot.style.top = `${mouseY}px`;
    }
  });

  function renderCursor() {
    ringX += (mouseX - ringX) * 0.22;
    ringY += (mouseY - ringY) * 0.22;
    if (el.cursorRing) {
      el.cursorRing.style.left = `${ringX}px`;
      el.cursorRing.style.top = `${ringY}px`;
    }
    requestAnimationFrame(renderCursor);
  }
  requestAnimationFrame(renderCursor);

  function bindHoverTargets() {
    document.querySelectorAll('button, .bet-spot, .zen-chip, a, label, .alabaster-card, .fairness-commit-bar').forEach(target => {
      target.addEventListener('mouseenter', () => el.cursorRing && el.cursorRing.classList.add('active-hover'));
      target.addEventListener('mouseleave', () => el.cursorRing && el.cursorRing.classList.remove('active-hover'));
    });
  }
  bindHoverTargets();

  // ==================== 2. ON-CARD ROADMAP SWITCHER & DRAWERS ====================
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

  if (el.chkSqueeze) {
    el.chkSqueeze.addEventListener('change', () => {
      sound.playTick();
      engine.setBowlOpaqueForSqueeze(el.chkSqueeze.checked);
      showStatus(
        el.chkSqueeze.checked
          ? 'Đã BẬT Nặn Bát 3D: Sau khi lắc, hãy kéo trượt ngang chiếc bát 3D để tự mở!'
          : 'Đã TẮT Nặn Bát 3D: Bát pha lê trong suốt giúp nhìn rõ xúc xắc nảy và tự động mở bát.'
      );
    });
  }

  function toggleMatrixDrawer(open) {
    sound.playTick();
    if (open) {
      el.chroniclesModal.classList.remove('open');
      el.fullMatrixModal.classList.add('open');
    } else {
      el.fullMatrixModal.classList.remove('open');
    }
  }

  function openChroniclesDrawer(tabId = 'tabBigRoad') {
    sound.playTick();
    el.fullMatrixModal.classList.remove('open');
    el.chroniclesModal.classList.add('open');
    switchChroniclesTab(tabId);
  }

  function closeChroniclesDrawer() {
    sound.playTick();
    el.chroniclesModal.classList.remove('open');
  }

  function switchChroniclesTab(tabId) {
    document.querySelectorAll('.chron-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.chron-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === tabId);
    });
  }

  el.btnOpenDrawer.addEventListener('click', () => toggleMatrixDrawer(true));
  el.btnExpandMatrix.addEventListener('click', () => toggleMatrixDrawer(true));
  el.btnCloseDrawer.addEventListener('click', () => toggleMatrixDrawer(false));
  el.fullMatrixModal.addEventListener('click', (e) => {
    if (e.target === el.fullMatrixModal) toggleMatrixDrawer(false);
  });

  el.btnOpenChronicles.addEventListener('click', () => openChroniclesDrawer('tabBigRoad'));
  el.btnCardOpenBigRoad.addEventListener('click', () => openChroniclesDrawer('tabBigRoad'));
  el.fairnessCommitBar.addEventListener('click', () => openChroniclesDrawer('tabFairness'));
  el.btnTelemetryFair.addEventListener('click', () => openChroniclesDrawer('tabFairness'));
  el.btnCloseChronicles.addEventListener('click', closeChroniclesDrawer);
  el.chroniclesModal.addEventListener('click', (e) => {
    if (e.target === el.chroniclesModal) closeChroniclesDrawer();
  });

  document.querySelectorAll('.chron-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      sound.playTick();
      switchChroniclesTab(tabBtn.getAttribute('data-tab'));
    });
  });

  // ==================== 3. DUAL GAMEPLAY MODE (MANUAL VS LIVE 15S) ====================
  function setGameMode(newMode) {
    sound.playTick();
    state.mode = newMode;

    el.btnModeManual.classList.toggle('active', newMode === 'manual');
    el.btnModeLive.classList.toggle('active', newMode === 'live');
    el.liveProgressTrack.classList.toggle('active', newMode === 'live');
    if (el.centerLiveBanner) {
      el.centerLiveBanner.classList.toggle('active', newMode === 'live');
    }
    el.hudModeLabel.textContent = newMode === 'live' ? 'LIVE 15S • VIP 08' : 'MANUAL • VIP 08';

    if (newMode === 'live') {
      resetLiveCountdown();
      startLiveLoop();
      showStatus('⚡ Phòng Live 15s đang chạy! Hệ thống sẽ tự động lắc và mở bát sau mỗi 15 giây.');
    } else {
      stopLiveLoop();
      el.liveTimerBadge.textContent = '15s';
      el.liveTimerBadge.classList.remove('urgent');
      el.btnRollLabel.textContent = 'Lắc Xúc Xắc';
      showStatus('Chế độ Tự Tay Lắc: Đặt phỉnh (hoặc lắc thử miễn phí) bằng nút Lắc Xúc Xắc.');
    }
  }

  el.btnModeManual.addEventListener('click', () => setGameMode('manual'));
  el.btnModeLive.addEventListener('click', () => setGameMode('live'));
  if (el.btnCenterRollNow) {
    el.btnCenterRollNow.addEventListener('click', () => startRoll('live'));
  }

  function resetLiveCountdown() {
    state.liveRemainingMs = state.liveDurationSec * 1000;
    state.liveLastSecTick = state.liveDurationSec;
    updateLiveTimerUI();
  }

  function updateLiveTimerUI() {
    const sec = Math.max(0, Math.ceil(state.liveRemainingMs / 1000));
    const pct = Math.max(0, Math.min(100, (state.liveRemainingMs / (state.liveDurationSec * 1000)) * 100));
    el.liveTimerBadge.textContent = `${sec}s`;
    el.liveTimerBadge.classList.toggle('urgent', sec <= 3 && sec > 0);
    el.liveProgressFill.style.width = `${pct}%`;

    if (el.centerLiveText) {
      if (state.isRolling) {
        el.centerLiveText.innerHTML = `⚡ PHÒNG LIVE • <strong>ĐANG LẮC XÚC XẮC 3D...</strong>`;
      } else if (state.isSqueezeActive) {
        el.centerLiveText.innerHTML = `⚡ PHÒNG LIVE • <strong>ĐANG MỞ BÁT...</strong>`;
      } else {
        el.centerLiveText.innerHTML = `PHÒNG LIVE TỰ ĐỘNG • TỰ LẮC SAU <strong id="centerLiveSec">${sec}s</strong>`;
      }
    }

    if (state.mode === 'live' && !state.isRolling && !state.isSqueezeActive) {
      el.btnRollLabel.textContent = `Tự Lắc (${sec}s)`;
    }
  }

  function startLiveLoop() {
    stopLiveLoop();
    let lastTs = performance.now();
    state.liveIntervalId = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(500, now - lastTs);
      lastTs = now;

      if (state.mode !== 'live') return;
      if (state.isRolling || state.isSqueezeActive) {
        updateLiveTimerUI();
        return;
      }

      state.liveRemainingMs = Math.max(0, state.liveRemainingMs - dt);
      const sec = Math.ceil(state.liveRemainingMs / 1000);

      if (sec < state.liveLastSecTick && sec > 0) {
        state.liveLastSecTick = sec;
        if (sec <= 5) {
          sound.playTimerTick(sec <= 3);
        }
      }

      updateLiveTimerUI();

      if (state.liveRemainingMs <= 0) {
        startRoll('live');
      }
    }, 100);
  }

  function stopLiveLoop() {
    if (state.liveIntervalId) {
      clearInterval(state.liveIntervalId);
      state.liveIntervalId = null;
    }
  }

  // ==================== 4. UI STATE, SERVER SYNC & LOCAL FALLBACK ====================
  function formatVND(num) {
    return Number(num || 0).toLocaleString('vi-VN');
  }

  function truncateHash(h) {
    if (!h || h.length < 20) return h || '---';
    return `${h.slice(0, 14)}...${h.slice(-10)}`;
  }

  function updateUI() {
    el.userBalance.textContent = formatVND(state.balance);
    const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
    el.currentWagerSummary.textContent = totalWager > 0 ? `${formatVND(totalWager)} ₫` : 'Lắc Thử';
  }

  function updateFairnessCommitUI() {
    const hash = state.provablyFair.nextServerSeedHash || '';
    const nonce = state.provablyFair.nextNonce || 1;
    el.nextHashPreview.textContent = truncateHash(hash);
    el.nextNoncePreview.textContent = `NONCE #${nonce}`;
    el.inputNextHash.value = hash;
    el.inputNextNonce.value = nonce;
  }

  async function browserSha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) return randomHex(64);
    const enc = new TextEncoder().encode(text);
    const buf = await window.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Render initial 36-round roadmap immediately so UI is populated before network response
  renderRoadmapAndBigRoad();
  updateUI();
  updateFairnessCommitUI();

  async function fetchServerState() {
    try {
      const res = await fetch(`${API_BASE}/api/state`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.user) {
        state.balance = data.user.balance;
        updateUI();
      }
      if (Array.isArray(data.history) && data.history.length > 0) {
        state.history = data.history;
        const latest = data.history[data.history.length - 1];
        el.roundCounterLabel.textContent = `MACAU VIP • #${latest.id}`;
        engine.setDiceFacesInstant(latest.dice);
        renderRoadmapAndBigRoad();
      }
      if (data.personalHistory) {
        state.personalHistory = data.personalHistory;
        renderPersonalLedger();
      }
      if (data.provablyFair) {
        state.provablyFair.nextServerSeedHash = data.provablyFair.nextServerSeedHash;
        state.provablyFair.nextNonce = data.provablyFair.nextNonce;
        updateFairnessCommitUI();

        if (data.provablyFair.lastRevealed) {
          populateVerifierInputs(data.provablyFair.lastRevealed, false);
        }
      }
    } catch (e) {
      // Offline / Live Server fallback: initialize real SHA-256 hash of localPendingServerSeed
      const hash = await browserSha256Hex(state.localPendingServerSeed);
      state.provablyFair.nextServerSeedHash = hash;
      updateFairnessCommitUI();
    }
  }

  // Full Client-Side Sicbo & Provably Fair Fallback when running on static Live Server without Node
  async function localRollFallback(bets, clientSeed) {
    const cleanBets = {};
    let totalBet = 0;
    for (const [k, v] of Object.entries(bets || {})) {
      const amt = Math.floor(Number(v) || 0);
      if (amt > 0) {
        cleanBets[k] = amt;
        totalBet += amt;
      }
    }

    const revealedSeed = state.localPendingServerSeed;
    const revealedHash = state.provablyFair.nextServerSeedHash || (await browserSha256Hex(revealedSeed));
    const nonce = state.provablyFair.nextNonce || 1;
    const hmacHex = await browserSha256Hex(`${revealedSeed}:${clientSeed}:${nonce}`);

    const d1 = (parseInt(hmacHex.slice(0, 8), 16) % 6) + 1;
    const d2 = (parseInt(hmacHex.slice(8, 16), 16) % 6) + 1;
    const d3 = (parseInt(hmacHex.slice(16, 24), 16) % 6) + 1;
    const dice = [d1, d2, d3];
    const total = d1 + d2 + d3;
    const isTriple = (d1 === d2 && d2 === d3);
    const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');
    const isEven = (total % 2 === 0);

    let totalPayout = 0;
    const winningSpots = [];

    for (const [betKey, betAmount] of Object.entries(cleanBets)) {
      let winMultiplier = 0;
      if (betKey === 'tai' && !isTriple && total >= 11 && total <= 17) winMultiplier = PAYOUT_RATES.tai;
      else if (betKey === 'xiu' && !isTriple && total >= 4 && total <= 10) winMultiplier = PAYOUT_RATES.xiu;
      else if (betKey === 'even' && !isTriple && isEven) winMultiplier = PAYOUT_RATES.even;
      else if (betKey === 'odd' && !isTriple && !isEven) winMultiplier = PAYOUT_RATES.odd;
      else if (betKey === 'triple_any' && isTriple) winMultiplier = PAYOUT_RATES.triple_any;
      else if (betKey.startsWith('triple_') && betKey !== 'triple_any') {
        const target = parseInt(betKey.split('_')[1], 10);
        if (isTriple && d1 === target) winMultiplier = PAYOUT_RATES[betKey];
      } else if (betKey.startsWith('total_')) {
        const targetSum = parseInt(betKey.split('_')[1], 10);
        if (total === targetSum && !isTriple) winMultiplier = PAYOUT_RATES[betKey] || 0;
      } else if (betKey.startsWith('single_')) {
        const targetFace = parseInt(betKey.split('_')[1], 10);
        const matchCount = dice.filter(x => x === targetFace).length;
        if (matchCount > 0) winMultiplier = matchCount;
      }

      if (winMultiplier > 0) {
        totalPayout += betAmount + (betAmount * winMultiplier);
        winningSpots.push(betKey);
      }
    }

    const newBalance = state.balance - totalBet + totalPayout;
    const netProfit = totalPayout - totalBet;
    const lastId = state.history.length > 0 ? state.history[state.history.length - 1].id : 1036;
    const roundId = lastId + 1;

    const revealedProof = {
      roundId,
      serverSeed: revealedSeed,
      serverSeedHash: revealedHash,
      clientSeed,
      nonce,
      hmacHex,
      dice,
      total,
      outcome
    };

    const nextHistory = [...state.history, { id: roundId, dice, total, outcome, isTriple }];
    if (nextHistory.length > 60) nextHistory.shift();

    const nextPersonal = [...state.personalHistory];
    if (totalBet > 0) {
      nextPersonal.unshift({
        roundId,
        timestamp: new Date().toISOString(),
        dice,
        total,
        outcome,
        bets: cleanBets,
        totalBet,
        totalPayout,
        netProfit,
        balanceAfter: newBalance,
        fairness: revealedProof
      });
    }

    // Rotate local seed for next round
    state.localPendingServerSeed = randomHex(64);
    const nextHash = await browserSha256Hex(state.localPendingServerSeed);
    const nextNonce = nonce + 1;

    return {
      success: true,
      spectator: totalBet === 0,
      roundId,
      dice,
      total,
      isTriple,
      outcome,
      totalBet,
      totalPayout,
      netProfit,
      winningSpots,
      newBalance,
      history: nextHistory,
      personalHistory: nextPersonal.slice(0, 30),
      fairness: {
        revealed: revealedProof,
        nextServerSeedHash: nextHash,
        nextNonce
      }
    };
  }

  // ==================== 5. CHIPS & BETTING ACTIONS ====================
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

  el.btnTopup.addEventListener('click', async (e) => {
    e.preventDefault();
    sound.playWin();
    try {
      const res = await fetch(`${API_BASE}/api/topup`, { method: 'POST' });
      if (!res.ok) throw new Error('Topup offline');
      const data = await res.json();
      if (data.success) {
        state.balance = data.balance;
        if (el.chipAllIn.classList.contains('active')) {
          state.selectedChip = state.balance;
        }
        updateUI();
        showStatus('Quỹ VIP đã nạp thêm +5,000,000 ₫.');
      }
    } catch (err) {
      state.balance += 5000000;
      if (el.chipAllIn.classList.contains('active')) {
        state.selectedChip = state.balance;
      }
      updateUI();
      showStatus('+5,000,000 ₫ đã nạp vào quỹ.');
    }
  });

  el.btnAudioToggle.addEventListener('click', () => {
    sound.enabled = !sound.enabled;
    el.btnAudioToggle.style.opacity = sound.enabled ? '1' : '0.45';
    el.btnAudioToggle.querySelector('.audio-text').textContent = sound.enabled ? 'SOUND' : 'MUTED';
  });

  document.querySelectorAll('.bet-spot').forEach(spot => {
    spot.addEventListener('click', () => {
      if (state.isRolling || state.isSqueezeActive) return;

      const betKey = spot.getAttribute('data-bet');
      const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
      const chipVal = el.chipAllIn.classList.contains('active')
        ? Math.max(0, state.balance - totalWager)
        : state.selectedChip;

      if (chipVal <= 0 || totalWager + chipVal > state.balance) {
        showStatus('Số dư không đủ để đặt thêm phỉnh này. Nhấn +5M CHIP trên thanh công cụ!');
        sound.playTick();
        return;
      }

      sound.playChip();
      state.currentBets[betKey] = (state.currentBets[betKey] || 0) + chipVal;
      renderBetSpot(spot, betKey);
      updateUI();
    });
  });

  function renderBetSpot(spot, betKey) {
    const amount = state.currentBets[betKey] || 0;
    const wagerEl = spot.querySelector('.wager-chip-counter');
    const chipPileEl = spot.querySelector('.spot-chip-pile');

    if (amount > 0) {
      if (wagerEl) {
        wagerEl.textContent = formatVND(amount);
        wagerEl.classList.add('active');
      }
      if (chipPileEl) {
        chipPileEl.innerHTML = `
          <div style="
            width: 13px; height: 13px; border-radius: 50%;
            background: #f5f2eb; border: 2px solid #181518;
            box-shadow: 0 2px 6px rgba(0,0,0,0.5);
          "></div>
        `;
      }
    } else {
      if (wagerEl) {
        wagerEl.textContent = '';
        wagerEl.classList.remove('active');
      }
      if (chipPileEl) chipPileEl.innerHTML = '';
      spot.classList.remove('winner');
    }
  }

  el.btnClear.addEventListener('click', () => {
    if (state.isRolling || state.isSqueezeActive) return;
    sound.playTick();
    state.currentBets = {};
    document.querySelectorAll('.bet-spot').forEach(spot => {
      renderBetSpot(spot, spot.getAttribute('data-bet'));
    });
    updateUI();
    showStatus('Đã thu hồi toàn bộ phỉnh cược trên bàn.');
  });

  el.btnDouble.addEventListener('click', () => {
    if (state.isRolling || state.isSqueezeActive) return;
    const currentTotal = Object.values(state.currentBets).reduce((a, b) => a + b, 0);
    if (currentTotal <= 0) return;

    if (currentTotal * 2 > state.balance) {
      showStatus('Số dư không đủ để nhân đôi cược.');
      return;
    }

    sound.playChip();
    for (const k in state.currentBets) state.currentBets[k] *= 2;
    document.querySelectorAll('.bet-spot').forEach(spot => {
      renderBetSpot(spot, spot.getAttribute('data-bet'));
    });
    updateUI();
    showStatus('Đã nhân đôi (x2) toàn bộ phỉnh cược.');
  });

  el.btnRebet.addEventListener('click', () => {
    if (state.isRolling || state.isSqueezeActive) return;
    const lastTotal = Object.values(state.lastBets).reduce((a, b) => a + b, 0);
    if (lastTotal <= 0) {
      showStatus('Chưa có lịch sử cược phiên trước.');
      return;
    }
    if (lastTotal > state.balance) {
      showStatus('Số dư không đủ để đặt lại cược cũ.');
      return;
    }

    sound.playChip();
    state.currentBets = { ...state.lastBets };
    document.querySelectorAll('.bet-spot').forEach(spot => {
      renderBetSpot(spot, spot.getAttribute('data-bet'));
    });
    updateUI();
    showStatus('Đã đặt lại phỉnh phiên trước.');
  });

  // ==================== 6. ROLL, PHYSICS BOUNCE & 3D SQUEEZE FLOW ====================
  el.btnRoll.addEventListener('click', () => startRoll(state.mode));
  el.btnQuickTopRoll.addEventListener('click', () => startRoll(state.mode));
  el.btnCardRollTrigger.addEventListener('click', () => startRoll(state.mode));

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.isSqueezeActive) {
        clearSqueezeAutoTimer();
        engine.openBowlQuick(() => finishReveal());
      } else if (!state.isRolling) {
        startRoll(state.mode);
      }
    }
    if (e.code === 'Escape') {
      toggleMatrixDrawer(false);
      closeChroniclesDrawer();
    }
  });

  async function startRoll(triggerMode = 'manual') {
    if (state.isRolling || state.isSqueezeActive) return;

    const totalWager = Object.values(state.currentBets).reduce((a, b) => a + b, 0);

    if (window.triggerLiquidRollPulse) {
      window.triggerLiquidRollPulse();
    }

    toggleMatrixDrawer(false);
    closeChroniclesDrawer();

    state.isRolling = true;
    el.btnRoll.disabled = true;
    el.btnRollLabel.textContent = 'Đang Lắc 3D...';
    updateLiveTimerUI();
    document.querySelectorAll('.bet-spot').forEach(s => s.classList.remove('winner'));

    const clientSeed = (el.inputClientSeed.value || 'sovereign-vip-888').trim() || 'sovereign-vip-888';
    showStatus(
      totalWager > 0
        ? `Đang lắc 3 viên xúc xắc ngà voi (Tổng cược: ${formatVND(totalWager)} ₫)...`
        : 'Đang lắc xúc xắc 3D (Phiên lắc thử / Quan sát cầu)...'
    );

    let data = null;
    try {
      const res = await fetch(`${API_BASE}/api/roll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bets: state.currentBets,
          clientSeed,
          mode: triggerMode
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Roll failed');
      data = json;
    } catch (err) {
      // Fallback to 100% deterministic client-side roll if Live Server / Offline
      data = await localRollFallback(state.currentBets, clientSeed);
    }

    state.pendingResult = data;
    if (totalWager > 0) {
      state.lastBets = { ...state.currentBets };
    }

    const useSqueeze = Boolean(el.chkSqueeze && el.chkSqueeze.checked) && state.mode !== 'live';

    engine.shakeAndRoll(
      data.dice,
      () => sound.playDiceShake(),
      () => onShakeComplete(useSqueeze),
      (intensity) => sound.playDiceBounce(intensity),
      useSqueeze
    );
  }

  function clearSqueezeAutoTimer() {
    if (state.squeezeAutoOpenTimer) {
      clearTimeout(state.squeezeAutoOpenTimer);
      state.squeezeAutoOpenTimer = null;
    }
  }

  function onShakeComplete(useSqueeze) {
    if (useSqueeze) {
      state.isSqueezeActive = true;
      el.squeezePctLabel.textContent = '0%';
      el.squeezePrompt.classList.add('active');
      el.btnRollLabel.textContent = 'Kéo Bát Để Mở...';
      updateLiveTimerUI();
      showStatus('Xúc xắc đã dừng! Nhấp giữ & kéo trượt ngang chiếc bát 3D để nặn hoặc nhấn Space.');

      engine.callbacks.onSqueezeProgress = (progress) => {
        const pct = Math.round(progress * 100);
        el.squeezePctLabel.textContent = `${pct}%`;
        sound.playSqueezeTension(progress);
      };

      engine.callbacks.onBowlOpened = () => {
        clearSqueezeAutoTimer();
        finishReveal();
      };

      clearSqueezeAutoTimer();
      state.squeezeAutoOpenTimer = setTimeout(() => {
        if (state.isSqueezeActive) {
          engine.openBowlQuick(() => finishReveal());
        }
      }, 8000);
    } else {
      // Default & Live 15s: automatically lift the crystal dome and reveal the dice!
      engine.openBowlQuick(() => finishReveal());
    }
  }

  el.btnQuickOpen.addEventListener('click', () => {
    if (state.isSqueezeActive) {
      clearSqueezeAutoTimer();
      engine.openBowlQuick(() => finishReveal());
    }
  });

  function finishReveal() {
    clearSqueezeAutoTimer();
    state.isSqueezeActive = false;
    el.squeezePrompt.classList.remove('active');
    engine.callbacks.onSqueezeProgress = null;

    const res = state.pendingResult;
    if (!res) {
      state.isRolling = false;
      el.btnRoll.disabled = false;
      return;
    }
    state.pendingResult = null;

    state.balance = res.newBalance;
    if (Array.isArray(res.history) && res.history.length > 0) {
      state.history = res.history;
    }
    if (res.personalHistory) {
      state.personalHistory = res.personalHistory;
      renderPersonalLedger();
    }

    if (res.fairness) {
      state.provablyFair.nextServerSeedHash = res.fairness.nextServerSeedHash;
      state.provablyFair.nextNonce = res.fairness.nextNonce;
      state.provablyFair.lastRevealed = res.fairness.revealed;
      updateFairnessCommitUI();

      if (res.fairness.revealed) {
        populateVerifierInputs(res.fairness.revealed, true);
      }
    }

    updateUI();
    renderRoadmapAndBigRoad();

    const outcomeLabel = res.outcome === 'TRIPLE' ? 'BÃO' : (res.outcome === 'TAI' ? 'TÀI' : 'XỈU');
    el.resBadgeOutcome.textContent = `${outcomeLabel} • ${res.total}`;
    el.resBadgeOutcome.className = `outcome-pill ${res.outcome.toLowerCase()}`;
    el.resBadgeTotal.textContent = res.dice.join('-');
    if (el.roundCounterLabel) {
      el.roundCounterLabel.textContent = `MACAU VIP • #${res.roundId}`;
    }

    el.resDiceStrip.innerHTML = res.dice.map(d => `<span>${DICE_SYMBOLS[d]}</span>`).join(' ');

    if (res.spectator) {
      el.resWinText.textContent = `Kết quả: ${outcomeLabel} ${res.total} điểm`;
      el.resWinText.style.color = '#191718';
      sound.playWin();
    } else if (res.netProfit > 0) {
      el.resWinText.textContent = `+${formatVND(res.netProfit)} ₫`;
      el.resWinText.style.color = '#1d6e50';

      if (res.netProfit >= 5000000 || res.isTriple) {
        sound.playBigWin();
        confetti({ particleCount: 95, spread: 80, origin: { y: 0.55 } });
      } else {
        sound.playWin();
        confetti({ particleCount: 45, spread: 60, origin: { y: 0.6 } });
      }
    } else {
      el.resWinText.textContent = `-${formatVND(res.totalBet)} ₫`;
      el.resWinText.style.color = '#b82e43';
      sound.playTick();
    }

    gsap.fromTo(el.resultBanner, { scale: 0.94 }, { scale: 1, duration: 0.38, ease: 'back.out(1.6)' });

    highlightWinners(res);

    state.currentBets = {};
    document.querySelectorAll('.bet-spot').forEach(spot => {
      renderBetSpot(spot, spot.getAttribute('data-bet'));
    });
    updateUI();

    state.isRolling = false;
    el.btnRoll.disabled = false;

    if (state.mode === 'live') {
      resetLiveCountdown();
    } else {
      el.btnRollLabel.textContent = 'Lắc Xúc Xắc';
    }

    showStatus(`Phiên #${res.roundId}: [${res.dice.join('-')}] = ${res.total} điểm (${outcomeLabel})`);
  }

  function highlightWinners(res) {
    const d = res.dice;
    const total = res.total;
    const isTriple = res.isTriple;
    const isEven = (total % 2 === 0);

    const winningKeys = [];
    if (!isTriple && total >= 11) winningKeys.push('tai');
    if (!isTriple && total <= 10) winningKeys.push('xiu');
    if (!isTriple && isEven) winningKeys.push('even');
    if (!isTriple && !isEven) winningKeys.push('odd');

    if (isTriple) {
      winningKeys.push('triple_any');
      winningKeys.push(`triple_${d[0]}`);
    }
    if (!isTriple) winningKeys.push(`total_${total}`);

    [1, 2, 3, 4, 5, 6].forEach(val => {
      if (d.includes(val)) winningKeys.push(`single_${val}`);
    });

    winningKeys.forEach(k => {
      const spot = document.querySelector(`.bet-spot[data-bet="${k}"]`);
      if (spot) spot.classList.add('winner');
    });
  }

  // ==================== 7. BEAD ROAD & MACAU 6-ROW BIG ROAD (CẦU DÂY) ====================
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
      dot.className = `road-dot ${item.outcome.toLowerCase()}`;
      dot.textContent = item.outcome === 'TRIPLE' ? 'B' : item.total;
      dot.title = `Phiên #${item.id}: [${item.dice.join('-')}] = ${item.total} (${item.outcome})`;
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

    // Full 60-round Bead Grid inside Chronicles Drawer
    if (el.fullBeadGrid) {
      el.fullBeadGrid.innerHTML = '';
      state.history.slice(-60).forEach(item => {
        const dot = document.createElement('div');
        dot.className = `road-dot ${item.outcome.toLowerCase()}`;
        dot.style.width = '22px';
        dot.style.height = '22px';
        dot.style.fontSize = '0.6rem';
        dot.textContent = item.outcome === 'TRIPLE' ? 'B' : item.total;
        dot.title = `#${item.id}: [${item.dice.join('-')}] = ${item.total}`;
        el.fullBeadGrid.appendChild(dot);
      });
    }

    // Render BOTH the On-Card Compact Big Road AND the Full Modal Big Road
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
          grid['0,0'] = {
            outcome: 'TRIPLE',
            total: item.total,
            id: item.id,
            dice: item.dice,
            triples: 1
          };
        }
        return;
      }

      const side = item.outcome;
      if (side !== lastSide) {
        streakStartCol = streakStartCol + 1;
        while (grid[`${streakStartCol},0`]) {
          streakStartCol++;
        }
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
      grid[`${curCol},${curRow}`] = {
        outcome: side,
        total: item.total,
        id: item.id,
        dice: item.dice,
        triples: 0
      };
    });

    return { grid, totalCols: Math.max(minCols, maxCol + 2), ROWS };
  }

  function renderMacauBigRoad(rounds) {
    const { grid, totalCols, ROWS } = buildBigRoadMatrix(rounds, 24);

    // 1. Render Full Modal Big Road
    if (el.bigRoadGrid) {
      el.bigRoadGrid.innerHTML = '';
      for (let c = 0; c < totalCols; c++) {
        for (let r = 0; r < ROWS; r++) {
          const cellDiv = document.createElement('div');
          cellDiv.className = 'bigroad-cell';
          const entry = grid[`${c},${r}`];
          if (entry) {
            const ring = document.createElement('div');
            ring.className = `bigroad-ring ${entry.outcome.toLowerCase()}`;
            ring.textContent = entry.outcome === 'TRIPLE' ? 'B' : entry.total;
            ring.title = `Phiên #${entry.id}: [${entry.dice.join('-')}] = ${entry.total}`;
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

    // 2. Render On-Card Compact Big Road (Card 2 on Right Wing)
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
            ring.className = `card-br-ring ${entry.outcome.toLowerCase()}`;
            ring.textContent = entry.outcome === 'TRIPLE' ? 'B' : entry.total;
            ring.title = `Phiên #${entry.id}: [${entry.dice.join('-')}] = ${entry.total}`;
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
    if (streakLen >= 4) {
      return `🔥 Cầu Bệt ${label}: ${streakLen} tay liên tiếp`;
    }

    let altCount = 1;
    for (let i = clean.length - 1; i > 0; i--) {
      if (clean[i].outcome !== clean[i - 1].outcome) altCount++;
      else break;
    }
    if (altCount >= 4) {
      return `⚡ Cầu Đảo 1-1 (${altCount} nhịp liên tiếp)`;
    }

    return `Xu hướng: ${label} (${streakLen} nhịp gần nhất)`;
  }

  // ==================== 8. PERSONAL BETTING LEDGER ====================
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
      el.personalLedgerBody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-ledger-cell">Chưa có phiên cược cá nhân nào. Hãy chọn phỉnh và đặt vào bàn!</td>
        </tr>
      `;
      return;
    }

    el.personalLedgerBody.innerHTML = '';
    list.forEach(item => {
      const tr = document.createElement('tr');
      const timeStr = new Date(item.timestamp).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const diceIcons = (item.dice || []).map(d => DICE_SYMBOLS[d]).join(' ');
      const outcomeVN = item.outcome === 'TRIPLE' ? 'BÃO' : (item.outcome === 'TAI' ? 'TÀI' : 'XỈU');
      const betsSummary = Object.entries(item.bets || {})
        .map(([k, v]) => `${formatBetName(k)} (${formatVND(v)})`)
        .join(', ');

      const profitClass = item.netProfit > 0 ? 'profit-pos' : 'profit-neg';
      const profitSign = item.netProfit > 0 ? '+' : '';

      tr.innerHTML = `
        <td>#${item.roundId}</td>
        <td>${timeStr}</td>
        <td>${diceIcons} <strong>(${item.total} • ${outcomeVN})</strong></td>
        <td>${betsSummary}</td>
        <td>${formatVND(item.totalBet)} ₫</td>
        <td class="${profitClass}">${profitSign}${formatVND(item.netProfit)} ₫</td>
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

  // ==================== 9. PROVABLY FAIR SHA-256 VERIFIER ====================
  function populateVerifierInputs(proof, autoRun = false) {
    if (!proof) return;
    el.verifyServerSeed.value = proof.serverSeed || '';
    el.verifyExpectedHash.value = proof.serverSeedHash || '';
    el.verifyClientSeed.value = proof.clientSeed || 'sovereign-vip-888';
    el.verifyNonce.value = proof.nonce || 1;

    if (autoRun && proof.serverSeed) {
      runFairnessVerification();
    }
  }

  el.btnCopyNextHash.addEventListener('click', async () => {
    const val = el.inputNextHash.value;
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      el.btnCopyNextHash.textContent = 'Copied ✓';
      setTimeout(() => { el.btnCopyNextHash.textContent = 'Copy'; }, 1500);
    } catch (e) {
      el.inputNextHash.select();
    }
  });

  async function runFairnessVerification() {
    const serverSeed = el.verifyServerSeed.value.trim();
    const expectedHash = el.verifyExpectedHash.value.trim().toLowerCase();
    const clientSeed = el.verifyClientSeed.value.trim() || 'sovereign-vip-888';
    const nonce = Number(el.verifyNonce.value || 1);

    if (!serverSeed) {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Vui lòng hoàn tất ít nhất 1 phiên mở bát hoặc nhập Server Seed để kiểm chứng.';
      return;
    }

    try {
      const localHash = await browserSha256Hex(serverSeed);
      let data = null;

      try {
        const res = await fetch(`${API_BASE}/api/verify-fairness`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverSeed, clientSeed, nonce, expectedHash })
        });
        if (res.ok) data = await res.json();
      } catch (_) {
        // Offline verification fallback
      }

      if (!data || !data.dice) {
        const hmacHex = await browserSha256Hex(`${serverSeed}:${clientSeed}:${nonce}`);
        const d1 = (parseInt(hmacHex.slice(0, 8), 16) % 6) + 1;
        const d2 = (parseInt(hmacHex.slice(8, 16), 16) % 6) + 1;
        const d3 = (parseInt(hmacHex.slice(16, 24), 16) % 6) + 1;
        const total = d1 + d2 + d3;
        const isTriple = (d1 === d2 && d2 === d3);
        data = {
          computedServerSeedHash: localHash,
          hmacHex,
          dice: [d1, d2, d3],
          total,
          outcome: isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU')
        };
      }

      const computedHash = localHash || data.computedServerSeedHash;
      const hashMatched = !expectedHash || (computedHash === expectedHash);
      const outcomeVN = data.outcome === 'TRIPLE' ? 'BÃO' : (data.outcome === 'TAI' ? 'TÀI' : 'XỈU');
      const diceIcons = (data.dice || []).map(d => DICE_SYMBOLS[d]).join(' ');

      if (hashMatched && data.dice) {
        el.verifyResultBox.className = 'verify-result-box verified-ok';
        el.verifyResultBox.innerHTML =
          `<strong>✓ XÁC THỰC SHA-256 &amp; KẾT QUẢ XÚC XẮC HỢP LỆ 100%</strong><br>` +
          `• SHA-256(ServerSeed): ${computedHash}<br>` +
          `• Đối chiếu Pre-Commit: ${expectedHash ? 'TRÙNG KHỚP TUYỆT ĐỐI ✓' : 'Hợp lệ'}<br>` +
          `• Hash Phiên (${clientSeed}:${nonce}): ${data.hmacHex.slice(0, 32)}...<br>` +
          `• Kết quả Xúc xắc: ${diceIcons} [${data.dice.join(' - ')}] = <strong>${data.total} điểm (${outcomeVN})</strong>`;
      } else {
        el.verifyResultBox.className = 'verify-result-box';
        el.verifyResultBox.innerHTML =
          `<strong style="color:#ff7b8e;">✕ MÃ HASH KHÔNG KHỚP VỚI SERVER SEED</strong><br>` +
          `• SHA-256 tính được: ${computedHash}<br>` +
          `• Hash kỳ vọng: ${expectedHash}`;
      }
    } catch (err) {
      el.verifyResultBox.className = 'verify-result-box';
      el.verifyResultBox.textContent = 'Lỗi kiểm chứng: ' + err.message;
    }
  }

  el.btnRunVerify.addEventListener('click', () => {
    sound.playTick();
    runFairnessVerification();
  });

  function showStatus(msg) {
    if (el.statusPill) el.statusPill.textContent = msg;
  }

  fetchServerState();
});
