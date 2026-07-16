#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generatePassword,
  normalizePortalHost,
  passwordMeetsPolicy,
} from '../credentials-store.mjs';
import {
  applicationActionDecision,
  isConclusiveRegistrationContext,
  isFinalApplicationActionLabel,
} from '../application-safety.mjs';
import { matchEeoOption, matchProfileRule, normLabel } from '../field-rules.mjs';
import { classifyLoginState } from '../login-core.mjs';
import { resolveFields, roleDraftKey, teachAnswers } from '../queue-resolve.mjs';
import { partitionRunRoles } from '../run-partition.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

// Login/registration classification: a registration form must win over the old
// weak "4+ inputs means application form" fallback.
assert.equal(classifyLoginState({
  bodyText: 'Create an account to apply',
  formLabels: ['First name', 'Last name', 'Email', 'Password', 'Confirm password'],
  buttons: ['Create account'],
  inputCount: 5,
}).result, 'registration-form');

assert.equal(classifyLoginState({
  bodyText: 'Please sign in to continue',
  formLabels: ['Email', 'Password'],
  buttons: ['Sign in', 'Create account'],
  inputCount: 2,
}).result, 'login-wall');

assert.equal(classifyLoginState({
  bodyText: 'Email or password is incorrect',
  inputCount: 2,
}).result, 'login-rejected');

assert.equal(classifyLoginState({
  bodyText: 'Enter the one-time code sent to your email',
  inputCount: 1,
}).result, 'human-challenge');

// Apply/continue labels are safe only in an explicit phase. A verified posting
// may open its application and a registration form may create the portal
// account; the same labels fail closed in an application form or unknown state.
assert.deepEqual(applicationActionDecision('Apply now', {
  phase: 'posting-entry', postingVerified: true, destinationMatched: true,
}), { allowed: true, kind: 'initial-application-navigation' });
assert.equal(applicationActionDecision('Apply now', {
  phase: 'posting-entry', postingVerified: false, destinationMatched: true,
}).allowed, false);
const registrationEvidence = {
  classification: 'registration-form',
  registrationIntentVisible: true,
  identityFieldVisible: true,
  passwordFieldVisible: true,
  applicationFormVisible: false,
};
assert.equal(isConclusiveRegistrationContext(registrationEvidence), true);
assert.deepEqual(applicationActionDecision('Create account', {
  phase: 'registration',
  registrationEvidence,
}), {
  allowed: true, kind: 'registration-confirmation',
});
assert.equal(applicationActionDecision('Create account', { phase: 'registration' }).allowed, false);
assert.equal(applicationActionDecision('Submit', { phase: 'registration' }).allowed, false);
assert.deepEqual(applicationActionDecision('Submit', {
  phase: 'registration',
  registrationEvidence,
}), {
  allowed: true, kind: 'registration-confirmation',
});
assert.equal(applicationActionDecision('Submit application', {
  phase: 'registration',
  registrationEvidence,
}).allowed, false);
assert.equal(applicationActionDecision('Submit', {
  phase: 'registration',
  registrationEvidence: { ...registrationEvidence, applicationFormVisible: true },
}).allowed, false);
assert.equal(applicationActionDecision('Submit', {
  phase: 'registration',
  registrationEvidence,
  applicationSubmissionDetected: true,
}).allowed, false);
assert.equal(applicationActionDecision('Continue', { phase: 'unknown' }).allowed, false);
assert.equal(applicationActionDecision('Submit application', { phase: 'form-navigation' }).allowed, false);
assert.equal(applicationActionDecision('Apply', { phase: 'unknown' }).allowed, false);

for (const label of [
  'Submit your application',
  'Finish and submit',
  'Complete and submit',
  'Send your application',
]) {
  assert.equal(isFinalApplicationActionLabel(label), true, `${label} must be a final boundary`);
  const decision = applicationActionDecision(label, { phase: 'unknown' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /candidate-only/);
}
for (const label of ['Continue', 'Save', 'Save and continue', 'Review']) {
  assert.equal(isFinalApplicationActionLabel(label), false, `${label} must remain navigation-only`);
}

// Exact-host and password guarantees without opening the credential store.
assert.equal(normalizePortalHost('Jobs.Example.COM.'), 'jobs.example.com');
assert.throws(() => normalizePortalHost('https://jobs.example.com/path'));
const generated = generatePassword();
assert.equal(generated.length, 24);
assert.match(generated, /[A-Z]/);
assert.match(generated, /[a-z]/);
assert.match(generated, /[0-9]/);
assert.match(generated, /[!@#$%^&*_-]/);

const displayedPolicy = {
  minLength: 14,
  maxLength: 16,
  preferredLength: 15,
  allowedSymbols: '@#',
  minUppercase: 2,
  minLowercase: 2,
  minDigits: 2,
  minSymbols: 2,
  forbiddenCharacters: 'O0',
  maxConsecutiveIdentical: 2,
  pattern: '[A-NP-Za-z1-9@#]+',
};
const compliant = generatePassword(displayedPolicy);
assert.equal(compliant.length, 15);
assert.equal(passwordMeetsPolicy(compliant, displayedPolicy), true);
assert.doesNotMatch(compliant, /[O0]/);
assert.match(compliant, /^[A-NP-Za-z1-9@#]+$/);

const alphanumericOnly = {
  length: 10,
  allowedCharacters: 'ABCDEFGHabcdefgh23456789',
  requireSymbol: false,
};
const noSymbolPassword = generatePassword(alphanumericOnly);
assert.equal(noSymbolPassword.length, 10);
assert.equal(passwordMeetsPolicy(noSymbolPassword, alphanumericOnly), true);
assert.match(noSymbolPassword, /^[A-Ha-h2-9]+$/);

const digitsForbiddenPolicy = {
  length: 12,
  forbiddenCharacters: '0123456789',
};
const digitsForbiddenPassword = generatePassword(digitsForbiddenPolicy);
assert.equal(passwordMeetsPolicy(digitsForbiddenPassword, digitsForbiddenPolicy), true);
assert.doesNotMatch(digitsForbiddenPassword, /[0-9]/);

const replacementPolicy = { ...displayedPolicy, rejectedPasswords: [compliant] };
const replacement = generatePassword(replacementPolicy);
assert.notEqual(replacement, compliant);
assert.equal(passwordMeetsPolicy(replacement, replacementPolicy), true);
assert.throws(
  () => generatePassword({ length: 8, allowedCharacters: 'abcdef', requireDigit: true }),
  /digit is required/,
);

const profile = {
  candidate: {},
  application_answers: {
    criminal_history: 'No',
    work_rights_consent: 'Yes',
    currently_student: 'No',
    has_masters: 'Yes',
    highest_qualification: 'Master of Information Technology',
    education_status: 'Completed',
  },
  eeo: { default: 'prefer not to say', gender: 'Man' },
};

assert.deepEqual(
  matchProfileRule('Do you have a criminal history?', 'radio', profile, {}),
  { value: 'No', rule: 'criminal_history' },
);
assert.equal(matchProfileRule('Are you currently a student?', 'radio', profile, {}).value, 'No');
assert.equal(matchProfileRule("Have you completed a Master's degree?", 'radio', profile, {}).value, 'Yes');
assert.equal(
  matchProfileRule('What is your highest qualification?', 'text', profile, {}).value,
  'Master of Information Technology',
);
assert.equal(
  matchEeoOption('Gender', ['Man', 'Woman', 'Prefer not to answer'], profile, false),
  'Prefer not to answer',
);
assert.equal(
  matchEeoOption('Preferred shift', ['Morning', 'Prefer not to answer'], profile, false),
  null,
);

const makeQueue = (id) => ({ roles: [{ id, company: 'Acme', title: 'Analyst', drafts: {} }] });
const makeCache = () => ({ version: 1, model: 'test', dimension: 2, entries: [] });
const makeStore = () => ({ version: 1, entries: {} });

// Every page may cross the teach barrier even when it had no novel fields.
{
  const out = teachAnswers('page-noop', '[]', {
    queue: makeQueue('page-noop'), cache: makeCache(), store: makeStore(),
    embedFn: () => { throw new Error('embedder must not run for an empty page'); },
  });
  assert.equal(out.noop, true);
  assert.deepEqual(out.taught, []);
}

// Review-required and reusable:false prose stays role-local and never contaminates
// the cross-role answer cache/store.
{
  const queue = makeQueue('review-local');
  const cache = makeCache();
  const store = makeStore();
  const label = 'How many years of direct domain experience do you have?';
  teachAnswers('review-local', JSON.stringify([{
    label,
    type: 'text',
    answer: '3',
    reusable: true,
    confidence: 'low',
    review_required: true,
    review_note: 'Conservative inference from dated experience; verify before submit.',
  }]), { queue, cache, store, embedFn: () => { throw new Error('must not embed'); } });

  const draft = queue.roles[0].drafts[normLabel(label)];
  assert.equal(draft.answer, '3');
  assert.equal(draft.reusable, false);
  assert.equal(draft.review_required, true);
  assert.deepEqual(queue.roles[0].review_required_fields, [label]);
  assert.equal(cache.entries.length, 0);
  assert.deepEqual(store.entries, {});

  const resumed = resolveFields(queue.roles[0], [{
    control_id: 'domain-years', label, type: 'text', required: true,
  }], {}, {
    cache, screenerStore: store,
    embedFn: () => { throw new Error('role-local taught answer should resume without embedding'); },
  });
  assert.equal(resumed.resolved[0].source, 'model');
  assert.equal(resumed.resolved[0].review_required, true);
  assert.equal(
    resumed.resolved[0].review_note,
    'Conservative inference from dated experience; verify before submit.',
  );
}

{
  const queue = makeQueue('nonreusable-local');
  const cache = makeCache();
  teachAnswers('nonreusable-local', JSON.stringify([{
    label: 'Why this company?', type: 'textarea', answer: 'Role-specific answer.', reusable: false,
  }]), { queue, cache, store: makeStore(), embedFn: () => { throw new Error('must not embed'); } });
  assert.equal(cache.entries.length, 0);
  assert.equal(queue.roles[0].drafts[normLabel('Why this company?')].answer, 'Role-specific answer.');
}

assert.throws(() => teachAnswers('invalid', JSON.stringify([{
  label: 'Question', answer: '', reusable: false,
}]), { queue: makeQueue('invalid'), cache: makeCache(), store: makeStore() }), /non-empty label\/answer/);

// Live controls are identified by control_id, not label alone. Duplicate labels
// must remain independently answerable and must not contaminate label-only caches.
{
  const queue = makeQueue('duplicate-controls');
  const fields = [
    { control_id: 'response-primary', label: 'Response', type: 'textarea' },
    { control_id: 'response-secondary', label: 'Response', type: 'textarea' },
  ];
  const first = resolveFields(queue.roles[0], fields, {}, {
    cache: makeCache(), screenerStore: makeStore(),
    embedFn: () => { throw new Error('ambiguous duplicate labels must go directly to L3'); },
  });
  assert.deepEqual(first.novel.map((item) => item.control_id), ['response-primary', 'response-secondary']);

  const cache = makeCache();
  const taught = teachAnswers('duplicate-controls', JSON.stringify([
    { control_id: 'response-primary', label: 'Response', type: 'textarea', answer: 'First answer', reusable: true },
    { control_id: 'response-secondary', label: 'Response', type: 'textarea', answer: 'Second answer', reusable: true },
  ]), {
    queue, cache, store: makeStore(),
    embedFn: () => { throw new Error('duplicate labels must remain role-local'); },
  });
  assert.equal(queue.roles[0].drafts[roleDraftKey(fields[0])].answer, 'First answer');
  assert.equal(queue.roles[0].drafts[roleDraftKey(fields[1])].answer, 'Second answer');
  assert.equal(cache.entries.length, 0);
  assert.deepEqual(taught.taught.map((item) => item.learnReason), ['duplicate-label', 'duplicate-label']);

  const resumed = resolveFields(queue.roles[0], fields, {}, {
    cache, screenerStore: makeStore(),
    embedFn: () => { throw new Error('exact control drafts should resume without embedding'); },
  });
  assert.deepEqual(resumed.resolved.map((item) => item.answer), ['First answer', 'Second answer']);
  assert.deepEqual(resumed.resolved.map((item) => item.control_id), ['response-primary', 'response-secondary']);
}

// Cross-agent workflow contract guards.
const apply = read('modes/apply.md');
const custom = read('modes/_custom.md');
const formFill = read('form-fill.mjs');
const credentials = read('credentials-store.mjs');
const autoPipeline = read('modes/auto-pipeline.md');
const oferta = read('modes/oferta.md');
const assistantRoute = read('web/src/app/api/assistant/route.ts');
const fieldRulesSource = read('field-rules.mjs');
const runPartitionSource = read('run-partition.mjs');
const dashboardServer = read('dashboard-server.mjs');
const dashboardClient = read('dashboard/web/app.js');

assert.match(apply, /Teach this page before Next — mandatory barrier/);
assert.match(apply, /answers:\[\]/);
assert.match(apply, /resolver_evidence_id/);
assert.match(apply, /application-receipt\.mjs --begin/);
assert.match(apply, /application-receipt\.mjs --page/);
assert.match(apply, /application-receipt\.mjs --finalize/);
assert.match(apply, /upload_controls` array \(including `\[\]` when none exist\)/);
assert.match(apply, /\{control_id,kind,expected,displayed,asset_sha256,verified:true\}/);
assert.match(apply, /requires a verified CV in every enabled `cv` control/);
assert.match(apply, /verified cover letter in every enabled `cover` or `supporting` control/);
assert.match(apply, /There is no "Ask candidate" or blank-field branch/);
assert.match(apply, /Submit my application, or Submit now/);
assert.doesNotMatch(apply, /legacy fallback/i);
assert.match(custom, /There are no "unsupported" form questions/);
assert.match(custom, /one browser-controller owns all live tabs/);
assert.match(custom, /only path allowed to promote[\s\S]{0,180}review-ready `filled`/);
assert.match(custom, /upload_controls:\[\{control_id,label,kind,required,multiple,enabled,accepts\}\]/);
assert.match(custom, /asset_sha256,verified:true/);
assert.match(custom, /every enabled `cv` control has the verified CV/);
assert.match(custom, /every enabled `cover` or `supporting` control has the verified cover letter/);
assert.match(formFill, /FORM_FILL_RUNTIME = 'offline-plan-only'/);
assert.match(formFill, /browser_owner: 'active-agent'/);
assert.match(formFill, /queue_mutation: false/);
assert.doesNotMatch(formFill, /from ['"]playwright['"]|launchPersistentContext|setStatus\s*\(|mutateQueue\s*\(/);
assert.doesNotMatch(formFill, /NAV_ALLOWLIST|findNavButton|FORM FILL COMPLETE|BROWSER REMAINS OPEN/);
assert.doesNotMatch(formFill, /getOrCreateCredentials/);
assert.doesNotMatch(credentials, /export function getOrCreateCredentials/);
assert.doesNotMatch(credentials, /export function listPortals/);
assert.match(credentials, /REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION = 2/);
assert.match(credentials, /export function bindAcceptedRegistrationObservation/);
assert.match(credentials, /Durable Playwright registration observation is missing/);
assert.match(credentials, /observation_source !== 'playwright-mcp'/);
assert.match(credentials, /Exact-host credentials already exist; refusing overwrite/);
assert.match(apply, /--bind-registration <role-id>/);
assert.match(apply, /before receipt\s+`--begin`/);
assert.match(custom, /caller-authored evidence shape or digest without that durable binding is invalid/i);
assert.doesNotMatch(assistantRoute, /^- setStatus[^\n]*"Applied"/m);
assert.match(assistantRoute, /Applied is receipt-gated/);
assert.match(autoPipeline, /Read and execute `modes\/oferta\.md` once, in full/);
assert.match(autoPipeline, /exactly one\s+`Evaluated` tracker addition/);
assert.match(autoPipeline, /Do not repeat those writes in this wrapper/);
assert.match(autoPipeline, /Present the verdict and stop/);
assert.doesNotMatch(autoPipeline, /mark the failed step as pending in the tracker/i);
assert.doesNotMatch(autoPipeline, /including Report and PDF as ✅/);
assert.match(oferta, /Never edit `data\/applications\.md` directly/);
assert.match(oferta, /always emits Status `Evaluated`/);
assert.doesNotMatch(fieldRulesSource, /handled by form-fill|form-fill's live path/i);
assert.match(
  runPartitionSource,
  /A scored selection is[\s\S]{0,120}promoted durably to `prepare-queued`[\s\S]{0,220}not an[\s\S]{0,20}application request until PREPARE succeeds/,
);

const dispatch = partitionRunRoles([
  { id: 'prepared', ats: 'greenhouse', status: 'prepared', flags: [] },
  { id: 'login', ats: 'lever', status: 'prepared', flags: ['login-required'] },
  { id: 'legacy', ats: 'greenhouse', status: 'prefilled', flags: [] },
  { id: 'filled', ats: 'greenhouse', status: 'filled', flags: [] },
  { id: 'custom', ats: 'custom', status: 'scored', flags: [] },
  { id: 'deep', ats: 'greenhouse', status: 'scored', flags: ['deep-eval'] },
  { id: 'blocked', ats: 'greenhouse', status: 'scored', flags: [] },
]);
assert.deepEqual(dispatch.agentPath.map((role) => role.id), ['prepared', 'login', 'legacy']);
assert.deepEqual(dispatch.filledCheck.map((role) => role.id), ['filled']);
assert.deepEqual(dispatch.notPrepared.map((role) => role.id), ['custom', 'deep', 'blocked']);
assert.deepEqual(Object.keys(dispatch).sort(), ['agentPath', 'filledCheck', 'notPrepared']);

const fillApi = dashboardServer.slice(
  dashboardServer.indexOf('function apiRoleFill'),
  dashboardServer.indexOf('function apiRoleDecision'),
);
const fillPrepare = fillApi.indexOf("setStatus(freshQueue, freshRole.id, 'prepare-queued')");
const fillGate = fillApi.indexOf('FILLABLE_STATUSES.has(freshRole.status)');
const fillDispatch = fillApi.indexOf('enqueueActiveAgentRequest(');
assert(fillPrepare >= 0 && fillGate > fillPrepare && fillDispatch > fillGate);
assert.doesNotMatch(fillApi.slice(0, fillGate), /freshRole\.ats\s*===\s*['"]custom['"]|isDeepEval\(freshRole\)/);

const bulkApi = dashboardServer.slice(
  dashboardServer.indexOf('function apiRun'),
  dashboardServer.indexOf('// ── Provenance summary helper'),
);
assert.match(bulkApi, /const selectedForPrepare = \[\]/);
assert.match(bulkApi, /role\.status === 'scored'[\s\S]{0,180}setStatus\(freshQueue, role\.id, 'prepare-queued'\)/);
assert.match(bulkApi, /prepareQueued:\s*dispatch\.selectedForPrepare\.length/);
assert.match(bulkApi, /notPrepared:\s*dispatch\.notPrepared\.length/);

const decisionApi = dashboardServer.slice(
  dashboardServer.indexOf('function apiRoleDecision'),
  dashboardServer.indexOf('// ── Kanban board — drag-to-move'),
);
assert.match(decisionApi, /submissionConfirmations\.consume\(id, confirmationNonce\)/);
const submissionClient = dashboardClient.slice(
  dashboardClient.indexOf('async function requestSubmittedDecision'),
  dashboardClient.indexOf('async function doDecision'),
);
assert.match(submissionClient, /\/submission-confirmation/);
assert.match(submissionClient, /doDecision\('submitted', roleId, data\.confirmation_nonce\)/);
assert.doesNotMatch(dashboardClient, /doDecision\(\s*['"]submitted['"]\s*\)/);

console.log('application workflow consistency tests passed');
