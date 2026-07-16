#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass } from './helpers.mjs';

console.log('\nApplication finalization crash recovery');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-finalization-recovery-'));
const reportsDir = join(temp, 'reports');
const reportPath = join(reportsDir, '001-recovery.md');
const handoverPath = join(temp, 'handover.md');
mkdirSync(reportsDir, { recursive: true });

const roleId = 'recovery:analyst';
const runId = 'recovery-run-1';
const receiptId = `application-receipt:${roleId}:${runId}`;
writeFileSync(reportPath, [
  '# Recovery Co — Analyst',
  '',
  '## Application Answers',
  '',
  '**Date:** 2026-07-16',
  '**State:** filled',
  `**Run ID:** ${runId}`,
  '**Receipt pages:** 1',
  '',
].join('\n'), 'utf8');
writeFileSync(handoverPath, [
  '# Handover',
  '',
  '## Application Compliance Receipts',
  '',
  `- <!-- ${receiptId} --> orphaned finalization side effect`,
  '',
].join('\n'), 'utf8');

const previous = {
  nodeEnv: process.env.NODE_ENV,
  reports: process.env.CAREER_OPS_REPORTS_DIR,
  handover: process.env.CAREER_OPS_HANDOVER_PATH,
  projectRoot: process.env.CAREER_OPS_TEST_PROJECT_ROOT,
};
process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_REPORTS_DIR = reportsDir;
process.env.CAREER_OPS_HANDOVER_PATH = handoverPath;
process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

try {
  const receipt = await import(`../application-receipt.mjs?recovery=${Date.now()}`);
  const transaction = {
    version: 1,
    state: 'staged',
    role_id: roleId,
    run_id: runId,
    report_path: reportPath,
    receipt_id: receiptId,
  };

  receipt.recoverStagedFinalizationArtifacts(transaction);
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* prefilled/);
  assert.doesNotMatch(readFileSync(handoverPath, 'utf8'), new RegExp(receiptId));
  pass('a durable staged transaction removes orphaned filled report and handover side effects');

  assert.doesNotThrow(() => receipt.recoverStagedFinalizationArtifacts(transaction));
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* prefilled/);
  pass('crash recovery is idempotent and safe to retry before finalization');
} finally {
  if (previous.nodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous.nodeEnv;
  if (previous.reports == null) delete process.env.CAREER_OPS_REPORTS_DIR;
  else process.env.CAREER_OPS_REPORTS_DIR = previous.reports;
  if (previous.handover == null) delete process.env.CAREER_OPS_HANDOVER_PATH;
  else process.env.CAREER_OPS_HANDOVER_PATH = previous.handover;
  if (previous.projectRoot == null) delete process.env.CAREER_OPS_TEST_PROJECT_ROOT;
  else process.env.CAREER_OPS_TEST_PROJECT_ROOT = previous.projectRoot;
  rmSync(temp, { recursive: true, force: true });
}
