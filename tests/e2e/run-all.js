#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const E2E_DIR = __dirname;
const PROJECT_ROOT = path.resolve(E2E_DIR, '..', '..');

const ORDERED_FILES = [
  'tier1-config-auth-admin.test.js',
  'tier1-sicbo-fairness-live.test.js',
  'tier1-ui-mobile.test.js',
  'tier2-security-boundaries.test.js',
  'tier3-pairwise.test.js',
  'tier4-workloads-vercel.test.js',
  'tier5-adversarial.test.js',
];

const discovered = fs.readdirSync(E2E_DIR)
  .filter((f) => /^tier\d+.*\.test\.js$/.test(f))
  .sort();

const filesToRun = [
  ...ORDERED_FILES.filter((f) => discovered.includes(f)),
  ...discovered.filter((f) => !ORDERED_FILES.includes(f)),
];

if (filesToRun.length === 0) {
  console.error('[E2E] No tier*.test.js files found in', E2E_DIR);
  process.exit(1);
}

console.log(`[E2E] Running ${filesToRun.length} suites (VERCEL=${process.env.VERCEL || 'unset'}, Target=${process.env.E2E_TARGET_ROOT || PROJECT_ROOT})`);

const results = [];
let overallExit = 0;

for (const file of filesToRun) {
  const fullPath = path.join(E2E_DIR, file);
  console.log(`\n=== Running ${file} ===`);
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', fullPath],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: process.env,
      shell: false,
    }
  );
  const code = res.status === null ? 1 : res.status;
  results.push({ file, code });
  if (code !== 0) {
    overallExit = code;
  }
}

console.log('\n=== E2E Suite Summary ===');
for (const r of results) {
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.file} (exit=${r.code})`);
}

process.exit(overallExit);
