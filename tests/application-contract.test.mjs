#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';
import {
  auditApplicationContract,
  checkAutofillOverview,
  checkApplicationScriptEntrypoints,
  checkApplicationSafetyRuntime,
  checkCredentialRuntime,
  checkDashboardClient,
  checkDashboardRuntime,
  checkFormFillRuntime,
  checkLocalizedWrapper,
  checkMergeTrackerRuntime,
  checkOfflineOpenRouterApply,
  checkQueueStoreRuntime,
  checkQueueResolverRuntime,
  checkReceiptRuntime,
  checkRetiredPrepareApplication,
  checkTrackerDeleteRuntime,
  checkTrackerMetadataWriter,
  checkTrackerTUIRuntime,
  checkWebPdfWorkerRuntime,
  checkWebRuntime,
} from '../verify-application-contract.mjs';

console.log('\nApplication contract drift guard');

const errors = auditApplicationContract(ROOT);
assert.deepEqual(
  errors,
  [],
  `application contract drift:\n${errors.map((item) => `- ${item.file}: ${item.message}`).join('\n')}`,
);
pass('all authoritative application surfaces satisfy the canonical contract');

const credentialRuntime = readFileSync(join(ROOT, 'credentials-store.mjs'), 'utf8');
assert.deepEqual(checkCredentialRuntime('credentials-store.mjs', credentialRuntime), []);
assert(
  checkCredentialRuntime(
    'credentials-store.mjs',
    credentialRuntime.replace(
      "firstDefined(policy, ['rejectedPasswords', 'rejected_passwords']),",
      'undefined,',
    ),
  ).some((item) => item.message.includes('rejected-password exclusion')),
  'guard must reject regeneration that can return an already rejected password',
);
assert(
  checkCredentialRuntime(
    'credentials-store.mjs',
    credentialRuntime.replace(
      'const normalized = normalizePasswordPolicy(policy);',
      'const normalized = normalizePasswordPolicy({});',
    ),
  ).some((item) => item.message.includes('displayed policy constraints')),
  'guard must reject a generator that ignores the displayed portal policy',
);
assert(
  checkCredentialRuntime(
    'credentials-store.mjs',
    credentialRuntime.replace(
      `const accepted = validateAcceptedRegistrationEvidence(
    key,
    normalizedEmail,
    evidence,
  );`,
      'const accepted = evidence;',
    ),
  ).some((item) => item.message.includes('before exact-host registration acceptance')),
  'guard must reject credential persistence that skips exact-host registration acceptance',
);
assert(
  checkCredentialRuntime(
    'credentials-store.mjs',
    credentialRuntime.replace('  registrationQueueBinding(queue, accepted);', ''),
  ).some((item) => item.message.includes('durable queue before commit')),
  'guard must reject accepted-registration evidence that is not bound to the durable queue',
);
pass('credential generation remains policy-aware and persistence remains acceptance-gated');

const applicationSafety = readFileSync(join(ROOT, 'application-safety.mjs'), 'utf8');
assert.deepEqual(checkApplicationSafetyRuntime('application-safety.mjs', applicationSafety), []);
assert(
  checkApplicationSafetyRuntime(
    'application-safety.mjs',
    applicationSafety.replace(
      "&& evidence?.applicationFormVisible === false;",
      '&& true;',
    ),
  ).some((item) => item.message.includes('known absence of application form')),
  'guard must reject registration confirmation without proven absence of an application form',
);
assert(
  checkApplicationSafetyRuntime(
    'application-safety.mjs',
    applicationSafety.replace(
      "if (applicationSubmissionDetected || phase === 'application-submit') {",
      "if (phase === 'application-submit') {",
    ),
  ).some((item) => item.message.includes('authoritative application-submit signal')),
  'guard must reject removal of the authoritative final-application signal',
);
pass('plain Submit is registration-only behind conclusive live-page evidence');

const pdfWorker = readFileSync(join(ROOT, 'web/src/app/api/run/route.ts'), 'utf8');
assert.deepEqual(checkWebPdfWorkerRuntime('web/src/app/api/run/route.ts', pdfWorker), []);
assert(
  checkWebPdfWorkerRuntime(
    'web/src/app/api/run/route.ts',
    pdfWorker.replace(
      'node set-status.mjs ${input} --pdf-ready --json',
      'in data/applications.md, change the PDF column for row #${input} from ❌ to ✅',
    ),
  ).some((item) => item.message.includes('canonical PDF-ready metadata writer')),
  'guard must reject headless PDF prompts that hand-edit the tracker',
);
pass('headless PDF worker delegates PDF metadata to set-status.mjs');

const trackerRuntime = readFileSync(join(ROOT, 'tracker.mjs'), 'utf8');
assert.deepEqual(checkTrackerDeleteRuntime('tracker.mjs', trackerRuntime), []);
assert(
  checkTrackerDeleteRuntime(
    'tracker.mjs',
    trackerRuntime.replace('lock = await acquireTrackerLock(', 'lock = await Promise.resolve('),
  ).some((item) => item.message.includes('shared lock')),
  'guard must reject a tracker delete that drops the shared writer lock',
);
pass('tracker delete cannot regress to a lock-free direct writer');

const resolverRuntime = readFileSync(join(ROOT, 'queue-resolve.mjs'), 'utf8');
assert.deepEqual(checkQueueResolverRuntime('queue-resolve.mjs', resolverRuntime), []);
assert(
  checkQueueResolverRuntime(
    'queue-resolve.mjs',
    resolverRuntime.replace(
      'const freshEvidence = assertPendingEvidence(freshRole, envelope);',
      'const freshEvidence = freshRole.application_progress.pending_resolver_evidence;',
    ),
  ).some((item) => item.message.includes('atomically revalidate evidence')),
  'guard must reject live teach that trusts a stale pre-lock lookup',
);
pass('live teach must revalidate and seal evidence before reusable learning');

const trackerMetadataWriter = readFileSync(join(ROOT, 'set-status.mjs'), 'utf8');
assert.deepEqual(checkTrackerMetadataWriter('set-status.mjs', trackerMetadataWriter), []);
assert(
  checkTrackerMetadataWriter(
    'set-status.mjs',
    trackerMetadataWriter.replace("parts[colmap.pdf] = '✅';", '// PDF mutation removed'),
  ).some((item) => item.message.includes('monotonic PDF-ready assignment')),
  'guard must reject removal of the exact-row PDF-ready mutation',
);
assert(
  checkTrackerMetadataWriter(
    'set-status.mjs',
    trackerMetadataWriter.replace(
      "...reviewReadinessErrors(role, { expectedReportState: 'submitted' }),",
      '// submitted receipt readiness removed',
    ),
  ).some((item) => item.message.includes('submitted Application Answers readiness rerun')),
  'guard must reject a caller-trusted receipt that skips submitted report readiness',
);
pass('tracker metadata writer cannot lose exact reveal/PDF gates or lifecycle preservation');

const validWrapper = `
# Local apply alias
> This file is a localization wrapper.
Read \`modes/apply.md\`, \`modes/_custom.md\`, \`queue-resolve.mjs\`, and
\`application-receipt.mjs\`.
Localization may change language only and must never change workflow behavior.
`;
assert.deepEqual(checkLocalizedWrapper('modes/xx/apply.md', validWrapper), []);

const copiedWorkflow = `${validWrapper}\n## Workflow\n1. DETECT — copied branch`;
assert(
  checkLocalizedWrapper('modes/xx/apply.md', copiedWorkflow)
    .some((item) => item.message.includes('independent Workflow')),
  'guard must reject a localized independent workflow',
);
pass('localized modes cannot grow a second application workflow');

const staleOverview = `
One executable source of truth: \`modes/apply.md\`, \`modes/_custom.md\`, and
\`queue-resolve.mjs\`. Use a stable role ID. Each page runs \`--lookup\`, L3,
\`--teach\` including \`[]\`, then verify the rendered state. Record a receipt,
show a final combined review, and only the candidate clicks the final application
submission control. Ask the candidate to fill the remaining questions.
`;
assert(
  checkAutofillOverview('docs/APPLY_AUTOFILL.md', staleOverview)
    .some((item) => item.message.includes('candidate form-filling handoff')),
  'guard must reject candidate form-filling handoffs',
);
pass('overview cannot regress to manual/copy-paste/blank-field handoffs');

const unsafeFill = `
// offline-plan-only; then run application-receipt.mjs
export const FORM_FILL_RUNTIME = 'offline-plan-only';
const plan = { browser_owner: 'active-agent', queue_mutation: false };
chromium.launchPersistentContext('/tmp/private');
setStatus(queue, ROLE_ID, 'prefilled');
`;
assert(
  checkFormFillRuntime('form-fill.mjs', unsafeFill)
    .some((item) => item.message.includes('browser launch/control')),
  'guard must reject restoration of private browser control',
);
pass('offline plan helper cannot restore browser or queue mutation paths');

const safeOfflineOpenRouterApply = `
export const OPENROUTER_APPLY_RUNTIME = 'offline-draft-only';
const articleDigest = readFile('article-digest.md');
const storyBank = readFile('interview-prep/story-bank.md');
const voiceDna = readFile('voice-dna.md');
const customMode = readFile('modes/_custom.md');
const prompt = \`OFFLINE DRAFT-ONLY COMPATIBILITY MODE
VOICE DNA (STYLE ONLY — NEVER FACTUAL EVIDENCE)
Treat the report as role/JD context, not as an independent source of candidate facts.
This cannot satisfy --lookup, L3, --teach, rendered verification, or application-receipt.
This output is not review-ready. Never submit an application.\`;
function cmdApply() { return callModel(prompt); }
`;
assert.deepEqual(checkOfflineOpenRouterApply('openrouter-runner.mjs', safeOfflineOpenRouterApply), []);
assert(
  checkOfflineOpenRouterApply(
    'openrouter-runner.mjs',
    safeOfflineOpenRouterApply.replace('return callModel(prompt);', 'chromium.launch(); return callModel(prompt);'),
  ).some((item) => item.message.includes('browser control')),
  'guard must reject browser control in the offline OpenRouter draft command',
);
pass('OpenRouter apply compatibility command remains source-grounded and offline draft-only');

const safeDashboard = `
import { reviewReadinessErrors, submissionReadinessErrors, markApplicationReportSubmitted } from './application-receipt.mjs';
import { validateDashboardMutationRequest, SelectionConfirmationStore, SubmissionConfirmationStore } from './dashboard-auth.mjs';
const MAX_ACTIVE_APPLICATION_REQUESTS = 4;
const SELECTION_CONFIRMATION_PHRASE = 'I selected these roles for preparation or filling';
const selectionConfirmations = new SelectionConfirmationStore();
const submissionConfirmations = new SubmissionConfirmationStore();
function enqueueActiveAgentRequest(role) { role.application_request = { controller: 'active-agent', controller_id }; }
function recordCandidateSelectionConfirmation(role, confirmation) { role.candidate_selection_confirmation = confirmation; }
function apiSelectionConfirmation() {
  if (body.confirmation !== SELECTION_CONFIRMATION_PHRASE) return respond({ error: 'confirmation required' });
  if (ids.length > MAX_ACTIVE_APPLICATION_REQUESTS) return respond({ error: 'max four' });
  return selectionConfirmations.issue({ roleIds: ids, action, roleStates });
}
function apiRoleFill() {
  const selectionConfirmation = consumeSelectionConfirmation({ action: 'fill', ids: [id] });
  mutateQueue((queue) => queue);
  recordCandidateSelectionConfirmation(role, selectionConfirmation, 'dashboard-fill');
  recordCandidateSelectionOverride(role, 4, 'dashboard-fill');
  if (role.status === 'filled') return { reviewReady: true, repairRequired: false };
  if (role.status === 'scored') setStatus(queue, role.id, 'prepare-queued');
  if (!FILLABLE_STATUSES.has(role.status)) return { preparationQueued: true };
  validateApplicationRole(role);
  enqueueActiveAgentRequest(role);
  return { method: 'agent', controller: 'active-agent' };
}
function apiRun() {
  const selectionConfirmation = consumeSelectionConfirmation({ action: 'run', ids });
  mutateQueue((freshQueue) => freshQueue);
  recordCandidateSelectionConfirmation(role, selectionConfirmation, 'dashboard-run');
  recordCandidateSelectionOverride(role, 4, 'dashboard-run');
  if (role.status === 'scored') setStatus(freshQueue, role.id, 'prepare-queued');
  if (FILLABLE_STATUSES.has(role.status)) enqueueActiveAgentRequest(role);
}
function apiRoleStage() {
  const selectionConfirmation = consumeSelectionConfirmation({ action: 'stage-prepare', ids: [id] });
  recordCandidateSelectionConfirmation(role, selectionConfirmation, 'dashboard-drag');
  setStatus(queue, id, target);
}
function apiSetThreshold() {
  mutateQueue((queue) => { queue.settings.score_threshold = threshold; });
  return respond({ threshold, selection_unchanged: true });
}
function writeTrackerTsv(role, decision, { receiptId = null } = {}) {
  if (decision === 'submitted' && !receiptId) throw new Error('receipt required');
  const status = 'Applied';
  const stagedStatus = decision === 'submitted' ? 'Evaluated' : status;
  const tsv = [role.company, role.title, stagedStatus, score];
  const args = ['set-status.mjs', role.company, 'Applied', '--report', role.report, '--receipt', receiptId];
  return execFileSync(process.execPath, args);
}
function beginCandidateDecision() {
  if (decision === 'submitted') {
    const errors = submissionReadinessErrors(role);
    if (errors.length) return respond(errors);
  }
  role.application_decision_transaction = { state: 'pending' };
}
function promoteOrReconcileSubmittedReport() { return markApplicationReportSubmitted(role); }
function apiSubmissionConfirmation() {
  return respond({ confirmation_nonce: submissionConfirmations.issue(id) });
}
function apiRoleDecision() {
  const confirmationNonce = body.confirmation_nonce;
  if (decision === 'submitted') submissionConfirmations.consume(id, confirmationNonce);
  mutateQueue((queue) => beginCandidateDecision(queue, id, decision));
  promoteOrReconcileSubmittedReport(role);
  writeTrackerTsv(workingRole, decision, { receiptId: role.application_progress.receipt_id });
  try {
    setStatus(queue, id, decision);
    transaction.state = 'committed';
  } catch (error) {
    return respond({ retry_same_decision: true });
  }
}
`;
assert.deepEqual(checkDashboardRuntime('dashboard-server.mjs', safeDashboard), []);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace("  recordCandidateSelectionOverride(role, 4, 'dashboard-fill');\n", ''),
  ).some((item) => item.message.includes('Fill API does not durably record')),
  'guard must reject a per-role Fill selection that omits the low-score override receipt',
);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace("  recordCandidateSelectionOverride(role, 4, 'dashboard-run');\n", ''),
  ).some((item) => item.message.includes('Run API does not durably record')),
  'guard must reject a checkbox Run selection that omits the low-score override receipt',
);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      "  recordCandidateSelectionOverride(role, 4, 'dashboard-fill');\n",
      "  enqueueActiveAgentRequest(role);\n  recordCandidateSelectionOverride(role, 4, 'dashboard-fill');\n",
    ),
  ).some((item) => item.message.includes('after quality/dispatch')),
  'guard must reject recording the Fill override after dispatch',
);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      "  recordCandidateSelectionOverride(role, 4, 'dashboard-run');\n",
      "  enqueueActiveAgentRequest(role);\n  recordCandidateSelectionOverride(role, 4, 'dashboard-run');\n",
    ),
  ).some((item) => item.message.includes('after dispatch')),
  'guard must reject recording the Run override after dispatch',
);
pass('every explicit dashboard Fill/Run selection must persist its low-score override');
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      "  const selectionConfirmation = consumeSelectionConfirmation({ action: 'fill', ids: [id] });",
      '  const selectionConfirmation = {};',
    ),
  ).some((item) => item.message.includes('Fill API is not bound')),
  'guard must reject a single/keyboard Fill that skips candidate selection consumption',
);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      "  const selectionConfirmation = consumeSelectionConfirmation({ action: 'run', ids });",
      '  const selectionConfirmation = {};',
    ),
  ).some((item) => item.message.includes('exact-role-set/run-bound')),
  'guard must reject a bulk Start Run that skips exact-role-set selection consumption',
);
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      "  const selectionConfirmation = consumeSelectionConfirmation({ action: 'stage-prepare', ids: [id] });",
      '  const selectionConfirmation = {};',
    ),
  ).some((item) => item.message.includes('PREPARE drag')),
  'guard must reject a PREPARE drag that skips candidate selection consumption',
);
pass('dashboard Fill, Run, and PREPARE drag cannot bypass candidate selection capabilities');
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace('const errors = submissionReadinessErrors(role);', 'const errors = [];'),
  ).some((item) => item.message.includes('not guarded')),
  'guard must reject a submitted decision without receipt readiness',
);
pass('dashboard submission decisions remain receipt-gated');
assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace('submissionConfirmations.consume(id, confirmationNonce);', 'true;'),
  ).some((item) => item.message.includes('one-use candidate confirmation nonce')),
  'guard must reject a submitted decision that does not consume its role-bound nonce',
);
pass('dashboard submitted decisions require a server-issued one-use nonce');

const safeMergeTracker = `
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected'];
const LIFECYCLE_STATES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);
const EXTERNAL_IMPORT = process.argv.includes('--external-import');
const HISTORICAL_IMPORT = process.argv.includes('--historical-import');
function stageLifecycleStatus(addition) {
  addition.requestedLifecycleStatus = addition.status;
  addition.status = 'Evaluated';
}
const pdfUpgrade = sanitizeCell(addition.pdf) === '✅' && sanitizeCell(duplicate.pdf) !== '✅' && sameReportIdentity(addition.report, duplicate.report) && (scoreUpgrade || newScore === oldScore);
const updatedLine = buildRow({ status: duplicate.status, pdf: pdfUpgrade ? '✅' : duplicate.pdf });
trackerLock.release();
const provenanceNote = \`[tracker-import:\${IMPORT_PROVENANCE}]\`;
execFileSync(process.execPath, [join(CAREER_OPS, 'set-status.mjs'), promotion.status, '--external']);
renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
`;
assert.deepEqual(checkMergeTrackerRuntime('merge-tracker.mjs', safeMergeTracker), []);
assert(
  checkMergeTrackerRuntime(
    'merge-tracker.mjs',
    safeMergeTracker.replace("addition.status = 'Evaluated';", "addition.status = 'Applied';"),
  ).some((item) => item.message.includes('Evaluated lifecycle staging')),
  'guard must reject direct lifecycle status insertion through tracker additions',
);
pass('merge-tracker cannot bypass Evaluated staging or canonical external provenance');

assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    safeDashboard.replace(
      'queue.settings.score_threshold = threshold;',
      "queue.settings.score_threshold = threshold; for (const role of queue.roles) role.status = 'prepare-queued';",
    ),
  ).some((item) => item.message.includes('threshold endpoint contains forbidden')),
  'guard must reject threshold-driven role selection or status promotion',
);
pass('dashboard threshold remains a setting/filter and cannot auto-select roles');

const safeThresholdClient = `
let csrfToken = '';
async function postJson(url, body = {}) {
  return fetch(url, { method: 'POST', headers: { 'X-Career-Ops-CSRF': csrfToken }, body: JSON.stringify(body) });
}
function loadQueue(data) { csrfToken = data.csrf_token; }
function selectionConfirmationBody(confirmation) {
  return {
    selection_confirmation_nonce: confirmation.selection_confirmation_nonce,
    selection_intent_id: confirmation.selection_intent_id,
  };
}
function requestCandidateSelection(ids, action, message, onConfirmed) {
  confirmToast(message, async () => {
    const res = await postJson('/api/selection-confirmation', { ids, action });
    const data = await res.json();
    if (data.selection_confirmation_nonce && data.selection_intent_id) onConfirmed(data);
  });
}
function startRun() { requestCandidateSelection(ids, 'run', message, executeStartRun); }
function doFill() { requestCandidateSelection([roleId], 'fill', message, executeFill); }
function handleDrop() {
  requestCandidateSelection([roleId], 'stage-prepare', message, (confirmation) => selectionConfirmationBody(confirmation));
}
async function setThreshold() {
  const res = await postJson('/api/threshold');
  toast('Selection threshold saved — no roles were queued or changed.');
}
function dropActionFor(fromStage, toStage, roleStatus) {
  if (roleStatus === 'filled') return null;
  return 'stage-flip';
}
const filledRepair = 'application-receipt.mjs --repair-filled';
const legacyNovelFieldLane = 'Requires active-agent L3 completion; candidate input is not requested';
async function requestSubmittedDecision(roleId) {
  const res = await postJson(\`/api/role/\${roleId}/submission-confirmation\`, {});
  const data = await res.json();
  if (data.confirmation_nonce) return doDecision('submitted', roleId, data.confirmation_nonce);
}
`;
assert.deepEqual(checkDashboardClient('dashboard/web/app.js', safeThresholdClient), []);
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace(
      "toast('Selection threshold saved — no roles were queued or changed.');",
      "toast(data.flipped + ' roles queued for prepare');",
    ),
  ).some((item) => item.message.includes('threshold UI')),
  'guard must reject stale threshold auto-queue UI claims',
);
pass('dashboard threshold UI cannot imply that changing a setting selects roles');
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace('/api/selection-confirmation', '/api/unsafe-selection'),
  ).some((item) => item.message.includes('role-selection confirmation flow')),
  'guard must reject a dashboard client that bypasses the server-issued selection endpoint',
);
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace(
      "function startRun() { requestCandidateSelection(ids, 'run', message, executeStartRun); }",
      'function startRun() { executeStartRun(ids); }',
    ),
  ).some((item) => item.message.includes('bulk Run')),
  'guard must reject a bulk Run UI that skips explicit candidate confirmation',
);
pass('dashboard client funnels selection mutations through the role-set intent flow');
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace('/submission-confirmation', '/decision-direct'),
  ).some((item) => item.message.includes('explicit nonce confirmation flow')),
  'guard must reject a client that bypasses the server-issued submission nonce endpoint',
);
pass('dashboard client funnels submitted mutations through the nonce confirmation flow');
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace("if (roleStatus === 'filled') return null;", ''),
  ).some((item) => item.message.includes('preserve receipt-gated filled')),
  'guard must reject a dashboard client that drags filled rows backward',
);
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    safeThresholdClient.replace('application-receipt.mjs --repair-filled', 'redo-filled-directly'),
  ).some((item) => item.message.includes('canonical repair')),
  'guard must reject a dashboard client without the filled repair route',
);
pass('dashboard drag client preserves valid filled evidence and routes corruption through repair');

const queueStoreRuntime = readFileSync(join(ROOT, 'queue-store.mjs'), 'utf8');
assert.deepEqual(checkQueueStoreRuntime('queue-store.mjs', queueStoreRuntime), []);
const forgedFilledDragStore = queueStoreRuntime.replace(
  "prepared:  'prepare-queued', // Prepared → To Do: un-prepare / send back for redo",
  "prepared:  'prepare-queued', // Prepared → To Do: un-prepare / send back for redo\n    filled:    'prepare-queued',",
);
assert(
  checkQueueStoreRuntime('queue-store.mjs', forgedFilledDragStore)
    .some((item) => item.message.includes('demoted by a bare dashboard drag')),
  'guard must reject a queue transition table that demotes receipt-gated filled',
);
pass('queue transition contract forbids direct Filled demotion');

const receiptRuntime = readFileSync(join(ROOT, 'application-receipt.mjs'), 'utf8');
assert.deepEqual(checkReceiptRuntime('application-receipt.mjs', receiptRuntime), []);
const receiptWithoutUploadBinding = receiptRuntime
  .replaceAll('cleanUploadControls', 'sanitizeUploads')
  .replaceAll('assertRoleAttachments', 'checkFiles')
  .replaceAll('asset_sha256', 'attachment_digest');
const uploadBindingErrors = checkReceiptRuntime('application-receipt.mjs', receiptWithoutUploadBinding);
assert(
  uploadBindingErrors.some((item) => item.message.includes('live upload-control manifest')) &&
  uploadBindingErrors.some((item) => item.message.includes('role-bound attachment verification')) &&
  uploadBindingErrors.some((item) => item.message.includes('content-hash-bound attachments')),
  'guard must reject receipts that lose upload control IDs or validated-asset SHA binding',
);
pass('receipt contract requires upload-control, control-ID, and content-SHA attachment evidence');
assert(
  checkReceiptRuntime(
    'application-receipt.mjs',
    receiptRuntime.replace(
      "finalizedInMemory = true;\n      setStatus(queue, roleId, 'filled');",
      "setStatus(queue, roleId, 'filled');\n      finalizedInMemory = true;",
    ),
  ).some((item) => item.message.includes('arm report/handover rollback')),
  'guard must reject arming finalizer rollback after the protected status call',
);
pass('receipt finalizer arms artifact rollback before status validation/persistence');

assert(
  checkReceiptRuntime(
    'application-receipt.mjs',
    receiptRuntime.replace('const staged = stageApplicationFinalization(roleId, payload);', 'const staged = { transaction: {} };'),
  ).some((item) => item.message.includes('stage and recover its durable transaction')),
  'guard must reject a finalizer that performs filesystem work without a durable staged transaction',
);
pass('receipt finalizer stages a resumable transaction before filesystem side effects');

const retiredPrepare = `
export const PREPARE_APPLICATION_RETIRED = true;
function message() { return 'The active-agent browser controller owns the browser.'; }
process.exitCode = 2;
`;
assert.deepEqual(checkRetiredPrepareApplication('prepare-application.mjs', retiredPrepare), []);
assert(
  checkRetiredPrepareApplication('prepare-application.mjs', `${retiredPrepare}\nfunction buildLeverFields() {}`)
    .some((item) => item.message.includes('ATS field-map implementation')),
  'guard must reject ATS field-map logic in the retired entrypoint',
);
pass('retired prepare-application tombstone cannot regrow a second workflow');

const entrypointFixture = mkdtempSync(join(tmpdir(), 'career-ops-entrypoints-'));
try {
  writeFileSync(join(entrypointFixture, 'package.json'), JSON.stringify({ scripts: { 'apply:plan': 'node form-fill.mjs' } }));
  writeFileSync(join(entrypointFixture, 'update-system.mjs'), "// Fail-closed tombstone\n'prepare-application.mjs'\n");
  assert.deepEqual(checkApplicationScriptEntrypoints(entrypointFixture), []);
} finally {
  rmSync(entrypointFixture, { recursive: true, force: true });
}
pass('package/updater expose only the offline plan and ship the fail-closed tombstone');

const webFixture = mkdtempSync(join(tmpdir(), 'career-ops-contract-'));
try {
  const legacyDir = join(webFixture, 'web', 'src', 'lib', 'apply');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'drive.ts'), 'export function drive() {}\n');
  assert(
    checkWebRuntime(webFixture).some((item) => item.message.includes('legacy direct-apply runtime')),
    'guard must reject restoration of the web direct-apply runtime',
  );
} finally {
  rmSync(webFixture, { recursive: true, force: true });
}
pass('web cannot restore a parallel direct-apply implementation');

const tuiFixture = mkdtempSync(join(tmpdir(), 'career-ops-tui-contract-'));
try {
  const dataDir = join(tuiFixture, 'dashboard', 'internal', 'data');
  const screensDir = join(tuiFixture, 'dashboard', 'internal', 'ui', 'screens');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(screensDir, { recursive: true });
  writeFileSync(join(dataDir, 'career.go'), `
func UpdateApplicationStatusAndNotes() {
  return os.WriteFile(filePath, bytes, 0644)
}
`);
  writeFileSync(join(screensDir, 'pipeline.go'), 'var statusOptions = []string{"Evaluated", "Applied"}\n');
  writeFileSync(join(screensDir, 'viewer.go'), 'var statusOptions = []string{"Applied"}\n');
  const tuiErrors = checkTrackerTUIRuntime(tuiFixture);
  assert(
    tuiErrors.some((item) => item.message.includes('directly rewrites applications.md')),
    'guard must reject a Go tracker status writer that bypasses set-status.mjs',
  );
  assert(
    tuiErrors.some((item) => item.message.includes('generic status picker exposes Applied')),
    'guard must reject Applied in a generic TUI status picker',
  );
} finally {
  rmSync(tuiFixture, { recursive: true, force: true });
}
pass('Go tracker UI cannot bypass receipt provenance or the canonical locked writer');
