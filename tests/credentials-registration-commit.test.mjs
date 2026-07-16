#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pass, ROOT } from './helpers.mjs';

console.log('\nCredential registration acceptance boundary');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-credential-commit-'));
const modulePath = join(temp, 'credentials-store.mjs');
const dataPath = join(temp, 'data');
const storePath = join(dataPath, 'portal-credentials.json');
const queuePath = join(dataPath, 'apply-queue.json');
const evidencePath = join(temp, 'registration-acceptance.json');
copyFileSync(join(ROOT, 'credentials-store.mjs'), modulePath);
mkdirSync(dataPath, { recursive: true });

try {
  const credentials = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  const host = 'jobs.example.test';
  const email = 'candidate@example.test';
  const password = credentials.generatePassword();
  const roleId = 'example:analyst';
  const runId = 'apply-example-1';
  const controllerId = 'browser-controller:test';
  const tabId = 'tab-example-registration';
  const requestId = `${runId}:${roleId}`;
  const role = {
    id: roleId,
    company: 'Example',
    title: 'Analyst',
    url: `https://${host}/jobs/analyst`,
    status: 'prepared',
    application_request: {
      version: 1,
      request_id: requestId,
      run_id: runId,
      role_id: roleId,
      source: 'dashboard-fill',
      state: 'queued',
      controller: 'active-agent',
      controller_id: controllerId,
      requested_at: '2026-07-16T02:59:00.000Z',
      url: `https://${host}/jobs/analyst`,
      contract: [
        'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs',
        'application-receipt.mjs',
      ],
    },
  };
  const queue = {
    version: 1,
    settings: {
      application_controller: {
        version: 1,
        controller: 'active-agent',
        controller_id: controllerId,
        max_active_roles: 4,
        created_at: '2026-07-16T02:58:00.000Z',
        updated_at: '2026-07-16T02:59:00.000Z',
      },
    },
    roles: [role],
  };
  const persistQueue = () => writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  persistQueue();

  assert.equal(existsSync(storePath), false);
  pass('password generation remains an in-memory staging step');

  assert.throws(
    () => credentials.upsertCredentials(host, email, password),
    /Accepted registration evidence is required/,
  );
  assert.equal(existsSync(storePath), false);
  pass('three-argument credential upsert fails closed before portal acceptance');

  const evidence = {
    version: credentials.REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION,
    classification: 'registration-accepted',
    result: 'accepted',
    portal_host: host,
    registration_url: `https://${host}/candidate/created`,
    account_email: email,
    account_created: true,
    application_submission_detected: false,
    role_id: roleId,
    application_request_id: requestId,
    run_id: runId,
    controller_id: controllerId,
    tab_id: tabId,
    observation_source: 'playwright-mcp',
    acceptance_signal: 'authenticated',
    accepted_at: '2026-07-16T03:00:00.000Z',
    snapshot_digest: 'a'.repeat(64),
    registration_control_id: 'create-account',
  };

  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(host, email, password, evidence),
    /Durable Playwright registration observation is missing/,
  );
  assert.equal(existsSync(storePath), false);
  pass('caller-authored acceptance shape and digest alone cannot persist credentials');

  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(
      host,
      email,
      password,
      {
        ...evidence,
        portal_host: 'other.example.test',
        registration_url: 'https://other.example.test/register',
      },
    ),
    /different portal host/,
  );
  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(
      host,
      email,
      password,
      { ...evidence, application_submission_detected: true },
    ),
    /final-application submission evidence/,
  );
  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(
      host,
      email,
      password,
      { ...evidence, account_email: 'someone-else@example.test' },
    ),
    /different account email/,
  );
  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(
      host,
      email,
      password,
      { ...evidence, controller_id: 'browser-controller:forged' },
    ),
    /different request, run, or controller/,
  );
  assert.throws(
    () => credentials.commitAcceptedRegistrationCredentials(
      host,
      email,
      password,
      { ...evidence, observation_source: 'caller-asserted' },
    ),
    /Playwright MCP observation/,
  );
  assert.equal(existsSync(storePath), false);
  pass('host, account, submit, controller, and observation mismatches fail closed');

  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const bound = JSON.parse(execFileSync(
    process.execPath,
    [
      join(ROOT, 'credentials-store.mjs'),
      '--bind-registration',
      roleId,
      `@${evidencePath}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAREER_OPS_DATA_DIR: dataPath,
        CAREER_OPS_QUEUE_BACKEND: 'local',
      },
    },
  ));
  assert.equal(bound.bound, true);
  assert.equal(bound.application_request_id, requestId);
  assert.equal(bound.tab_id, tabId);
  const queueAfterBind = JSON.parse(readFileSync(queuePath, 'utf8'));
  role.application_request.registration_acceptance =
    queueAfterBind.roles[0].application_request.registration_acceptance;
  pass('binding CLI durably records accepted Playwright evidence before receipt begin');

  const committed = credentials.commitAcceptedRegistrationCredentials(
    host,
    email,
    password,
    evidence,
  );
  assert.deepEqual(Object.keys(committed).sort(), [
    'accepted_at', 'committed', 'created_at', 'portal_host', 'updated_at',
  ]);
  assert.equal(committed.committed, true);
  assert.equal(committed.portal_host, host);
  assert.equal(Object.prototype.hasOwnProperty.call(committed, 'password'), false);

  const stored = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(stored[host].email, email);
  assert.equal(stored[host].password, password);
  assert.equal(stored[host].registration_accepted_at, evidence.accepted_at);
  assert.match(stored[host].registration_evidence_sha256, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(storePath).mode & 0o777, 0o600);
  }
  assert.equal(credentials.getCredentials(host).password, password);
  pass('exact-host queued registration commits atomically without returning the password');

  const idempotent = credentials.upsertCredentials(host, email, password, evidence);
  assert.equal(idempotent.committed, true);
  const replacement = credentials.generatePassword({ rejectedPasswords: [password] });
  assert.throws(
    () => credentials.upsertCredentials(host, email, replacement, evidence),
    /refusing overwrite/,
  );
  assert.equal(credentials.getCredentials(host).password, password);
  pass('compatibility upsert is idempotent but cannot replace an existing portal password');

  role.application_request.state = 'in-progress';
  role.application_request.tab_id = tabId;
  role.application_progress = {
    run_id: runId,
    application_request_id: requestId,
    controller_id: controllerId,
    tab: { id: tabId, url: evidence.registration_url },
  };
  persistQueue();
  assert.doesNotThrow(() => credentials.validateAcceptedRegistrationEvidence(host, email, evidence));
  const wrongTab = { ...evidence, tab_id: 'different-tab' };
  assert.throws(
    () => credentials.validateAcceptedRegistrationEvidence(host, email, wrongTab),
    /active receipt run\/tab/,
  );
  pass('post-begin validation is additionally bound to application_progress tab evidence');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
