#!/usr/bin/env node
// tests/snapshot-extract.test.mjs — Evidence Protocol v3 parser + path security.
//
// Covers the file-derived receipt foundation: snapshot parsing across five
// portal shapes (sanitized fixtures — no PII), field/upload extraction,
// verification semantics, before/after comparison, and the evidence-path
// trust boundary (roots containment, symlink escape, empty/replaced files).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pass, fail, NODE, ROOT } from './helpers.mjs';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'snapshots');

const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  CAREER_OPS_SNAPSHOT_ROOTS: process.env.CAREER_OPS_SNAPSHOT_ROOTS,
};
process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_SNAPSHOT_ROOTS = FIXTURES;

const {
  parseSnapshot, extractFields, extractUploadControls, extractDisplayedFilenames,
  readSnapshotFile, resolveEvidencePath, readEvidenceBytes, snapshotEvidenceRoots,
  compareFieldSets, verifyPopulatedValues, normalizeValue, findSubmitBoundary,
} = await import(pathToFileURL(join(ROOT, 'snapshot-extract.mjs')).href);

console.log('\n🧪 snapshot-extract (Evidence Protocol v3 parser)');

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name} — ${err.message}`);
  }
}

const snap = (name) => readSnapshotFile(join(FIXTURES, name));
const fieldsOf = (name) => extractFields(snap(name).tree);
const byId = (fields) => new Map(fields.map((f) => [f.control_id, f]));

// ── Extraction across portal shapes ─────────────────────────────────────────

check('workable: fields, requireds, password + disabled + chrome excluded', () => {
  const fields = fieldsOf('workable-form.yml');
  const ids = byId(fields);
  assert(ids.has('textbox:first-name:1'));
  assert.equal(ids.get('textbox:first-name:1').required, true);
  assert.equal(ids.get('textbox:first-name:1').value, 'Alex');
  assert(!fields.some((f) => /password/i.test(f.label)), 'password field must be excluded');
  assert(!fields.some((f) => /hidden legacy/i.test(f.label)), 'disabled field must be excluded');
  assert(!fields.some((f) => /search jobs|newsletter/i.test(f.label)), 'banner/footer controls must be excluded');
});

check('workable: radiogroup options strip the question prefix; nested checked detected', () => {
  const ids = byId(fieldsOf('workable-form.yml'));
  const employee = ids.get('radio:are-you-a-current-or-previous-employee:1');
  assert(employee, 'grouped radio field missing');
  assert.deepEqual(employee.options, [
    'Yes, I am a current Acme Energy employee.',
    'No, I am not a current or previous employee.',
  ]);
  assert.equal(employee.value, 'No, I am not a current or previous employee.');
  const rights = ids.get('radio:do-you-have-full-working-rights-in-australia:1');
  assert.deepEqual(rights.options, ['Yes', 'No']);
  assert.equal(rights.value, '', 'unchecked group must have empty value');
});

check('workable: upload controls classified with kinds; displayed filename chip found', () => {
  const s = snap('workable-form.yml');
  const uploads = extractUploadControls(s.tree);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads.map((u) => u.kind).sort(), ['cover', 'cv']);
  assert(uploads.every((u) => u.enabled));
  assert(extractDisplayedFilenames(s.tree).includes('Alex-Candidate-CV.pdf'));
});

check('workable: submit boundary detected via canonical final-action labels', () => {
  const boundary = findSubmitBoundary(snap('workable-form.yml').tree);
  assert.deepEqual(boundary.map((b) => b.label), ['Submit application']);
});

check('orc: intermediate page has no submit boundary; selected combobox values read', () => {
  const s = snap('orc-form.yml');
  assert.equal(findSubmitBoundary(s.tree).length, 0, 'Continue/Save as Draft are not final actions');
  const ids = byId(extractFields(s.tree));
  assert.equal(ids.get('combobox:state:1').value, 'Victoria');
  assert.equal(ids.get('combobox:country:1').options.length, 3);
});

check('successfactors: date placeholder value + password pair excluded + searchbox kept', () => {
  const ids = byId(fieldsOf('successfactors-form.yml'));
  assert.equal(ids.get('textbox:date-of-birth:1').value, '01/01/1990');
  assert(!ids.has('textbox:create-password:1'));
  assert(!ids.has('textbox:confirm-password:1'));
  assert(ids.has('textbox:search-skills:1'), 'named searchbox maps to textbox field');
});

check('humanforce: combobox generic value child + companion searchbox skipped', () => {
  const fields = fieldsOf('humanforce-form.yml');
  const ids = byId(fields);
  assert.equal(ids.get('combobox:home-address:1').value, '1 Example Street, Melbourne VIC 3000');
  assert.equal(ids.get('radio:have-you-ever-worked-at-example-transit:1').value, 'No');
  assert(!fields.some((f) => f.control_id === 'textbox:visa-type:1'),
    'unnamed searchbox beside combobox must not become its own field');
});

check('careersvic: yaml-quoted labels, loose radios grouped, Submit Application boundary', () => {
  const s = snap('careersvic-form.yml');
  const ids = byId(extractFields(s.tree));
  assert.equal(ids.get('textbox:email-address:1').value, 'alex.candidate@example.com');
  assert.equal(ids.get('textbox:email-address:1').required, true);
  const disability = ids.get('radio:do-you-identify-as-a-person-with-disability:1');
  assert(disability, 'radios without a radiogroup must be grouped by shared container');
  assert.deepEqual(disability.options, ['Yes', 'No', 'Prefer not to say']);
  assert.equal(disability.value, 'Prefer not to say');
  assert.deepEqual(findSubmitBoundary(s.tree).map((b) => b.label), ['Submit Application']);
});

check('option cap: >200 options truncated with flag', () => {
  const lines = ['- combobox "Country of birth" [ref=x1]:'];
  for (let i = 0; i < 250; i += 1) lines.push(`  - option "Country ${i}"`);
  const fields = extractFields(parseSnapshot(lines.join('\n')));
  assert.equal(fields.length, 1);
  assert.equal(fields[0].options.length, 200);
  assert.equal(fields[0].options_truncated, true);
});

// ── Comparison + verification ────────────────────────────────────────────────

check('compareFieldSets: conditional field appears in added, nothing removed', () => {
  const diff = compareFieldSets(fieldsOf('workable-form.yml'), fieldsOf('workable-form-conditional.yml'));
  assert.deepEqual(diff.added.map((f) => f.control_id), ['textbox:which-team-did-you-work-in:1']);
  assert.equal(diff.removed.length, 0);
  assert(diff.common.length >= 10);
});

check('verifyPopulatedValues: text/select/radio/checkbox semantics + mismatch reasons', () => {
  const tree = snap('workable-form-filled.yml').tree;
  const results = verifyPopulatedValues(tree, [
    { control_id: 'textbox:expected-annual-salary-aud:1', answer: '95000' },
    { control_id: 'combobox:notice-period:1', answer: '4 weeks' },
    { control_id: 'radio:do-you-have-full-working-rights-in-australia:1', answer: 'Yes' },
    { control_id: 'checkbox:i-agree-to-the-privacy-policy:1', answer: 'Yes' },
    { control_id: 'textbox:first-name:1', answer: 'Wrong Name' },
    { control_id: 'textbox:does-not-exist:1', answer: 'x' },
  ]);
  const map = new Map(results.map((r) => [r.control_id, r]));
  assert.equal(map.get('textbox:expected-annual-salary-aud:1').verified, true);
  assert.equal(map.get('combobox:notice-period:1').verified, true);
  assert.equal(map.get('radio:do-you-have-full-working-rights-in-australia:1').verified, true);
  assert.equal(map.get('checkbox:i-agree-to-the-privacy-policy:1').verified, true,
    'checked checkbox verifies against affirmative answer');
  assert.equal(map.get('textbox:first-name:1').verified, false);
  assert.match(map.get('textbox:first-name:1').reason, /does not match/);
  assert.equal(map.get('textbox:does-not-exist:1').verified, false);
  assert.match(map.get('textbox:does-not-exist:1').reason, /not found/);
});

check('verifyPopulatedValues: unchecked checkbox verifies against "No" answer', () => {
  const tree = snap('workable-form.yml').tree;
  const [res] = verifyPopulatedValues(tree, [
    { control_id: 'checkbox:i-agree-to-the-privacy-policy:1', answer: 'No' },
  ]);
  assert.equal(res.verified, true);
});

check('normalizeValue: whitespace collapse + NFKC + case fold, nothing fancier', () => {
  assert.equal(normalizeValue('  Ａｌｅｘ　 Candidate '), 'alex candidate');
  assert.equal(normalizeValue('95\u00A0000'), '95 000');
  assert.notEqual(normalizeValue('95,000'), normalizeValue('95000'),
    'punctuation differences must NOT silently pass');
});

// ── Evidence-path trust boundary ─────────────────────────────────────────────

const secRoot = mkdtempSync(join(tmpdir(), 'snapshot-security-'));
const outsideDir = mkdtempSync(join(tmpdir(), 'snapshot-outside-'));
try {
  const saved = process.env.CAREER_OPS_SNAPSHOT_ROOTS;
  process.env.CAREER_OPS_SNAPSHOT_ROOTS = secRoot;

  writeFileSync(join(secRoot, 'good.yml'), '- textbox "Email" [ref=e1]: a@example.com\n');
  writeFileSync(join(secRoot, 'empty.yml'), '');
  writeFileSync(join(outsideDir, 'outside.yml'), '- textbox "Leak" [ref=e1]\n');
  symlinkSync(join(outsideDir, 'outside.yml'), join(secRoot, 'evil-link.yml'));

  check('path security: file inside root resolves; digest is sha256 of raw bytes', () => {
    const s = readSnapshotFile(join(secRoot, 'good.yml'));
    const raw = readFileSync(join(secRoot, 'good.yml'));
    assert.equal(s.digest, createHash('sha256').update(raw).digest('hex'));
    assert.equal(extractFields(s.tree).length, 1);
  });

  check('path security: path outside approved roots rejected', () => {
    assert.throws(() => readSnapshotFile(join(outsideDir, 'outside.yml')), /outside the approved evidence roots/);
  });

  check('path security: traversal out of the root rejected', () => {
    assert.throws(
      () => resolveEvidencePath(join(secRoot, '..', 'somewhere', 'x.yml'), snapshotEvidenceRoots()),
      /outside the approved evidence roots|does not exist/,
    );
  });

  check('path security: symlink escaping the root rejected via realpath', () => {
    assert.throws(() => readSnapshotFile(join(secRoot, 'evil-link.yml')), /outside the approved evidence roots/);
  });

  check('path security: empty snapshot file rejected', () => {
    assert.throws(() => readEvidenceBytes(join(secRoot, 'empty.yml'), snapshotEvidenceRoots()), /empty/);
  });

  check('path security: missing file and null byte rejected', () => {
    assert.throws(() => readSnapshotFile(join(secRoot, 'nope.yml')), /does not exist/);
    assert.throws(() => resolveEvidencePath(`${secRoot}/a\0b.yml`, snapshotEvidenceRoots()), /null byte/);
  });

  check('path security: root override env is test-entrypoint gated', () => {
    // A non-test process must refuse CAREER_OPS_SNAPSHOT_ROOTS entirely.
    const out = execFileSync(NODE, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'snapshot-extract.mjs')).href)});
      try { m.snapshotEvidenceRoots(); console.log('NO-THROW'); }
      catch (err) { console.log('THREW: ' + err.message); }
    `], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', CAREER_OPS_SNAPSHOT_ROOTS: secRoot },
    });
    assert.match(out, /THREW: .*test-only/);
  });

  process.env.CAREER_OPS_SNAPSHOT_ROOTS = saved;
} finally {
  rmSync(secRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}

// ── Restore environment for subsequent in-process test files ─────────────────
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
