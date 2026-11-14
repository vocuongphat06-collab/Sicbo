const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PERSONAL_FILE = path.join(DATA_DIR, 'personal_history.json');
const FAIRNESS_FILE = path.join(DATA_DIR, 'provably_fair.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==================== PROVABLY FAIR SHA-256 ENGINE ====================
function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function hmacSha256Buffer(serverSeed, message) {
  return crypto.createHmac('sha256', String(serverSeed)).update(String(message), 'utf8').digest();
}

/**
 * Deterministically derives 3 unbiased dice (1..6) from serverSeed, clientSeed, and nonce
 * using HMAC-SHA256 with rejection sampling (bytes < 252, since 252 = 42 * 6 -> zero modulo bias).
 */
function deriveFairDice(serverSeed, clientSeed, nonce) {
  const cleanClientSeed = String(clientSeed || 'sovereign-vip-888').trim() || 'sovereign-vip-888';
  const cleanNonce = Number.isFinite(Number(nonce)) ? Number(nonce) : 1;
  const dice = [];
  let attempt = 0;
  let primaryHmacHex = '';

  while (dice.length < 3) {
    const msg = attempt === 0
      ? `${cleanClientSeed}:${cleanNonce}`
      : `${cleanClientSeed}:${cleanNonce}:${attempt}`;
    const buf = hmacSha256Buffer(serverSeed, msg);
    if (attempt === 0) {
      primaryHmacHex = buf.toString('hex');
    }
    for (let i = 0; i < buf.length && dice.length < 3; i++) {
      const byte = buf[i];
      if (byte < 252) {
        dice.push((byte % 6) + 1);
      }
    }
    attempt++;
  }

  return {
    dice,
    clientSeed: cleanClientSeed,
    nonce: cleanNonce,
    hmacHex: primaryHmacHex
  };
}

function createFreshCommit(nonce = 1, lastRevealed = null) {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = sha256Hex(serverSeed);
  return {
    serverSeed,
    serverSeedHash,
    nonce,
    lastRevealed
  };
}

function loadFairnessState() {
  if (!fs.existsSync(FAIRNESS_FILE)) {
    const initial = createFreshCommit(1, null);
    fs.writeFileSync(FAIRNESS_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FAIRNESS_FILE, 'utf8'));
    if (!parsed.serverSeed || !parsed.serverSeedHash) {
      const fresh = createFreshCommit(1, null);
      fs.writeFileSync(FAIRNESS_FILE, JSON.stringify(fresh, null, 2), 'utf8');
      return fresh;
    }
    return parsed;
  } catch (e) {
    const fresh = createFreshCommit(1, null);
    fs.writeFileSync(FAIRNESS_FILE, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
}

function saveFairnessState(fairState) {
  fs.writeFileSync(FAIRNESS_FILE, JSON.stringify(fairState, null, 2), 'utf8');
}

// ==================== DATA PERSISTENCE HELPERS ====================
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const initial = {
      VIP_PLAYER: {
        username: 'VIP_PLAYER',
        name: 'Đại Gia Sài Gòn',
        balance: 10000000,
        totalBet: 0,
        totalWon: 0,
        rounds: 0,
        winRounds: 0
      }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    const seeded = [];
    for (let i = 0; i < 36; i++) {
      const d1 = crypto.randomInt(1, 7);
      const d2 = crypto.randomInt(1, 7);
      const d3 = crypto.randomInt(1, 7);
      const total = d1 + d2 + d3;
      const isTriple = (d1 === d2 && d2 === d3);
      const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');
      seeded.push({
        id: 1000 + i,
        dice: [d1, d2, d3],
        total,
        isTriple,
        outcome,
        timestamp: Date.now() - (36 - i) * 45000
      });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(seeded, null, 2), 'utf8');
    return seeded;
  }
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-120), null, 2), 'utf8');
}

function loadPersonalHistory() {
  if (!fs.existsSync(PERSONAL_FILE)) {
    fs.writeFileSync(PERSONAL_FILE, JSON.stringify([], null, 2), 'utf8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(PERSONAL_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function savePersonalHistory(records) {
  fs.writeFileSync(PERSONAL_FILE, JSON.stringify(records.slice(-60), null, 2), 'utf8');
}

const TOTAL_MULTIPLIERS = {
  4: 60, 5: 30, 6: 18, 7: 12, 8: 8, 9: 6,
  10: 6, 11: 6, 12: 6, 13: 8, 14: 12, 15: 18, 16: 30, 17: 60
};

// ==================== API ROUTES ====================

app.get('/api/state', (req, res) => {
  const users = loadUsers();
  const history = loadHistory();
  const personalHistory = loadPersonalHistory();
  const fairState = loadFairnessState();

  const user = users['VIP_PLAYER'] || {
    username: 'VIP_PLAYER',
    name: 'Đại Gia Sài Gòn',
    balance: 10000000
  };

  res.json({
    user,
    history: history.slice(-60),
    personalHistory: personalHistory.slice(-40).reverse(),
    provablyFair: {
      nextServerSeedHash: fairState.serverSeedHash,
      nextNonce: fairState.nonce,
      defaultClientSeed: 'sovereign-vip-888',
      lastRevealed: fairState.lastRevealed || null
    },
    serverTime: Date.now()
  });
});

app.post('/api/topup', (req, res) => {
  const users = loadUsers();
  const user = users['VIP_PLAYER'];
  user.balance += 5000000;
  saveUsers(users);
  res.json({ success: true, balance: user.balance });
});

app.post('/api/verify-fairness', (req, res) => {
  const { serverSeed, clientSeed, nonce, expectedHash } = req.body || {};
  if (!serverSeed) {
    return res.status(400).json({ valid: false, error: 'Thiếu Server Seed để kiểm chứng.' });
  }

  const computedHash = sha256Hex(serverSeed);
  const derived = deriveFairDice(serverSeed, clientSeed, nonce);
  const [d1, d2, d3] = derived.dice;
  const total = d1 + d2 + d3;
  const isTriple = (d1 === d2 && d2 === d3);
  const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');
  const hashMatches = expectedHash ? (computedHash === String(expectedHash).trim().toLowerCase()) : true;

  res.json({
    valid: hashMatches,
    hashMatches,
    computedServerSeedHash: computedHash,
    clientSeed: derived.clientSeed,
    nonce: derived.nonce,
    hmacHex: derived.hmacHex,
    dice: derived.dice,
    total,
    isTriple,
    outcome
  });
});

// Roll / Bet Resolution (Supports both Wagered Rolls and Free/Spectator Rolls!)
app.post('/api/roll', (req, res) => {
  const { bets = {}, clientSeed = 'sovereign-vip-888', mode = 'manual' } = req.body || {};
  const users = loadUsers();
  const user = users['VIP_PLAYER'];
  const fairState = loadFairnessState();

  let totalBet = 0;
  const cleanBets = {};
  for (const [key, amount] of Object.entries(bets)) {
    if (typeof amount === 'number' && amount > 0) {
      totalBet += amount;
      cleanBets[key] = amount;
    }
  }

  if (totalBet > 0 && user.balance < totalBet) {
    return res.status(400).json({ error: 'Số dư không đủ để đặt cược!' });
  }

  if (totalBet > 0) {
    user.balance -= totalBet;
    user.totalBet += totalBet;
    user.rounds += 1;
  }

  const activeServerSeed = fairState.serverSeed;
  const activeServerSeedHash = fairState.serverSeedHash;
  const activeNonce = fairState.nonce;

  const derived = deriveFairDice(activeServerSeed, clientSeed, activeNonce);
  const dice = derived.dice;
  const [d1, d2, d3] = dice;
  const total = d1 + d2 + d3;
  const isTriple = (d1 === d2 && d2 === d3);
  const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');
  const isEven = (total % 2 === 0);
  const isOdd = (total % 2 !== 0);

  let totalWin = 0;
  const winningDetails = [];

  for (const [betKey, amount] of Object.entries(cleanBets)) {
    let won = false;
    let multiplier = 0;

    if (betKey === 'tai' && total >= 11 && total <= 17 && !isTriple) {
      won = true;
      multiplier = 1;
    } else if (betKey === 'xiu' && total >= 4 && total <= 10 && !isTriple) {
      won = true;
      multiplier = 1;
    } else if (betKey === 'even' && isEven && !isTriple) {
      won = true;
      multiplier = 1;
    } else if (betKey === 'odd' && isOdd && !isTriple) {
      won = true;
      multiplier = 1;
    } else if (betKey === 'triple_any' && isTriple) {
      won = true;
      multiplier = 30;
    } else if (betKey.startsWith('triple_') && isTriple) {
      const targetVal = parseInt(betKey.replace('triple_', ''), 10);
      if (d1 === targetVal) {
        won = true;
        multiplier = 180;
      }
    } else if (betKey.startsWith('total_') && !isTriple) {
      const targetTotal = parseInt(betKey.replace('total_', ''), 10);
      if (total === targetTotal) {
        won = true;
        multiplier = TOTAL_MULTIPLIERS[targetTotal] || 6;
      }
    } else if (betKey.startsWith('single_')) {
      const targetVal = parseInt(betKey.replace('single_', ''), 10);
      const matchCount = dice.filter(d => d === targetVal).length;
      if (matchCount > 0) {
        won = true;
        multiplier = matchCount;
      }
    }

    if (won) {
      const winPayout = amount + (amount * multiplier);
      totalWin += winPayout;
      winningDetails.push({
        betKey,
        amount,
        profit: amount * multiplier,
        payout: winPayout
      });
    }
  }

  if (totalBet > 0) {
    user.balance += totalWin;
    if (totalWin > 0) {
      user.winRounds += 1;
      user.totalWon += (totalWin - totalBet > 0 ? totalWin - totalBet : 0);
    }
    saveUsers(users);
  }

  const history = loadHistory();
  const roundId = (history[history.length - 1]?.id || 1000) + 1;
  const nowTs = Date.now();

  const revealedProof = {
    roundId,
    serverSeed: activeServerSeed,
    serverSeedHash: activeServerSeedHash,
    clientSeed: derived.clientSeed,
    nonce: derived.nonce,
    hmacHex: derived.hmacHex,
    dice,
    total,
    outcome,
    timestamp: nowTs
  };

  const newRound = {
    id: roundId,
    dice,
    total,
    isTriple,
    outcome,
    serverSeedHash: activeServerSeedHash,
    nonce: derived.nonce,
    timestamp: nowTs
  };
  history.push(newRound);
  saveHistory(history);

  const nextFairState = createFreshCommit(activeNonce + 1, revealedProof);
  saveFairnessState(nextFairState);

  const personalHistory = loadPersonalHistory();
  if (totalBet > 0) {
    personalHistory.push({
      roundId,
      timestamp: nowTs,
      mode,
      bets: cleanBets,
      dice,
      total,
      outcome,
      totalBet,
      totalWin,
      netProfit: totalWin - totalBet,
      balanceAfter: user.balance,
      fairness: revealedProof
    });
    savePersonalHistory(personalHistory);
  }

  res.json({
    success: true,
    roundId,
    mode,
    spectator: totalBet === 0,
    dice,
    total,
    isTriple,
    outcome,
    totalBet,
    totalWin,
    netProfit: totalWin - totalBet,
    winningDetails,
    newBalance: user.balance,
    history: history.slice(-60),
    personalHistory: personalHistory.slice(-40).reverse(),
    fairness: {
      revealed: revealedProof,
      nextServerSeedHash: nextFairState.serverSeedHash,
      nextNonce: nextFairState.nonce
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🎲 SOVEREIGN • PRIVATE 3D SICBO SALON (AAA SHOWCASE)`);
  console.log(`🛡  Provably Fair SHA-256 Commit-Reveal Engine Active`);
  console.log(`🚀 Open browser at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
