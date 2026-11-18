'use strict';

const crypto = require('crypto');

const DEFAULT_CLIENT_SEED = 'sovereign-vip-888';
const MAX_SINGLE_BET = 1_000_000_000;
const LIVE_ROUND_MS = 20_000;
const LIVE_BET_MS = 15_000;
const LIVE_REVEAL_MS = 5_000;

const TOTAL_MULTIPLIERS = Object.freeze({
  4: 60,
  5: 30,
  6: 18,
  7: 12,
  8: 8,
  9: 6,
  10: 6,
  11: 6,
  12: 6,
  13: 8,
  14: 12,
  15: 18,
  16: 30,
  17: 60
});

const BET_KEYS_LIST = [
  'tai',
  'xiu',
  'even',
  'odd',
  'triple_any'
];

for (let i = 1; i <= 6; i++) {
  BET_KEYS_LIST.push(`triple_${i}`);
}
for (let i = 1; i <= 6; i++) {
  BET_KEYS_LIST.push(`double_${i}`);
}
for (let a = 1; a <= 6; a++) {
  for (let b = a + 1; b <= 6; b++) {
    BET_KEYS_LIST.push(`pair_${a}_${b}`);
  }
}
for (let t = 4; t <= 17; t++) {
  BET_KEYS_LIST.push(`total_${t}`);
}
for (let i = 1; i <= 6; i++) {
  BET_KEYS_LIST.push(`single_${i}`);
}

const ALLOWED_BET_KEYS = new Set(BET_KEYS_LIST);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateBets(bets) {
  if (!isPlainObject(bets)) {
    return {
      valid: false,
      cleanBets: {},
      totalBet: 0,
      error: 'Bets must be a plain object'
    };
  }

  if (Object.getOwnPropertySymbols(bets).length > 0) {
    return {
      valid: false,
      cleanBets: {},
      totalBet: 0,
      error: 'Bets object cannot contain symbol keys'
    };
  }

  const keys = Object.keys(bets);
  if (Object.getOwnPropertyNames(bets).length !== keys.length) {
    return {
      valid: false,
      cleanBets: {},
      totalBet: 0,
      error: 'Bets object cannot contain non-enumerable properties'
    };
  }

  if (keys.length === 0) {
    return {
      valid: false,
      cleanBets: {},
      totalBet: 0,
      error: 'Bets object cannot be empty'
    };
  }

  const cleanBets = {};
  let totalBet = 0;

  for (const key of keys) {
    if (!ALLOWED_BET_KEYS.has(key)) {
      return {
        valid: false,
        cleanBets: {},
        totalBet: 0,
        error: `Unknown bet key: ${key}`
      };
    }

    const amount = bets[key];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
      return {
        valid: false,
        cleanBets: {},
        totalBet: 0,
        error: `Bet amount for ${key} must be a safe integer`
      };
    }

    if (amount <= 0 || amount > MAX_SINGLE_BET) {
      return {
        valid: false,
        cleanBets: {},
        totalBet: 0,
        error: `Bet amount for ${key} must be between 1 and ${MAX_SINGLE_BET}`
      };
    }

    if (!Number.isSafeInteger(totalBet + amount)) {
      return {
        valid: false,
        cleanBets: {},
        totalBet: 0,
        error: 'Total bet exceeds safe integer limit'
      };
    }

    totalBet += amount;
    cleanBets[key] = amount;
  }

  return {
    valid: true,
    cleanBets,
    totalBet,
    error: null
  };
}

function getBetMultiplier(betKey, dice, total, isTriple, counts) {
  if (betKey === 'tai') {
    return (!isTriple && total >= 11 && total <= 17) ? 1 : 0;
  }
  if (betKey === 'xiu') {
    return (!isTriple && total >= 4 && total <= 10) ? 1 : 0;
  }
  if (betKey === 'even') {
    return (!isTriple && total % 2 === 0) ? 1 : 0;
  }
  if (betKey === 'odd') {
    return (!isTriple && total % 2 !== 0) ? 1 : 0;
  }
  if (betKey === 'triple_any') {
    return isTriple ? 30 : 0;
  }
  if (betKey.startsWith('triple_')) {
    const target = Number(betKey.slice(7));
    return (isTriple && dice[0] === target) ? 180 : 0;
  }
  if (betKey.startsWith('double_')) {
    const target = Number(betKey.slice(7));
    return counts[target] >= 2 ? 10 : 0;
  }
  if (betKey.startsWith('pair_')) {
    const parts = betKey.split('_');
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    return (counts[a] >= 1 && counts[b] >= 1) ? 5 : 0;
  }
  if (betKey.startsWith('total_')) {
    const targetTotal = Number(betKey.slice(6));
    return total === targetTotal ? (TOTAL_MULTIPLIERS[targetTotal] || 0) : 0;
  }
  if (betKey.startsWith('single_')) {
    const target = Number(betKey.slice(7));
    return counts[target] || 0;
  }
  return 0;
}

function evaluateRoll(dice, cleanBets) {
  if (!Array.isArray(dice) || dice.length !== 3) {
    throw new TypeError('dice must be an array of 3 integers between 1 and 6');
  }

  const d1 = dice[0];
  const d2 = dice[1];
  const d3 = dice[2];
  if (
    !Number.isInteger(d1) || d1 < 1 || d1 > 6 ||
    !Number.isInteger(d2) || d2 < 1 || d2 > 6 ||
    !Number.isInteger(d3) || d3 < 1 || d3 > 6
  ) {
    throw new TypeError('dice must be an array of 3 integers between 1 and 6');
  }
  const cleanDice = [d1, d2, d3];

  let betsToEval = {};
  if (cleanBets !== undefined) {
    if (!isPlainObject(cleanBets)) {
      throw new TypeError('cleanBets must be a plain object');
    }
    if (
      Object.getOwnPropertySymbols(cleanBets).length > 0 ||
      Object.getOwnPropertyNames(cleanBets).length !== Object.keys(cleanBets).length ||
      Object.keys(cleanBets).length > 0
    ) {
      const validation = validateBets(cleanBets);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      betsToEval = validation.cleanBets;
    }
  }

  const total = d1 + d2 + d3;
  const isTriple = (d1 === d2 && d2 === d3);
  const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');

  const counts = [0, 0, 0, 0, 0, 0, 0];
  counts[d1] += 1;
  counts[d2] += 1;
  counts[d3] += 1;

  let totalBet = 0;
  let totalWin = 0;
  const winningDetails = [];

  for (const [betKey, amount] of Object.entries(betsToEval)) {
    totalBet += amount;
    const multiplier = getBetMultiplier(betKey, cleanDice, total, isTriple, counts);
    if (multiplier > 0) {
      const profit = amount * multiplier;
      const payout = amount + profit;
      totalWin += payout;
      winningDetails.push({
        betKey,
        amount,
        multiplier,
        profit,
        payout
      });
    }
  }

  const netProfit = totalWin - totalBet;

  return {
    dice: cleanDice,
    total,
    isTriple,
    outcome,
    totalBet,
    totalWin,
    netProfit,
    winningDetails
  };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function hmacSha256Buffer(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message), 'utf8').digest();
}

function hmacSha256Hex(secret, message) {
  return hmacSha256Buffer(secret, message).toString('hex');
}

function assertNonEmptySecret(secret, label) {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function parseNonNegativeSafeInt(value, label, allowUndefinedDefaultZero = false) {
  if (value === undefined && allowUndefinedDefaultZero) {
    return 0;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'symbol' || typeof value === 'object') {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
    return parsed;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`);
    }
    return value === 0 ? 0 : value;
  }
  throw new TypeError(`${label} must be a non-negative safe integer`);
}

function deriveDiceWithHmac(hmacBufferFn, baseMessage) {
  if (typeof hmacBufferFn !== 'function') {
    throw new TypeError('hmacBufferFn must be a function');
  }
  if (typeof baseMessage !== 'string' || baseMessage.length === 0) {
    throw new TypeError('baseMessage must be a non-empty string');
  }

  const dice = [];
  let attempt = 0;
  let primaryHmacHex = '';

  while (dice.length < 3) {
    const msg = attempt === 0 ? baseMessage : `${baseMessage}:${attempt}`;
    const buf = hmacBufferFn(msg);
    if (!buf || typeof buf.length !== 'number') {
      throw new TypeError('hmacBufferFn must return a Buffer or byte array');
    }
    if (attempt === 0) {
      primaryHmacHex = Buffer.from(buf).toString('hex');
    }
    for (let i = 0; i < buf.length && dice.length < 3; i++) {
      const byte = buf[i];
      if (byte < 252) {
        dice.push((byte % 6) + 1);
      }
    }
    attempt += 1;
  }

  return {
    dice,
    hmacHex: primaryHmacHex,
    attempts: attempt
  };
}

function deriveFairDice(serverSeed, clientSeed, nonce) {
  assertNonEmptySecret(serverSeed, 'serverSeed');

  const rawClient = (clientSeed === undefined || clientSeed === null) ? '' : String(clientSeed).trim();
  const cleanClientSeed = rawClient || DEFAULT_CLIENT_SEED;
  const cleanNonce = parseNonNegativeSafeInt(nonce, 'nonce', true);

  const baseMessage = `${cleanClientSeed}:${cleanNonce}`;
  const derived = deriveDiceWithHmac(
    (msg) => hmacSha256Buffer(serverSeed, msg),
    baseMessage
  );

  return {
    dice: derived.dice,
    clientSeed: cleanClientSeed,
    nonce: cleanNonce,
    hmacHex: derived.hmacHex,
    attempts: derived.attempts
  };
}

function getLiveRoundClock(nowMs = Date.now()) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('nowMs must be a finite non-negative number');
  }

  const serverTime = Math.floor(nowMs) || 0;
  const liveRoundId = Math.floor(serverTime / LIVE_ROUND_MS);
  const roundStartMs = liveRoundId * LIVE_ROUND_MS;
  const elapsedMs = serverTime - roundStartMs;
  const phase = elapsedMs < LIVE_BET_MS ? 'BETTING' : 'REVEAL';
  const betRemainingMs = phase === 'BETTING' ? (LIVE_BET_MS - elapsedMs) : 0;
  const roundRemainingMs = LIVE_ROUND_MS - elapsedMs;

  return {
    serverTime,
    liveRoundId,
    roundStartMs,
    elapsedMs,
    phase,
    betRemainingMs,
    roundRemainingMs
  };
}

function deriveLiveRoundDice(liveMasterSecret, liveRoundId) {
  assertNonEmptySecret(liveMasterSecret, 'liveMasterSecret');
  const rid = parseNonNegativeSafeInt(liveRoundId, 'liveRoundId', false);
  const baseMessage = `live:${rid}`;
  const derived = deriveDiceWithHmac(
    (msg) => hmacSha256Buffer(liveMasterSecret, msg),
    baseMessage
  );

  return {
    liveRoundId: rid,
    dice: derived.dice,
    hmacHex: derived.hmacHex,
    attempts: derived.attempts
  };
}

function computeLiveCommitmentHash(liveMasterSecret, liveRoundId) {
  assertNonEmptySecret(liveMasterSecret, 'liveMasterSecret');
  const rid = parseNonNegativeSafeInt(liveRoundId, 'liveRoundId', false);
  const hmacHex = hmacSha256Hex(liveMasterSecret, `live:${rid}`);
  return sha256Hex(`commit:${hmacHex}`);
}

module.exports = {
  DEFAULT_CLIENT_SEED,
  MAX_SINGLE_BET,
  LIVE_ROUND_MS,
  LIVE_BET_MS,
  LIVE_REVEAL_MS,
  TOTAL_MULTIPLIERS,
  ALLOWED_BET_KEYS,
  validateBets,
  evaluateRoll,
  sha256Hex,
  hmacSha256Buffer,
  hmacSha256Hex,
  deriveDiceWithHmac,
  deriveFairDice,
  getLiveRoundClock,
  deriveLiveRoundDice,
  computeLiveCommitmentHash
};
