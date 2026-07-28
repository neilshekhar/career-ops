#!/usr/bin/env node
/**
 * install-browser.mjs — postinstall Chromium bootstrap with a real fallback.
 *
 * Replaces:
 *   npx playwright install chromium --with-deps || npx playwright install chromium --with-deps
 *
 * Both sides of that `||` were the identical command, so the "fallback" could
 * only ever fail the same way twice. `--with-deps` needs root on Linux to apt-get
 * system libraries, which is exactly the common failure — and the retry could not
 * help because it did the same thing.
 *
 * The real ladder:
 *   1. `playwright install chromium --with-deps`  (best: browser + system libs)
 *   2. `playwright install chromium`              (genuinely different: skips the
 *                                                  privileged apt-get step)
 *
 * Chromium is needed for PDF generation and browser-based liveness checks, but
 * not for scanning, evaluation, or the tracker. So this NEVER fails the install:
 * it prints the exact recovery command and exits 0. `doctor.mjs` is the gate that
 * reports the capability as unavailable, and the scaffolder now runs doctor before
 * claiming the project is ready.
 */

import { spawnSync } from 'child_process';

const STEPS = [
  {
    label: 'Chromium + system dependencies',
    args: ['playwright', 'install', 'chromium', '--with-deps'],
    note: 'needs elevated privileges on Linux to install system libraries',
  },
  {
    label: 'Chromium only',
    args: ['playwright', 'install', 'chromium'],
    note: 'skips the privileged system-library step',
  },
];

function run(args) {
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    stdio: 'inherit',
    shell: false,
  });
  return result.status === 0;
}

if (process.env.CAREER_OPS_SKIP_BROWSER_INSTALL === '1') {
  console.log('→ Skipping Chromium install (CAREER_OPS_SKIP_BROWSER_INSTALL=1).');
  process.exit(0);
}

let installed = false;
for (const [index, step] of STEPS.entries()) {
  console.log(`\n→ Installing ${step.label} (${step.note}) ...`);
  if (run(step.args)) {
    installed = true;
    break;
  }
  if (index < STEPS.length - 1) {
    console.warn(`! ${step.label} failed — trying the next option.`);
  }
}

if (installed) {
  process.exit(0);
}

// Non-fatal by design: evaluation, scanning, and the tracker all work without it.
console.warn(`
! Chromium could not be installed automatically.

  career-ops still works for scanning, evaluation, and tracking. You need Chromium
  only for PDF generation and browser-based liveness checks.

  To install it yourself:
      npx playwright install chromium

  On Linux you may also need the system libraries:
      sudo npx playwright install chromium --with-deps

  Then confirm with:
      npm run doctor
`);
process.exit(0);
