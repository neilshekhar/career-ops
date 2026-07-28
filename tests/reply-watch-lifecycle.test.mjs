#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';
import { acquireTrackerLock, trackerLockDirFor } from '../tracker-utils.mjs';
import { applyConfirmedTrackerStatus } from '../reply-watch.mjs';

console.log('\nReply-watch canonical lifecycle guard');

const replySource = readFileSync(join(ROOT, 'reply-watch.mjs'), 'utf8');
assert(!/import\s*\{[^}]*rebuildRow/.test(replySource), 'reply-watch must not import a Markdown row writer');
assert(!/function\s+updateTrackerStatus\s*\(/.test(replySource), 'reply-watch must not implement a tracker writer');
assert(!/writeFileSync\s*\(\s*APPS_FILE/.test(replySource), 'reply-watch must never write applications.md directly');
assert(replySource.includes("'set-status.mjs'"), 'reply-watch must delegate to set-status.mjs');
assert(replySource.includes("'--external'"), 'reply-watch must declare confirmed replies external');
assert(replySource.includes("'--note'"), 'reply-watch must persist reply evidence');
pass('reply-watch has no direct applications.md mutation path');

const replyMode = readFileSync(join(ROOT, 'modes', 'reply-watch.md'), 'utf8');
assert.match(replyMode, /set-status\.mjs --external --note/);
assert.match(replyMode, /never rewrites `data\/applications\.md` itself/);
assert.doesNotMatch(replyMode, /script will rewrite the matched rows/i);
pass('reply-watch instructions expose the same canonical confirmation boundary');

let captured = null;
const helperResult = applyConfirmedTrackerStatus({
  appNum: 42,
  newStatus: 'Interview',
  note: '[reply-watch:msg-42] type=Interview; evidence=interview invitation',
}, {
  runner(command, args, options) {
    captured = { command, args, options };
    return {
      status: 0,
      stdout: JSON.stringify({ changed: true, num: 42, newStatus: 'Interview' }),
      stderr: '',
    };
  },
});
assert.equal(captured.command, process.execPath);
assert.deepEqual(captured.args.slice(1, 3), ['42', 'Interview']);
assert(captured.args.includes('--external'));
assert(captured.args.includes('--note'));
assert(captured.args.includes('--json'));
assert.equal(helperResult.num, 42);
assert.throws(
  () => applyConfirmedTrackerStatus({ appNum: 42, newStatus: 'Interview', note: '' }, { runner: () => null }),
  /missing reply evidence/,
);
pass('confirmed reply transitions use an exact numeric selector plus external evidence');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-reply-watch-'));
try {
  const tracker = join(temp, 'applications.md');
  const trackerDb = join(temp, 'applications.db');
  const candidates = join(temp, 'reply-candidates.json');
  const initialTracker = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 7 | 2026-07-01 | Acme Corp | Software Engineer | 4.5/5 | Applied | ✅ | [7](../reports/007-acme.md) | original note |',
    '',
  ].join('\n');
  writeFileSync(tracker, initialTracker);
  writeFileSync(candidates, JSON.stringify([{
    message_id: 'reply-7',
    from: 'recruiter@acmecorp.com',
    subject: 'Interview invitation for Software Engineer at Acme Corp',
    body_snippet: 'Please schedule an interview for the Software Engineer role.',
    signal: 'interview_invite',
  }], null, 2));

  const env = {
    ...process.env,
    CAREER_OPS_TRACKER: tracker,
    CAREER_OPS_TRACKER_DB: trackerDb,
  };
  const dryRun = spawnSync(process.execPath, [join(ROOT, 'reply-watch.mjs'), candidates, '--dry-run'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run — recommendations only; tracker unchanged/);
  assert.equal(readFileSync(tracker, 'utf8'), initialTracker);
  pass('reply-watch dry-run stays suggestion-only and does not prompt or mutate');

  const confirmed = spawnSync(process.execPath, [join(ROOT, 'reply-watch.mjs'), candidates], {
    cwd: ROOT,
    env,
    input: 'yes\n',
    encoding: 'utf8',
  });
  assert.equal(confirmed.status, 0, `${confirmed.stdout}\n${confirmed.stderr}`);
  const updated = readFileSync(tracker, 'utf8');
  assert.match(updated, /\| Interview \|/);
  assert.match(updated, /\[reply-watch:reply-7\] type=Interview; evidence=/);
  assert.match(updated, /\[external-status\]/);
  assert.match(updated, /original note/);
  pass('user-confirmed reply is persisted through set-status with durable provenance');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const normalizeSource = readFileSync(join(ROOT, 'normalize-statuses.mjs'), 'utf8');
// The normalizer reaches the shared lock through openTrackerTransaction (upstream #1912)
// rather than calling acquireTrackerLock/writeFileAtomic itself. Assert the whole chain —
// the call site here AND the guarantee inside the helper — so neither half can regress
// silently: dropping the lock or the atomic replace from tracker-utils.mjs still fails.
const trackerUtilsSource = readFileSync(join(ROOT, 'tracker-utils.mjs'), 'utf8');
const transactionBody = trackerUtilsSource.slice(trackerUtilsSource.indexOf('export async function openTrackerTransaction('));
assert(transactionBody.length > 0, 'tracker-utils.mjs must export openTrackerTransaction');
assert(normalizeSource.includes('openTrackerTransaction(APPS_FILE)'), 'normalizer must open a tracker transaction on the canonical tracker');
assert(transactionBody.includes('acquireTrackerLock('), 'tracker transaction must acquire the shared tracker lock');
assert(transactionBody.includes('trackerLockDirFor('), 'tracker transaction must use the canonical tracker lock key');
assert(transactionBody.includes('writeFileAtomic('), 'tracker transaction must atomically replace the tracker');
assert(/trackerTransaction\??\.replace\(/.test(normalizeSource), 'normalizer must write through the transaction, not a direct file write');
assert(/trackerTransaction\??\.close\(\)/.test(normalizeSource), 'normalizer must release the tracker lock in a finally block');
assert(normalizeSource.includes('[status-normalized:'), 'normalizer must add migration provenance');
assert(normalizeSource.includes("'[external-status]'"), 'progression migrations must be marked external');
assert(!/writeFileSync\s*\(\s*APPS_FILE/.test(normalizeSource), 'normalizer must not use a bare tracker write');
pass('status normalizer is locked, atomic, and provenance-bearing');

const normalizeTemp = mkdtempSync(join(tmpdir(), 'career-ops-normalize-'));
try {
  const tracker = join(normalizeTemp, 'applications.md');
  const initial = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|----------|-------|--------|-----|--------|-------|',
    '| 11 | 2026-07-02 | Globex | Data Analyst | Melbourne | **4.2/5** | Aplicado 2026-07-02 | ✅ | [11](../reports/011-globex.md) | keep me |',
    '| 12 | 2026-07-03 | Initech | BI Analyst | Sydney | 4.0/5 | **Interview** | ✅ | [12](../reports/012-initech.md) | [application-receipt:receipt-12] |',
    '',
  ].join('\n');
  writeFileSync(tracker, initial);

  const canonicalTracker = realpathSync(tracker);
  const lock = await acquireTrackerLock(trackerLockDirFor(canonicalTracker), {
    timeoutMs: 500,
    retryMs: 10,
    tracker: canonicalTracker,
  });
  try {
    const blocked = spawnSync(process.execPath, [join(ROOT, 'normalize-statuses.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: tracker,
        CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '80',
        CAREER_OPS_TRACKER_LOCK_RETRY_MS: '10',
      },
      encoding: 'utf8',
    });
    assert.notEqual(blocked.status, 0, 'normalizer should fail closed while another writer owns the lock');
    assert.equal(readFileSync(tracker, 'utf8'), initial);
  } finally {
    lock.release();
  }
  pass('status normalizer cannot race an existing canonical tracker writer');

  const normalized = spawnSync(process.execPath, [join(ROOT, 'normalize-statuses.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_TRACKER: tracker },
    encoding: 'utf8',
  });
  assert.equal(normalized.status, 0, normalized.stderr);
  const result = readFileSync(tracker, 'utf8');
  assert.match(result, /\| Melbourne \| 4\.2\/5 \| Applied \|/);
  assert.match(result, /keep me/);
  assert.match(result, /\[status-normalized:Aplicado 2026-07-02->Applied\]/);
  assert.match(result, /\[external-status\]/);
  const receiptRow = result.split('\n').find((line) => line.includes('| 12 |'));
  assert.match(receiptRow, /\[application-receipt:receipt-12\]/);
  assert.match(receiptRow, /\[status-normalized:Interview->Interview\]/);
  assert(!receiptRow.includes('[external-status]'), 'receipt-backed history must retain receipt provenance');
  assert(existsSync(`${tracker}.bak`), 'normalizer should preserve its migration backup');
  pass('status normalizer preserves custom columns and records exact migration provenance');
} finally {
  rmSync(normalizeTemp, { recursive: true, force: true });
}
