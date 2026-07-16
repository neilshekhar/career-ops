#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass } from './helpers.mjs';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';

console.log('\nMerge-tracker progression provenance');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const HEADER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function makeSandbox(additions) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-merge-progression-'));
  const tracker = join(dir, 'applications.md');
  const additionsDir = join(dir, 'tracker-additions');
  mkdirSync(additionsDir, { recursive: true });
  writeFileSync(tracker, HEADER, 'utf8');
  for (const [filename, content] of Object.entries(additions)) {
    writeFileSync(join(additionsDir, filename), content, 'utf8');
  }
  return { dir, tracker, additions: additionsDir };
}

function runMerge(sandbox, args = []) {
  const env = {
    ...process.env,
    CAREER_OPS_TRACKER: sandbox.tracker,
    CAREER_OPS_ADDITIONS: sandbox.additions,
  };
  const result = spawnSync(NODE, [join(ROOT, 'merge-tracker.mjs'), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error || ''),
  };
}

function rows(sandbox) {
  const lines = readFileSync(sandbox.tracker, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

function tsv(num, company, status) {
  return `${num}\t2026-07-16\t${company}\t${company} Analyst\t${status}\t4.2/5\t❌\t[${num}](reports/${num}-${company.toLowerCase()}.md)\timport fixture\n`;
}

// A lifecycle label in an ordinary evaluation addition is not event evidence.
// It must land as Evaluated and carry no fabricated progression provenance.
{
  const sandbox = makeSandbox({ '1-default.tsv': tsv(1, 'DefaultCo', 'Applied') });
  try {
    const result = runMerge(sandbox);
    const row = rows(sandbox)[0];
    assert.equal(result.code, 0);
    assert.equal(row.status, 'Evaluated');
    assert.doesNotMatch(row.notes, /external-status|tracker-import/);
    assert.match(result.stderr, /importing as Evaluated/);
    assert.equal(existsSync(join(sandbox.additions, '1-default.tsv')), false);
    pass('ordinary TSV lifecycle claims are downgraded to Evaluated without provenance');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// Every post-application lifecycle state, including Hired, is accepted only as
// an explicit historical import. merge-tracker creates Evaluated rows, releases
// its lock, then set-status performs the provenance-marked promotions.
{
  const statuses = ['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected'];
  const additions = Object.fromEntries(statuses.map((status, index) => {
    const num = index + 10;
    return [`${num}-${status.toLowerCase()}.tsv`, tsv(num, `${status}Co`, status)];
  }));
  const sandbox = makeSandbox(additions);
  try {
    const result = runMerge(sandbox, ['--historical-import']);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const byCompany = new Map(rows(sandbox).map((row) => [row.company, row]));
    for (const [index, status] of statuses.entries()) {
      const row = byCompany.get(`${status}Co`);
      const filename = `${index + 10}-${status.toLowerCase()}.tsv`;
      assert.equal(row?.status, status);
      assert.match(row?.notes || '', /\[external-status\]/);
      assert.match(row?.notes || '', new RegExp(`\\[tracker-import:historical\\] source=${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(existsSync(join(sandbox.additions, filename)), false);
      assert.equal(existsSync(join(sandbox.additions, 'merged', filename)), true);
    }
    pass('explicit historical import promotes every lifecycle state through set-status with provenance');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// External imports use a distinct durable source marker while sharing the
// canonical set-status --external evidence boundary.
{
  const sandbox = makeSandbox({ '30-external.tsv': tsv(30, 'ExternalCo', 'Applied') });
  try {
    const result = runMerge(sandbox, ['--external-import']);
    const row = rows(sandbox)[0];
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(row.status, 'Applied');
    assert.match(row.notes, /\[tracker-import:external\] source=30-external\.tsv/);
    assert.match(row.notes, /\[external-status\]/);
    pass('explicit external import records external provenance through canonical set-status');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// PDF generation is a metadata-only tracker upgrade. It uses an Evaluated TSV
// and must not reset an already-progressed row or rewrite unrelated metadata.
{
  const sandbox = makeSandbox({
    '35-pdf.tsv': '35\t2026-07-16\tPdfCo\tPdfCo Analyst\tEvaluated\t4.2/5\t✅\t[35](reports/35-pdfco.md)\tnew pdf generated\n',
  });
  try {
    writeFileSync(sandbox.tracker, `${HEADER}| 35 | 2026-07-01 | PdfCo | PdfCo Analyst | 4.2/5 | Interview | ❌ | [35](reports/35-pdfco.md) | preserve this note |\n`, 'utf8');
    const result = runMerge(sandbox);
    const row = rows(sandbox)[0];
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(row.status, 'Interview');
    assert.equal(row.pdf, '✅');
    assert.equal(row.score, '4.2/5');
    assert.equal(row.date, '2026-07-01');
    assert.equal(row.notes, 'preserve this note');
    assert.match(result.stdout, /PDF ❌→✅/);
    pass('same-score PDF upgrade is monotonic and preserves lifecycle status plus metadata');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// A stale lower-score TSV is not allowed to smuggle in a PDF flag; pdf mode
// must identify the current tracker row and carry its existing score.
{
  const sandbox = makeSandbox({
    '36-stale-pdf.tsv': '36\t2026-07-16\tStalePdfCo\tStalePdfCo Analyst\tEvaluated\t4.2/5\t✅\t[36](reports/36-stale-pdfco.md)\tstale pdf fixture\n',
  });
  try {
    writeFileSync(sandbox.tracker, `${HEADER}| 36 | 2026-07-01 | StalePdfCo | StalePdfCo Analyst | 4.7/5 | Offer | ❌ | [36](reports/36-stale-pdfco.md) | current row |\n`, 'utf8');
    const result = runMerge(sandbox);
    const row = rows(sandbox)[0];
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(row.status, 'Offer');
    assert.equal(row.pdf, '❌');
    assert.equal(row.score, '4.7/5');
    pass('lower-score duplicate cannot perform a stale PDF metadata upgrade');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// A lifecycle TSV whose Evaluated row already exists is the failed-promotion
// signature: a provenanced import merged the row but its set-status promotion
// did not commit. A routine plain merge must leave that TSV pending instead of
// consuming the retry source, and a provenanced rerun must then promote it.
{
  const sandbox = makeSandbox({ '50-defer.tsv': tsv(50, 'DeferCo', 'Evaluated') });
  try {
    const seed = runMerge(sandbox);
    assert.equal(seed.code, 0, `${seed.stdout}\n${seed.stderr}`);
    writeFileSync(join(sandbox.additions, '50-defer-retry.tsv'), tsv(50, 'DeferCo', 'Applied'), 'utf8');

    const plain = runMerge(sandbox);
    const row = rows(sandbox)[0];
    assert.equal(plain.code, 0, `${plain.stdout}\n${plain.stderr}`);
    assert.equal(row.status, 'Evaluated');
    assert.match(plain.stderr, /leaving the TSV pending/);
    assert.equal(existsSync(join(sandbox.additions, '50-defer-retry.tsv')), true);
    assert.equal(existsSync(join(sandbox.additions, 'merged', '50-defer-retry.tsv')), false);

    const retry = runMerge(sandbox, ['--external-import']);
    const promoted = rows(sandbox)[0];
    assert.equal(retry.code, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(promoted.status, 'Applied');
    assert.match(promoted.notes, /\[external-status\]/);
    assert.equal(existsSync(join(sandbox.additions, '50-defer-retry.tsv')), false);
    assert.equal(existsSync(join(sandbox.additions, 'merged', '50-defer-retry.tsv')), true);
    pass('plain merge defers a pending lifecycle TSV and a provenanced retry still promotes it');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// Re-importing an old TSV batch must never walk a progressed row backward:
// an import promotion is applied only when it advances the canonical ladder.
{
  const sandbox = makeSandbox({ '51-regress.tsv': tsv(51, 'RegressCo', 'Applied') });
  try {
    writeFileSync(sandbox.tracker, `${HEADER}| 51 | 2026-07-01 | RegressCo | RegressCo Analyst | 4.2/5 | Interview | ❌ | [51](reports/51-regressco.md) | in process |\n`, 'utf8');
    const result = runMerge(sandbox, ['--external-import']);
    const row = rows(sandbox)[0];
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(row.status, 'Interview');
    assert.equal(row.notes, 'in process');
    assert.match(result.stderr, /skipping non-advancing Applied promotion/);
    assert.equal(existsSync(join(sandbox.additions, 'merged', '51-regress.tsv')), true);
    pass('provenanced re-import cannot regress a progressed row backward');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// Provenance modes are intentionally unambiguous and fail before the tracker
// or pending import is touched.
{
  const sandbox = makeSandbox({ '40-conflict.tsv': tsv(40, 'ConflictCo', 'Hired') });
  try {
    const before = readFileSync(sandbox.tracker, 'utf8');
    const result = runMerge(sandbox, ['--external-import', '--historical-import']);
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(sandbox.tracker, 'utf8'), before);
    assert.equal(existsSync(join(sandbox.additions, '40-conflict.tsv')), true);
    pass('conflicting import provenance flags fail closed before mutation');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}
