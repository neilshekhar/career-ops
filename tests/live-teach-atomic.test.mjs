#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pass, ROOT } from './helpers.mjs';

console.log('\nLive teach atomic evidence gate');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-live-teach-'));
const dataDir = join(temp, 'data');
const queuePath = join(dataDir, 'apply-queue.json');
const cachePath = join(dataDir, 'answer-cache.json');
const storePath = join(dataDir, 'screener-answers.json');
mkdirSync(dataDir, { recursive: true });

const roleId = 'atomic:analyst';
const runId = 'run-live-teach-atomic';
const tabId = 'tab-live-teach-atomic';
const pageId = 'questions';
const url = 'https://jobs.example.test/atomic/apply';
const observedAt = '2026-07-16T02:00:00.000Z';
const snapshotDigest = 'a'.repeat(64);
const fields = [
  {
    control_id: 'quasar-method',
    label: 'Describe the obscure quasar methodology',
    type: 'textarea',
    required: true,
    options: [],
    help: null,
    kind: null,
  },
  {
    control_id: 'mystery-response',
    label: 'Preferred mystery response',
    type: 'select',
    required: true,
    options: ['Alpha', 'Beta'],
    help: null,
    kind: null,
  },
];

function pendingEvidence(evidenceId) {
  return {
    version: 1,
    evidence_id: evidenceId,
    run_id: runId,
    tab_id: tabId,
    page_id: pageId,
    page_index: 0,
    url,
    snapshot_digest: snapshotDigest,
    observed_at: observedAt,
    fields,
    resolved: [],
    novel: fields.map(({ control_id, label, type, required }) => ({ control_id, label, type, required })),
    lookup_fingerprint: 'b'.repeat(64),
    lookup_completed_at: '2026-07-16T02:00:01.000Z',
    teach: null,
  };
}

writeFileSync(queuePath, JSON.stringify({
  version: 1,
  settings: {},
  roles: [{
    id: roleId,
    company: 'Atomic Co',
    title: 'Analyst',
    url,
    ats: 'custom',
    status: 'prepared',
    drafts: {},
    application_progress: {
      version: 1,
      run_id: runId,
      tab: { id: tabId, url, title: 'Atomic application' },
      preflight: {
        liveness: { method: 'playwright' },
        destination: { method: 'playwright' },
      },
      pages: [],
      review_ready: false,
      pending_resolver_evidence: pendingEvidence('resolver-evidence:initial'),
    },
  }],
}, null, 2) + '\n', 'utf8');

const env = {
  ...process.env,
  CAREER_OPS_DATA_DIR: dataDir,
  CAREER_OPS_QUEUE_BACKEND: 'local',
};
const run = (args) => spawnSync(process.execPath, args, {
  cwd: ROOT,
  env,
  encoding: 'utf8',
});

const teachPath = join(temp, 'teach.json');

function writeTeach(evidenceId) {
  writeFileSync(teachPath, JSON.stringify({
    run_id: runId,
    tab_id: tabId,
    page_id: pageId,
    page_index: 0,
    url,
    snapshot_digest: snapshotDigest,
    observed_at: observedAt,
    evidence_id: evidenceId,
    answers: [
      {
        control_id: 'quasar-method',
        label: 'Describe the obscure quasar methodology',
        type: 'textarea',
        answer: 'A source-supported quasar answer.',
        reusable: true,
      },
      {
        control_id: 'mystery-response',
        label: 'Preferred mystery response',
        type: 'select',
        options: ['Alpha', 'Beta'],
        answer: 'Alpha',
        reusable: true,
      },
    ],
  }), 'utf8');
}

function seedEvidence(evidenceId) {
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  queue.roles[0].application_progress.pending_resolver_evidence = pendingEvidence(evidenceId);
  writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n', 'utf8');
}

const resolverUrl = pathToFileURL(join(ROOT, 'queue-resolve.mjs')).href;
const queueStoreUrl = pathToFileURL(join(ROOT, 'queue-store.mjs')).href;
const embedFnSource = `const embedFn = (texts) => ({ embeddings: texts.map(() => [1, 0, 0]) });`;

try {
  writeTeach('resolver-evidence:initial');
  const staleScript = `
import { liveTeach } from ${JSON.stringify(resolverUrl)};
import { mutateQueue } from ${JSON.stringify(queueStoreUrl)};
${embedFnSource}
const [roleId, payload] = process.argv.slice(1);
try {
  liveTeach(roleId, payload, {
    embedFn,
    beforeQueueCommit() {
      mutateQueue((queue) => {
        const role = queue.roles.find((item) => item.id === roleId);
        role.application_progress.pending_resolver_evidence.evidence_id = 'resolver-evidence:replaced';
      });
    },
  });
  process.stderr.write('stale teach unexpectedly succeeded\\n');
  process.exitCode = 2;
} catch (error) {
  if (!/evidence_id does not match/.test(error.message)) {
    process.stderr.write(error.stack + '\\n');
    process.exitCode = 3;
  }
  process.stderr.write(error.message + '\\n');
}
`;
  const stale = run(['--input-type=module', '-e', staleScript, roleId, `@${teachPath}`]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stderr, /evidence_id does not match/);

  const afterStale = JSON.parse(readFileSync(queuePath, 'utf8')).roles[0];
  assert.doesNotMatch(JSON.stringify(afterStale.drafts ?? {}), /source-supported quasar answer|Alpha/);
  assert.equal(afterStale.application_progress.pending_resolver_evidence.teach, null);
  assert.equal(existsSync(cachePath), false, 'stale teach contaminated the reusable answer cache');
  assert.equal(existsSync(storePath), false, 'stale teach contaminated the reusable screener store');
  pass('stale live-teach evidence writes no role drafts or reusable learning');

  seedEvidence('resolver-evidence:fresh');
  writeTeach('resolver-evidence:fresh');
  const successScript = `
import { liveTeach } from ${JSON.stringify(resolverUrl)};
${embedFnSource}
const [roleId, payload] = process.argv.slice(1);
process.stdout.write(JSON.stringify(liveTeach(roleId, payload, { embedFn }))); 
`;
  const success = run(['--input-type=module', '-e', successScript, roleId, `@${teachPath}`]);
  assert.equal(success.status, 0, success.stderr);
  const successOut = JSON.parse(success.stdout);
  assert.match(successOut.teach_fingerprint, /^[a-f0-9]{64}$/);

  const finalRole = JSON.parse(readFileSync(queuePath, 'utf8')).roles[0];
  assert.match(JSON.stringify(finalRole.drafts), /source-supported quasar answer/);
  assert.match(JSON.stringify(finalRole.drafts), /Alpha/);
  assert.equal(finalRole.application_progress.pending_resolver_evidence.teach.noop, false);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert(cache.entries.some((entry) => entry.answer === 'A source-supported quasar answer.'));
  assert.equal(store.entries['preferred mystery response']?.answer, 'Alpha');
  pass('successful live teach seals queue evidence before persisting reusable cache and screener learning');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
