#!/usr/bin/env node
// tests/apply-page.test.mjs — Evidence Protocol v3 driver (apply-page.mjs).
//
// End-to-end through the real CLI in child processes: snapshot fixtures are
// copied into the repo's `.playwright-mcp/` (the approved live snapshot root),
// the queue/profile/stores are redirected to a temp dir, and the receipts the
// driver produces are asserted from the durable queue file — exactly what a
// live agent session does, minus the browser.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, fail, ROOT } from './helpers.mjs';
import { roleDraftKey } from '../queue-resolve.mjs';

console.log('\n🧪 apply-page driver (Evidence Protocol v3)');

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'snapshots');
const MCP_DIR = join(ROOT, '.playwright-mcp');
const temp = mkdtempSync(join(tmpdir(), 'career-ops-apply-page-'));
const dataDir = join(temp, 'data');
mkdirSync(dataDir, { recursive: true });
mkdirSync(MCP_DIR, { recursive: true });

const stamp = Date.now();
const snapPath = (name) => join(MCP_DIR, `page-test-${stamp}-${name}.yml`);
const SNAPSHOTS = {
  before: snapPath('before'),
  filled: snapPath('filled'),
  conditional: snapPath('conditional'),
};
copyFileSync(join(FIXTURES, 'workable-form.yml'), SNAPSHOTS.before);
copyFileSync(join(FIXTURES, 'workable-form-filled.yml'), SNAPSHOTS.filled);
copyFileSync(join(FIXTURES, 'workable-form-conditional.yml'), SNAPSHOTS.conditional);
// Deterministic observation ordering: before < filled/conditional.
const t0 = new Date('2026-07-16T01:00:00.000Z');
const t1 = new Date('2026-07-16T01:05:00.000Z');
utimesSync(SNAPSHOTS.before, t0, t0);
utimesSync(SNAPSHOTS.filled, t1, t1);
utimesSync(SNAPSHOTS.conditional, t1, t1);

const url = 'https://apply.example-portal.com/acme-energy/data-cleanse-analyst';

function draft(controlId, label, answer) {
  return [roleDraftKey({ control_id: controlId, label }), {
    field_type: 'text', label, control_id: controlId, answer, source: 'deterministic',
  }];
}

const SHARED_DRAFTS = [
  draft('textbox:first-name:1', 'First name *', 'Alex'),
  draft('textbox:last-name:1', 'Last name *', 'Candidate'),
  draft('combobox:phone-country:1', 'Phone country', 'Australia (+61)'),
  draft('textbox:address:1', 'Address', '1 Example Street, Melbourne VIC 3000'),
];

function makeRole(id, tabId, extraDrafts) {
  return {
    id,
    company: 'Acme Energy',
    title: 'Data Cleanse Analyst',
    url,
    status: 'prepared',
    drafts: Object.fromEntries([...SHARED_DRAFTS, ...extraDrafts]),
    application_progress: {
      version: 2,
      run_id: `run-${id}`,
      role_id: id,
      evidence_protocol: 'v3',
      evidence_capture: 'file-derived',
      tab: { id: tabId, url },
      preflight: {
        liveness: {
          method: 'playwright', checked_url: url, result: 'active',
          checked_at: '2026-07-16T00:00:00.000Z', snapshot_digest: 'a'.repeat(64),
        },
        destination: {
          method: 'playwright', checked_url: url, result: 'matched',
          checked_at: '2026-07-16T00:00:00.000Z', snapshot_digest: 'a'.repeat(64),
          observed_company: 'Acme Energy', observed_title: 'Data Cleanse Analyst',
          observed_requisition: 'not shown',
          expected_company: 'Acme Energy', expected_title: 'Data Cleanse Analyst',
        },
        liveness_verified: true,
        role_match_verified: true,
        checked_url: url,
      },
      pages: [],
      review_required: [],
      review_ready: false,
    },
  };
}

writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
  version: 1,
  settings: {},
  roles: [
    makeRole('v3:role-a', 'tab-a', [
      draft('textbox:email:1', 'Email *', 'alex.candidate@example.com'),
      draft('textbox:summary:1', 'Summary', 'Data analyst with pipeline automation experience across energy retail.'),
    ]),
    makeRole('v3:role-b', 'tab-b', [
      draft('textbox:email:1', 'Email *', 'alex.candidate@example.com'),
      draft('textbox:summary:1', 'Summary', 'A different summary that will not verify.'),
    ]),
    makeRole('v3:role-c', 'tab-c', [
      draft('textbox:email:1', 'Email *', 'wrong@example.com'),
      draft('textbox:summary:1', 'Summary', 'Data analyst with pipeline automation experience across energy retail.'),
    ]),
  ],
}, null, 2), 'utf8');

const profilePath = join(temp, 'profile.yml');
writeFileSync(profilePath, 'candidate:\n  name: Alex Candidate\n  email: alex.candidate@example.com\n', 'utf8');

const env = {
  ...process.env,
  CAREER_OPS_DATA_DIR: dataDir,
  CAREER_OPS_QUEUE_BACKEND: 'local',
  CAREER_OPS_PROFILE: profilePath,
};
delete env.CAREER_OPS_SNAPSHOT_ROOTS;
delete env.CAREER_OPS_EVIDENCE_ROOTS;

function run(script, args) {
  return spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT, env, encoding: 'utf8',
  });
}
const readQueue = () => JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'));
const roleFromQueue = (id) => readQueue().roles.find((role) => role.id === id);

// Answers for every possibly-novel control on the workable fixture; the test
// selects from this map based on what lookup actually reports as novel, so it
// does not over-pin the resolver's L1/L1.5/L2 classification.
const ANSWER_BOOK = {
  'radio:are-you-a-current-or-previous-employee:1': 'No, I am not a current or previous employee.',
  'radio:do-you-have-full-working-rights-in-australia:1': 'Yes',
  'textbox:expected-annual-salary-aud:1': '95000',
  'combobox:notice-period:1': '4 weeks',
  'checkbox:i-agree-to-the-privacy-policy:1': 'Yes',
  'checkbox:send-me-job-alerts:1': 'Yes',
  'textbox:first-name:1': 'Alex',
  'textbox:last-name:1': 'Candidate',
  'textbox:email:1': 'alex.candidate@example.com',
  'combobox:phone-country:1': 'Australia (+61)',
  'textbox:address:1': '1 Example Street, Melbourne VIC 3000',
  'textbox:summary:1': 'Data analyst with pipeline automation experience across energy retail.',
};
const answersFor = (novel) => novel.map((item) => ({
  control_id: item.control_id,
  answer: ANSWER_BOOK[item.control_id] ?? '(unmapped)',
}));

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name} — ${err.message}`);
  }
}

try {
  // ── lookup: staging + compact model-visible output ─────────────────────────
  const lookup = run('apply-page.mjs', ['lookup', 'v3:role-a', JSON.stringify({
    page_index: 0, url, snapshot: SNAPSHOTS.before,
  })]);
  assert.equal(lookup.status, 0, lookup.stderr);
  const lookupOut = JSON.parse(lookup.stdout);

  check('lookup resolves drafts and reports the rest as novel questions', () => {
    assert.equal(lookupOut.field_count, 12);
    assert.equal(lookupOut.resolved.length + lookupOut.novel.length, 12);
    assert.ok(lookupOut.resolved.some((item) => item.control_id === 'textbox:email:1'));
    assert.ok(lookupOut.novel.some((item) => item.control_id === 'textbox:expected-annual-salary-aud:1'));
  });

  check('lookup output is compact: no raw snapshot text, refs, or evidence envelopes', () => {
    for (const needle of ['Acme Energy careers', '[ref=', 'cursor=pointer', 'lookup_fingerprint', 'hunter2']) {
      assert.ok(!lookup.stdout.includes(needle), `stdout leaked: ${needle}`);
    }
  });

  check('lookup stages snapshot-file evidence with machine-extracted upload manifest', () => {
    const staged = roleFromQueue('v3:role-a').application_progress.pending_resolver_evidence;
    assert.equal(staged.capture, 'snapshot-file');
    assert.equal(staged.snapshot_path, SNAPSHOTS.before);
    assert.equal(staged.fields.length, 12);
    assert.deepEqual(staged.upload_controls.map((control) => control.kind).sort(), ['cover', 'cv']);
    assert.ok(staged.snapshot_digest.match(/^[a-f0-9]{64}$/));
  });

  check('inline queue-resolve --lookup is rejected on a v3 file-derived run', () => {
    const inline = run('queue-resolve.mjs', ['--lookup', 'v3:role-b', JSON.stringify({
      run_id: 'run-v3:role-b', tab_id: 'tab-b', page_id: 'hand', page_index: 0, url,
      snapshot_digest: 'b'.repeat(64), observed_at: '2026-07-16T01:00:00.000Z',
      fields: [{ control_id: 'x:1', label: 'X', type: 'text', required: false }],
    })]);
    assert.notEqual(inline.status, 0);
    assert.match(inline.stderr, /requires file-derived evidence.*apply-page\.mjs lookup/s);
  });

  // ── complete: failure policies (all before any teach commit) ───────────────
  check('complete rejects an unchanged after-snapshot', () => {
    const out = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
      after_snapshot: SNAPSHOTS.before, answers: answersFor(lookupOut.novel),
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /identical to the before snapshot/);
  });

  check('complete hard-fails when a conditional field appears, naming it and the re-lookup step', () => {
    const out = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
      after_snapshot: SNAPSHOTS.conditional, answers: answersFor(lookupOut.novel),
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /conditional field\(s\) appeared/);
    assert.match(out.stderr, /which-team-did-you-work-in/);
    assert.match(out.stderr, /re-run apply-page\.mjs lookup/);
  });

  check('complete demands an answer for every novel question', () => {
    const out = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
      after_snapshot: SNAPSHOTS.filled, answers: [],
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /every novel question needs an answer/);
  });

  check('complete refuses to override a resolved answer via the answers list', () => {
    const resolvedId = lookupOut.resolved[0].control_id;
    const out = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
      after_snapshot: SNAPSHOTS.filled,
      answers: [...answersFor(lookupOut.novel), { control_id: resolvedId, answer: 'override' }],
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /already resolved; resolved answers cannot be overridden/);
  });

  check('failed completes never commit the teach barrier', () => {
    const staged = roleFromQueue('v3:role-a').application_progress.pending_resolver_evidence;
    assert.equal(staged.teach, null);
  });

  check('complete rejects attachment evidence whose file the portal does not display', () => {
    const out = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
      after_snapshot: SNAPSHOTS.filled,
      answers: answersFor(lookupOut.novel),
      attachments: [{ control_id: 'upload:upload-a-file-or-drag-and-drop-here:1', kind: 'cv', path: 'output/Nope.pdf' }],
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /not visible in the after-fill snapshot/);
  });

  // ── complete: happy path ────────────────────────────────────────────────────
  const completeA = run('apply-page.mjs', ['complete', 'v3:role-a', JSON.stringify({
    after_snapshot: SNAPSHOTS.filled, answers: answersFor(lookupOut.novel),
  })]);

  check('complete records a machine-verified page receipt', () => {
    assert.equal(completeA.status, 0, completeA.stderr);
    const out = JSON.parse(completeA.stdout);
    assert.equal(out.page_index, 0);
    assert.equal(out.field_count, 12);
    assert.deepEqual(out.verification_warnings, []);
    const progress = roleFromQueue('v3:role-a').application_progress;
    assert.equal(progress.pages.length, 1);
    assert.equal(progress.pending_resolver_evidence, undefined);
    const page = progress.pages[0];
    assert.equal(page.resolver_evidence.capture, 'snapshot-file');
    assert.equal(page.resolver_evidence.teach.answers.length, lookupOut.novel.length);
    assert.equal(page.answered_count, 12);
    assert.equal(page.browser_observation.before.snapshot_digest, page.resolver_evidence.snapshot_digest);
  });

  check('complete output is compact: no receipt body, fingerprints, or snapshot text', () => {
    for (const needle of ['populated_manifest', 'lookup_fingerprint', 'field_manifest', '[ref=', 'Acme Energy careers']) {
      assert.ok(!completeA.stdout.includes(needle), `stdout leaked: ${needle}`);
    }
  });

  // ── verification policy: non-critical mismatch degrades to a warning ────────
  const lookupB = run('apply-page.mjs', ['lookup', 'v3:role-b', JSON.stringify({
    page_index: 0, url, snapshot: SNAPSHOTS.before,
  })]);
  assert.equal(lookupB.status, 0, lookupB.stderr);
  const lookupBOut = JSON.parse(lookupB.stdout);
  const completeB = run('apply-page.mjs', ['complete', 'v3:role-b', JSON.stringify({
    after_snapshot: SNAPSHOTS.filled, answers: answersFor(lookupBOut.novel),
  })]);

  check('non-critical mismatches become verification warnings on the receipt', () => {
    assert.equal(completeB.status, 0, completeB.stderr);
    const out = JSON.parse(completeB.stdout);
    assert.equal(out.verification_warnings.length, 1);
    assert.equal(out.verification_warnings[0].control_id, 'textbox:summary:1');
    const progress = roleFromQueue('v3:role-b').application_progress;
    assert.equal(progress.verification_warnings.length, 1);
    assert.equal(progress.verification_warnings[0].verified_in_snapshot, false);
    assert.equal(progress.verification_warnings[0].page_index, 0);
  });

  // ── verification policy: critical mismatch hard-fails ───────────────────────
  const lookupC = run('apply-page.mjs', ['lookup', 'v3:role-c', JSON.stringify({
    page_index: 0, url, snapshot: SNAPSHOTS.before,
  })]);
  assert.equal(lookupC.status, 0, lookupC.stderr);
  const lookupCOut = JSON.parse(lookupC.stdout);

  check('critical field mismatch hard-fails the page with an actionable error', () => {
    const out = run('apply-page.mjs', ['complete', 'v3:role-c', JSON.stringify({
      after_snapshot: SNAPSHOTS.filled, answers: answersFor(lookupCOut.novel),
    })]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /critical field\(s\) failed populated-value verification/);
    assert.match(out.stderr, /textbox:email:1/);
    const progress = roleFromQueue('v3:role-c').application_progress;
    assert.equal(progress.pages.length, 0);
    assert.equal(progress.pending_resolver_evidence.teach, null);
  });

  // ── cross-role isolation ─────────────────────────────────────────────────────
  check('teach on one role never leaks drafts into another role', () => {
    const roleC = roleFromQueue('v3:role-c');
    const salaryKey = roleDraftKey({
      control_id: 'textbox:expected-annual-salary-aud:1',
      label: 'Expected annual salary (AUD) *',
    });
    assert.equal(roleC.drafts[salaryKey], undefined);
    const roleA = roleFromQueue('v3:role-a');
    assert.ok(roleA.drafts[salaryKey]);
  });

  // ── controlled fallback ──────────────────────────────────────────────────────
  check('fallback records a durable manual-review block on the run', () => {
    const out = run('apply-page.mjs', ['fallback', 'v3:role-c', JSON.stringify({
      reason: 'canvas date picker cannot be machine-extracted',
      control_ids: ['custom:date-picker:1'],
      url,
      page_index: 0,
    })]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /manual-review path/);
    const progress = roleFromQueue('v3:role-c').application_progress;
    assert.equal(progress.verification_fallback.reason, 'canvas date picker cannot be machine-extracted');
    assert.deepEqual(progress.verification_fallback.control_ids, ['custom:date-picker:1']);
  });
} finally {
  for (const path of Object.values(SNAPSHOTS)) rmSync(path, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
