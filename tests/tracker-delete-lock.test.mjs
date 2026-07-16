#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';
import { acquireTrackerLock, canonicalizeTrackerPath, writeFileAtomic } from '../tracker-utils.mjs';

console.log('\nTracker delete shared-lock gate');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-tracker-delete-'));
const tracker = join(temp, 'applications.md');
const db = join(temp, 'applications.db');
const lockPath = join(temp, `career-ops-merge-tracker-delete-${process.pid}.lock`);
const header = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];
const deleteRow = '| 1 | 2026-07-16 | DeleteCo | Analyst | 4.0/5 | Evaluated | ❌ | [job](https://jobs.test/delete) | |';
const keepRow = '| 2 | 2026-07-16 | KeepCo | Engineer | 4.2/5 | Evaluated | ❌ | [job](https://jobs.test/keep) | |';
const concurrentRow = '| 3 | 2026-07-16 | ConcurrentCo | Scientist | 4.4/5 | Evaluated | ❌ | [job](https://jobs.test/concurrent) | |';
const initial = [...header, deleteRow, keepRow, ''].join('\n');
writeFileSync(tracker, initial, 'utf8');

let lock = null;
try {
  lock = await acquireTrackerLock(lockPath, {
    timeoutMs: 5_000,
    retryMs: 20,
    staleMs: 60_000,
    tracker: canonicalizeTrackerPath(tracker),
  });

  let stderr = '';
  const child = spawn(process.execPath, [join(ROOT, 'tracker.mjs'), 'delete', '--num', '1'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: tracker,
      CAREER_OPS_TRACKER_DB: db,
      CAREER_OPS_TRACKER_LOCK: lockPath,
      CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '5000',
      CAREER_OPS_TRACKER_LOCK_RETRY_MS: '20',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null, 'delete process bypassed the held shared tracker lock');
  assert.equal(readFileSync(tracker, 'utf8'), initial, 'delete mutated the tracker while another writer held the lock');

  // Simulate the current lock owner committing a concurrent canonical update.
  // The waiting delete must read this newer snapshot after it acquires the lock.
  writeFileAtomic(tracker, [...header, deleteRow, keepRow, concurrentRow, ''].join('\n'));
  lock.release();
  lock = null;

  const result = await exited;
  assert.equal(result.signal, null, `delete process was terminated by ${result.signal}`);
  assert.equal(result.code, 0, stderr);
  const final = readFileSync(tracker, 'utf8');
  assert.doesNotMatch(final, /\| 1 \|[^\n]*DeleteCo/);
  assert.match(final, /\| 2 \|[^\n]*KeepCo/);
  assert.match(final, /\| 3 \|[^\n]*ConcurrentCo/);
  pass('tracker delete waits for the shared lock and preserves a concurrent canonical update');
} finally {
  lock?.release();
  rmSync(temp, { recursive: true, force: true });
}
