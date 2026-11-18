'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONSTANTS = Object.freeze({
  LIVE_ROUND_MS: 20_000,
  LIVE_BET_MS: 15_000,
  LIVE_REVEAL_MS: 5_000,
  DAILY_BONUS_AMOUNT: 2_000_000,
  DAILY_BONUS_COOLDOWN_MS: 24 * 60 * 60 * 1000,
  BANKRUPTCY_THRESHOLD: 10_000,
  BANKRUPTCY_AID_AMOUNT: 500_000,
  BANKRUPTCY_COOLDOWN_MS: 60 * 60 * 1000,
  INITIAL_BALANCE: 10_000_000,
  GUEST_INITIAL_BALANCE: 2_000_000,
  BODY_LIMIT: '16kb',
  COOKIE_NAME: 'sicbo_token',
  JWT_TTL_SECONDS: 7 * 24 * 60 * 60,
  AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  AUTH_RATE_LIMIT_MAX: 20,
  BET_RATE_LIMIT_WINDOW_MS: 60_000,
  BET_RATE_LIMIT_MAX: 40,
  MAX_SINGLE_BET: 1_000_000_000,
  DEFAULT_CLIENT_SEED: 'sovereign-vip-888'
});

const ephemeralCache = {
  jwtSecret: null,
  liveMasterSecret: null
};

let cachedConfig = null;

function trimNonEmpty(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function parseBoolEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === '' ||
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }
  return true;
}

function parsePort(value, fallback = 3000) {
  const s = trimNonEmpty(value === undefined || value === null ? '' : String(value));
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function randomHex32() {
  return crypto.randomBytes(32).toString('hex');
}

function parseDotEnvFile(filePath) {
  const parsed = {};
  if (!fs.existsSync(filePath)) return parsed;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const line = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t');
      }
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }

    parsed[key] = val;
  }

  return parsed;
}

function isValidStoredSecret(value) {
  return typeof value === 'string' && value.trim().length >= 32;
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const writeOpts = process.platform === 'win32'
    ? { encoding: 'utf8' }
    : { encoding: 'utf8', mode: 0o600 };

  try {
    fs.writeFileSync(tmpPath, content, writeOpts);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      // Ignore cleanup errors
    }
    throw err;
  }
}

function loadOrCreateLocalSecrets(secretsFile) {
  let existing = null;
  let needsWrite = false;

  if (fs.existsSync(secretsFile)) {
    try {
      const raw = fs.readFileSync(secretsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed;
      } else {
        needsWrite = true;
      }
    } catch (_) {
      needsWrite = true;
    }
  } else {
    needsWrite = true;
  }

  const candidateJwt = existing ? (existing.jwtSecret || existing.JWT_SECRET) : null;
  const candidateLive = existing ? (existing.liveMasterSecret || existing.LIVE_MASTER_SECRET) : null;

  let jwtSecret = isValidStoredSecret(candidateJwt) ? candidateJwt.trim() : '';
  let liveMasterSecret = isValidStoredSecret(candidateLive) ? candidateLive.trim() : '';

  if (!jwtSecret) {
    jwtSecret = randomHex32();
    needsWrite = true;
  }
  if (!liveMasterSecret) {
    liveMasterSecret = randomHex32();
    needsWrite = true;
  }

  if (needsWrite) {
    const payload = JSON.stringify(
      {
        jwtSecret,
        liveMasterSecret,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    );
    writeFileAtomic(secretsFile, `${payload}\n`);
  }

  return { jwtSecret, liveMasterSecret };
}

function loadConfig(options = {}) {
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(__dirname, '..');

  const rawEnv = options.env || process.env;
  const preliminaryIsVercel = parseBoolEnv(rawEnv.VERCEL);

  let env = rawEnv;
  if (
    options.env === undefined &&
    options.loadDotEnv !== false &&
    !preliminaryIsVercel &&
    rawEnv.NODE_ENV !== 'test'
  ) {
    const dotEnvBase = parseDotEnvFile(path.join(rootDir, '.env'));
    const dotEnvLocal = parseDotEnvFile(path.join(rootDir, '.env.local'));
    env = { ...dotEnvBase, ...dotEnvLocal, ...rawEnv };
  }

  const isVercel = parseBoolEnv(env.VERCEL);
  const nodeEnv = trimNonEmpty(env.NODE_ENV) || (isVercel ? 'production' : 'development');
  const isProduction = nodeEnv === 'production' || isVercel;
  const port = parsePort(env.PORT, 3000);

  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : (isVercel ? path.join(os.tmpdir(), 'sicbo-data') : path.join(rootDir, 'data'));

  const secretsFile = options.secretsFile
    ? path.resolve(options.secretsFile)
    : path.join(dataDir, '.secrets.json');

  const envJwt = trimNonEmpty(env.JWT_SECRET);
  const envLive = trimNonEmpty(env.LIVE_MASTER_SECRET);

  let jwtSecret = envJwt;
  let liveMasterSecret = envLive;
  let secretsDegraded = false;
  let secretsSource = 'env';

  if (isVercel) {
    const missing = [];
    if (!jwtSecret) {
      missing.push('JWT_SECRET');
      jwtSecret = options.fresh
        ? randomHex32()
        : (ephemeralCache.jwtSecret || (ephemeralCache.jwtSecret = randomHex32()));
    }
    if (!liveMasterSecret) {
      missing.push('LIVE_MASTER_SECRET');
      liveMasterSecret = options.fresh
        ? randomHex32()
        : (ephemeralCache.liveMasterSecret || (ephemeralCache.liveMasterSecret = randomHex32()));
    }

    secretsDegraded = missing.length > 0;
    if (secretsDegraded) {
      secretsSource = (envJwt || envLive) ? 'mixed-ephemeral' : 'ephemeral';
      if (!options.silent) {
        console.warn(
          `[sicbo-config] WARNING: Running on Vercel without ${missing.join(', ')}. ` +
          'Generated ephemeral per-instance CSPRNG secret(s); sessions and live round commitments will not persist across cold starts or instances.'
        );
      }
    }
  } else if (!jwtSecret || !liveMasterSecret) {
    const persisted = loadOrCreateLocalSecrets(secretsFile);
    if (!jwtSecret) jwtSecret = persisted.jwtSecret;
    if (!liveMasterSecret) liveMasterSecret = persisted.liveMasterSecret;
    secretsSource = (envJwt || envLive) ? 'mixed' : 'file';
  }

  const adminUsername = trimNonEmpty(env.ADMIN_USERNAME);
  const adminUsernameLower = adminUsername.toLowerCase();
  const adminPassword = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';

  const upstashRedisRestUrl = trimNonEmpty(env.UPSTASH_REDIS_REST_URL);
  const upstashRedisRestToken = trimNonEmpty(env.UPSTASH_REDIS_REST_TOKEN);
  const databaseUrl = trimNonEmpty(env.DATABASE_URL);

  const dbDriver = (upstashRedisRestUrl && upstashRedisRestToken)
    ? 'upstash'
    : (databaseUrl ? 'postgres' : 'json');

  return {
    ...CONSTANTS,
    port,
    nodeEnv,
    isVercel,
    isProduction,
    rootDir,
    dataDir,
    secretsFile,
    jwtSecret,
    liveMasterSecret,
    secretsDegraded,
    secretsSource,
    adminUsername,
    adminUsernameLower,
    adminPassword,
    upstashRedisRestUrl,
    upstashRedisRestToken,
    databaseUrl,
    dbDriver
  };
}

function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

function resetConfigCache() {
  cachedConfig = null;
  ephemeralCache.jwtSecret = null;
  ephemeralCache.liveMasterSecret = null;
}

module.exports = {
  ...CONSTANTS,
  CONSTANTS,
  loadConfig,
  getConfig,
  resetConfigCache,
  parseBoolEnv
};
