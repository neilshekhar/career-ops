#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { pass } from './helpers.mjs';

console.log('\nQueue receipt transition guard');

// ── Cross-drive containment ────────────────────────────────────────────────
// The Windows CI leg put the repo on D: and the OS temp dir on C:. path.relative()
// between two different drives returns the ABSOLUTE target rather than a '..'
// walk, so a containment guard built only from "falsy / starts with .. /
// round-trips through resolve()" passes a file on another drive as contained —
// application-receipt-integrity.mjs accepted a caller-authored report artifact
// that way. The isAbsolute() rung is the only one that catches it. Assert the
// invariant under win32 semantics so it holds on every platform, and prove the
// rung is load-bearing rather than decorative.
{
  const root = 'D:\\a\\career-ops\\career-ops\\reports';
  const otherDrive = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\co\\report.md';
  const rel = win32.relative(root, otherDrive);

  assert.ok(rel, 'precondition: a cross-drive relative path is not empty');
  assert.ok(!rel.startsWith('..'), 'precondition: it does not start with ..');
  assert.equal(win32.resolve(root, rel), otherDrive,
    'precondition: it round-trips through resolve(), so that rung cannot catch it either');

  const withoutIsAbsolute = !(!rel || rel.startsWith('..') || win32.resolve(root, rel) !== otherDrive);
  const withIsAbsolute = !(!rel || rel.startsWith('..') || win32.isAbsolute(rel)
    || win32.resolve(root, rel) !== otherDrive);
  assert.equal(withoutIsAbsolute, true, 'the pre-fix guard shape wrongly treats another drive as contained');
  assert.equal(withIsAbsolute, false, 'the isAbsolute rung is what rejects it');
  pass('cross-drive paths are only excluded by the isAbsolute rung, so containment guards must keep it');
}

const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-queue-receipt-'));
const queuePath = join(dataDir, 'apply-queue.json');
const legacyRole = {
  id: 'legacy:submitted',
  company: 'Legacy Co',
  title: 'Legacy Role',
  url: 'https://example.com/legacy',
  ats: 'custom',
  status: 'submitted',
  // Deliberately no application_progress: this row predates receipts.
};

writeFileSync(queuePath, JSON.stringify({
  version: 1,
  settings: { counter: 0 },
  roles: [legacyRole],
}, null, 2) + '\n');
const outsideReportPath = join(dataDir, 'caller-authored-report.md');
writeFileSync(outsideReportPath, [
  '# Caller-authored report',
  '',
  '## Application Answers',
  '',
  '**State:** filled',
  '**Run ID:** run-1',
  '**Receipt pages:** 1',
  '',
].join('\n'), 'utf8');

const oldData = process.env.CAREER_OPS_DATA_DIR;
const oldBackend = process.env.CAREER_OPS_QUEUE_BACKEND;
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';

function finalizedReceipt(reportState) {
  const receiptId = 'application-receipt:test:run-1';
  return {
    review_ready: true,
    finalized_at: '2026-07-16T01:00:00.000Z',
    report_state_finalized_at: '2026-07-16T01:00:00.000Z',
    report_state: reportState,
    application_answers_report: outsideReportPath,
    handover_receipt_id: receiptId,
    receipt_id: receiptId,
    assets_verified: true,
    pages: [{ final_page: true }],
    integrity: {
      version: 1,
      algorithm: 'sha256',
      contract: 'career-ops/application-receipt-integrity/v1',
      expected_report_state: reportState,
      sealed_at: '2026-07-16T01:00:00.000Z',
      artifacts: {
        report: {
          path: outsideReportPath,
          state: reportState,
          run_id: 'run-1',
          page_count: 1,
          section_sha256: '0'.repeat(64),
        },
        handover: {
          receipt_id: receiptId,
          line_sha256: '0'.repeat(64),
        },
      },
      digest: '0'.repeat(64),
    },
    ...(reportState === 'submitted'
      ? { submission_confirmed_at: '2026-07-16T01:05:00.000Z' }
      : {}),
  };
}

try {
  const queueUrl = new URL(`../queue-store.mjs?receipt-guard=${Date.now()}`, import.meta.url).href;
  const store = await import(queueUrl);

  const direct = store.loadQueue();
  direct.settings.direct_touch = true;
  assert.doesNotThrow(() => store.saveQueue(direct));
  assert.equal(JSON.parse(readFileSync(queuePath, 'utf8')).roles[0].status, 'submitted');

  assert.doesNotThrow(() => store.mutateQueue((queue) => {
    queue.settings.counter = (queue.settings.counter ?? 0) + 1;
  }));
  const afterLegacyMutation = JSON.parse(readFileSync(queuePath, 'utf8'));
  assert.equal(afterLegacyMutation.settings.counter, 1);
  assert.equal(afterLegacyMutation.roles[0].status, 'submitted');
  assert.equal(afterLegacyMutation.roles[0].application_progress, undefined);
  pass('unchanged legacy submitted rows do not block unrelated direct saves or locked mutations');

  store.mutateQueue((queue) => {
    store.appendRole(queue, {
      id: 'modern:prepared',
      company: 'Modern Co',
      title: 'Modern Role',
      url: 'https://example.com/modern',
      ats: 'custom',
      status: 'prepared',
    });
  });

  const directBypass = store.loadQueue();
  const directRole = store.getById(directBypass, 'modern:prepared');
  directRole.application_progress = finalizedReceipt('filled');
  directRole.status = 'filled';
  assert.throws(
    () => store.saveQueue(directBypass),
    /protected status filled must be entered through queue-store\.setStatus/,
  );
  assert.equal(store.getById(store.loadQueue(), 'modern:prepared').status, 'prepared');
  pass('direct saveQueue mutation cannot bypass the protected filled transition, even with receipt-shaped data');

  assert.throws(
    () => store.mutateQueue((queue) => {
      const role = store.getById(queue, 'modern:prepared');
      role.application_progress = finalizedReceipt('submitted');
      role.status = 'submitted';
    }),
    /protected status submitted must be entered through queue-store\.setStatus/,
  );
  assert.equal(store.getById(store.loadQueue(), 'modern:prepared').status, 'prepared');
  pass('locked mutations cannot bypass the protected submitted transition with a bare assignment');

  const missingEvidence = store.loadQueue();
  assert.throws(
    () => store.setStatus(missingEvidence, 'modern:prepared', 'filled'),
    /finalized review-ready application receipt/,
  );
  pass('setStatus capability still rejects a new filled transition without finalized evidence');

  const validFilled = store.loadQueue();
  const validFilledRole = store.getById(validFilled, 'modern:prepared');
  validFilledRole.application_progress = finalizedReceipt('filled');
  assert.throws(
    () => store.setStatus(validFilled, 'modern:prepared', 'filled'),
    /canonical reports\/ root/,
  );
  assert.equal(store.getById(store.loadQueue(), 'modern:prepared').status, 'prepared');
  pass('a shallow /tmp receipt plus a caller-authored hash cannot authorize filled');

  const validSubmitted = store.loadQueue();
  const validSubmittedRole = store.getById(validSubmitted, 'modern:prepared');
  validSubmittedRole.application_progress = finalizedReceipt('submitted');
  validSubmittedRole.status = 'filled';
  assert.throws(
    () => store.setStatus(validSubmitted, 'modern:prepared', 'submitted'),
    /canonical reports\/ root/,
  );
  assert.equal(store.getById(store.loadQueue(), 'modern:prepared').status, 'prepared');
  pass('a shallow /tmp receipt plus a caller-authored hash cannot authorize submitted');
} finally {
  if (oldData == null) delete process.env.CAREER_OPS_DATA_DIR;
  else process.env.CAREER_OPS_DATA_DIR = oldData;
  if (oldBackend == null) delete process.env.CAREER_OPS_QUEUE_BACKEND;
  else process.env.CAREER_OPS_QUEUE_BACKEND = oldBackend;
  rmSync(dataDir, { recursive: true, force: true });
}
