#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { pass, ROOT } from './helpers.mjs';
import { APPLICATION_RECEIPT_REQUEST_CONTRACT } from '../application-receipt-integrity.mjs';

console.log('\nExecutable resolver evidence');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-resolver-evidence-'));
const dataDir = join(temp, 'data');
mkdirSync(dataDir, { recursive: true });
const roleId = 'test:resolver-evidence';
const runId = 'apply-resolver-evidence';
const requestId = `${runId}:${roleId}`;
const controllerId = 'browser-controller:test';
const url = 'https://jobs.example.test/apply/review';
const lookupSnapshot = 'b'.repeat(64);
const observedAt = '2026-07-16T01:00:00.000Z';
writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
  version: 1,
  settings: {
    application_controller: {
      version: 1,
      controller: 'active-agent',
      controller_id: controllerId,
      max_active_roles: 4,
    },
  },
  roles: [{
    id: roleId,
    company: 'Evidence Co',
    title: 'Analyst',
    url,
    status: 'prepared',
    // The completed begin/asset gate represented by this fixture supplied a CV.
    cv_pdf: 'output/test-cv.pdf',
    drafts: {},
    // This fixture starts after the canonical begin step. Preserve the durable
    // dashboard request binding that every real in-progress run already has.
    application_request: {
      version: 1,
      request_id: requestId,
      run_id: runId,
      role_id: roleId,
      source: 'dashboard-fill',
      state: 'in-progress',
      controller: 'active-agent',
      controller_id: controllerId,
      requested_at: '2026-07-16T00:00:00.000Z',
      url,
      contract: [...APPLICATION_RECEIPT_REQUEST_CONTRACT],
    },
    application_progress: {
      version: 2,
      run_id: runId,
      role_id: roleId,
      application_request_id: requestId,
      controller_id: controllerId,
      evidence_protocol: 'v3',
      // This suite exercises the resolver envelope itself. Production v3 runs
      // use snapshot-file capture through apply-page.mjs; inline-test is the
      // explicit fixture-only escape used by the receipt contract tests.
      evidence_capture: 'inline-test',
      tab: { id: 'tab-evidence', url },
      preflight: {
        liveness: {
          method: 'playwright', checked_url: url, result: 'active',
          checked_at: '2026-07-16T00:00:00.000Z', snapshot_digest: 'a'.repeat(64),
        },
        destination: {
          method: 'playwright', checked_url: url, result: 'matched',
          checked_at: '2026-07-16T00:00:00.000Z', snapshot_digest: 'a'.repeat(64),
          observed_company: 'Evidence Co', observed_title: 'Analyst', observed_requisition: 'not shown',
          expected_company: 'Evidence Co', expected_title: 'Analyst',
        },
        liveness_verified: true,
        role_match_verified: true,
        checked_url: url,
      },
      pages: [],
      review_required: [],
      review_ready: false,
    },
  }, {
    id: 'test:prepare-teach',
    company: 'Prepare Co',
    title: 'Engineer',
    url,
    status: 'prepare-queued',
    drafts: {},
  }],
}, null, 2), 'utf8');

// config/profile.yml is an untracked user-layer file, so clean checkouts and
// CI don't have one — point the resolver at a minimal fixture instead.
const profilePath = join(temp, 'profile.yml');
writeFileSync(profilePath, [
  'candidate:',
  '  name: Resolver Evidence',
  '  email: resolver@example.test',
  '',
].join('\n'), 'utf8');

const env = {
  ...process.env,
  CAREER_OPS_DATA_DIR: dataDir,
  CAREER_OPS_QUEUE_BACKEND: 'local',
  CAREER_OPS_PROFILE: profilePath,
};
function run(script, args) {
  return spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

try {
  const prepareTeach = run('queue-resolve.mjs', ['--teach', 'test:prepare-teach', '[]']);
  assert.equal(prepareTeach.status, 0, prepareTeach.stderr);
  pass('bare answer arrays remain available only for PREPARE-time teaching');

  const unsafeLiveTeach = run('queue-resolve.mjs', ['--teach', roleId, '[]']);
  assert.notEqual(unsafeLiveTeach.status, 0);
  assert.match(unsafeLiveTeach.stderr, /live application pages require/);
  pass('an active live run cannot bypass evidence with a bare teach array');

  const duplicateLookupPath = join(temp, 'lookup-duplicate-control.json');
  writeFileSync(duplicateLookupPath, JSON.stringify({
    run_id: runId,
    tab_id: 'tab-evidence',
    page_id: 'duplicate-controls',
    page_index: 0,
    url,
    snapshot_digest: lookupSnapshot,
    observed_at: observedAt,
    fields: [
      { control_id: 'same-control', label: 'Response', type: 'text', required: true },
      { control_id: 'same-control', label: 'Response', type: 'text', required: true },
    ],
  }), 'utf8');
  const duplicateLookup = run('queue-resolve.mjs', ['--lookup', roleId, `@${duplicateLookupPath}`]);
  assert.notEqual(duplicateLookup.status, 0);
  assert.match(duplicateLookup.stderr, /control_id must be unique/);
  pass('--lookup rejects duplicate control identities before creating resolver evidence');

  const lookupPath = join(temp, 'lookup.json');
  writeFileSync(lookupPath, JSON.stringify({
    run_id: runId,
    tab_id: 'tab-evidence',
    page_id: 'final-review',
    page_index: 0,
    url,
    snapshot_digest: lookupSnapshot,
    observed_at: observedAt,
    fields: [],
  }), 'utf8');
  const lookup = run('queue-resolve.mjs', ['--lookup', roleId, `@${lookupPath}`]);
  assert.equal(lookup.status, 0, lookup.stderr);
  const lookupOut = JSON.parse(lookup.stdout);
  assert.match(lookupOut.evidence_id, /^resolver-evidence:/);
  pass('--lookup emits and persists active run/page-bound evidence');

  const teachPath = join(temp, 'teach.json');
  writeFileSync(teachPath, JSON.stringify({
    run_id: runId,
    tab_id: 'tab-evidence',
    page_id: 'final-review',
    page_index: 0,
    url,
    snapshot_digest: lookupSnapshot,
    observed_at: observedAt,
    evidence_id: lookupOut.evidence_id,
    answers: [],
  }), 'utf8');
  const teach = run('queue-resolve.mjs', ['--teach', roleId, `@${teachPath}`]);
  assert.equal(teach.status, 0, teach.stderr);
  const teachOut = JSON.parse(teach.stdout);
  assert.equal(teachOut.evidence_id, lookupOut.evidence_id);
  assert.match(teachOut.teach_fingerprint, /^[a-f0-9]{64}$/);
  pass('--teach seals the matching lookup evidence, including a no-novel page');

  const pagePath = join(temp, 'page.json');
  writeFileSync(pagePath, JSON.stringify({
    run_id: runId,
    tab_id: 'tab-evidence',
    page_id: 'final-review',
    page_index: 0,
    url,
    resolver_evidence_id: lookupOut.evidence_id,
    field_count: 0,
    fields: [],
    upload_controls: [],
    lookup_completed: true,
    l3_completed: true,
    teach_completed: true,
    conditional_rescan_completed: true,
    verified: true,
    validation_errors: [],
    attachments: [],
    final_page: true,
    browser_observation: {
      source: 'playwright-mcp',
      page_kind: 'review',
      before: {
        snapshot_digest: lookupSnapshot, url, field_manifest: [], captured_at: observedAt,
      },
      rescan: {
        snapshot_digest: 'c'.repeat(64), url, field_manifest: [], captured_at: '2026-07-16T01:01:00.000Z',
      },
      after: {
        snapshot_digest: 'd'.repeat(64), url, field_manifest: [], captured_at: '2026-07-16T01:02:00.000Z',
        populated_manifest: [], validation_errors: [],
      },
      submit_boundary: { present: true, control_id: 'submit', label: 'Submit application' },
    },
  }), 'utf8');
  const page = run('application-receipt.mjs', ['--page', roleId, `@${pagePath}`]);
  assert.equal(page.status, 0, page.stderr);
  const queue = JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'));
  const stored = queue.roles[0].application_progress;
  assert.equal(stored.pending_resolver_evidence, undefined);
  assert.equal(stored.pages[0].resolver_evidence_id, lookupOut.evidence_id);
  pass('--page consumes executable evidence into the durable page receipt');

  const replay = run('application-receipt.mjs', ['--page', roleId, `@${pagePath}`]);
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /executable resolver evidence is missing/);
  pass('consumed lookup/teach evidence cannot be replayed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
