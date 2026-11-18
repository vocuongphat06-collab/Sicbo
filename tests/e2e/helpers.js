'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, fork } = require('node:child_process');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function getTargetRoot() {
  return process.env.E2E_TARGET_ROOT
    ? path.resolve(process.env.E2E_TARGET_ROOT)
    : DEFAULT_PROJECT_ROOT;
}

const LIVE_ROUND_MS = 45000;
const LIVE_BET_MS = 40000;
const LIVE_REVEAL_MS = 5000;

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
  17: 60,
});

const MACAU_BET_KEYS = Object.freeze((() => {
  const keys = ['tai', 'xiu', 'even', 'odd', 'triple_any'];
  for (let i = 1; i <= 6; i++) keys.push(`triple_${i}`);
  for (let i = 1; i <= 6; i++) keys.push(`double_${i}`);
  for (let a = 1; a <= 5; a++) {
    for (let b = a + 1; b <= 6; b++) {
      keys.push(`pair_${a}_${b}`);
    }
  }
  for (let t = 4; t <= 17; t++) keys.push(`total_${t}`);
  for (let s = 1; s <= 6; s++) keys.push(`single_${s}`);
  return keys;
})());

/**
 * Independent Macau Sicbo reference evaluator derived from ORIGINAL_REQUEST.md & PROJECT.md.
 */
function referenceEvaluateRoll(dice, bets) {
  if (!Array.isArray(dice) || dice.length !== 3) {
    throw new Error(`Invalid dice array: ${JSON.stringify(dice)}`);
  }
  const [d1, d2, d3] = dice;
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) {
    if (!Number.isInteger(d) || d < 1 || d > 6) {
      throw new Error(`Invalid die face: ${d}`);
    }
    counts[d]++;
  }
  const total = d1 + d2 + d3;
  const isTriple = d1 === d2 && d2 === d3;
  const outcome = isTriple ? 'TRIPLE' : (total >= 11 ? 'TAI' : 'XIU');

  let totalBet = 0;
  let totalWin = 0;
  const winningDetails = {};

  for (const [key, rawStake] of Object.entries(bets || {})) {
    const stake = Number(rawStake);
    totalBet += stake;
    let payout = 0;

    if (key === 'tai') {
      if (!isTriple && total >= 11 && total <= 17) payout = stake * 2;
    } else if (key === 'xiu') {
      if (!isTriple && total >= 4 && total <= 10) payout = stake * 2;
    } else if (key === 'even') {
      if (!isTriple && total % 2 === 0) payout = stake * 2;
    } else if (key === 'odd') {
      if (!isTriple && total % 2 === 1) payout = stake * 2;
    } else if (key === 'triple_any') {
      if (isTriple) payout = stake * 31;
    } else if (/^triple_[1-6]$/.test(key)) {
      const target = Number(key.slice(7));
      if (isTriple && d1 === target) payout = stake * 181;
    } else if (/^double_[1-6]$/.test(key)) {
      const target = Number(key.slice(7));
      if (counts[target] >= 2) payout = stake * 11;
    } else if (/^pair_([1-6])_([1-6])$/.test(key)) {
      const [, aStr, bStr] = key.match(/^pair_([1-6])_([1-6])$/);
      const a = Number(aStr);
      const b = Number(bStr);
      if (a < b && counts[a] >= 1 && counts[b] >= 1) payout = stake * 6;
    } else if (/^total_(\d+)$/.test(key)) {
      const target = Number(key.slice(6));
      if (TOTAL_MULTIPLIERS[target] && total === target) {
        payout = stake * (TOTAL_MULTIPLIERS[target] + 1);
      }
    } else if (/^single_[1-6]$/.test(key)) {
      const target = Number(key.slice(7));
      if (counts[target] >= 1) payout = stake * (counts[target] + 1);
    } else {
      throw new Error(`Unknown bet key in referenceEvaluateRoll: ${key}`);
    }

    if (payout > 0) {
      totalWin += payout;
      winningDetails[key] = payout;
    }
  }

  return {
    dice: [...dice],
    total,
    isTriple,
    outcome,
    totalBet,
    totalWin,
    netProfit: totalWin - totalBet,
    winningDetails,
  };
}

/**
 * Browser-identical Web Crypto SHA-256 hex digest.
 */
async function webCryptoSha256Hex(input) {
  const enc = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(String(input)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Browser-identical Web Crypto HMAC-SHA256 + rejection sampling (byte < 252).
 */
async function webCryptoDeriveFairDice(serverSeed, clientSeed, nonce) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(String(serverSeed)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const cleanClientSeed = String(clientSeed ?? '').trim() || 'sovereign-vip-888';
  const cleanNonce = Number(nonce);
  const dice = [];
  let attempt = 0;

  while (dice.length < 3) {
    const msg = attempt === 0
      ? `${cleanClientSeed}:${cleanNonce}`
      : `${cleanClientSeed}:${cleanNonce}:${attempt}`;
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(msg));
    const bytes = new Uint8Array(sig);
    for (let i = 0; i < bytes.length && dice.length < 3; i++) {
      if (bytes[i] < 252) {
        dice.push((bytes[i] % 6) + 1);
      }
    }
    attempt++;
    if (attempt > 64) {
      throw new Error('Rejection sampling exceeded 64 attempts');
    }
  }
  return dice;
}

function syncDeriveFairDiceWithMeta(serverSeed, clientSeed, nonce) {
  const cleanClientSeed = String(clientSeed ?? '').trim() || 'sovereign-vip-888';
  const cleanNonce = Number(nonce);
  const dice = [];
  let attempt = 0;
  let skippedHighByte = false;
  let firstHmacHex = '';

  while (dice.length < 3) {
    const msg = attempt === 0
      ? `${cleanClientSeed}:${cleanNonce}`
      : `${cleanClientSeed}:${cleanNonce}:${attempt}`;
    const bytes = crypto.createHmac('sha256', String(serverSeed)).update(msg).digest();
    if (attempt === 0) firstHmacHex = bytes.toString('hex');
    for (let i = 0; i < bytes.length && dice.length < 3; i++) {
      if (bytes[i] >= 252) {
        skippedHighByte = true;
      } else {
        dice.push((bytes[i] % 6) + 1);
      }
    }
    attempt++;
  }
  return { dice, skippedHighByte, firstHmacHex };
}

let cachedFairVectors = null;

/**
 * Deterministically finds (and caches) valid (serverSeed, clientSeed, nonce) vectors
 * covering all 6 triples, min/max totals, doubles, distinct, and byte >= 252 rejection sampling.
 */
function findDeterministicFairVectors() {
  if (cachedFairVectors) return cachedFairVectors;

  const targets = {
    triple_1: [1, 1, 1],
    triple_2: [2, 2, 2],
    triple_3: [3, 3, 3],
    triple_4: [4, 4, 4],
    triple_5: [5, 5, 5],
    triple_6: [6, 6, 6],
    total_4: [1, 1, 2],
    total_17: [5, 6, 6],
    double_2: [2, 2, 5],
    distinct_123: [1, 2, 3],
  };

  const found = {};
  const neededKeys = new Set(Object.keys(targets));
  let rejectionSamplingCase = null;

  for (let i = 0; i < 100000 && (neededKeys.size > 0 || !rejectionSamplingCase); i++) {
    const serverSeed = `e2e-vec-seed-${i}`;
    const clientSeed = 'e2e-client';
    const nonce = i % 7;
    const res = syncDeriveFairDiceWithMeta(serverSeed, clientSeed, nonce);

    if (!rejectionSamplingCase && res.skippedHighByte) {
      rejectionSamplingCase = {
        serverSeed,
        clientSeed,
        nonce,
        expectedDice: res.dice,
        firstHmacHex: res.firstHmacHex,
      };
    }

    for (const k of Array.from(neededKeys)) {
      const t = targets[k];
      if (res.dice[0] === t[0] && res.dice[1] === t[1] && res.dice[2] === t[2]) {
        found[k] = { serverSeed, clientSeed, nonce, expectedDice: res.dice };
        neededKeys.delete(k);
      }
    }
  }

  if (neededKeys.size > 0 || !rejectionSamplingCase) {
    throw new Error(`Could not derive deterministic vectors: missing=${Array.from(neededKeys).join(',')}`);
  }

  cachedFairVectors = { ...found, rejectionSamplingCase };
  return cachedFairVectors;
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Creates an isolated temporary workspace copying server.js, package.json, .env.example, lib/, public/.
 * Never copies data/. Creates an NTFS junction (Windows) or symlink (POSIX) to node_modules.
 */
function createIsolatedWorkspace({ seedEnvFile = false, sourceRoot = getTargetRoot() } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sicbo-e2e-'));
  const appDir = path.join(tempRoot, 'app');
  const tmpDir = path.join(tempRoot, 'tmp');
  const dataDir = path.join(appDir, 'data');

  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  for (const fileName of ['server.js', 'package.json', '.env.example']) {
    const src = path.join(sourceRoot, fileName);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(appDir, fileName));
    }
  }
  if (seedEnvFile && fs.existsSync(path.join(sourceRoot, '.env'))) {
    fs.copyFileSync(path.join(sourceRoot, '.env'), path.join(appDir, '.env'));
  }

  copyDirRecursive(path.join(sourceRoot, 'lib'), path.join(appDir, 'lib'));
  copyDirRecursive(path.join(sourceRoot, 'public'), path.join(appDir, 'public'));

  const nmTarget = fs.existsSync(path.join(sourceRoot, 'node_modules'))
    ? path.join(sourceRoot, 'node_modules')
    : path.join(DEFAULT_PROJECT_ROOT, 'node_modules');
  if (fs.existsSync(nmTarget)) {
    fs.symlinkSync(
      nmTarget,
      path.join(appDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }

  function unlinkNodeModulesJunction() {
    const nmLink = path.join(appDir, 'node_modules');
    try {
      const st = fs.lstatSync(nmLink);
      if (st.isSymbolicLink()) {
        try {
          fs.unlinkSync(nmLink);
        } catch {
          fs.rmSync(nmLink, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    } catch {
      // node_modules link absent
    }
  }

  function cleanup() {
    if (!fs.existsSync(tempRoot)) return;
    unlinkNodeModulesJunction();
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }

  async function cleanupAsync() {
    if (!fs.existsSync(tempRoot)) return;
    unlinkNodeModulesJunction();
    const maxAttempts = 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
        return;
      } catch (err) {
        const retriable = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY');
        if (!retriable || attempt === maxAttempts) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  return { tempRoot, appDir, tmpDir, dataDir, cleanup, cleanupAsync };
}

function buildCleanEnv(workspace, { vercel = false, env = {}, clearCloudEnv = true, stripSecrets = false } = {}) {
  const clean = { ...process.env };
  delete clean.PORT;
  delete clean.VERCEL;
  delete clean.VERCEL_ENV;
  delete clean.VERCEL_URL;

  if (clearCloudEnv) {
    delete clean.UPSTASH_REDIS_REST_URL;
    delete clean.UPSTASH_REDIS_REST_TOKEN;
    delete clean.DATABASE_URL;
  }

  if (stripSecrets) {
    delete clean.JWT_SECRET;
    delete clean.LIVE_MASTER_SECRET;
    delete clean.ADMIN_USERNAME;
    delete clean.ADMIN_PASSWORD;
  }

  clean.TEMP = workspace.tmpDir;
  clean.TMP = workspace.tmpDir;
  clean.TMPDIR = workspace.tmpDir;
  clean.NODE_ENV = env.NODE_ENV || 'test';

  if (vercel) {
    clean.VERCEL = '1';
  }

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) {
      delete clean[k];
    } else {
      clean[k] = String(v);
    }
  }
  return clean;
}

function waitForChildExit(child, maxWaitMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        clearTimeout(t);
        resolve();
      }
    };
    const t = setTimeout(done, maxWaitMs);
    t.unref();
    child.once('close', done);
    child.once('exit', () => setTimeout(done, 50).unref());
  });
}

function spawnBootstrappedChild(workspace, cleanEnv, { preloadPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const bootPath = path.join(workspace.tempRoot, '_e2e_boot.js');
    const bootCode = [
      "const http = require('node:http');",
      "const path = require('node:path');",
      "const app = require(path.join(process.cwd(), 'server.js'));",
      'const server = http.createServer(app);',
      "server.listen(0, '127.0.0.1', () => {",
      "  if (process.send) process.send({ type: 'ready', port: server.address().port });",
      '});',
      "process.on('message', (msg) => {",
      "  if (msg && msg.type === 'shutdown') {",
      '    server.close(() => process.exit(0));',
      "    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();",
      '    setTimeout(() => process.exit(0), 600).unref();',
      '  }',
      '});',
    ].join('\n');
    fs.writeFileSync(bootPath, bootCode, 'utf8');

    const args = [];
    if (preloadPath) {
      args.push('-r', preloadPath);
    }
    args.push(bootPath);

    const child = spawn(process.execPath, args, {
      cwd: workspace.appDir,
      env: cleanEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        waitForChildExit(child, 3000).then(() => {
          reject(new Error(`Test server startup timeout.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        });
      }
    }, 45000);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Test server exited early (code=${code}, signal=${signal}).\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });

    child.on('message', (msg) => {
      if (!settled && msg && msg.type === 'ready') {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, port: msg.port, getLogs: () => ({ stdout, stderr }) });
      }
    });
  });
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.once('close', finish);
    child.once('exit', () => setTimeout(finish, 80).unref());
    try {
      if (child.connected) {
        child.send({ type: 'shutdown' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      setTimeout(finish, 2500).unref();
    }, 1500);
    timer.unref();
  });
}

/**
 * Starts an isolated Express server child process on 127.0.0.1:0.
 * Supports restart(newOptions) preserving the same temp workspace (data/ and tmp/).
 */
async function startTestServer(options = {}) {
  const workspace = options.existingWorkspace || createIsolatedWorkspace({
    seedEnvFile: Boolean(options.seedEnvFile),
    sourceRoot: options.sourceRoot || getTargetRoot(),
  });

  let currentOpts = {
    vercel: Boolean(options.vercel),
    env: options.env ? { ...options.env } : {},
    clearCloudEnv: options.clearCloudEnv !== undefined ? options.clearCloudEnv : true,
    stripSecrets: Boolean(options.stripSecrets),
  };

  let proc = await spawnBootstrappedChild(
    workspace,
    buildCleanEnv(workspace, currentOpts)
  ).catch(async (err) => {
    if (!options.existingWorkspace) await workspace.cleanupAsync();
    throw err;
  });

  const handle = {
    port: proc.port,
    baseUrl: `http://127.0.0.1:${proc.port}`,
    tempRoot: workspace.tempRoot,
    appDir: workspace.appDir,
    dataDir: workspace.dataDir,
    tmpDir: workspace.tmpDir,
    workspace,
    getLogs: () => proc.getLogs(),
    async stop(keepWorkspace = false) {
      await stopChildProcess(proc.child);
      if (!keepWorkspace) {
        await workspace.cleanupAsync();
      }
    },
    async close() {
      await handle.stop(false);
    },
    async restart(newOpts = {}) {
      await stopChildProcess(proc.child);
      currentOpts = {
        vercel: newOpts.vercel !== undefined ? Boolean(newOpts.vercel) : currentOpts.vercel,
        env: newOpts.env !== undefined ? { ...newOpts.env } : currentOpts.env,
        clearCloudEnv: newOpts.clearCloudEnv !== undefined ? newOpts.clearCloudEnv : currentOpts.clearCloudEnv,
        stripSecrets: newOpts.stripSecrets !== undefined ? Boolean(newOpts.stripSecrets) : currentOpts.stripSecrets,
      };
      proc = await spawnBootstrappedChild(workspace, buildCleanEnv(workspace, currentOpts));
      handle.port = proc.port;
      handle.baseUrl = `http://127.0.0.1:${proc.port}`;
      return handle;
    },
  };

  return handle;
}

/**
 * Starts an isolated server with Date.now() controlled via IPC SET_TIME.
 */
async function startClockedServer({
  initialNowMs,
  vercel = false,
  env = {},
  clearCloudEnv = true,
  stripSecrets = false,
  sourceRoot = getTargetRoot(),
} = {}) {
  const workspace = createIsolatedWorkspace({ sourceRoot });
  const preloadPath = path.join(workspace.tempRoot, '_e2e_clock_preload.js');
  const preloadCode = [
    'let mockNow = Number(process.env.E2E_MOCK_NOW_MS);',
    'Date.now = () => mockNow;',
    "process.on('message', (msg) => {",
    "  if (msg && msg.type === 'SET_TIME') {",
    '    mockNow = Number(msg.nowMs);',
    "    if (process.send) process.send({ type: 'SET_TIME_ACK', nowMs: mockNow });",
    '  }',
    '});',
  ].join('\n');
  fs.writeFileSync(preloadPath, preloadCode, 'utf8');

  const startMs = initialNowMs !== undefined
    ? Number(initialNowMs)
    : Math.ceil(Date.now() / LIVE_ROUND_MS) * LIVE_ROUND_MS;

  const cleanEnv = buildCleanEnv(workspace, {
    vercel,
    env: { ...env, E2E_MOCK_NOW_MS: String(startMs) },
    clearCloudEnv,
    stripSecrets,
  });

  let proc;
  try {
    proc = await spawnBootstrappedChild(workspace, cleanEnv, { preloadPath });
  } catch (err) {
    await workspace.cleanupAsync();
    throw err;
  }

  return {
    port: proc.port,
    baseUrl: `http://127.0.0.1:${proc.port}`,
    tempRoot: workspace.tempRoot,
    appDir: workspace.appDir,
    dataDir: workspace.dataDir,
    tmpDir: workspace.tmpDir,
    getLogs: () => proc.getLogs(),
    setTime(nowMs) {
      return new Promise((resolve, reject) => {
        if (!proc.child.connected) {
          return reject(new Error('Clocked server IPC is disconnected'));
        }
        const onMsg = (msg) => {
          if (msg && msg.type === 'SET_TIME_ACK') {
            proc.child.off('message', onMsg);
            clearTimeout(timer);
            resolve(msg.nowMs);
          }
        };
        const timer = setTimeout(() => {
          proc.child.off('message', onMsg);
          reject(new Error('Timed out waiting for SET_TIME_ACK'));
        }, 3000);
        proc.child.on('message', onMsg);
        proc.child.send({ type: 'SET_TIME', nowMs: Number(nowMs) });
      });
    },
    async close() {
      await stopChildProcess(proc.child);
      await workspace.cleanupAsync();
    },
  };
}

/**
 * Spawns `node server.js` directly in an isolated workspace to test
 * `if (require.main === module && !process.env.VERCEL)` entrypoint behavior.
 */
function spawnDirectEntrypoint({
  vercel = false,
  env = {},
  clearCloudEnv = true,
  stripSecrets = false,
  timeoutMs = 10000,
  sourceRoot = getTargetRoot(),
} = {}) {
  const workspace = createIsolatedWorkspace({ sourceRoot });
  const cleanEnv = buildCleanEnv(workspace, { vercel, env, clearCloudEnv, stripSecrets });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: workspace.appDir,
      env: cleanEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await workspace.cleanupAsync().catch(() => {});
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function inspectServerModuleExport(sourceRoot = getTargetRoot()) {
  const workspace = createIsolatedWorkspace({ sourceRoot });
  const cleanEnv = buildCleanEnv(workspace, { vercel: true, stripSecrets: true });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', "const app = require('./server.js'); process.stdout.write(typeof app);"],
      {
        cwd: workspace.appDir,
        env: cleanEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', async (code) => {
      await workspace.cleanupAsync().catch(() => {});
      resolve({ code, stdout: stdout.trim(), stderr });
    });
  });
}

class CookieJar {
  constructor(initialCookies = []) {
    this.cookies = new Map();
    this.rawOverride = null;
    for (const [k, v] of initialCookies) {
      this.cookies.set(k, { ...v });
    }
  }

  ingestSetCookies(setCookieHeaders = []) {
    for (const raw of setCookieHeaders) {
      if (!raw) continue;
      const parts = String(raw).split(';').map((p) => p.trim());
      const [nameValue, ...attrs] = parts;
      if (!nameValue || !nameValue.includes('=')) continue;
      const eqIdx = nameValue.indexOf('=');
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();

      const meta = {
        name,
        value,
        raw,
        httpOnly: false,
        secure: false,
        sameSite: null,
        path: null,
        maxAge: null,
        expires: null,
        cleared: false,
      };

      for (const attr of attrs) {
        const lower = attr.toLowerCase();
        if (lower === 'httponly') meta.httpOnly = true;
        else if (lower === 'secure') meta.secure = true;
        else if (lower.startsWith('samesite=')) meta.sameSite = attr.slice(9).trim();
        else if (lower.startsWith('path=')) meta.path = attr.slice(5).trim();
        else if (lower.startsWith('max-age=')) {
          const num = Number(attr.slice(8).trim());
          meta.maxAge = Number.isFinite(num) ? num : null;
          if (num <= 0) meta.cleared = true;
        } else if (lower.startsWith('expires=')) {
          meta.expires = attr.slice(8).trim();
          const ts = Date.parse(meta.expires);
          if (Number.isFinite(ts) && ts <= Date.now()) meta.cleared = true;
        }
      }

      if (value === '') meta.cleared = true;
      this.cookies.set(name, meta);
      this.rawOverride = null;
    }
  }

  getCookie(name) {
    const entry = this.cookies.get(name);
    if (!entry || entry.cleared || !entry.value) return undefined;
    return entry.value;
  }

  getCookieMeta(name) {
    return this.cookies.get(name) || null;
  }

  snapshotCookie() {
    if (this.rawOverride !== null) return this.rawOverride;
    const active = [];
    for (const entry of this.cookies.values()) {
      if (!entry.cleared && entry.value) {
        active.push(`${entry.name}=${entry.value}`);
      }
    }
    return active.join('; ');
  }

  setRawCookieHeader(rawHeader) {
    this.rawOverride = rawHeader;
  }

  clear() {
    this.cookies.clear();
    this.rawOverride = null;
  }

  clone() {
    const copy = new CookieJar(this.cookies.entries());
    copy.rawOverride = this.rawOverride;
    return copy;
  }
}

function createClient(baseUrl, initialJar = null) {
  const jar = initialJar || new CookieJar();

  async function request(method, urlPath, opts = {}) {
    const url = urlPath.startsWith('http') ? urlPath : `${baseUrl}${urlPath}`;
    const headers = { ...(opts.headers || {}) };

    if (!opts.noCookies) {
      const hasExplicitCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
      if (!hasExplicitCookie) {
        const cookieHdr = jar.snapshotCookie();
        if (cookieHdr) headers.Cookie = cookieHdr;
      }
    }

    let bodyToSend;
    if (opts.rawBody !== undefined) {
      bodyToSend = opts.rawBody;
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    } else if (opts.body !== undefined) {
      bodyToSend = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: bodyToSend,
      redirect: 'manual',
    });

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    if (!opts.skipCookieSave && setCookies.length > 0) {
      jar.ingestSetCookies(setCookies);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      setCookies,
      text,
      json,
    };
  }

  return {
    baseUrl,
    jar,
    request,
    get: (p, opts) => request('GET', p, opts),
    post: (p, body, opts = {}) => request('POST', p, { ...opts, body }),
    put: (p, body, opts = {}) => request('PUT', p, { ...opts, body }),
    delete: (p, opts) => request('DELETE', p, opts),
    getCookie: (name) => jar.getCookie(name),
    getCookieMeta: (name) => jar.getCookieMeta(name),
    snapshotCookie: () => jar.snapshotCookie(),
    setRawCookieHeader: (raw) => jar.setRawCookieHeader(raw),
    clearCookies: () => jar.clear(),
    clone: () => createClient(baseUrl, jar.clone()),
  };
}

/**
 * Raw HTTP request via node:http for exact byte-count (e.g. 16kb + 1 byte)
 * and malformed JSON error testing.
 */
function rawHttpRequest(baseUrl, { method = 'POST', path: reqPath = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const finalHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      ...headers,
    };

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: reqPath,
        method,
        headers: finalHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function waitForLivePhase(client, targetPhase, minRemainingMs = 2500, timeoutMs = 26000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.get('/api/live/state');
    if (res.status !== 200 || !res.json) {
      throw new Error(`GET /api/live/state failed: ${res.status} ${res.text}`);
    }
    const state = res.json;
    const rem = targetPhase === 'BETTING' ? state.betRemainingMs : state.roundRemainingMs;
    if (state.phase === targetPhase && Number(rem) >= minRemainingMs) {
      return state;
    }
    const waitMs = targetPhase === 'BETTING'
      ? Math.min(Math.max(Number(state.roundRemainingMs || 500) + 150, 200), 2500)
      : Math.min(Math.max(Number(state.betRemainingMs || 500) + 150, 200), 2500);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`Timed out waiting for live phase ${targetPhase}`);
}

/**
 * Strips CSS comments and extracts rules with optional @media context.
 */
function parseCssRules(cssText) {
  const clean = String(cssText).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];

  function parseBlock(text, mediaCtx) {
    let i = 0;
    const len = text.length;
    while (i < len) {
      while (i < len && /\s/.test(text[i])) i++;
      if (i >= len) break;

      const braceOpen = text.indexOf('{', i);
      if (braceOpen === -1) break;
      const header = text.slice(i, braceOpen).trim();

      let depth = 1;
      let j = braceOpen + 1;
      while (j < len && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(braceOpen + 1, j - 1);

      if (header.startsWith('@media')) {
        parseBlock(body, header);
      } else if (!header.startsWith('@')) {
        const props = new Map();
        for (const decl of body.split(';')) {
          const colon = decl.indexOf(':');
          if (colon === -1) continue;
          const prop = decl.slice(0, colon).trim().toLowerCase();
          const val = decl.slice(colon + 1).trim();
          if (prop) props.set(prop, val);
        }
        const selectors = header.split(',').map((s) => s.trim()).filter(Boolean);
        rules.push({ media: mediaCtx, selector: header, selectors, props });
      }
      i = j;
    }
  }

  parseBlock(clean, null);
  return rules;
}

function extractHtmlDataBets(html) {
  const bets = [];
  const regex = /data-bet\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    bets.push(m[1]);
  }
  return bets;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseTagAttrs(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

/**
 * Walks HTML tags to find an element by #id and its ancestor chain.
 */
function extractElementAndAncestors(html, targetId) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const stack = [];
  const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(stripped)) !== null) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const isClose = full.startsWith('</');
    const isSelfClose = full.endsWith('/>') || VOID_TAGS.has(tag);

    if (isClose) {
      for (let idx = stack.length - 1; idx >= 0; idx--) {
        if (stack[idx].tag === tag) {
          stack.length = idx;
          break;
        }
      }
      continue;
    }

    const attrs = parseTagAttrs(m[2] || '');
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    const node = { tag, id: attrs.id || null, classes, attrs };

    if (node.id === targetId) {
      return {
        element: node,
        ancestors: [...stack],
      };
    }

    if (!isSelfClose) {
      stack.push(node);
    }
  }
  return null;
}

function stripCssImportant(val) {
  return String(val ?? '').replace(/!important/gi, '').trim();
}

function parseCssCompoundTail(singleSelector) {
  const trimmed = String(singleSelector || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s>+~]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const rawTail = parts[parts.length - 1].replace(/:+[a-zA-Z-]+(\([^)]*\))?/g, '');
  if (!rawTail) return null;

  const tagMatch = rawTail.match(/^([a-zA-Z0-9-]+|\*)/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : null;
  const ids = [];
  const classes = [];
  const idRe = /#([a-zA-Z0-9_-]+)/g;
  const clsRe = /\.([a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = idRe.exec(rawTail)) !== null) ids.push(m[1]);
  while ((m = clsRe.exec(rawTail)) !== null) classes.push(m[1]);
  return { tag, ids, classes, rawTail };
}

function selectorMatchesNode(singleSelector, node) {
  const parsed = parseCssCompoundTail(singleSelector);
  if (!parsed) return false;
  if (parsed.ids.length === 0 && parsed.classes.length === 0) return false;
  if (parsed.tag && parsed.tag !== '*' && parsed.tag !== node.tag) return false;
  for (const id of parsed.ids) {
    if (id !== node.id) return false;
  }
  for (const cls of parsed.classes) {
    if (!node.classes.includes(cls)) return false;
  }
  return true;
}

function getMatrixBackdropOpenState(cssRules) {
  let maxZ = 0;
  let basePointerEvents = null;
  let openPointerEvents = null;

  for (const rule of cssRules) {
    if (rule.media) continue;
    let matchesBase = false;
    let matchesOpen = false;
    for (const sel of rule.selectors) {
      const parsed = parseCssCompoundTail(sel);
      if (!parsed) continue;
      const targetsMatrix =
        parsed.ids.includes('fullMatrixModal') ||
        parsed.classes.includes('matrix-drawer-backdrop');
      if (!targetsMatrix) continue;
      if (parsed.classes.includes('open')) {
        matchesOpen = true;
      } else {
        matchesBase = true;
      }
    }
    if (!matchesBase && !matchesOpen) continue;

    if (rule.props.has('z-index')) {
      const z = Number(stripCssImportant(rule.props.get('z-index')));
      if (Number.isFinite(z)) {
        maxZ = Math.max(maxZ, z);
      }
    }
    if (rule.props.has('pointer-events')) {
      const ptr = stripCssImportant(rule.props.get('pointer-events')).toLowerCase();
      if (matchesOpen) openPointerEvents = ptr;
      if (matchesBase) basePointerEvents = ptr;
    }
  }

  return {
    matrixZ: maxZ,
    matrixOpenPointerEvents: openPointerEvents ?? basePointerEvents,
  };
}

function extractAncestorChainZIndex(html, cssRules, elementId, { includeMediaPattern = null } = {}) {
  const found = extractElementAndAncestors(html, elementId);
  if (!found) return null;

  const chain = [...found.ancestors, found.element];
  return chain.map((node) => {
    let zIndex = null;
    let position = null;
    let pointerEvents = null;
    let display = null;

    for (const rule of cssRules) {
      if (rule.media && (!includeMediaPattern || !includeMediaPattern.test(rule.media))) {
        continue;
      }
      const matched = rule.selectors.some((sel) => selectorMatchesNode(sel, node));
      if (!matched) continue;
      if (rule.props.has('z-index')) {
        const parsed = Number(stripCssImportant(rule.props.get('z-index')));
        if (Number.isFinite(parsed)) zIndex = parsed;
      }
      if (rule.props.has('position')) position = stripCssImportant(rule.props.get('position'));
      if (rule.props.has('pointer-events')) pointerEvents = stripCssImportant(rule.props.get('pointer-events'));
      if (rule.props.has('display')) display = stripCssImportant(rule.props.get('display'));
    }

    return {
      tag: node.tag,
      id: node.id,
      classes: node.classes,
      zIndex,
      position,
      pointerEvents,
      display,
    };
  });
}

function hasPlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PROJECT_ROOT,
  getTargetRoot,
  LIVE_ROUND_MS,
  LIVE_BET_MS,
  LIVE_REVEAL_MS,
  TOTAL_MULTIPLIERS,
  MACAU_BET_KEYS,
  referenceEvaluateRoll,
  webCryptoSha256Hex,
  webCryptoDeriveFairDice,
  findDeterministicFairVectors,
  createIsolatedWorkspace,
  startTestServer,
  startClockedServer,
  spawnDirectEntrypoint,
  inspectServerModuleExport,
  CookieJar,
  createClient,
  rawHttpRequest,
  waitForLivePhase,
  parseCssRules,
  stripCssImportant,
  selectorMatchesNode,
  getMatrixBackdropOpenState,
  extractHtmlDataBets,
  extractElementAndAncestors,
  extractAncestorChainZIndex,
  hasPlaywright,
};
