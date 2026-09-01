#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { pass, warn, ROOT } from './helpers.mjs';

console.log('\nDashboard Portal CV toggle integration');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForDashboard(child, origin) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`dashboard did not start: ${output.trim()}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(origin)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`dashboard exited early (${code}): ${output.trim()}`));
    });
  });
}

// CI installs with `npm install --ignore-scripts`, which skips the postinstall
// that downloads Playwright's Chromium (.github/workflows/test.yml). Degrade to
// a warning there rather than reddening the gate for a missing browser — but
// warn, never pass, so a skipped run is never mistaken for a verified one.
// Locally this is the only test that proves the toggle actually renders.
function chromiumExecutable() {
  try {
    const path = chromium.executablePath();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

if (!chromiumExecutable()) {
  warn('dashboard Portal CV toggle — SKIPPED: Playwright Chromium is not installed (`npx playwright install chromium`)');
} else {

const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-portal-cv-dashboard-'));
const queuePath = join(dataDir, 'apply-queue.json');
writeFileSync(queuePath, `${JSON.stringify({
  version: 1,
  settings: { score_threshold: 4 },
  roles: [],
}, null, 2)}\n`, 'utf8');

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dashboard-server.mjs', '--port', String(port)], {
  cwd: ROOT,
  env: {
    ...process.env,
    CAREER_OPS_DATA_DIR: dataDir,
    CAREER_OPS_QUEUE_BACKEND: 'local',
    DOTENV_CONFIG_PATH: join(dataDir, 'no-env-file'),
    DOTENV_CONFIG_QUIET: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  await waitForDashboard(child, origin);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  const button = page.locator('#btn-portal-default-cv');
  await button.waitFor({ state: 'visible' });
  await page.waitForFunction(() => (
    document.querySelector('#btn-portal-default-cv')?.textContent?.includes('off')
  ));
  assert.equal(await button.getAttribute('class').then((value) => (value || '').includes('active')), false);

  await button.click();
  await page.waitForFunction(() => (
    document.querySelector('#btn-portal-default-cv')?.textContent?.includes('Seek/Indeed')
    && document.querySelector('#btn-portal-default-cv')?.classList.contains('active')
  ));
  let persisted = JSON.parse(readFileSync(queuePath, 'utf8'));
  assert.equal(persisted.settings.portal_default_cv, true);
  assert.deepEqual(persisted.roles, []);

  await button.click();
  await page.waitForFunction(() => (
    document.querySelector('#btn-portal-default-cv')?.textContent?.includes('off')
    && !document.querySelector('#btn-portal-default-cv')?.classList.contains('active')
  ));
  persisted = JSON.parse(readFileSync(queuePath, 'utf8'));
  assert.equal(persisted.settings.portal_default_cv, false);
  assert.deepEqual(persisted.roles, []);
  assert.deepEqual(pageErrors, []);

  pass('button renders, toggles on/off, persists only the setting, and raises no page errors');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else child.once('exit', resolve);
  });
  rmSync(dataDir, { recursive: true, force: true });
}
}
