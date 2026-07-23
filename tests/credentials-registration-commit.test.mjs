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
    'accepted_at', 'committed', 'created_at', 'portal_host', 'portal_key', 'updated_at',
  ]);
  assert.equal(committed.committed, true);
  assert.equal(committed.portal_host, host);
  assert.equal(committed.portal_key, host);
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
  assert.equal(idempotent.portal_host, host);
  assert.equal(idempotent.portal_key, host);
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

  // ── Multi-tenant host keying (career10.successfactors.com-style ATS) ──────
  const tenantHost = 'career10.successfactors.com';
  const makeTenantRole = (roleId, tenant, tabIdSuffix) => {
    const runId = `apply-tenant-${tabIdSuffix}`;
    const tabIdLocal = `tab-tenant-${tabIdSuffix}`;
    const requestIdLocal = `${runId}:${roleId}`;
    const registrationUrl = `https://${tenantHost}/career?company=${tenant}`;
    const roleObj = {
      id: roleId,
      company: tenant,
      title: 'Analyst',
      url: registrationUrl,
      status: 'prepared',
      application_request: {
        version: 1,
        request_id: requestIdLocal,
        run_id: runId,
        role_id: roleId,
        source: 'dashboard-fill',
        state: 'queued',
        controller: 'active-agent',
        controller_id: controllerId,
        requested_at: '2026-07-16T02:59:00.000Z',
        url: registrationUrl,
        contract: [
          'modes/apply.md', 'modes/_custom.md', 'queue-resolve.mjs',
          'application-receipt.mjs',
        ],
      },
    };
    const evidenceLocal = {
      version: credentials.REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION,
      classification: 'registration-accepted',
      result: 'accepted',
      portal_host: tenantHost,
      registration_url: registrationUrl,
      account_email: email,
      account_created: true,
      application_submission_detected: false,
      role_id: roleId,
      application_request_id: requestIdLocal,
      run_id: runId,
      controller_id: controllerId,
      tab_id: tabIdLocal,
      observation_source: 'playwright-mcp',
      acceptance_signal: 'authenticated',
      accepted_at: '2026-07-16T03:00:00.000Z',
      snapshot_digest: 'b'.repeat(64),
      registration_control_id: 'create-account',
    };
    return { roleObj, evidenceLocal, requestIdLocal, tabIdLocal };
  };

  const tenantA = makeTenantRole('tenant:analyst-a', 'tenanta', 'a');
  const tenantB = makeTenantRole('tenant:analyst-b', 'tenantb', 'b');
  const tenantQueue = {
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
    roles: [tenantA.roleObj, tenantB.roleObj],
  };
  writeFileSync(queuePath, `${JSON.stringify(tenantQueue, null, 2)}\n`);

  for (const { roleObj, evidenceLocal } of [tenantA, tenantB]) {
    writeFileSync(evidencePath, `${JSON.stringify(evidenceLocal, null, 2)}\n`);
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'credentials-store.mjs'),
        '--bind-registration',
        roleObj.id,
        `@${evidencePath}`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CAREER_OPS_DATA_DIR: dataPath, CAREER_OPS_QUEUE_BACKEND: 'local' },
      },
    );
  }

  const passwordA = credentials.generatePassword();
  const passwordB = credentials.generatePassword({ rejectedPasswords: [passwordA] });
  const committedTenantA = credentials.commitAcceptedRegistrationCredentials(
    tenantHost, email, passwordA, tenantA.evidenceLocal,
  );
  const committedTenantB = credentials.commitAcceptedRegistrationCredentials(
    tenantHost, email, passwordB, tenantB.evidenceLocal,
  );

  const tenantStore = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(tenantStore[`${tenantHost}?company=tenanta`].password, passwordA);
  assert.equal(tenantStore[`${tenantHost}?company=tenantb`].password, passwordB);
  assert.equal(Object.prototype.hasOwnProperty.call(tenantStore, tenantHost), false);
  assert.equal(committedTenantA.portal_host, tenantHost);
  assert.equal(committedTenantB.portal_host, tenantHost);
  assert.equal(committedTenantA.portal_key, `${tenantHost}?company=tenanta`);
  assert.equal(committedTenantB.portal_key, `${tenantHost}?company=tenantb`);
  pass('two tenants on one host commit to distinct keys derived from the registration URL');

  assert.equal(
    credentials.getCredentials(tenantHost, tenantA.evidenceLocal.registration_url).password,
    passwordA,
  );
  assert.equal(
    credentials.getCredentials(tenantHost, tenantB.evidenceLocal.registration_url).password,
    passwordB,
  );
  assert.equal(credentials.getCredentials(tenantHost), null);
  assert.throws(
    () => credentials.getCredentials(tenantHost, `https://${tenantHost}/career`),
    /missing its company tenant parameter/,
  );
  pass('tenant-qualified lookups never fall back to a bare-host entry');

  assert.throws(
    () => credentials.derivePortalKey(tenantHost, `https://other.test/career?company=tenanta`),
    /does not match the exact portal host/,
  );
  pass('portal key derivation rejects a URL host that does not match the exact host');

  // Only ATS families with grounded shared-host URL shapes receive a tenant
  // qualifier. A generic company= filter on an unrelated site stays bare-host
  // keyed, avoiding a false credential split.
  assert.equal(
    credentials.derivePortalKey(
      'jobs.example.test',
      'https://jobs.example.test/search?company=tenant-a',
    ),
    'jobs.example.test',
  );
  assert.equal(
    credentials.derivePortalKey(
      'jobs.smartrecruiters.com',
      'https://jobs.smartrecruiters.com/acme/search?company=division-a',
    ),
    'jobs.smartrecruiters.com',
  );
  pass('unrecognized company query parameters do not split a bare-host credential realm');

  assert.equal(
    credentials.derivePortalKey(
      'secure.dc2.pageuppeople.com',
      'https://secure.dc2.pageuppeople.com/apply/311/applicationForm/',
    ),
    'secure.dc2.pageuppeople.com?client=311',
  );
  assert.equal(
    credentials.derivePortalKey(
      'sjobs.brassring.com',
      'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?siteid=6106&partnerid=16030',
    ),
    'sjobs.brassring.com?partnerid=16030&siteid=6106',
  );
  assert.equal(
    credentials.derivePortalKey(
      'workforcenow.adp.com',
      'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=1&cid=b0e24f83-6e4d-492d-9d6a-bc0fea197d6a',
    ),
    'workforcenow.adp.com?cid=b0e24f83-6e4d-492d-9d6a-bc0fea197d6a',
  );
  assert.equal(
    credentials.derivePortalKey(
      'jobs.dayforcehcm.com',
      'https://jobs.dayforcehcm.com/en-US/odc/CANDIDATEPORTAL/profile',
    ),
    'jobs.dayforcehcm.com?client=odc&site=CANDIDATEPORTAL',
  );
  assert.equal(
    credentials.derivePortalKey(
      'www.dayforcehcm.com',
      'https://www.dayforcehcm.com/CandidatePortal/en-US/thechronicle',
    ),
    'www.dayforcehcm.com?client=thechronicle',
  );
  assert.equal(
    credentials.derivePortalKey(
      'recruiting.ultipro.com',
      'https://recruiting.ultipro.com/MAR1036MBCI/JobBoard/board-id/OpportunityDetail',
    ),
    'recruiting.ultipro.com?company=MAR1036MBCI',
  );
  pass('recognized shared-host ATS families derive stable query/path tenant keys');

  assert.throws(
    () => credentials.derivePortalKey(
      tenantHost,
      `https://${tenantHost}/career?company=tenanta&Company=tenantb`,
    ),
    /Ambiguous portal tenant parameter/,
  );
  pass('conflicting duplicate tenant parameters fail closed');

  assert.throws(
    () => credentials.normalizePortalKey('jobs.example.test?company=tenant-a'),
    /not supported for this portal host/,
  );
  assert.throws(
    () => credentials.derivePortalKey(
      'sjobs.brassring.com',
      'https://sjobs.brassring.com/TGnewUI/Search/Home/Home?partnerid=16030',
    ),
    /incomplete partnerid\/siteid/,
  );
  pass('rekey and known shared-host inputs reject incomplete or unsupported tenant keys');

  assert.equal(
    credentials.normalizePortalKey('Career10.SuccessFactors.com?company=tenanta-renamed'),
    `${tenantHost}?company=tenanta-renamed`,
  );
  const rekeyed = credentials.rekeyPortalCredential(
    `${tenantHost}?company=tenanta`,
    `https://${tenantHost}/career?company=tenanta-renamed`,
  );
  assert.equal(rekeyed.rekeyed, true);
  const afterRekey = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(afterRekey[`${tenantHost}?company=tenanta-renamed`].password, passwordA);
  assert.equal(Object.prototype.hasOwnProperty.call(afterRekey, `${tenantHost}?company=tenanta`), false);
  assert.throws(
    () => credentials.rekeyPortalCredential(
      `${tenantHost}?company=tenanta-renamed`,
      `${tenantHost}?company=tenantb`,
    ),
    /Refusing to overwrite/,
  );
  pass('rekeyPortalCredential moves a stored entry without overwriting an existing key');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
