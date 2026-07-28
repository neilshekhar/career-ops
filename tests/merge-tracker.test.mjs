// tests/merge-tracker.test.mjs — regression coverage for status validation.
//
// `validateStatus` is not exported and importing merge-tracker.mjs runs the CLI
// (top-level lock + merge), so this exercises the real merge path as a CLI
// integration test via the CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS env
// overrides the script already supports for test isolation.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nmerge-tracker.mjs — status validation');

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n');

// One merge run in an isolated workspace. Returns the merged tracker text.
function runMerge(additions) {
  const work = mkdtempSync(join(tmpdir(), 'cops-merge-'));
  try {
    const tracker = join(work, 'applications.md');
    const addsDir = join(work, 'adds');
    mkdirSync(addsDir, { recursive: true });
    writeFileSync(tracker, TRACKER_HEADER);
    for (const [name, line] of Object.entries(additions)) {
      writeFileSync(join(addsDir, name), line);
    }
    execFileSync(NODE, [join(ROOT, 'merge-tracker.mjs')], {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: addsDir },
    });
    return readFileSync(tracker, 'utf-8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  // TSV column order is status-BEFORE-score (per the batch TSV contract).
  // Hired is canonical, but a batch TSV is not outcome provenance. Fail closed:
  // lifecycle claims arriving through this ingestion path remain Evaluated.
  const hired = runMerge({
    '1-acme.tsv': '1\t2026-01-01\tAcme\tML Eng\tHired\t4.5/5\t✅\t[1](reports/1-acme-2026-01-01.md)\tlanded the job\n',
  });
  const hiredRow = hired.split('\n').find(l => /\bAcme\b/.test(l)) || '';
  if (/\|\s*Evaluated\s*\|/.test(hiredRow) && !/\|\s*Hired\s*\|/.test(hiredRow)) {
    pass('merge-tracker rejects an unprovenanced Hired lifecycle claim');
  } else {
    fail(`merge-tracker accepted an unprovenanced Hired claim: ${hiredRow.trim()}`);
  }

  // The accepted alias has the same provenance requirement and cannot bypass
  // the lifecycle gate merely by using an alias.
  const accepted = runMerge({
    '2-globex.tsv': '2\t2026-01-02\tGlobex\tData Eng\taccepted\t4.0/5\t✅\t[2](reports/2-globex-2026-01-02.md)\toffer accepted\n',
  });
  const acceptedRow = accepted.split('\n').find(l => /\bGlobex\b/.test(l)) || '';
  if (/\|\s*Evaluated\s*\|/.test(acceptedRow) && !/\|\s*Hired\s*\|/.test(acceptedRow)) {
    pass('merge-tracker rejects an unprovenanced accepted/Hired alias');
  } else {
    fail(`merge-tracker accepted an unprovenanced accepted/Hired alias: ${acceptedRow.trim()}`);
  }
} catch (e) {
  fail(`merge-tracker.mjs tests crashed: ${e.message}`);
}
