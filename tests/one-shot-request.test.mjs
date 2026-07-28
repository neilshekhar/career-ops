#!/usr/bin/env node
/**
 * tests/one-shot-request.test.mjs — Finding 1 acceptance tests.
 *
 * The durable One-shot chain: a candidate's single Run click authorizes
 * deep-eval → PREPARE → machine asset gate → live fill → `prefilled`, and the
 * authorization survives an agent restart without a second click.
 *
 * The eight acceptance criteria from FINDINGS-2026-07-28 Finding 1:
 *   1. prepare-queued + One-shot + confirmed Run writes one durable request
 *   2. Repeating Run is idempotent
 *   3. The role passes gate → fill and ends prefilled
 *   4. A simulated crash after PREPARE resumes from durable state
 *   5. More than four roles drain in batches of at most four
 *   6. A failed asset gate cannot create an application_request
 *   7. Turning One-shot on never selects a role by itself
 *   8. No path clicks or bypasses the final submission control
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, ROOT } from './helpers.mjs';

const IS_CHILD = process.env.CAREER_OPS_ONE_SHOT_CHILD === '1';

async function runIsolated() {
console.log('\nOne-shot durable request state machine');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-one-shot-'));
const dataDir = join(temp, 'data');
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(temp, 'config'), { recursive: true });
mkdirSync(join(temp, 'modes'), { recursive: true });
mkdirSync(join(temp, 'output'), { recursive: true });
mkdirSync(join(temp, 'jds'), { recursive: true });
mkdirSync(join(temp, 'reports'), { recursive: true });

process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_HANDOVER_PATH = join(temp, 'handover.md');
process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

writeFileSync(join(temp, 'handover.md'), '# Handover\n\n## Session Log\n', 'utf8');
writeFileSync(join(temp, 'cv.md'), '# CV\nSQL analysis and stakeholder reporting evidence.\n', 'utf8');
writeFileSync(join(temp, 'modes', '_profile.md'), '# Profile\n', 'utf8');
writeFileSync(join(temp, 'modes', '_custom.md'), '# Rules\n', 'utf8');
writeFileSync(join(temp, 'voice-dna.md'), [
  '# Voice',
  'Clear and direct.',
  '<!-- career-ops:banned-terms:begin -->',
  '```text',
  'delve, synergy',
  '```',
  '<!-- career-ops:banned-terms:end -->',
  '',
].join('\n'), 'utf8');
writeFileSync(join(temp, 'config', 'profile.yml'), [
  'candidate:',
  '  full_name: Test Candidate',
  'application_quality:',
  '  require_fresh_assets: false',
  '  cover_body_words_min: 1',
  '  cover_body_words_max: 500',
  '  cover_required_formats: [md, pdf]',
  '',
].join('\n'), 'utf8');

try {
  const {
    buildPdfLayoutEvidence,
    persistPdfLayoutEvidence,
    printablePageBox,
  } = await import('../generation-provenance.mjs');
  const { buildMarkdown } = await import('../generate-cover-markdown.mjs');
  const store = await import('../queue-store.mjs');
  const oneShot = await import('../one-shot-request.mjs');
  const lean = await import('../lean-application.mjs');
  const { MAX_ACTIVE_APPLICATION_REQUESTS } = await import('../application-request.mjs');

  const PDF_FIXTURE = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
  function writePdfFixture(path) {
    writeFileSync(path, PDF_FIXTURE);
    const printable = printablePageBox('a4');
    persistPdfLayoutEvidence(path, buildPdfLayoutEvidence({
      pdfPath: path,
      pdfBuffer: PDF_FIXTURE,
      format: 'a4',
      pageCount: 1,
      measurement: {
        top_px: 0,
        bottom_px: printable.height_px * 0.9,
        height_px: printable.height_px * 0.9,
      },
      measuredAt: new Date('2026-07-16T00:00:00.000Z'),
    }));
  }

  const jdText = (
    'Example Co needs an analyst to deliver reliable SQL reporting, translate stakeholder '
    + 'requirements, validate data quality, document decisions, and communicate findings clearly. '
  ).repeat(6);
  writeFileSync(join(temp, 'jds', 'analyst.md'), jdText, 'utf8');

  // Build a full, gate-passing asset set for one role. Paths are stored
  // repo-relative because `resolveApplicationAsset` only accepts `output/…`
  // inside the project root — a local source CV elsewhere on disk is rejected.
  function assetsFor(slug, company) {
    const cvPdf = join(temp, 'output', `${slug}-cv.pdf`);
    const cvHtml = join(temp, 'output', `${slug}-cv.html`);
    const coverMd = join(temp, 'output', `${slug}-cover.md`);
    const coverPdf = join(temp, 'output', `${slug}-cover.pdf`);
    const coverPayload = join(temp, 'output', `${slug}-cover.payload.json`);
    writePdfFixture(cvPdf);
    writePdfFixture(coverPdf);
    writeFileSync(
      cvHtml,
      `<html><head><meta name="career-ops-template-id" content="cv-template">`
        + `<meta name="career-ops-template-version" content="1"></head>`
        + `<body>${company} SQL analysis and stakeholder reporting.</body></html>`,
      'utf8',
    );
    const payload = {
      candidate: { name: 'Test Candidate' },
      letter: {
        company,
        role_title: 'Analyst',
        opening: `I am applying to ${company} because this matches my analytics evidence.`,
        profile_intro: 'I bring reliable SQL reporting and stakeholder communication.',
        achievements: [],
        problems_section: '',
        closing: 'Thank you for reviewing my application.',
      },
    };
    writeFileSync(coverMd, buildMarkdown(payload), 'utf8');
    writeFileSync(coverPayload, JSON.stringify(payload), 'utf8');
    return {
      cv_pdf: `output/${slug}-cv.pdf`,
      cover_letter_paths: {
        md: `output/${slug}-cover.md`,
        pdf: `output/${slug}-cover.pdf`,
        payload: `output/${slug}-cover.payload.json`,
      },
    };
  }

  // The gate always runs against the project root the modules were pointed at.
  const gateOptions = { root: temp };

  function baseRole(id, company, status, extra = {}) {
    return {
      id,
      company,
      title: 'Analyst',
      url: `https://jobs.example.test/${id}`,
      status,
      score: 4.4,
      flags: [],
      jd_path: 'jds/analyst.md',
      jd_text: jdText,
      ...extra,
    };
  }

  function confirmSelection(role, intentId, options = {}) {
    const roleIds = options.roleIds || [role.id];
    const roleStates = options.roleStates || Object.fromEntries(
      roleIds.map((id) => [id, id === role.id ? role.status : 'prepared']),
    );
    role.candidate_selection_confirmation = {
      version: 1,
      intent_id: intentId,
      action: options.action || 'run',
      role_ids: roleIds,
      role_states: roleStates,
      source: options.source || 'dashboard-run',
      confirmed_at: '2026-07-28T00:00:00.000Z',
      consumed_at: '2026-07-28T00:00:01.000Z',
    };
  }

  function writeQueue(roles, settings = {}) {
    writeFileSync(join(dataDir, 'apply-queue.json'), `${JSON.stringify({
      version: 1,
      settings: { score_threshold: null, auto_fill_all: false, ...settings },
      roles,
    }, null, 2)}\n`, 'utf8');
  }

  // ── 1 + 7: recording only happens for an explicitly selected one-shot role ──
  writeQueue([
    baseRole('r-one', 'Example Co', 'prepare-queued'),
    baseRole('r-two', 'Other Co', 'prepare-queued'),
  ], { auto_fill_all: true });

  assert.throws(
    () => store.mutateQueue((queue) => {
      oneShot.recordOneShotRequest(
        queue.roles.find((item) => item.id === 'r-one'),
        'intent-unconfirmed',
      );
    }),
    /candidate_selection_confirmation is required/,
  );
  pass('One-shot work cannot be minted without the candidate dashboard attestation');

  let recorded;
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    assert.equal(oneShot.isOneShotRole(queue, role), true);
    // An abandoned older browser run must not make this new request look as if
    // it is already filling or review-ready.
    role.application_progress = {
      application_request_id: 'old-request',
      run_id: 'old-run',
      role_id: role.id,
      controller_id: 'old-controller',
      lean_review_ready: true,
    };
    confirmSelection(role, 'intent-abc');
    recorded = oneShot.recordOneShotRequest(role, 'intent-abc', { source: 'dashboard-run' });
  });
  assert.equal(recorded.reused, false);
  assert.equal(recorded.request.state, 'prepare-requested');
  assert.equal(recorded.request.selection_intent_id, 'intent-abc');
  assert.equal(recorded.request.request_id, 'one-shot:intent-abc:r-one');
  assert.equal(recorded.request.controller, 'active-agent');
  assert.equal(oneShot.reconcileOneShotRequests().reconciled, 0);
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'r-one').one_shot_request.state,
    'prepare-requested',
  );
  pass('acceptance 1: One-shot Run on a prepare-queued role writes one durable request');

  // The unselected role has none, even though auto_fill_all is globally on.
  let listing = oneShot.listOneShotRequests();
  assert.equal(listing.all.length, 1);
  assert.equal(listing.all[0].role_id, 'r-one');
  pass('acceptance 7: turning One-shot on never selects or records a role by itself');

  // ── 2: idempotent repeat Run ───────────────────────────────────────────────
  let repeated;
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    confirmSelection(role, 'intent-xyz');
    repeated = oneShot.recordOneShotRequest(role, 'intent-xyz', { source: 'dashboard-run' });
  });
  assert.equal(repeated.reused, true);
  // The ORIGINAL candidate intent is preserved — a second click never rewrites
  // the attestation the chain is anchored to.
  assert.equal(repeated.request.selection_intent_id, 'intent-abc');
  assert.equal(oneShot.listOneShotRequests().all.length, 1);
  pass('acceptance 2: repeating Run is idempotent and preserves the original intent');

  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    role.one_shot_request.selection_confirmation.action = 'fill';
  });
  assert.throws(
    () => oneShot.claimOneShotRequest('r-one'),
    /binding is missing or has been tampered with/,
  );
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    role.one_shot_request.selection_confirmation.action = 'run';
  });
  pass('the immutable candidate selection snapshot is checked before work advances');

  // ── 6: a failed asset gate cannot create an application_request ────────────
  oneShot.claimOneShotRequest('r-one');
  let gateError = null;
  try {
    oneShot.verifyOneShotAssets('r-one', gateOptions);
  } catch (error) {
    gateError = error;
  }
  assert.ok(gateError, 'verify must fail while the role is still prepare-queued with no assets');
  assert.match(gateError.message, /PREPARE must reach 'prepared'/);

  // Promote to prepared but WITHOUT assets: the gate must still refuse.
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    role.status = 'prepared';
  });
  gateError = null;
  try {
    oneShot.verifyOneShotAssets('r-one', gateOptions);
  } catch (error) {
    gateError = error;
  }
  assert.ok(gateError, 'verify must fail when the asset gate reports errors');
  assert.match(gateError.message, /asset gate failed/);
  assert.ok(gateError.issues.length > 0);

  // Dispatch must also refuse, and must not have written a request.
  let dispatchError = null;
  try {
    oneShot.dispatchOneShotFill('r-one', gateOptions);
  } catch (error) {
    dispatchError = error;
  }
  assert.ok(dispatchError);
  assert.match(dispatchError.message, /run verify first/);
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'r-one').application_request,
    undefined,
  );
  pass('acceptance 6: a failed asset gate cannot produce an application_request');

  // ── 3: the happy path reaches a dispatched fill request ────────────────────
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'r-one');
    Object.assign(role, assetsFor('r-one', 'Example Co'));
  });
  const verified = oneShot.verifyOneShotAssets('r-one', gateOptions);
  assert.equal(verified.request.state, 'assets-verified');

  const dispatched = oneShot.dispatchOneShotFill('r-one', gateOptions);
  assert.equal(dispatched.request.state, 'fill-requested');
  assert.equal(dispatched.reused, false);
  const req = dispatched.application_request;
  assert.equal(req.state, 'queued');
  assert.equal(req.controller, 'active-agent');
  // application-receipt.mjs requires a dashboard-sourced request; this work does
  // originate from the candidate's dashboard One-shot Run.
  assert.match(req.source, /^dashboard(?:-|$)/);
  assert.equal(req.request_id, `one-shot-intent-abc:r-one`);
  assert.equal(req.run_id, 'one-shot-intent-abc');
  pass('acceptance 3: gate pass dispatches exactly one dashboard-sourced application_request');

  // Dispatching again is idempotent — no duplicate request, no extra slot used.
  const redispatch = (() => {
    try {
      return oneShot.dispatchOneShotFill('r-one', gateOptions);
    } catch (error) {
      return { error };
    }
  })();
  assert.ok(redispatch.error, 'a second dispatch from fill-requested is rejected, not duplicated');

  // ── 4: crash-resume reconstructs state from durable role facts ─────────────
  // Begin through the real live-application gate, then simulate the agent dying
  // before it had a chance to mirror that durable fact into one_shot_request.
  const snapshotDigest = createHash('sha256').update(req.url).digest('hex');
  lean.beginLeanOrReceipt('r-one', {
    run_id: req.run_id,
    controller_id: req.controller_id,
    tab: { id: 'tab-r-one', url: req.url, title: 'Analyst — Example Co' },
    liveness_evidence: {
      method: 'playwright',
      checked_url: req.url,
      result: 'active',
      checked_at: '2026-07-28T00:10:00.000Z',
      snapshot_digest: snapshotDigest,
    },
    destination_evidence: {
      method: 'playwright',
      checked_url: req.url,
      result: 'matched',
      checked_at: '2026-07-28T00:10:00.000Z',
      snapshot_digest: snapshotDigest,
      observed_company: 'Example Co',
      observed_title: 'Analyst',
      observed_requisition: 'not shown',
    },
  });
  const restartedAgent = spawnSync(
    process.execPath,
    [join(ROOT, 'one-shot-request.mjs'), 'reconcile'],
    { cwd: ROOT, env: { ...process.env }, encoding: 'utf8' },
  );
  assert.equal(restartedAgent.status, 0, restartedAgent.stderr || restartedAgent.stdout);
  const reconciled = JSON.parse(restartedAgent.stdout);
  assert.equal(reconciled.reconciled, 1);
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'r-one').one_shot_request.state,
    'filling',
  );
  pass('acceptance 4: a crash after PREPARE resumes from durable state without a new click');

  // Finish through the real lean path. It promotes to prefilled and closes the
  // bound One-shot request in the same queue transaction.
  lean.recordLeanPage('r-one', {
    page_index: 0,
    url: `${req.url}/review`,
    label: 'Review',
    final_page: true,
  });
  writeFileSync(join(temp, 'reports', 'r-one-answers.md'), '# Application report\n', 'utf8');
  const finished = lean.finishLean('r-one', {
    final_url: `${req.url}/review`,
    final_control: 'Submit application',
    application_answers_report: 'reports/r-one-answers.md',
    attachments_not_applicable_reason: 'No upload controls were present on this portal flow.',
  });
  assert.equal(finished.status, 'prefilled');
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'r-one').one_shot_request.state,
    'review-ready',
  );
  assert.equal(store.loadQueue().roles.find((item) => item.id === 'r-one').status, 'prefilled');
  pass('the real lean finish closes the One-shot chain at the candidate review boundary');

  // ── 5: more than four roles drain in batches of at most four ───────────────
  const many = [];
  for (let index = 0; index < 6; index += 1) {
    const id = `bulk-${index}`;
    many.push(baseRole(id, `Bulk ${index} Co`, 'prepared', assetsFor(id, `Bulk ${index} Co`)));
  }
  writeQueue(many, { auto_fill_all: true });
  store.mutateQueue((queue) => {
    for (const role of queue.roles) {
      confirmSelection(role, `intent-bulk-${role.id}`);
      oneShot.recordOneShotRequest(role, `intent-bulk-${role.id}`, { source: 'dashboard-run' });
    }
  });

  let batch = oneShot.nextOneShotBatch();
  assert.equal(batch.max_active_roles, MAX_ACTIVE_APPLICATION_REQUESTS);
  assert.equal(batch.available_slots, MAX_ACTIVE_APPLICATION_REQUESTS);
  assert.equal(batch.batch.length, 4);
  assert.equal(batch.deferred.length, 2);

  for (const row of batch.batch) {
    oneShot.claimOneShotRequest(row.role_id);
    oneShot.verifyOneShotAssets(row.role_id, gateOptions);
    oneShot.dispatchOneShotFill(row.role_id, gateOptions);
  }
  batch = oneShot.nextOneShotBatch();
  assert.equal(batch.available_slots, 0);
  assert.equal(batch.batch.length, 0, 'no fifth role may be dispatched while four are active');
  assert.equal(batch.in_flight.length, 4);

  // The fifth genuinely cannot be dispatched.
  oneShot.claimOneShotRequest('bulk-4');
  oneShot.verifyOneShotAssets('bulk-4', gateOptions);
  let capError = null;
  try {
    oneShot.dispatchOneShotFill('bulk-4', gateOptions);
  } catch (error) {
    capError = error;
  }
  assert.ok(capError);
  assert.match(capError.message, /already has 4 active roles/);

  // Parking one frees exactly one slot, but it cannot be resumed over a new
  // fourth request (which would otherwise violate the structural cap).
  oneShot.parkOneShotRequest('bulk-0', 'blocked', 'temporary portal outage');
  assert.equal(oneShot.nextOneShotBatch().available_slots, 1);
  const fifth = oneShot.dispatchOneShotFill('bulk-4', gateOptions);
  assert.equal(fifth.request.state, 'fill-requested');
  assert.throws(
    () => oneShot.resumeOneShotRequest('bulk-0', 'portal recovered'),
    /already has 4 active roles/,
  );
  store.mutateQueue((queue) => {
    oneShot.cancelOneShotRequestOnRole(
      queue.roles.find((item) => item.id === 'bulk-0'),
      'candidate cancelled the parked role',
    );
  });
  pass('acceptance 5: more than four roles drain in batches of at most four');

  // ── Parking and resume ─────────────────────────────────────────────────────
  const parked = oneShot.parkOneShotRequest('bulk-5', 'candidate-action-required', 'portal needs MFA');
  assert.equal(parked.state, 'candidate-action-required');
  assert.equal(parked.parked_from, 'prepare-requested');
  assert.equal(parked.reason, 'portal needs MFA');
  assert.equal(oneShot.listOneShotRequests().parked.length, 1);
  // A parked request is never silently reconciled forward.
  assert.equal(oneShot.reconciledOneShotState(
    store.loadQueue().roles.find((item) => item.id === 'bulk-5'),
  ), null);
  const resumed = oneShot.resumeOneShotRequest('bulk-5', 'candidate completed MFA');
  assert.equal(resumed.state, 'prepare-requested');
  assert.equal(resumed.parked_from, undefined);
  pass('parking preserves the prior state and resume restores it exactly');

  // ── Illegal transitions are refused ────────────────────────────────────────
  let skipError = null;
  try {
    oneShot.dispatchOneShotFill('bulk-5', gateOptions); // prepare-requested → fill-requested
  } catch (error) {
    skipError = error;
  }
  assert.ok(skipError);
  assert.match(skipError.message, /run verify first/);
  pass('the state machine refuses to skip the asset gate');

  const parkedLive = oneShot.parkOneShotRequest('bulk-4', 'blocked', 'temporary portal error');
  assert.equal(parkedLive.parked_from, 'fill-requested');
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'bulk-4').application_request.state,
    'parked',
  );
  oneShot.resumeOneShotRequest('bulk-4', 'portal recovered');
  assert.equal(
    store.loadQueue().roles.find((item) => item.id === 'bulk-4').application_request.state,
    'queued',
  );
  store.mutateQueue((queue) => {
    const role = queue.roles.find((item) => item.id === 'bulk-4');
    assert.equal(oneShot.cancelOneShotRequestOnRole(role, 'candidate deselected the role'), true);
  });
  const cancelledRole = store.loadQueue().roles.find((item) => item.id === 'bulk-4');
  assert.equal(cancelledRole.one_shot_request.state, 'cancelled');
  assert.equal(cancelledRole.application_request.state, 'cancelled');
  pass('parking and candidate cancellation also park/cancel the bound live request');

  store.mutateQueue((queue) => {
    const role = baseRole(
      'deep-one',
      'Deep Co',
      'prepared',
      { ...assetsFor('deep-one', 'Deep Co'), flags: ['deep-eval'] },
    );
    confirmSelection(role, 'intent-deep');
    oneShot.recordOneShotRequest(role, 'intent-deep', { source: 'dashboard-run' });
    queue.roles.push(role);
  });
  oneShot.claimOneShotRequest('deep-one');
  assert.throws(
    () => oneShot.verifyOneShotAssets('deep-one', gateOptions),
    /deep evaluation completion evidence is missing/,
  );
  writeFileSync(
    join(temp, 'reports', 'deep-one.md'),
    '# Deep evaluation\n\n## Machine Summary\n\n```yaml\nscore: 4.4\n```\n',
    'utf8',
  );
  const deepEvidence = oneShot.completeOneShotDeepEvaluation(
    'deep-one',
    'reports/deep-one.md',
    gateOptions,
  );
  assert.equal(deepEvidence.report_path, 'reports/deep-one.md');
  assert.equal(oneShot.verifyOneShotAssets('deep-one', gateOptions).request.state, 'assets-verified');
  pass('deep-eval roles cannot pass the asset gate until report evidence is bound');

  // ── 8: nothing in this module can submit ───────────────────────────────────
  const source = readFileSync(join(ROOT, 'one-shot-request.mjs'), 'utf8');
  assert.doesNotMatch(source, /playwright|browser_click|launchPersistentContext|page\.goto/i);
  assert.doesNotMatch(source, /candidate_selection_confirmation\s*=/);
  assert.doesNotMatch(source, /SELECTION_CONFIRMATION_PHRASE|I selected these roles/);
  pass('acceptance 8: the one-shot drain never opens a browser, submits, or mints a candidate confirmation');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
}

if (IS_CHILD) {
  await runIsolated();
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ONE_SHOT_CHILD: '1', NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    assert.equal(
      child.status,
      0,
      child.stderr || child.stdout || child.error?.message || 'one-shot child failed',
    );
  }
  process.stdout.write(child.stdout);
  pass('One-shot durable chain: record → claim → gate → dispatch → filling → review-ready');
}
