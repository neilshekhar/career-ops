#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass } from './helpers.mjs';

const IS_CHILD = process.env.CAREER_OPS_APPLICATION_REPAIR_CHILD === '1';

async function runIsolatedRepair() {
  const temp = mkdtempSync(join(tmpdir(), 'career-ops-repair-'));
  const dataDir = join(temp, 'data');
  const reportsDir = join(temp, 'reports');
  const reportPath = join(reportsDir, '001-broken.md');
  const handoverPath = join(temp, 'handover.md');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  writeFileSync(reportPath, [
    '# Broken report', '', '## Application Answers', '',
    '**Date:** 2026-07-16', '**State:** filled', '**Run ID:** broken-run',
    '**Receipt pages:** 0', '', '### Free-text answers', '', '- None captured.', '',
    '### Selections made', '', '- None captured.', '', '### Other field values', '',
    '- None captured.', '', '### Files used', '', '- None captured.', '',
  ].join('\n'), 'utf8');
  writeFileSync(
    handoverPath,
    '# Handover\n\n## Application Compliance Receipts\n\n- <!-- broken-receipt --> stale invalid receipt\n',
    'utf8',
  );
  writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
    version: 1,
    settings: {},
    roles: [{
      id: 'broken-role', company: 'Broken Co', title: 'Analyst',
      url: 'https://jobs.test/broken', status: 'filled',
      application_request: {
        version: 1, request_id: 'broken-run:broken-role', run_id: 'broken-run',
        role_id: 'broken-role', source: 'dashboard-fill', state: 'review-ready',
        controller: 'active-agent', controller_id: 'browser-controller:test',
        requested_at: '2026-07-16T00:00:00.000Z',
      },
      application_progress: {
        version: 1, run_id: 'broken-run', role_id: 'broken-role',
        receipt_id: 'broken-receipt', handover_receipt_id: 'broken-receipt',
        report_state: 'filled', application_answers_report: reportPath,
        review_ready: true, pages: [],
      },
    }],
  }, null, 2) + '\n', 'utf8');

  process.env.NODE_ENV = 'test';
  process.env.CAREER_OPS_QUEUE_BACKEND = 'local';
  process.env.CAREER_OPS_DATA_DIR = dataDir;
  process.env.CAREER_OPS_REPORTS_DIR = reportsDir;
  process.env.CAREER_OPS_HANDOVER_PATH = handoverPath;
  process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

  try {
    const receipt = await import(`../application-receipt.mjs?repair=${Date.now()}`);
    const result = receipt.repairFilledRole('broken-role');
    const role = JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8')).roles[0];
    assert.equal(result.status, 'prepared');
    assert.equal(role.status, 'prepared');
    assert.equal(role.application_progress, undefined);
    assert.equal(role.application_request, undefined);
    assert.equal(role.application_receipt_repairs.length, 1);
    assert(role.application_receipt_repairs[0].errors.length > 0);
    assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* prefilled/i);
    assert.doesNotMatch(readFileSync(handoverPath, 'utf8'), /broken-receipt/);
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (IS_CHILD) {
  await runIsolatedRepair();
} else {
  console.log('\nInvalid filled receipt repair');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: join(fileURLToPath(new URL('.', import.meta.url)), '..'),
    env: { ...process.env, CAREER_OPS_APPLICATION_REPAIR_CHILD: '1' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
  assert.equal(result.ok, true);
  pass('invalid filled evidence is archived, demoted to prepared, and cleaned without overwriting history');
}
