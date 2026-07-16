#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatApplicationAnswersSection,
  snapshotFromApplicationProgress,
} from '../application-answers.mjs';
import { pass, ROOT } from './helpers.mjs';

console.log('\nApplication Answers persistence gate');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-answers-gate-'));
const reportsDir = join(temp, 'reports');
const dataDir = join(temp, 'data');
mkdirSync(reportsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const oldReports = process.env.CAREER_OPS_REPORTS_DIR;
const oldNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_REPORTS_DIR = reportsDir;

try {
  const receipt = await import(`../application-receipt.mjs?answers-gate=${Date.now()}`);
  const reportPath = join(reportsDir, '001-acme.md');
  const field = (overrides = {}) => ({
    control_id: 'why-role',
    label: 'Why this role?',
    type: 'textarea',
    answer: 'An exact, source-supported answer.',
    resolution: 'novel',
    provenance: 'model',
    taught: true,
    review_required: false,
    review_note: null,
    ...overrides,
  });
  const progress = {
    run_id: 'answers-run-1',
    pages: [{
      page_id: 'questions',
      page_index: 0,
      fields: [field()],
      attachments: [],
    }],
  };
  const validSnapshot = snapshotFromApplicationProgress(progress, {
    date: '2026-07-16',
    state: 'prefilled',
  });
  validSnapshot.files.push({
    field: 'CV',
    path: 'output/acme-cv.pdf',
    expected: 'output/acme-cv.pdf',
    verified: true,
  });
  const validSection = formatApplicationAnswersSection(validSnapshot);
  writeFileSync(reportPath, [
    '# Acme — Analyst',
    '',
    '**State:** submitted',
    '**Run ID:** unrelated-run',
    '',
    validSection.trimEnd(),
    '',
  ].join('\n'), 'utf8');
  assert.doesNotThrow(() => receipt.validateApplicationAnswersReport(reportPath, progress, 'prefilled'));
  assert.match(validSection, /- Page: questions/);
  assert.match(validSection, /- Page index: 0/);
  assert.match(validSection, /- Control ID: why-role/);
  assert.match(validSection, /- Occurrence: 1/);
  assert.match(validSection, /- Taught: yes/);
  assert.match(validSection, /- Review note: \(none\)/);
  pass('exact Application Answers entries persist full receipt metadata while file attachments remain separate');

  const duplicateProgress = {
    run_id: 'answers-run-duplicate',
    pages: [{
      page_id: 'duplicate-labels',
      page_index: 0,
      fields: [
        field({
          control_id: 'response-one', label: 'Response', answer: 'First answer.',
          review_required: true, review_note: 'Confirm the first response.',
        }),
        field({
          control_id: 'response-two', label: 'Response', answer: 'Second answer.',
          resolution: 'resolved', provenance: 'cache', taught: false,
        }),
      ],
      attachments: [],
    }],
  };
  const incompleteProgress = structuredClone(duplicateProgress);
  incompleteProgress.pages[0].fields = incompleteProgress.pages[0].fields.slice(0, 1);
  const incompleteDuplicateSection = formatApplicationAnswersSection(
    snapshotFromApplicationProgress(incompleteProgress, {
      date: '2026-07-16',
      state: 'prefilled',
    }),
  );
  writeFileSync(reportPath, `# Duplicate labels\n\n${incompleteDuplicateSection}`, 'utf8');
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
    /missing receipted field occurrence/,
  );

  const duplicateSnapshot = snapshotFromApplicationProgress(duplicateProgress, {
    date: '2026-07-16',
    state: 'prefilled',
  });
  const completeDuplicateSection = formatApplicationAnswersSection(duplicateSnapshot);
  writeFileSync(reportPath, `# Duplicate labels\n\n${completeDuplicateSection}`, 'utf8');
  assert.doesNotThrow(
    () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
  );
  assert.match(completeDuplicateSection, /Control ID: response-one[\s\S]*Occurrence: 1/);
  assert.match(completeDuplicateSection, /Control ID: response-two[\s\S]*Occurrence: 2/);
  pass('duplicate labels remain distinct through control ID and explicit occurrence metadata');

  const identityMismatchCases = [
    ['page', '- Page: duplicate-labels', '- Page: wrong-page'],
    ['page_index', '- Page index: 0', '- Page index: 1'],
    ['control_id', '- Control ID: response-one', '- Control ID: wrong-control'],
    ['occurrence', '- Occurrence: 1', '- Occurrence: 3'],
  ];
  for (const [, before, after] of identityMismatchCases) {
    const mismatched = completeDuplicateSection.replace(before, after);
    writeFileSync(reportPath, `# Identity mismatch\n\n${mismatched}`, 'utf8');
    assert.throws(
      () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
      /missing receipted field occurrence/,
    );
  }
  pass('page, page index, control ID, and occurrence are mandatory receipt-bound identities');

  const mismatchCases = [
    ['provenance', '- Provenance: model', '- Provenance: cache'],
    ['resolution', '- Resolution: novel', '- Resolution: resolved'],
    ['taught', '- Taught: yes', '- Taught: no'],
    ['review_required', '- Review required: yes', '- Review required: no'],
    ['review_note', '- Review note: Confirm the first response.', '- Review note: Different note.'],
  ];
  for (const [property, before, after] of mismatchCases) {
    const mismatched = completeDuplicateSection.replace(before, after);
    writeFileSync(reportPath, `# Metadata mismatch\n\n${mismatched}`, 'utf8');
    assert.throws(
      () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
      new RegExp(`Application Answers ${property} does not exactly match`),
    );
  }
  pass('resolution, provenance, teaching, and review metadata must exactly match the receipt');

  const missingMetadata = completeDuplicateSection.replace('- Control ID: response-one\n', '');
  writeFileSync(reportPath, `# Missing metadata\n\n${missingMetadata}`, 'utf8');
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
    /missing receipt metadata: control_id/,
  );
  pass('missing receipt identity metadata is rejected');

  const duplicateConsumedSnapshot = structuredClone(duplicateSnapshot);
  duplicateConsumedSnapshot.freeText.push(structuredClone(duplicateConsumedSnapshot.freeText[0]));
  writeFileSync(
    reportPath,
    `# Duplicate consumed\n\n${formatApplicationAnswersSection(duplicateConsumedSnapshot)}`,
    'utf8',
  );
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
    /duplicate-consumed field entry/,
  );
  pass('one persisted field occurrence cannot be consumed twice');

  const unexpectedExtraSnapshot = structuredClone(duplicateSnapshot);
  unexpectedExtraSnapshot.freeText.push({
    ...structuredClone(duplicateSnapshot.freeText[0]),
    question: 'Unexpected question',
    field: 'Unexpected question',
    answer: 'Unexpected answer.',
    value: 'Unexpected answer.',
    selection: 'Unexpected answer.',
    control_id: 'unexpected-control',
    occurrence: 1,
  });
  writeFileSync(
    reportPath,
    `# Unexpected extra\n\n${formatApplicationAnswersSection(unexpectedExtraSnapshot)}`,
    'utf8',
  );
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, duplicateProgress, 'prefilled'),
    /unexpected extra field entry/,
  );
  pass('unexpected report field entries are rejected rather than silently ignored');

  const wrongAnswerSection = validSection.replace(
    '> An exact, source-supported answer.',
    '> An exact, source-supported answer with unrelated extra text.',
  );
  writeFileSync(reportPath, [
    '# Acme — Analyst',
    '',
    '## H) Draft Application Answers',
    '',
    '1. **Why this role?**',
    '',
    '> An exact, source-supported answer.',
    '',
    wrongAnswerSection.trimEnd(),
  ].join('\n'), 'utf8');
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, progress, 'prefilled'),
    /answer does not exactly match the receipted field/,
  );
  pass('an answer appearing elsewhere in the report cannot satisfy the exact structured section ledger');

  writeFileSync(
    reportPath,
    `# Acme — Analyst\n\n**State:** prefilled\n\n${validSection.replace('**State:** prefilled\n', '')}`,
    'utf8',
  );
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, progress, 'prefilled'),
    /State: prefilled/,
  );
  pass('state metadata outside the exact Application Answers section is rejected');

  writeFileSync(
    reportPath,
    `# Acme — Analyst\n\n**Run ID:** answers-run-1\n\n${validSection.replace('**Run ID:** answers-run-1\n', '')}`,
    'utf8',
  );
  assert.throws(
    () => receipt.validateApplicationAnswersReport(reportPath, progress, 'prefilled'),
    /Run ID does not match/,
  );
  pass('run metadata outside the exact Application Answers section is rejected');

  const cliReport = join(temp, 'cli-report.md');
  const cliInput = join(temp, 'answers.json');
  writeFileSync(cliReport, '# CLI report\n', 'utf8');
  const baseline = readFileSync(cliReport, 'utf8');
  const runCli = (...args) => spawnSync(
    process.execPath,
    [join(ROOT, 'application-answers.mjs'), '--report', cliReport, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_DATA_DIR: dataDir,
        CAREER_OPS_QUEUE_BACKEND: 'local',
      },
    },
  );

  for (const state of ['filled', 'submitted']) {
    writeFileSync(cliInput, JSON.stringify({ state, freeText: [] }), 'utf8');
    const result = runCli('--input', cliInput);
    assert.notEqual(result.status, 0, `CLI unexpectedly authored state ${state}`);
    assert.match(result.stderr, /cannot be authored by application-answers\.mjs/);
    assert.equal(readFileSync(cliReport, 'utf8'), baseline);
  }
  pass('input snapshots cannot directly author filled or submitted report states');

  writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
    version: 1,
    settings: {},
    roles: [{
      id: 'acme:analyst',
      company: 'Acme',
      title: 'Analyst',
      status: 'prepared',
      application_progress: {
        run_id: 'answers-run-1',
        pages: [{ page_id: 'questions', page_index: 0, fields: [], attachments: [] }],
      },
    }],
  }), 'utf8');
  const roleResult = runCli('--role', 'acme:analyst', '--state', 'submitted');
  assert.notEqual(roleResult.status, 0);
  assert.match(roleResult.stderr, /cannot be authored by application-answers\.mjs/);
  assert.equal(readFileSync(cliReport, 'utf8'), baseline);
  pass('role-derived report writes are also restricted to the prefilled checkpoint');

  writeFileSync(cliInput, JSON.stringify({
    state: 'prefilled',
    runId: 'answers-run-1',
    freeText: [{ question: 'Why this role?', answer: 'An exact, source-supported answer.' }],
  }), 'utf8');
  const prefilledResult = runCli('--input', cliInput);
  assert.equal(prefilledResult.status, 0, prefilledResult.stderr);
  assert.match(readFileSync(cliReport, 'utf8'), /\*\*State:\*\* prefilled/);
  pass('application-answers CLI still authors the required prefilled checkpoint');
} finally {
  if (oldReports == null) delete process.env.CAREER_OPS_REPORTS_DIR;
  else process.env.CAREER_OPS_REPORTS_DIR = oldReports;
  if (oldNodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  rmSync(temp, { recursive: true, force: true });
}
