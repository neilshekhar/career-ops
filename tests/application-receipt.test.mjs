#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { pass } from './helpers.mjs';
import {
  formatApplicationAnswersSection, snapshotFromApplicationProgress,
} from '../application-answers.mjs';
import { buildMarkdown } from '../generate-cover-markdown.mjs';
import {
  buildPdfLayoutEvidence,
  persistPdfLayoutEvidence,
  printablePageBox,
} from '../generation-provenance.mjs';
import { setStatus } from '../queue-store.mjs';

console.log('\nApplication receipt gate');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-receipt-'));
const reportsDir = join(temp, 'reports');
const handoverPath = join(temp, 'handover.md');
mkdirSync(reportsDir, { recursive: true });
mkdirSync(join(temp, 'config'), { recursive: true });
mkdirSync(join(temp, 'modes'), { recursive: true });
mkdirSync(join(temp, 'output'), { recursive: true });
writeFileSync(handoverPath, '# Handover\n\n## Session Log\n', 'utf8');
writeFileSync(join(temp, 'cv.md'), '# CV\nSQL analysis and stakeholder reporting evidence.\n', 'utf8');
writeFileSync(join(temp, 'article-digest.md'), '# Proof points\nReliable reporting evidence.\n', 'utf8');
writeFileSync(join(temp, 'modes', '_profile.md'), '# Profile\n', 'utf8');
writeFileSync(join(temp, 'modes', '_custom.md'), '# Application rules\n', 'utf8');
writeFileSync(join(temp, 'voice-dna.md'), '# Voice\nClear and direct.\n', 'utf8');
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

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const answerHash = (value) => createHash('sha256').update(String(value)).digest('hex');
const attachment = (controlId, kind, path) => ({
  control_id: controlId,
  kind,
  expected: path,
  displayed: path,
  verified: true,
});
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
function preflight(url, company, title, seed) {
  const snapshotDigest = hash(`${seed}:${url}:${company}:${title}`);
  return {
    controller_id: 'browser-controller:test',
    // Historical receipt-v3 suite: keep the receipt loop explicitly.
    execution_protocol: 'receipt-v3',
    // This suite hand-installs synthetic resolver evidence, which v3 runs
    // reject. The inline-test capture escape only works from test entrypoints.
    evidence_capture: 'inline-test',
    liveness_evidence: {
      method: 'playwright', checked_url: url, result: 'active', snapshot_digest: snapshotDigest,
    },
    destination_evidence: {
      method: 'playwright', checked_url: url, result: 'matched', snapshot_digest: snapshotDigest,
      observed_company: company, observed_title: title, observed_requisition: 'not shown',
    },
  };
}
function authorize(role, runId, overrides = {}) {
  role.application_request = {
    version: 1,
    request_id: `${runId}:${role.id}`,
    run_id: runId,
    role_id: role.id,
    source: 'dashboard-fill',
    state: 'queued',
    controller: 'active-agent',
    controller_id: 'browser-controller:test',
    requested_at: '2026-07-16T00:59:00.000Z',
    url: role.url,
    contract: [
      'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs', 'application-receipt.mjs',
    ],
    ...overrides,
  };
  return role;
}
function installResolverEvidence(role, context, { fields, resolved, novel, answers }) {
  const snapshotDigest = context.snapshot_digest ?? hash(`before:${context.run_id}:${context.page_id}`);
  const observedAt = context.observed_at ?? '2026-07-16T01:00:00.000Z';
  const core = {
    version: 1,
    evidence_id: `resolver-evidence:${context.run_id}:${context.page_index}:test`,
    run_id: context.run_id,
    tab_id: context.tab_id,
    page_id: context.page_id,
    page_index: context.page_index,
    url: context.url,
    snapshot_digest: snapshotDigest,
    observed_at: observedAt,
    fields,
    resolved,
    novel,
  };
  const teachCore = {
    evidence_id: core.evidence_id,
    run_id: core.run_id,
    tab_id: core.tab_id,
    page_id: core.page_id,
    page_index: core.page_index,
    url: core.url,
    snapshot_digest: core.snapshot_digest,
    observed_at: core.observed_at,
    answers,
  };
  role.application_progress.pending_resolver_evidence = {
    ...core,
    lookup_fingerprint: hash(core),
    lookup_completed_at: '2026-07-16T01:00:00.000Z',
    teach: {
      ...teachCore,
      teach_fingerprint: hash(teachCore),
      completed_at: '2026-07-16T01:01:00.000Z',
      noop: answers.length === 0,
    },
  };
  return core.evidence_id;
}

function browserObservation(url, fields, snapshotDigest, { finalPage = false, pageKind = 'form' } = {}) {
  const manifest = fields.map((field) => ({
    control_id: field.control_id,
    label: field.label,
    type: field.type,
    required: field.required,
  }));
  const step = (seed, capturedAt) => ({
    snapshot_digest: seed === 'before' ? snapshotDigest : hash(`${seed}:${url}`),
    url,
    field_manifest: manifest,
    captured_at: capturedAt,
  });
  return {
    source: 'playwright-mcp',
    page_kind: pageKind,
    before: step('before', '2026-07-16T01:00:00.000Z'),
    rescan: step('rescan', '2026-07-16T01:02:00.000Z'),
    after: {
      ...step('after', '2026-07-16T01:03:00.000Z'),
      populated_manifest: fields.map((field) => ({
        control_id: field.control_id,
        answer_digest: answerHash(field.answer),
      })),
      validation_errors: [],
    },
    ...(finalPage ? {
      submit_boundary: { present: true, control_id: 'submit-application', label: 'Submit application' },
    } : {}),
  };
}

const oldReports = process.env.CAREER_OPS_REPORTS_DIR;
const oldHandover = process.env.CAREER_OPS_HANDOVER_PATH;
const oldNodeEnv = process.env.NODE_ENV;
const oldTestProjectRoot = process.env.CAREER_OPS_TEST_PROJECT_ROOT;
process.env.CAREER_OPS_REPORTS_DIR = reportsDir;
process.env.CAREER_OPS_HANDOVER_PATH = handoverPath;
process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

try {
  const receipt = await import(`../application-receipt.mjs?test=${Date.now()}`);
  const cvPath = join(temp, 'output', 'acme-cv.pdf');
  const cvHtmlPath = join(temp, 'output', 'acme-cv.html');
  const coverMdPath = join(temp, 'output', 'acme-cover.md');
  const coverPdfPath = join(temp, 'output', 'acme-cover.pdf');
  const coverPayloadPath = join(temp, 'output', 'acme-cover.payload.json');
  const coverPayload = {
    candidate: { name: 'Test Candidate' },
    letter: {
      company: 'Acme',
      role_title: 'Analyst',
      opening: 'I am applying because this role matches my evidence-based analytics experience.',
      profile_intro: 'I bring reliable SQL reporting and stakeholder communication.',
      achievements: [],
      problems_section: '',
      closing: 'Thank you for reviewing my application.',
    },
  };
  writePdfFixture(cvPath);
  writeFileSync(cvHtmlPath, '<html><body>SQL analysis and stakeholder reporting evidence.</body></html>', 'utf8');
  writeFileSync(coverMdPath, buildMarkdown(coverPayload), 'utf8');
  writePdfFixture(coverPdfPath);
  writeFileSync(coverPayloadPath, JSON.stringify(coverPayload), 'utf8');
  const role = {
    id: 'acme:analyst', company: 'Acme', title: 'Analyst',
    url: 'https://jobs.example.test/1', status: 'prepared', cv_pdf: cvPath,
    jd_text: 'Acme needs an analyst to deliver reliable SQL reporting, translate stakeholder requirements, validate data quality, document decisions, and communicate findings clearly. '.repeat(3),
    cover_letter_paths: { md: coverMdPath, pdf: coverPdfPath, payload: coverPayloadPath },
  };
  authorize(role, 'apply-acme-1');
  const run = receipt.beginApplicationProgress(role, {
    run_id: 'apply-acme-1',
    tab: { id: 'tab-acme', url: role.url, title: 'Analyst — Acme' },
    ...preflight(role.url, 'Acme', 'Analyst', 'acme'),
  });
  assert.equal(run.review_ready, false);
  assert.equal(run.application_request_id, 'apply-acme-1:acme:analyst');
  assert.equal(role.application_request.state, 'in-progress');
  pass('run begins only from a matching queued dashboard request with tab and preflight evidence');

  const decoratedRole = {
    id: 'acme:decorated-analyst', company: 'Acme', title: 'Analyst',
    requisition_id: 'REQ-4821', url: 'https://jobs.example.test/requisition/REQ-4821',
    status: 'prepared', cv_pdf: cvPath, jd_text: role.jd_text,
    cover_letter_paths: structuredClone(role.cover_letter_paths),
  };
  authorize(decoratedRole, 'decorated-run');
  const decoratedEvidence = preflight(
    decoratedRole.url,
    'The Acme Pty Ltd Careers',
    'Analyst (12-month fixed term)',
    'decorated',
  );
  decoratedEvidence.destination_evidence.observed_requisition = 'Job ID 4821';
  const decoratedRun = receipt.beginApplicationProgress(decoratedRole, {
    run_id: 'decorated-run',
    tab: { id: 'decorated-tab', url: decoratedRole.url },
    ...decoratedEvidence,
  });
  assert.equal(decoratedRun.preflight.role_match_verified, true);
  assert.equal(decoratedRun.preflight.destination.expected_requisition, 'REQ-4821');
  assert.equal(decoratedRun.preflight.destination.requisition_compared, true);
  pass('destination matching tolerates only conservative ATS company/title decorations and equivalent requisition labels');

  for (const mismatch of [
    { id: 'wrong-company-destination', observedCompany: 'Other Company', observedTitle: 'Analyst', requisition: 'not shown', pattern: /observed company materially differs/ },
    { id: 'wrong-title-destination', observedCompany: 'Acme', observedTitle: 'Marketing Analyst', requisition: 'not shown', pattern: /observed title materially differs/ },
    { id: 'wrong-title-id-destination', observedCompany: 'Acme', observedTitle: 'Analyst - 9999', requisition: 'not shown', requisitionId: 'REQ-4821', pattern: /observed title materially differs/ },
    { id: 'wrong-requisition-destination', observedCompany: 'Acme', observedTitle: 'Analyst', requisition: 'REQ-9999', requisitionId: 'REQ-4821', pattern: /observed requisition materially differs/ },
  ]) {
    const mismatchRole = authorize({
      id: mismatch.id,
      company: 'Acme',
      title: 'Analyst',
      ...(mismatch.requisitionId ? { requisition_id: mismatch.requisitionId } : {}),
      url: `https://jobs.example.test/${mismatch.id}`,
      status: 'prepared',
    }, `${mismatch.id}-run`);
    const mismatchEvidence = preflight(
      mismatchRole.url,
      mismatch.observedCompany,
      mismatch.observedTitle,
      mismatch.id,
    );
    mismatchEvidence.destination_evidence.observed_requisition = mismatch.requisition;
    assert.throws(() => receipt.beginApplicationProgress(mismatchRole, {
      run_id: `${mismatch.id}-run`,
      tab: { id: `${mismatch.id}-tab`, url: mismatchRole.url },
      ...mismatchEvidence,
    }), mismatch.pattern);
  }
  pass('a caller-provided matched result cannot self-attest a material company, title, or requisition mismatch');

  assert.throws(() => receipt.beginApplicationProgress({
    id: 'no-request', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
  }, {
    run_id: 'no-request-run', tab: { id: 'no-request-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'no-request'),
  }), /durable queued dashboard application_request is required/);
  pass('receipt begin rejects roles without a durable dashboard authorization');

  const wrongRun = authorize({
    id: 'wrong-run', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
  }, 'authorized-run');
  assert.throws(() => receipt.beginApplicationProgress(wrongRun, {
    run_id: 'different-run', tab: { id: 'wrong-run-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'wrong-run'),
  }), /run_id does not match/);
  const wrongController = authorize({
    id: 'wrong-controller', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
  }, 'wrong-controller-run', { controller: 'private-browser' });
  assert.throws(() => receipt.beginApplicationProgress(wrongController, {
    run_id: 'wrong-controller-run', tab: { id: 'wrong-controller-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'wrong-controller'),
  }), /controller must be active-agent/);
  const wrongRole = authorize({
    id: 'right-role', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
  }, 'wrong-role-run', { role_id: 'another-role' });
  assert.throws(() => receipt.beginApplicationProgress(wrongRole, {
    run_id: 'wrong-role-run', tab: { id: 'wrong-role-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'wrong-role'),
  }), /different role/);
  pass('receipt begin rejects mismatched run, controller, and role authorizations');

  const booleanOnly = authorize({
    id: 'boolean-only', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
  }, 'boolean-run');
  assert.throws(() => receipt.beginApplicationProgress(booleanOnly, {
    run_id: 'boolean-run',
    controller_id: 'browser-controller:test',
    tab: { id: 'boolean-tab', url: role.url },
    liveness_verified: true, role_match_verified: true,
  }), /bare verification booleans are not accepted/);
  pass('bare preflight booleans cannot begin a live application run');
  const invalidAssets = authorize({
    id: 'invalid-assets', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
    cv_pdf: join(temp, 'output', 'missing.pdf'), jd_text: role.jd_text,
    cover_letter_paths: structuredClone(role.cover_letter_paths),
  }, 'invalid-assets-run');
  assert.throws(() => receipt.beginApplicationProgress(invalidAssets, {
    run_id: 'invalid-assets-run', tab: { id: 'invalid-assets-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'invalid-assets'),
  }), /application quality gate failed.*cv-missing/);
  assert.equal(invalidAssets.application_progress, undefined);
  assert.equal(invalidAssets.application_request.state, 'queued');
  pass('receipt begin executes the full asset quality gate before consuming dashboard authorization');
  assert.throws(() => receipt.beginApplicationProgress({
    id: 'wrong-status', company: 'Acme', title: 'Analyst', url: role.url, status: 'scored',
  }, {
    tab: { id: 'wrong-status-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'wrong-status'),
  }), /may begin only from/);
  pass('receipt begin rejects queue statuses outside prepared/prefilled');

  const duplicateTabRole = authorize({
    ...structuredClone(role), id: 'duplicate-tab-role', status: 'prepared',
    application_progress: undefined, application_request: undefined,
  }, 'duplicate-tab-run');
  const duplicateTabQueue = {
    settings: {
      application_controller: {
        version: 1, controller: 'active-agent', controller_id: 'browser-controller:test',
        max_active_roles: 4,
      },
    },
    roles: [
      duplicateTabRole,
      {
        id: 'other-tab-owner',
        application_request: { state: 'in-progress', controller_id: 'browser-controller:test' },
        application_progress: { tab: { id: 'shared-tab' } },
      },
    ],
  };
  assert.throws(() => receipt.beginApplicationProgress(duplicateTabRole, {
    run_id: 'duplicate-tab-run',
    controller_id: 'browser-controller:test',
    tab: { id: 'shared-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'duplicate-tab'),
  }, { queue: duplicateTabQueue }), /already bound to role other-tab-owner/);
  pass('receipt begin enforces the one-controller tab lease across queue roles');

  assert.throws(() => receipt.recordPageReceipt(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'self-attested', page_index: 0,
    url: 'https://jobs.example.test/1/apply', field_count: 0, fields: [],
    upload_controls: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: false,
  }), /executable resolver evidence is missing/);
  pass('lookup/teach booleans alone cannot self-attest a page receipt');

  const questionsUrl = 'https://jobs.example.test/1/apply';
  const questionEvidenceId = installResolverEvidence(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'questions', page_index: 0, url: questionsUrl,
  }, {
    fields: [
      { control_id: 'why-role', label: 'Why this role?', type: 'textarea', required: true, options: [], help: null, kind: null },
      { control_id: 'work-auth', label: 'Work authorization detail', type: 'text', required: true, options: [], help: null, kind: null },
    ],
    resolved: [{
      control_id: 'work-auth',
      label: 'Work authorization detail',
      answer: 'Distinctive temporary work-rights answer.', source: 'deterministic',
      review_required: true,
      review_note: 'Verify the portal wording before submission.',
    }],
    novel: [{ control_id: 'why-role', label: 'Why this role?', type: 'textarea', required: true }],
    answers: [{
      control_id: 'why-role',
      label: 'Why this role?', type: 'textarea',
      answer: 'Distinctive remediation evidence answer.', reusable: false,
      review_required: false, review_note: null,
    }],
  });

  const page = receipt.recordPageReceipt(role, {
    run_id: run.run_id,
    tab_id: 'tab-acme',
    page_id: 'questions',
    page_index: 0,
    url: questionsUrl,
    resolver_evidence_id: questionEvidenceId,
    field_count: 2,
    fields: [
      {
        control_id: 'why-role',
        label: 'Why this role?', type: 'textarea', required: true,
        answer: 'Distinctive remediation evidence answer.',
        resolution: 'novel', provenance: 'model', taught: true,
        review_required: false,
      },
      {
        control_id: 'work-auth',
        label: 'Work authorization detail', type: 'text', required: true,
        answer: 'Distinctive temporary work-rights answer.',
        resolution: 'resolved', provenance: 'deterministic', taught: false,
        review_required: true, review_note: 'Verify the portal wording before submission.',
      },
    ],
    lookup_completed: true,
    l3_completed: true,
    teach_completed: true,
    conditional_rescan_completed: true,
    verified: true,
    validation_errors: [],
    browser_observation: browserObservation(questionsUrl, [
      {
        control_id: 'why-role', label: 'Why this role?', type: 'textarea', required: true,
        answer: 'Distinctive remediation evidence answer.',
      },
      {
        control_id: 'work-auth', label: 'Work authorization detail', type: 'text', required: true,
        answer: 'Distinctive temporary work-rights answer.',
      },
    ], role.application_progress.pending_resolver_evidence.snapshot_digest),
    upload_controls: [
      {
        control_id: 'resume-upload', label: 'Resume', kind: 'cv', required: true,
        multiple: false, enabled: true, accepts: '.pdf',
      },
      {
        control_id: 'cover-upload', label: 'Cover letter (optional)', kind: 'cover', required: false,
        multiple: false, enabled: true, accepts: '.pdf',
      },
    ],
    attachments: [
      attachment('resume-upload', 'CV', cvPath),
      attachment('cover-upload', 'Cover letter', coverPdfPath),
    ],
    final_page: false,
  });
  assert.equal(page.novel_count, 1);
  assert.equal(page.taught_count, 1);
  assert.equal(page.provenance_counts.model, 1);
  assert.equal(page.review_required.length, 1);
  assert.equal(role.application_progress.pending_resolver_evidence, undefined);
  pass('page receipt derives counts from an exact answer/provenance ledger');

  const reportSnapshot = snapshotFromApplicationProgress(role.application_progress, {
    date: '2026-07-16', state: 'prefilled',
  });
  const reportSection = formatApplicationAnswersSection(reportSnapshot);
  assert.match(reportSection, /\*\*Run ID:\*\* apply-acme-1/);
  assert.match(reportSection, /Page: questions/);
  assert.match(reportSection, /Page index: 0/);
  assert.match(reportSection, /Control ID: why-role/);
  assert.match(reportSection, /Occurrence: 1/);
  assert.match(reportSection, /Provenance: model/);
  assert.match(reportSection, /Resolution: novel/);
  assert.match(reportSection, /Taught: yes/);
  assert.match(reportSection, /Review required: yes/);
  assert.match(reportSection, /Review note: Verify the portal wording/);
  assert.match(reportSection, /\*\*State:\*\* prefilled/);
  pass('Application Answers snapshot preserves every receipted control and its workflow/review metadata');

  assert.throws(() => receipt.validatePageReceipt({
    ...page,
    fields: page.fields.map((field, index) => index === 0 ? { ...field, answer: 'tampered' } : field),
  }, run), /fingerprint/);
  pass('stored page fingerprints detect field-ledger tampering');

  const finalUrl = 'https://jobs.example.test/1/apply/review';
  const finalEvidenceId = installResolverEvidence(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'final-review', page_index: 1, url: finalUrl,
  }, { fields: [], resolved: [], novel: [], answers: [] });
  const finalSnapshotDigest = role.application_progress.pending_resolver_evidence.snapshot_digest;
  assert.throws(() => receipt.recordPageReceipt(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'final-review', page_index: 1,
    url: finalUrl, resolver_evidence_id: finalEvidenceId, field_count: 0, fields: [],
    upload_controls: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: true,
  }), /browser_observation is required/);
  pass('lookup/teach evidence plus booleans cannot replace browser observation evidence');
  assert.throws(() => receipt.recordPageReceipt(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'final-review', page_index: 1,
    url: finalUrl, resolver_evidence_id: finalEvidenceId, field_count: 0, fields: [],
    upload_controls: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: false,
    browser_observation: browserObservation(finalUrl, [], finalSnapshotDigest),
  }), /zero-field receipt is allowed only/);
  pass('a zero-field form or non-final page cannot be receipted as complete');

  // Even a fully valid, self-consistent evidence blob inlined into the --page
  // payload must be rejected when nothing was staged by queue-resolve: the
  // live path only trusts progress.pending_resolver_evidence.
  const stolenFinalEvidence = structuredClone(role.application_progress.pending_resolver_evidence);
  delete role.application_progress.pending_resolver_evidence;
  assert.throws(() => receipt.recordPageReceipt(role, {
    run_id: run.run_id, tab_id: 'tab-acme', page_id: 'final-review', page_index: 1,
    url: finalUrl, resolver_evidence_id: finalEvidenceId, field_count: 0, fields: [],
    upload_controls: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: true,
    resolver_evidence: stolenFinalEvidence,
    browser_observation: browserObservation(finalUrl, [], finalSnapshotDigest, {
      finalPage: true,
      pageKind: 'review',
    }),
  }), /executable resolver evidence is missing/);
  pass('a caller-inlined resolver evidence blob cannot replace staged queue-resolve evidence');
  role.application_progress.pending_resolver_evidence = stolenFinalEvidence;

  receipt.recordPageReceipt(role, {
    run_id: run.run_id,
    tab_id: 'tab-acme',
    page_id: 'final-review',
    page_index: 1,
    url: finalUrl,
    resolver_evidence_id: finalEvidenceId,
    field_count: 0,
    fields: [],
    lookup_completed: true,
    l3_completed: true,
    teach_completed: true,
    conditional_rescan_completed: true,
    verified: true,
    validation_errors: [],
    browser_observation: browserObservation(finalUrl, [], finalSnapshotDigest, {
      finalPage: true,
      pageKind: 'review',
    }),
    upload_controls: [],
    attachments: [
      attachment('resume-upload', 'CV', cvPath),
      attachment('cover-upload', 'Cover letter', coverPdfPath),
    ],
    final_page: true,
  });

  const reportPath = join(reportsDir, '001-acme.md');
  const finalReportSection = formatApplicationAnswersSection(
    snapshotFromApplicationProgress(role.application_progress, {
      date: '2026-07-16', state: 'prefilled',
    }),
  );
  const tamperedReportSection = finalReportSection.replace(
    '- Review note: Verify the portal wording before submission.',
    '- Review note: Tampered review note.',
  );
  writeFileSync(reportPath, `# Acme — Analyst\n\n${tamperedReportSection}`, 'utf8');
  assert.throws(() => receipt.finalizeApplicationProgress(role, {
    run_id: run.run_id,
    final_url: finalUrl,
    application_answers_report: reportPath,
    validation_errors: [],
    attachments: [
      attachment('resume-upload', 'CV', cvPath),
      attachment('cover-upload', 'Cover letter', coverPdfPath),
    ],
  }), /review_note does not exactly match/);
  assert.equal(role.application_progress.review_ready, false);
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* prefilled/);
  pass('finalization rejects a report whose per-control review metadata was altered');

  writeFileSync(reportPath, `# Acme — Analyst\n\n${finalReportSection}`, 'utf8');

  assert.throws(() => receipt.finalizeApplicationProgress(role, {
    run_id: run.run_id,
    final_url: finalUrl,
    application_answers_report: reportPath,
    validation_errors: [],
    attachments: [attachment('resume-upload', 'CV', cvPath)],
  }), /cover-compatible upload control was observed but no verified cover letter was attached/);
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* prefilled/);
  pass('a live cover-compatible upload control cannot finalize with CV-only evidence');

  assert.throws(() => receipt.finalizeApplicationProgress(role, {
    run_id: run.run_id,
    final_url: finalUrl,
    application_answers_report: reportPath,
    validation_errors: [],
    attachments: [],
    attachments_not_applicable_reason: 'Attachments are not applicable.',
  }), /not_applicable_reason is invalid while an enabled upload control accepts an attachment/);
  assert.throws(() => receipt.finalizeApplicationProgress(role, {
    run_id: run.run_id,
    final_url: finalUrl,
    application_answers_report: reportPath,
    validation_errors: [],
    attachments: [
      attachment('resume-upload', 'CV', cvPath),
      attachment('cover-upload', 'Cover letter', coverPdfPath),
    ],
    attachments_not_applicable_reason: 'Attachments are not applicable.',
  }), /not_applicable_reason cannot accompany verified attachments/);
  pass('not-applicable attachment evidence is accepted only when no enabled upload control exists');

  const finalized = receipt.finalizeApplicationProgress(role, {
    run_id: run.run_id,
    final_url: finalUrl,
    application_answers_report: reportPath,
    validation_errors: [],
    attachments: [
      attachment('resume-upload', 'CV', cvPath),
      attachment('cover-upload', 'Cover letter', coverPdfPath),
    ],
  });
  assert.equal(finalized.review_ready, true);
  assert.equal(finalized.receipt_id, 'application-receipt:acme:analyst:apply-acme-1');
  assert.equal(role.application_request.state, 'review-ready');
  assert.equal(role.application_request.receipt_id, finalized.receipt_id);
  assert.equal(role.application_request.completed_at, finalized.finalized_at);
  assert.equal(finalized.integrity.version, 2);
  assert.equal(finalized.integrity.expected_report_state, 'filled');
  assert.match(finalized.integrity.digest, /^[a-f0-9]{64}$/);
  assert.equal(finalized.integrity.artifacts.report.state, 'filled');
  assert.equal(finalized.integrity.artifacts.handover.receipt_id, finalized.receipt_id);
  assert.deepEqual(receipt.reviewReadinessErrors(role), []);
  role.application_request.state = 'in-progress';
  assert(
    receipt.reviewReadinessErrors(role)
      .some((error) => error.includes('dashboard application_request authorization is invalid')),
    'review readiness must fail when the consumed request is not review-ready',
  );
  role.application_request.state = 'review-ready';
  assert.deepEqual(role.review_required_fields, ['Work authorization detail']);
  assert.match(readFileSync(handoverPath, 'utf8'), /application-receipt:acme:analyst:apply-acme-1/);
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* filled/);
  pass('finalizer seals the full request/tab/page/report/handover evidence contract');

  const originalCoverPdf = readFileSync(coverPdfPath);
  writeFileSync(coverPdfPath, Buffer.concat([originalCoverPdf, Buffer.from('\nchanged-content') ]));
  assert(
    receipt.reviewReadinessErrors(role)
      .some((error) => /content hash no longer matches|integrity digest/.test(error)),
    'replacing an attachment under the same basename must invalidate the receipt',
  );
  writeFileSync(coverPdfPath, originalCoverPdf);
  pass('attachment evidence binds file content, not only the displayed basename');

  const tamperedController = structuredClone(role);
  tamperedController.status = 'prepared';
  tamperedController.application_request.controller_id = 'browser-controller:forged';
  assert.throws(
    () => setStatus({ roles: [tamperedController] }, tamperedController.id, 'filled'),
    /controller_id differs|integrity digest/,
  );
  const tamperedPage = structuredClone(role);
  tamperedPage.status = 'prepared';
  tamperedPage.application_progress.pages[0].fields[0].answer = 'Forged answer';
  assert.throws(
    () => setStatus({ roles: [tamperedPage] }, tamperedPage.id, 'filled'),
    /page fingerprint|integrity digest/,
  );
  const originalReport = readFileSync(reportPath, 'utf8');
  writeFileSync(reportPath, originalReport.replace(
    'Distinctive remediation evidence answer.',
    'Forged report answer.',
  ), 'utf8');
  assert.throws(
    () => setStatus({ roles: [structuredClone(role)] }, role.id, 'filled'),
    /report\/handover artifacts no longer match|Application Answers/,
  );
  writeFileSync(reportPath, originalReport, 'utf8');
  const originalHandover = readFileSync(handoverPath, 'utf8');
  writeFileSync(handoverPath, originalHandover.replace(
    'final application submission not performed by agent.',
    'forged completion claim.',
  ), 'utf8');
  assert.throws(
    () => setStatus({ roles: [structuredClone(role)] }, role.id, 'filled'),
    /handover receipt is missing binding|report\/handover artifacts no longer match/,
  );
  writeFileSync(handoverPath, originalHandover, 'utf8');
  const liveQueue = { roles: [role] };
  assert.equal(setStatus(liveQueue, role.id, 'filled'), true);
  assert.equal(role.status, 'filled');
  pass('queue-store independently rejects tampered evidence and accepts the canonical finalizer seal');

  assert.deepEqual(receipt.submissionReadinessErrors(role), []);
  const submissionTransition = receipt.markApplicationReportSubmitted(role);
  assert.equal(submissionTransition.changed, true);
  assert.equal(submissionTransition.receipt_id, finalized.receipt_id);
  assert.equal(role.application_progress.report_state, 'submitted');
  assert.equal(role.application_progress.integrity.expected_report_state, 'submitted');
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* submitted/);
  assert.deepEqual(receipt.submissionReadinessErrors(role), []);
  assert.equal(setStatus(liveQueue, role.id, 'submitted'), true);
  assert.equal(role.status, 'submitted');
  const submissionRetry = receipt.markApplicationReportSubmitted(role);
  assert.equal(submissionRetry.changed, false);
  assert.equal(receipt.rollbackApplicationReportSubmission(role, submissionTransition), true);
  role.status = 'filled';
  assert.equal(role.application_progress.integrity.expected_report_state, 'filled');
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* filled/);
  assert.deepEqual(receipt.reviewReadinessErrors(role), []);
  receipt.markApplicationReportSubmitted(role);
  assert.equal(setStatus(liveQueue, role.id, 'submitted'), true);
  assert.match(readFileSync(reportPath, 'utf8'), /\*\*State:\*\* submitted/);
  pass('candidate-confirmed promotion refreshes the submitted seal and rollback restores the filled seal');

  assert.throws(() => setStatus({ roles: [{ id: 'bypass', status: 'prepared' }] }, 'bypass', 'filled'), /finalized review-ready/);
  pass('queue status cannot bypass the receipt finalizer');

  const failedCvPath = join(temp, 'output', 'failed-cv.pdf');
  const failedCvHtmlPath = join(temp, 'output', 'failed-cv.html');
  writePdfFixture(failedCvPath);
  writeFileSync(failedCvHtmlPath, '<html><body>SQL analysis and stakeholder reporting evidence.</body></html>', 'utf8');
  const failedRole = {
    id: 'failed:role', company: 'Acme', title: 'Analyst', url: role.url,
    status: 'prepared', cv_pdf: failedCvPath, jd_text: role.jd_text,
    cover_letter_paths: structuredClone(role.cover_letter_paths),
  };
  authorize(failedRole, 'failed-run');
  const failedRun = receipt.beginApplicationProgress(failedRole, {
    run_id: 'failed-run', tab: { id: 'failed-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'failed'),
  });
  const failedEvidenceId = installResolverEvidence(failedRole, {
    run_id: failedRun.run_id, tab_id: 'failed-tab', page_id: 'final', page_index: 0, url: role.url,
  }, { fields: [], resolved: [], novel: [], answers: [] });
  const failedSnapshotDigest = failedRole.application_progress.pending_resolver_evidence.snapshot_digest;
  receipt.recordPageReceipt(failedRole, {
    run_id: failedRun.run_id, tab_id: 'failed-tab', page_id: 'final', page_index: 0,
    url: role.url, resolver_evidence_id: failedEvidenceId, field_count: 0, fields: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: true,
    browser_observation: browserObservation(role.url, [], failedSnapshotDigest, {
      finalPage: true,
      pageKind: 'review',
    }),
    upload_controls: [],
  });
  const failedReportPath = join(reportsDir, '002-failed.md');
  writeFileSync(
    failedReportPath,
    `# Failed — Role\n\n${formatApplicationAnswersSection(
      snapshotFromApplicationProgress(failedRole.application_progress, {
        date: '2026-07-16', state: 'prefilled',
      }),
    )}`,
    'utf8',
  );
  failedRole.status = 'scored';
  assert.throws(() => receipt.finalizeApplicationProgress(failedRole, {
    run_id: failedRun.run_id, final_url: role.url,
    application_answers_report: failedReportPath, validation_errors: [], attachments: [],
    attachments_not_applicable_reason: 'Portal has no upload controls.',
  }), /may finalize only from/);
  failedRole.status = 'prepared';
  rmSync(failedCvPath);
  assert.throws(() => receipt.finalizeApplicationProgress(failedRole, {
    run_id: failedRun.run_id, final_url: role.url,
    application_answers_report: failedReportPath, validation_errors: [],
    attachments: [],
    attachments_not_applicable_reason: 'Portal has no upload controls.',
  }), /quality evidence asset is missing|quality gate failed|no longer matches/);
  assert.match(readFileSync(failedReportPath, 'utf8'), /\*\*State:\*\* prefilled/);
  assert.equal(failedRole.application_progress.review_ready, false);
  assert.equal(failedRole.application_request.state, 'in-progress');
  pass('finalize status guard and failed finalization cannot leave a false-filled report or role receipt');

  const incomplete = authorize({
    id: 'bad:role', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
    cv_pdf: cvPath, jd_text: role.jd_text,
    cover_letter_paths: structuredClone(role.cover_letter_paths),
  }, 'bad-run');
  const incompleteRun = receipt.beginApplicationProgress(incomplete, {
    run_id: 'bad-run', tab: { id: 'bad-tab', url: role.url },
    ...preflight(role.url, 'Acme', 'Analyst', 'bad'),
  });
  const badEvidenceId = installResolverEvidence(incomplete, {
    run_id: incompleteRun.run_id, tab_id: 'bad-tab', page_id: 'bad', page_index: 0, url: role.url,
  }, {
    fields: [{ control_id: 'novel-question', label: 'Novel question', type: 'text', required: true, options: [], help: null, kind: null }],
    resolved: [],
    novel: [{ control_id: 'novel-question', label: 'Novel question', type: 'text', required: true }],
    answers: [{
      control_id: 'novel-question',
      label: 'Novel question', type: 'text', answer: 'Answer', reusable: false,
      review_required: false, review_note: null,
    }],
  });
  assert.throws(() => receipt.recordPageReceipt(incomplete, {
    run_id: incompleteRun.run_id, tab_id: 'bad-tab', page_id: 'bad', page_index: 0,
    url: role.url, field_count: 1,
    upload_controls: [],
    resolver_evidence_id: badEvidenceId,
    fields: [{
      control_id: 'novel-question',
      label: 'Novel question', type: 'text', required: true, answer: 'Answer',
      resolution: 'novel', provenance: 'model', taught: false, review_required: false,
    }],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: false,
  }), /must be taught/);
  pass('untaught novel answers can never produce a page receipt');

  // ── Evidence-protocol v3 enforcement ───────────────────────────────────────
  const v3Role = authorize({
    id: 'v3:role', company: 'Acme', title: 'Analyst', url: role.url, status: 'prepared',
    cv_pdf: cvPath, jd_text: role.jd_text,
    cover_letter_paths: structuredClone(role.cover_letter_paths),
  }, 'v3-run');
  const v3Preflight = preflight(role.url, 'Acme', 'Analyst', 'v3');
  delete v3Preflight.evidence_capture; // production shape: no test escape
  const v3Run = receipt.beginApplicationProgress(v3Role, {
    run_id: 'v3-run', tab: { id: 'v3-tab', url: role.url },
    execution_protocol: 'receipt-v3',
    ...v3Preflight,
  });
  assert.equal(v3Run.evidence_capture, 'file-derived');
  assert.equal(v3Run.evidence_protocol, 'v3');
  const v3EvidenceId = installResolverEvidence(v3Role, {
    run_id: v3Run.run_id, tab_id: 'v3-tab', page_id: 'v3-final', page_index: 0, url: role.url,
  }, { fields: [], resolved: [], novel: [], answers: [] });
  const v3Digest = v3Role.application_progress.pending_resolver_evidence.snapshot_digest;
  assert.throws(() => receipt.recordPageReceipt(v3Role, {
    run_id: v3Run.run_id, tab_id: 'v3-tab', page_id: 'v3-final', page_index: 0,
    url: role.url, resolver_evidence_id: v3EvidenceId, field_count: 0, fields: [],
    lookup_completed: true, l3_completed: true, teach_completed: true,
    conditional_rescan_completed: true, verified: true, validation_errors: [], final_page: true,
    browser_observation: browserObservation(role.url, [], v3Digest, { finalPage: true, pageKind: 'review' }),
    upload_controls: [],
  }), /hand-authored resolver evidence is not accepted.*apply-page\.mjs lookup/s);
  pass('v3 runs mechanically reject hand-authored resolver evidence (file-derived receipts only)');

  const fallbackBlock = receipt.recordVerificationFallback(v3Role, {
    reason: 'canvas-based custom widget cannot be machine-extracted',
    control_ids: ['custom:widget:1'],
    url: role.url,
    page_index: 0,
  });
  assert.equal(fallbackBlock.reason, 'canvas-based custom widget cannot be machine-extracted');
  assert.throws(() => receipt.finalizeApplicationProgress(v3Role, {
    run_id: v3Run.run_id, final_url: role.url,
    application_answers_report: 'reports/does-not-matter.md', validation_errors: [], attachments: [],
  }), /verification fallback.*cannot become review-ready/s);
  assert.ok(receipt.reviewReadinessErrors(v3Role).some((err) => /verification fallback/.test(err)));
  pass('a recorded verification fallback permanently blocks review-ready finalization');
} finally {
  if (oldReports == null) delete process.env.CAREER_OPS_REPORTS_DIR;
  else process.env.CAREER_OPS_REPORTS_DIR = oldReports;
  if (oldHandover == null) delete process.env.CAREER_OPS_HANDOVER_PATH;
  else process.env.CAREER_OPS_HANDOVER_PATH = oldHandover;
  if (oldNodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldTestProjectRoot == null) delete process.env.CAREER_OPS_TEST_PROJECT_ROOT;
  else process.env.CAREER_OPS_TEST_PROJECT_ROOT = oldTestProjectRoot;
  rmSync(temp, { recursive: true, force: true });
}
