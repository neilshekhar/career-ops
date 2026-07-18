#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass } from './helpers.mjs';

const IS_CHILD = process.env.CAREER_OPS_MANUAL_SUBMISSION_CHILD === '1';

function validProvenance(priorStatus = 'prepared') {
  return {
    version: 1,
    source: 'candidate-dashboard',
    confirmation: 'I submitted this application in the portal',
    confirmed_at: new Date().toISOString(),
    prior_status: priorStatus,
    transaction_id: 'candidate-decision:test-role:submitted:test',
  };
}

async function runIsolated() {
  const temp = mkdtempSync(join(tmpdir(), 'career-ops-manual-submit-'));
  const dataDir = join(temp, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(temp, 'handover.md'), '# Handover\n', 'utf8');

  writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
    version: 1,
    settings: {},
    roles: [
      {
        id: 'manual-prepared', company: 'Manual Co', title: 'Analyst',
        url: 'https://jobs.test/manual-prepared', status: 'prepared',
      },
      {
        id: 'manual-scored', company: 'Scored Co', title: 'Engineer',
        url: 'https://jobs.test/manual-scored', status: 'scored', score: 4.1,
      },
      {
        id: 'manual-skipped', company: 'Skipped Co', title: 'Scientist',
        url: 'https://jobs.test/manual-skipped', status: 'skipped',
      },
      {
        id: 'stuck-finalization', company: 'Stuck Co', title: 'Data Engineer',
        url: 'https://jobs.test/stuck-finalization', status: 'prepared',
        application_finalization_transaction: {
          version: 1,
          transaction_id: 'application-finalization:stuck-finalization:stale-run',
          role_id: 'stuck-finalization', run_id: 'stale-run',
          payload_digest: 'not-a-real-digest', state: 'staged',
          attempts: 3, started_at: '2026-07-18T00:00:00.000Z',
          updated_at: '2026-07-18T00:00:00.000Z',
        },
      },
      {
        id: 'committed-finalization', company: 'Done Co', title: 'BI Analyst',
        url: 'https://jobs.test/committed-finalization', status: 'prepared',
        application_finalization_transaction: {
          version: 1,
          transaction_id: 'application-finalization:committed-finalization:run',
          role_id: 'committed-finalization', run_id: 'run',
          payload_digest: 'digest', state: 'committed',
          attempts: 1, started_at: '2026-07-18T00:00:00.000Z',
          updated_at: '2026-07-18T00:00:00.000Z',
        },
      },
    ],
  }, null, 2) + '\n', 'utf8');

  process.env.NODE_ENV = 'test';
  process.env.CAREER_OPS_QUEUE_BACKEND = 'local';
  process.env.CAREER_OPS_DATA_DIR = dataDir;
  process.env.CAREER_OPS_HANDOVER_PATH = join(temp, 'handover.md');
  process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

  try {
    const store = await import('../queue-store.mjs');
    const receipt = await import('../application-receipt.mjs');

    // -- Provenance validator --------------------------------------------------
    assert.equal(store.manualSubmissionProvenanceError({ manual_submission: validProvenance() }), null);
    assert.match(store.manualSubmissionProvenanceError({}), /provenance is missing/);
    assert.match(
      store.manualSubmissionProvenanceError({ manual_submission: { ...validProvenance(), confirmation: 'yes' } }),
      /typed candidate confirmation/,
    );
    assert.match(
      store.manualSubmissionProvenanceError({ manual_submission: { ...validProvenance(), source: 'agent' } }),
      /source/,
    );
    assert.match(
      store.manualSubmissionProvenanceError({ manual_submission: validProvenance('skipped') }),
      /prior_status/,
    );
    assert.match(
      store.manualSubmissionProvenanceError({ manual_submission: { ...validProvenance(), transaction_id: ' ' } }),
      /transaction id/,
    );

    // -- setStatus: manual provenance authorizes submitted from active stages --
    store.mutateQueue((queue) => {
      const role = queue.roles.find((r) => r.id === 'manual-prepared');
      role.manual_submission = validProvenance('prepared');
      assert.equal(store.setStatus(queue, role.id, 'submitted'), true);
      assert.equal(role.status, 'submitted');
    });
    const persisted = JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'));
    const submittedRole = persisted.roles.find((r) => r.id === 'manual-prepared');
    assert.equal(submittedRole.status, 'submitted');
    assert.equal(submittedRole.manual_submission.source, 'candidate-dashboard');

    // -- setStatus: no provenance still requires receipt-gated filled ----------
    assert.throws(
      () => store.mutateQueue((queue) => {
        store.setStatus(queue, 'manual-scored', 'submitted');
      }),
      /receipt-gated filled state or candidate/,
    );

    // -- setStatus: manual provenance never revives a done role ----------------
    assert.throws(
      () => store.mutateQueue((queue) => {
        const role = queue.roles.find((r) => r.id === 'manual-skipped');
        role.manual_submission = validProvenance('prepared');
        store.setStatus(queue, role.id, 'submitted');
      }),
      /active role/,
    );

    // -- Persistence boundary: provenance cannot bypass setStatus --------------
    assert.throws(
      () => store.mutateQueue((queue) => {
        const role = queue.roles.find((r) => r.id === 'manual-scored');
        role.manual_submission = validProvenance('scored');
        role.status = 'submitted';
      }),
      /must be entered through queue-store\.setStatus/,
    );

    // -- repair-finalization: clears a stuck staged transaction ----------------
    const repaired = receipt.repairFinalizationTransaction('stuck-finalization');
    assert.equal(repaired.status, 'prepared');
    assert.equal(repaired.archived_transaction_id, 'application-finalization:stuck-finalization:stale-run');
    const afterRepair = JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'));
    const repairedRole = afterRepair.roles.find((r) => r.id === 'stuck-finalization');
    assert.equal(repairedRole.application_finalization_transaction, undefined);
    assert.equal(repairedRole.application_receipt_repairs.length, 1);
    assert.equal(repairedRole.application_receipt_repairs[0].kind, 'finalization-transaction');
    assert.equal(
      repairedRole.application_receipt_repairs[0].finalization_transaction.transaction_id,
      'application-finalization:stuck-finalization:stale-run',
    );

    // -- repair-finalization refusals ------------------------------------------
    assert.throws(
      () => receipt.repairFinalizationTransaction('committed-finalization'),
      /committed finalization transaction/,
    );
    assert.throws(
      () => receipt.repairFinalizationTransaction('manual-scored'),
      /no application finalization transaction/,
    );

    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (IS_CHILD) {
  await runIsolated();
} else {
  console.log('\nCandidate manual submission + finalization repair');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: join(fileURLToPath(new URL('.', import.meta.url)), '..'),
    env: { ...process.env, CAREER_OPS_MANUAL_SUBMISSION_CHILD: '1' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
  assert.equal(result.ok, true);
  pass('candidate manual-submission provenance and --repair-finalization behave per contract');
}
