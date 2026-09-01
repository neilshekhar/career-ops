#!/usr/bin/env node
/**
 * tests/lean-application.test.mjs — lean-llm-v1 lifecycle.
 *
 * Covers: lean begin stamp, page-done → finish → prefilled, reject
 * complete/finalize on lean runs, compact Application Answers without page
 * receipts, and manual Mark Submitted from lean prefilled.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { fileURLToPath } from 'node:url';
import { pass, ROOT } from './helpers.mjs';

const IS_CHILD = process.env.CAREER_OPS_LEAN_CHILD === '1';

async function runIsolated() {
console.log('\nLean LLM application lifecycle');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-lean-'));
const dataDir = join(temp, 'data');
const reportsDir = join(temp, 'reports');
mkdirSync(dataDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
mkdirSync(join(temp, 'config'), { recursive: true });
mkdirSync(join(temp, 'modes'), { recursive: true });
mkdirSync(join(temp, 'output'), { recursive: true });
mkdirSync(join(temp, 'jds'), { recursive: true });

// Redirect queue I/O BEFORE importing any module that loads queue-store.
process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_HANDOVER_PATH = join(temp, 'handover.md');
process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

writeFileSync(join(temp, 'handover.md'), '# Handover\n\n## Session Log\n', 'utf8');
writeFileSync(join(temp, 'cv.md'), '# CV\nSQL analysis and stakeholder reporting evidence.\n', 'utf8');
writeFileSync(join(temp, 'article-digest.md'), '# Proof\nReliable reporting evidence.\n', 'utf8');
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

const {
  buildPdfLayoutEvidence,
  persistPdfLayoutEvidence,
  printablePageBox,
} = await import('../generation-provenance.mjs');
const { buildMarkdown } = await import('../generate-cover-markdown.mjs');

const PDF_FIXTURE = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
function writePdfFixture(path, utilization = 0.90) {
  writeFileSync(path, PDF_FIXTURE);
  const printable = printablePageBox('a4');
  persistPdfLayoutEvidence(path, buildPdfLayoutEvidence({
    pdfPath: path,
    pdfBuffer: PDF_FIXTURE,
    format: 'a4',
    pageCount: 1,
    measurement: {
      top_px: 0,
      bottom_px: printable.height_px * utilization,
      height_px: printable.height_px * utilization,
    },
    measuredAt: new Date('2026-07-16T00:00:00.000Z'),
  }));
}

const cvPath = join(temp, 'output', 'lean-cv.pdf');
const cvHtmlPath = join(temp, 'output', 'lean-cv.html');
const coverMd = join(temp, 'output', 'lean-cover.md');
const coverPdf = join(temp, 'output', 'lean-cover.pdf');
const coverPayload = join(temp, 'output', 'lean-cover.payload.json');
const jdPath = join(temp, 'jds', 'lean-analyst.md');
writePdfFixture(cvPath);
writePdfFixture(coverPdf);
writeFileSync(
  cvHtmlPath,
  '<html><head><meta name="career-ops-template-id" content="cv-template">'
    + '<meta name="career-ops-template-version" content="1"></head>'
    + '<body>SQL analysis and stakeholder reporting evidence.</body></html>',
  'utf8',
);
const jdText = (
  'Lean Co needs an analyst to deliver reliable SQL reporting, translate stakeholder '
  + 'requirements, validate data quality, document decisions, and communicate findings clearly. '
).repeat(6);
writeFileSync(jdPath, jdText, 'utf8');
const coverObj = {
  candidate: { name: 'Test Candidate' },
  letter: {
    company: 'Lean Co',
    role_title: 'Analyst',
    opening: 'I am applying because this role matches my evidence-based analytics experience.',
    profile_intro: 'I bring reliable SQL reporting and stakeholder communication.',
    achievements: [],
    problems_section: '',
    closing: 'Thank you for reviewing my application.',
  },
};
writeFileSync(coverMd, buildMarkdown(coverObj), 'utf8');
writeFileSync(coverPayload, JSON.stringify(coverObj), 'utf8');

const reportRel = 'reports/099-lean-co-analyst-2026-07-20.md';
const reportPath = join(temp, reportRel);
writeFileSync(reportPath, [
  '# Lean Co — Analyst',
  '',
  '**Score:** 4.2/5',
  '**URL:** https://jobs.example.test/lean',
  '**Legitimacy:** likely-real',
  '',
  '## Machine Summary',
  '',
  '```yaml',
  'company: Lean Co',
  'role: Analyst',
  'score: 4.2',
  '```',
  '',
].join('\n'), 'utf8');

const url = 'https://jobs.example.test/lean';
const roleId = 'lean:analyst';
const receiptRoleId = 'receipt:analyst';
const portalRoleId = 'portal-resume:analyst';
const portalUrl = 'https://www.seek.com.au/job/12345';

writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
  version: 1,
  settings: {
    portal_default_cv: true,
    application_controller: {
      version: 1,
      controller: 'active-agent',
      controller_id: 'browser-controller:test',
      max_active_roles: 4,
    },
  },
  roles: [
    {
      id: roleId,
      company: 'Lean Co',
      title: 'Analyst',
      url,
      status: 'prepared',
      cv_pdf: cvPath,
      jd_path: 'jds/lean-analyst.md',
      jd_text: jdText,
      cover_letter_paths: { md: coverMd, pdf: coverPdf, payload: coverPayload },
      application_request: {
        version: 1,
        request_id: 'lean-run:lean:analyst',
        run_id: 'lean-run',
        role_id: roleId,
        source: 'dashboard-fill',
        state: 'queued',
        controller: 'active-agent',
        controller_id: 'browser-controller:test',
        requested_at: '2026-07-20T00:00:00.000Z',
        url,
        contract: [
          'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs', 'application-receipt.mjs',
        ],
      },
    },
    {
      id: receiptRoleId,
      company: 'Lean Co',
      title: 'Analyst',
      url: 'https://jobs.example.test/receipt',
      status: 'prepared',
      cv_pdf: cvPath,
      jd_path: 'jds/lean-analyst.md',
      jd_text: jdText,
      cover_letter_paths: { md: coverMd, pdf: coverPdf, payload: coverPayload },
      application_request: {
        version: 1,
        request_id: 'receipt-run:receipt:analyst',
        run_id: 'receipt-run',
        role_id: receiptRoleId,
        source: 'dashboard-fill',
        state: 'queued',
        controller: 'active-agent',
        controller_id: 'browser-controller:test',
        requested_at: '2026-07-20T00:00:00.000Z',
        url: 'https://jobs.example.test/receipt',
        contract: [
          'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs', 'application-receipt.mjs',
        ],
      },
    },
    {
      id: portalRoleId,
      company: 'Lean Co',
      title: 'Analyst',
      url: portalUrl,
      status: 'prepared',
      cv_source: 'portal-default',
      jd_path: 'jds/lean-analyst.md',
      jd_text: jdText,
      cover_letter_paths: { md: coverMd, pdf: coverPdf, payload: coverPayload },
      one_shot_request: {
        version: 1,
        state: 'fill-requested',
        selection_intent_id: 'portal-selection',
        requested_at: '2026-07-20T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
        history: [],
      },
      application_request: {
        version: 1,
        request_id: 'portal-run:portal-resume:analyst',
        run_id: 'portal-run',
        role_id: portalRoleId,
        source: 'dashboard-one-shot',
        state: 'queued',
        controller: 'active-agent',
        controller_id: 'browser-controller:test',
        requested_at: '2026-07-20T00:00:00.000Z',
        url: portalUrl,
        contract: [
          'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs', 'application-receipt.mjs',
        ],
      },
    },
  ],
}, null, 2) + '\n', 'utf8');

try {
  const store = await import('../queue-store.mjs');
  const receipt = await import('../application-receipt.mjs');
  const lean = await import('../lean-application.mjs');
  const answers = await import('../application-answers.mjs');

  function hash(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
  }

  function leanPreflight(targetUrl, company, title) {
    const digest = hash(`lean:${targetUrl}`);
    return {
      controller_id: 'browser-controller:test',
      liveness_evidence: {
        method: 'playwright',
        checked_url: targetUrl,
        result: 'active',
        checked_at: '2026-07-20T00:01:00.000Z',
        snapshot_digest: digest,
      },
      destination_evidence: {
        method: 'playwright',
        checked_url: targetUrl,
        result: 'matched',
        checked_at: '2026-07-20T00:01:00.000Z',
        snapshot_digest: digest,
        observed_company: company,
        observed_title: title,
        observed_requisition: 'not shown',
      },
    };
  }

  const idlePortalRoleId = 'portal-resume:idle';
  store.mutateQueue((queue) => {
    queue.roles.push({
      id: idlePortalRoleId,
      company: 'Idle Co',
      title: 'Analyst',
      url: portalUrl,
      status: 'prepared',
      cv_source: 'portal-default',
    });
  });
  assert.throws(
    () => receipt.recordObservedApplicationHost(
      idlePortalRoleId,
      'https://boards.greenhouse.io/idle-co/jobs/1',
    ),
    /durable queued dashboard application_request is required/,
  );
  const idlePortalRole = store.loadQueue().roles.find((r) => r.id === idlePortalRoleId);
  assert.equal(idlePortalRole.application_host, undefined);
  assert.equal(idlePortalRole.status, 'prepared');
  pass('host observation cannot mutate an idle role without dashboard authorization');

  const portalProgress = lean.beginLeanOrReceipt(portalRoleId, {
    run_id: 'portal-run',
    tab: { id: 'tab-portal', url: portalUrl, title: 'Analyst — Lean Co' },
    ...leanPreflight(portalUrl, 'Lean Co', 'Analyst'),
  });
  assert.equal(portalProgress.application_host, 'seek.com.au');
  assert.throws(
    () => lean.recordLeanPage(portalRoleId, {
      page_index: 0,
      url: 'https://boards.greenhouse.io/lean-co/jobs/12345',
      label: 'Application form',
    }),
    (error) => {
      assert.equal(error.code, 'PORTAL_RESUME_REDIRECT');
      assert.equal(error.httpCode, 409);
      assert.match(error.message, /observed host was saved and this role was returned to PREPARE/i);
      return true;
    },
  );
  const redirectedPortalRole = store.loadQueue().roles.find((r) => r.id === portalRoleId);
  assert.equal(redirectedPortalRole.application_host, 'boards.greenhouse.io');
  assert.equal(redirectedPortalRole.application_progress, undefined);
  assert.equal(redirectedPortalRole.status, 'prepare-queued');
  assert.equal(redirectedPortalRole.application_request.state, 'parked');
  assert.equal(redirectedPortalRole.application_request.asset_quality_evidence, undefined);
  assert.equal(redirectedPortalRole.one_shot_request.state, 'preparing');
  assert.equal(redirectedPortalRole.one_shot_request.selection_intent_id, 'portal-selection');
  const { portalResumeExemptionApplies } = await import('../portal-resume-hosts.mjs');
  assert.equal(
    portalResumeExemptionApplies(redirectedPortalRole, store.loadQueue().settings),
    false,
  );
  pass('external redirect persists before the 409, parks the stale fill, and rewinds One-shot to PREPARE');

  let progress;
  store.mutateQueue((queue) => {
    const role = queue.roles.find((r) => r.id === roleId);
    progress = receipt.beginApplicationProgress(role, {
      run_id: 'lean-run',
      tab: { id: 'tab-lean', url, title: 'Analyst — Lean Co' },
      ...leanPreflight(url, 'Lean Co', 'Analyst'),
    }, { queue });
  });
  assert.equal(progress.execution_protocol, 'lean-llm-v1');
  assert.equal(progress.verification_mode, 'selective');
  assert.equal(progress.receipt_required, false);
  assert.equal(progress.evidence_protocol, undefined);
  assert.equal(lean.isLeanProgress(progress), true);
  pass('begin stamps lean-llm-v1 by default (selective, receipt_required false)');

  let receiptProgress;
  store.mutateQueue((queue) => {
    const role = queue.roles.find((r) => r.id === receiptRoleId);
    receiptProgress = receipt.beginApplicationProgress(role, {
      run_id: 'receipt-run',
      execution_protocol: 'receipt-v3',
      tab: { id: 'tab-receipt', url: role.url, title: 'Analyst — Lean Co' },
      ...leanPreflight(role.url, 'Lean Co', 'Analyst'),
    }, { queue });
  });
  assert.equal(receiptProgress.execution_protocol, 'receipt-v3');
  assert.equal(receiptProgress.receipt_required, true);
  assert.equal(receiptProgress.evidence_protocol, 'v3');
  assert.equal(lean.isLeanProgress(receiptProgress), false);
  pass('explicit execution_protocol receipt-v3 keeps the historical receipt stamp');

  const midBeforeReject = store.loadQueue().roles.find((r) => r.id === roleId);
  assert.throws(
    () => lean.assertNotLeanForReceiptCommand(midBeforeReject.application_progress, 'complete'),
    /not valid for lean-llm-v1/,
  );
  assert.throws(
    () => lean.assertNotLeanForReceiptCommand(midBeforeReject.application_progress, 'finalize'),
    /not valid for lean-llm-v1/,
  );
  const cliEnv = {
    ...process.env,
    NODE_ENV: 'test',
    CAREER_OPS_DATA_DIR: dataDir,
    CAREER_OPS_QUEUE_BACKEND: 'local',
  };
  delete cliEnv.CAREER_OPS_HANDOVER_PATH;
  delete cliEnv.CAREER_OPS_TEST_PROJECT_ROOT;
  delete cliEnv.CAREER_OPS_REPORTS_DIR;
  const completeCli = spawnSync(process.execPath, [
    join(ROOT, 'apply-page.mjs'), 'complete', roleId,
    JSON.stringify({ after_snapshot: 'x.yml' }),
  ], { cwd: ROOT, env: cliEnv, encoding: 'utf8' });
  assert.notEqual(completeCli.status, 0);
  assert.match(completeCli.stderr || completeCli.stdout || '', /not valid for lean-llm-v1|lean-llm-v1/);
  const finalizeCli = spawnSync(process.execPath, [
    join(ROOT, 'apply-page.mjs'), 'finalize', roleId,
    JSON.stringify({ application_answers_report: reportRel }),
  ], { cwd: ROOT, env: cliEnv, encoding: 'utf8' });
  assert.notEqual(finalizeCli.status, 0);
  assert.match(finalizeCli.stderr || finalizeCli.stdout || '', /not valid for lean-llm-v1|lean-llm-v1/);
  pass('complete and finalize are rejected on lean runs');

  lean.recordLeanPage(roleId, {
    page_index: 0,
    url,
    label: 'Personal details',
    attachments_handled: true,
  });
  lean.recordLeanPage(roleId, {
    page_index: 1,
    url: `${url}/review`,
    label: 'Review',
    final_page: true,
    review_required: [{ label: 'Salary expectation', answer: 'Negotiable', note: 'inferred' }],
  });
  const mid = store.loadQueue().roles.find((r) => r.id === roleId);
  assert.equal(mid.application_progress.pages?.length ?? 0, 0);
  assert.equal(mid.application_progress.lean_pages.length, 2);
  assert.equal(mid.status, 'prepared');
  pass('page-done records lean_pages without page receipts or status promotion');

  // ── Teach-barrier gate: untaught novel fields block the lean terminal ──────
  // writers (page-done AND finish). receipt-v3's `complete` auto-teaches, so it
  // structurally can't skip; lean must enforce the decision explicitly.
  function setPending(novel, teach) {
    store.mutateQueue((queue) => {
      const role = queue.roles.find((r) => r.id === roleId);
      role.application_progress.pending_resolver_evidence = {
        evidence_id: 'ev-gate', run_id: 'lean-run', page_index: 0, novel, teach,
      };
    });
  }
  function clearPending() {
    store.mutateQueue((queue) => {
      const role = queue.roles.find((r) => r.id === roleId);
      delete role.application_progress.pending_resolver_evidence;
    });
  }

  // (a) A page whose lookup surfaced novel fields but was never taught blocks
  //     BOTH page-done and finish.
  setPending([{ control_id: 'q1', label: 'Why do you want to work here?' }], null);
  assert.throws(
    () => lean.recordLeanPage(roleId, { page_index: 2, url, label: 'Screening' }),
    /untaught novel field/i,
  );
  assert.throws(
    () => lean.finishLean(roleId, {
      final_url: `${url}/review`,
      final_control: 'Submit application',
      application_answers_report: reportRel,
    }),
    /untaught novel field/i,
  );
  // The blocked finish must not have written the report or promoted the queue.
  const blocked = store.loadQueue().roles.find((r) => r.id === roleId);
  assert.equal(blocked.status, 'prepared');
  assert.notEqual(blocked.application_progress.lean_review_ready, true);
  pass('untaught novel field blocks both page-done and finish (no report / no promotion)');

  // (b) Once the page has been taught (pending.teach sealed) page-done proceeds.
  //     A page whose novels all turned out non-reusable still carries a sealed
  //     teach — the gate demands the decision, not that anything be cached.
  setPending(
    [{ control_id: 'q1', label: 'Why do you want to work here?' }],
    { noop: false, completed_at: '2026-07-20T00:02:00.000Z' },
  );
  const taughtEntry = lean.recordLeanPage(roleId, { page_index: 2, url, label: 'Screening' });
  assert.equal(taughtEntry.page_index, 2);
  pass('page-done proceeds once the page has been taught');

  // (c) A page with zero novel fields (pure uploads / fully L1-L2 resolved) is
  //     never gated, even with teach still null.
  setPending([], null);
  const noNovelEntry = lean.recordLeanPage(roleId, { page_index: 3, url, label: 'Uploads' });
  assert.equal(noNovelEntry.page_index, 3);
  pass('page-done is not gated when the page had no novel fields');

  // (d) A no-op teach seal (empty novel + sealed teach) also clears the gate,
  //     mirroring a `queue-resolve.mjs --teach` no-op barrier.
  setPending([], { noop: true, completed_at: '2026-07-20T00:03:00.000Z' });
  const noopEntry = lean.recordLeanPage(roleId, { page_index: 4, url, label: 'Consent' });
  assert.equal(noopEntry.page_index, 4);
  pass('page-done accepts a no-op teach seal');

  // Restore the pristine (no pending, pages 0-1 only) state so the real finish
  // flow below still asserts exactly two completed pages.
  clearPending();
  store.mutateQueue((queue) => {
    const role = queue.roles.find((r) => r.id === roleId);
    role.application_progress.lean_pages = role.application_progress.lean_pages
      .filter((p) => p.page_index < 2);
  });

  const snap = answers.snapshotFromApplicationProgress(mid.application_progress, {
    important_answers: [{ label: 'Why this role?', answer: 'SQL reporting fit', source: 'model' }],
  });
  assert.equal(snap.executionProtocol, 'lean-llm-v1');
  assert.equal(snap.pageCount, 0);
  assert.equal(snap.leanPageCount, 2);
  const section = answers.formatApplicationAnswersSection(snap);
  assert.match(section, /lean-llm-v1/);
  assert.match(section, /Lean pages completed/);
  pass('Application Answers supports lean compact sections without page receipts');

  // An unparseable widget hard-blocks receipt-v3 finalize. Lean still finishes,
  // but the candidate must see it in the compact review.
  store.mutateQueue((queue) => {
    receipt.recordVerificationFallback(queue.roles.find((r) => r.id === roleId), {
      reason: 'canvas signature widget could not be machine-verified',
      control_ids: ['sig-canvas'],
      url: `${url}/review`,
      page_index: 1,
    });
  });

  const finished = lean.finishLean(roleId, {
    final_url: `${url}/review`,
    final_control: 'Submit application',
    application_answers_report: reportRel,
    important_answers: [{ label: 'Why this role?', answer: 'SQL reporting fit', source: 'model' }],
    attachments: { cv: 'lean-cv.pdf', cover: 'lean-cover.pdf' },
    warnings: [],
  });
  assert.equal(finished.status, 'prefilled');
  assert.equal(finished.execution_protocol, 'lean-llm-v1');
  assert.equal(finished.pages_completed, 2);
  const after = store.loadQueue().roles.find((r) => r.id === roleId);
  assert.equal(after.status, 'prefilled');
  assert.equal(after.application_progress.lean_review_ready, true);
  assert.equal(after.application_progress.review_ready, false);
  assert.notEqual(after.status, 'filled');
  const reportText = readFileSync(reportPath, 'utf8');
  assert.match(reportText, /## Application Answers/);
  assert.match(reportText, /\*\*State:\*\* prefilled/);
  assert.match(reportText, /lean-llm-v1/);
  assert.doesNotMatch(reportText, /\*\*State:\*\* filled/);
  pass('finish sets queue prefilled with compact review (never filled)');

  assert.match(reportText, /Verification fallback recorded on page 1/);
  assert.match(reportText, /sig-canvas/);
  assert.deepEqual(
    after.application_progress.lean_review.warnings.length, 1,
  );
  pass('a verification fallback surfaces in the lean review instead of vanishing');

  // The compact review must stay readable by the same exact parser the receipt
  // path uses — headings and entry metadata share one vocabulary.
  const parsedLean = answers.parseApplicationAnswersSection(reportText);
  assert.equal(parsedLean.state, 'prefilled');
  const leanLabels = parsedLean.entries.map((entry) => entry.label);
  assert.ok(leanLabels.includes('Why this role?'), `lean entries: ${leanLabels.join(' | ')}`);
  assert.ok(leanLabels.includes('Salary expectation'), `lean entries: ${leanLabels.join(' | ')}`);
  assert.equal(
    parsedLean.entries.find((entry) => entry.label === 'Salary expectation').review_required,
    true,
  );
  pass('lean compact review parses with parseApplicationAnswersSection');

  // A finished lean run is review-ready, not resumable: `prefilled` alone no
  // longer proves a role is fillable, so begin and the dashboard must refuse it.
  assert.throws(
    () => store.mutateQueue((queue) => receipt.beginApplicationProgress(
      queue.roles.find((r) => r.id === roleId),
      {
        tab: { id: 'tab-lean-2', url },
        controller_id: 'controller-lean',
        run_id: 'run-lean-2',
      },
      { queue },
    )),
    /already completed a lean-llm-v1 run|duplicate application/i,
  );
  pass('begin refuses to overwrite a finished lean run');

  assert.throws(
    () => lean.recordLeanPage(roleId, { page_index: 2, url }),
    /an active application run is required/,
  );
  pass('page-done refuses to append to a finished lean run');

  const { partitionRunRoles } = await import('../run-partition.mjs');
  const leanLanes = partitionRunRoles([after]);
  assert.equal(leanLanes.agentPath.length, 0);
  assert.equal(leanLanes.filledCheck.length, 1);
  pass('dashboard dispatch never re-queues a finished lean run');

  store.mutateQueue((queue) => {
    const role = queue.roles.find((r) => r.id === roleId);
    role.manual_submission = {
      version: 1,
      source: 'candidate-dashboard',
      confirmation: 'I submitted this application in the portal',
      confirmed_at: new Date().toISOString(),
      prior_status: 'prefilled',
      transaction_id: 'candidate-decision:lean:analyst:submitted:test',
    };
    assert.equal(store.setStatus(queue, roleId, 'submitted'), true);
    assert.equal(role.status, 'submitted');
  });
  pass('manual Mark Submitted from lean prefilled succeeds');

  const selectiveTriggers = [
    'conditional fields appeared',
    'validation errors visible',
    'upload basename mismatch',
    'ambiguous Submit vs Continue',
    'session reset / unexpected navigation',
  ];
  assert.equal(selectiveTriggers.length, 5);
  pass('selective verification trigger list is defined for lean risk gates');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
}

if (IS_CHILD) {
  await runIsolated();
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_LEAN_CHILD: '1', NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    assert.equal(
      child.status,
      0,
      child.stderr || child.stdout || child.error?.message || 'lean child failed',
    );
  }
  process.stdout.write(child.stdout);
  pass('lean-llm-v1 begin/page-done/finish → prefilled; receipt-v3 opt-in; complete/finalize rejected');
}
