#!/usr/bin/env node
/**
 * Static drift guard for the live-application contract.
 *
 * This checker intentionally reads a small, explicit set of authoritative and
 * executable surfaces. It does not inspect user data, credential stores, or
 * historical handover text. The goal is to prevent a second application
 * workflow from quietly appearing in a locale, overview, dashboard, or web UI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));

export const LOCALIZED_APPLY_FILES = Object.freeze([
  'modes/ar/takdeem.md',
  'modes/da/apply.md',
  'modes/de/bewerben.md',
  'modes/es/aplicar.md',
  'modes/fr/postuler.md',
  'modes/hi/aavedan.md',
  'modes/id/melamar.md',
  'modes/it/candidarsi.md',
  'modes/ja/oubo.md',
  'modes/ko/jiwon.md',
  'modes/pl/aplikuj.md',
  'modes/pt/aplicar.md',
  'modes/ru/apply.md',
  'modes/tr/basvuru.md',
  'modes/ua/apply.md',
  'modes/zh/apply.md',
]);

export const LOCALIZED_EVALUATION_FILES = Object.freeze([
  'modes/ar/fursah.md',
  'modes/da/oferta.md',
  'modes/de/angebot.md',
  'modes/es/oferta.md',
  'modes/fr/offre.md',
  'modes/hi/naukri.md',
  'modes/id/lowongan.md',
  'modes/it/annuncio.md',
  'modes/ja/kyujin.md',
  'modes/ko/gonggo.md',
  'modes/pl/oferta.md',
  'modes/pt/oferta.md',
  'modes/ru/oferta.md',
  'modes/tr/is-ilani.md',
  'modes/ua/oferta.md',
  'modes/zh/oferta.md',
]);

export const LOCALIZED_PIPELINE_FILES = Object.freeze([
  'ar', 'da', 'de', 'es', 'fr', 'hi', 'id', 'it',
  'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'ua', 'zh',
].map((locale) => `modes/${locale}/pipeline.md`));

export const LOCALIZED_SHARED_FILES = Object.freeze([
  'ar', 'da', 'de', 'es', 'fr', 'hi', 'id', 'it',
  'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'ua', 'zh',
].map((locale) => `modes/${locale}/_shared.md`));

function issue(file, message) {
  return { file, message };
}

function readRequired(root, file, errors) {
  const path = join(root, file);
  if (!existsSync(path)) {
    errors.push(issue(file, 'required contract surface is missing'));
    return '';
  }
  return readFileSync(path, 'utf8');
}

// User-layer surfaces (modes/_custom.md, config/profile.yml, modes/_profile.md)
// are untracked personal files: validated when present, skipped on a clean
// checkout/CI where they cannot exist.
function readUserLayer(root, file) {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function walkFiles(root, relativeDir, extensions = null) {
  const start = join(root, relativeDir);
  if (!existsSync(start)) return [];
  const out = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const path = join(start, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, relative(root, path), extensions));
    } else if (!extensions || extensions.has(extname(entry.name))) {
      out.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  return out.sort();
}

function section(source, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^##+\\s+${escaped}\\s*$`, 'mi').exec(source);
  if (!match) return '';
  const start = match.index;
  const rest = source.slice(start + match[0].length);
  const next = /^##\s+/m.exec(rest);
  return source.slice(start, next ? start + match[0].length + next.index : source.length);
}

function functionBody(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!match) return '';
  // Parameters may contain destructuring defaults (`{ receiptId = null }`).
  // The last opening brace in the matched signature is the function body;
  // taking the first one would truncate the extracted body at the parameter.
  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return '';
}

function requirePatterns(file, source, checks) {
  const errors = [];
  for (const [description, pattern] of checks) {
    if (!pattern.test(source)) errors.push(issue(file, `missing ${description}`));
  }
  return errors;
}

export function checkLocalizedWrapper(file, source) {
  const errors = requirePatterns(file, source, [
    ['thin-wrapper declaration', /localization wrapper/i],
    ['root modes\/apply.md authority', /`modes\/apply\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['apply-page.mjs authority', /`apply-page\.mjs`/],
    ['queue-resolve.mjs authority', /`queue-resolve\.mjs`/],
    ['application-receipt.mjs authority', /`application-receipt\.mjs`/],
    ['language-only localization boundary', /localization may change language/i],
    ['workflow-preservation rule', /must never change workflow/i],
  ]);

  if (source.split(/\r?\n/).length > 70) {
    errors.push(issue(file, 'localized apply mode is no longer a thin wrapper (over 70 lines)'));
  }
  const forbidden = [
    ['an independent Workflow section', /^##\s+Workflow\s*$/im],
    ['copied numbered canonical workflow', /^\s*(?:\d+|5b|7b)\.\s+(?:DETECT|IDENTIFY|SEARCH|LOAD|PREFLIGHT|PRE-SCAN|ANALYZE|GENERATE|TEACH|PRESENT|PERSIST)\b/im],
    ['browser-tool implementation details', /\bbrowser_(?:navigate|tabs|fill_form|click|type)\b/i],
    ['copy/paste handoff instructions', /copy[- ]?paste|copy and paste/i],
  ];
  for (const [description, pattern] of forbidden) {
    if (pattern.test(source)) errors.push(issue(file, `contains ${description}`));
  }
  return errors;
}

export function checkLocalizedEvaluationWrapper(file, source) {
  const errors = requirePatterns(file, source, [
    ['thin-wrapper declaration', /localization wrapper/i],
    ['root modes\/oferta.md authority', /`modes\/oferta\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['A-G evaluation preservation', /A[–-]G/],
    ['language-only localization boundary', /Localization may change language/i],
    ['workflow-preservation rule', /must never change/i],
    ['live-application boundary', /never opens or fills a live application/i],
    ['root apply handoff', /root `modes\/apply\.md`/i],
  ]);
  if (source.split(/\r?\n/).length > 55) {
    errors.push(issue(file, 'localized evaluation mode is no longer a thin wrapper (over 55 lines)'));
  }
  for (const [description, pattern] of [
    ['an independent Workflow section', /^##\s+Workflow\s*$/im],
    ['copied evaluation blocks', /^##\s+(?:BLOCK|Block)\s+[A-H]\b/m],
    ['independent score formula', /(?:Final Score|Puntuaci[oó]n final|Gesamtpunktzahl)\s*[:=]/i],
  ]) {
    if (pattern.test(source)) errors.push(issue(file, `contains ${description}`));
  }
  return errors;
}

export function checkLocalizedPipelineWrapper(file, source) {
  const errors = requirePatterns(file, source, [
    ['thin-wrapper declaration', /localization wrapper/i],
    ['root modes\/pipeline.md authority', /`modes\/pipeline\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['API-first liveness preservation', /API-first/i],
    ['bounded single-pass worker preservation', /single-pass\/no-recursive-fanout/i],
    ['language-only localization boundary', /Localization may change language/i],
    ['workflow-preservation rule', /must never change/i],
  ]);
  if (source.split(/\r?\n/).length > 45) {
    errors.push(issue(file, 'localized pipeline mode is no longer a thin wrapper (over 45 lines)'));
  }
  for (const [description, pattern] of [
    ['an independent Workflow section', /^##\s+Workflow\s*$/im],
    ['copied numbered pipeline procedure', /^\s*\d+\.\s+(?:Read|Process|Evaluate|Generate|Update|Verify)\b/im],
  ]) {
    if (pattern.test(source)) errors.push(issue(file, `contains ${description}`));
  }
  return errors;
}

export function checkLocalizedSharedOverlay(file, source) {
  const errors = requirePatterns(file, source, [
    ['language\/market overlay declaration', /language and market-vocabulary overlay only/i],
    ['root modes\/_shared.md authority', /root `modes\/_shared\.md`/i],
    ['modes\/_profile.md authority', /`modes\/_profile\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['root modes\/apply.md authority', /`modes\/apply\.md`/],
    ['apply-page.mjs authority', /`apply-page\.mjs`/],
    ['queue-resolve.mjs authority', /`queue-resolve\.mjs`/],
    ['application-receipt.mjs authority', /`application-receipt\.mjs`/],
    ['language-only localization boundary', /Localization may change language/i],
    ['candidate source boundary', /Candidate-facing factual content may use only the approved sources/i],
    ['locale-is-not-evidence boundary', /locale file is never a source of candidate/i],
    ['mandatory-form root handoff', /mandatory live form control is handled only[\s\S]{0,100}root `modes\/apply\.md`/i],
  ]);
  if (source.split(/\r?\n/).length > 75) {
    errors.push(issue(file, 'localized shared file is no longer a thin overlay (over 75 lines)'));
  }
  for (const [description, pattern] of [
    ['a copied North Star', /^##\s+.*North Star/im],
    ['copied archetypes', /^##\s+.*Archetypes?/im],
    ['copied application workflow', /^##\s+.*(?:Application|Apply).*Workflow/im],
    ['credential-like sample', /(?:password|token|api[_ -]?key)\s*[:=]\s*\S+/i],
  ]) {
    if (pattern.test(source)) errors.push(issue(file, `contains ${description}`));
  }
  return errors;
}

export function checkInstructionSurface(file, source, { skill = false } = {}) {
  if (skill) {
    const localized = section(source, 'Localized apply aliases');
    const errors = requirePatterns(file, localized, [
      ['Localized apply aliases section', /Localized apply aliases/i],
      ['root modes\/apply.md authority', /root `modes\/apply\.md`/i],
      ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
      ['apply-page.mjs authority', /`apply-page\.mjs`/],
      ['queue-resolve.mjs authority', /`queue-resolve\.mjs`/],
      ['application-receipt.mjs authority', /`application-receipt\.mjs`/],
      ['single-workflow rule', /single workflow/i],
      ['queue preservation anchor', /\bqueue\b/i],
      ['authentication preservation anchor', /\bauth\b/i],
      ['resolver\/teach preservation anchor', /resolver\/teach/i],
      ['tab preservation anchor', /\btab\b/i],
      ['persistence preservation anchor', /\bpersistence\b/i],
      ['review preservation anchor', /\breview\b/i],
      ['never-submit preservation anchor', /never-submit/i],
    ]);
    for (const alias of ['takdeem', 'bewerben', 'postuler', 'aavedan', 'oubo', 'basvuru']) {
      if (!localized.includes(alias)) errors.push(issue(file, `localized alias list is missing ${alias}`));
    }
    return errors;
  }

  return requirePatterns(file, source, [
    ['Live Application Execution Contract heading', /Live Application Execution Contract \(CRITICAL\)/],
    ['modes\/apply.md authority', /`modes\/apply\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['apply-page.mjs authority', /`apply-page\.mjs`/],
    ['queue-resolve.mjs authority', /`queue-resolve\.mjs`/],
    ['application-receipt.mjs authority', /`application-receipt\.mjs`/],
    ['stable role ID precondition', /stable role ID/i],
    ['lean-llm-v1 default', /lean-llm-v1/],
    ['per-page lookup step', /apply-page\.mjs lookup/],
    ['L3 novel-answer step', /\bL3\b/],
    ['lean page-done step', /apply-page\.mjs page-done/],
    ['lean finish step', /apply-page\.mjs finish/],
    ['lean prefilled completion', /finish[\s\S]{0,120}`?prefilled`?|`prefilled`[\s\S]{0,80}lean/i],
    ['exact-host auth state machine', /exact-host[^.\n]*(?:registration|login)|(?:registration|login)[^.\n]*exact-host/i],
    ['agent-owned registration', /registration confirmation is permitted/i],
    ['final submission prohibition', /final\s+application\s+submission\s+is\s+never\s+permitted/i],
    ['offline form-fill boundary', /`form-fill\.mjs`[^.\n]*offline planning helper only/i],
    ['receipt-only filled promotion', /only the receipt finalizer may set review-ready\s+`filled`/i],
  ]);
}

export function checkAutofillOverview(file, source) {
  const errors = requirePatterns(file, source, [
    ['single-source declaration', /one executable source of truth/i],
    ['modes\/apply.md authority', /`modes\/apply\.md`/],
    ['modes\/_custom.md authority', /`modes\/_custom\.md`/],
    ['apply-page.mjs authority', /`apply-page\.mjs`/],
    ['queue-resolve.mjs authority', /`queue-resolve\.mjs`/],
    ['lean-llm-v1 default', /lean-llm-v1/],
    ['application-receipt historical', /application-receipt\.mjs|receipt-v3/i],
    ['stable role ID', /stable role ID/i],
    ['per-page lookup', /apply-page\.mjs lookup|`--lookup`/],
    ['L3 completion', /\bL3\b/],
    ['lean page-done', /apply-page\.mjs page-done|page-done/],
    ['lean finish', /apply-page\.mjs finish|\bfinish\b[\s\S]{0,40}prefilled/i],
    ['sign-in registration-route scan', /sign-in page with no exact-host credential[\s\S]{0,240}Register \/ Create account \/ Sign up route/i],
    ['manual-login fallback boundary', /parks for candidate login only when no registration route is visible[\s\S]{0,220}stored-credential attempt fails/i],
    ['combined review boundary', /final combined review|compact lean review/i],
    ['candidate-only final submission', /only the candidate clicks the final application submission control/i],
  ]);

  const forbidden = [
    ['copy/paste handoff', /copy[- ]?paste|copy and paste/i],
    ['candidate form-filling handoff', /(?:ask|tell|leave) (?:the )?(?:candidate|user)[^.\n]{0,80}(?:fill|answer|complete|paste|select)/i],
    ['manual form-filling instruction', /manual(?:ly)?\s+(?:fill|answer|complete|paste|select)/i],
    ['blank-field instruction', /leave (?:the )?(?:fields?|questions?|answers?|it) blank/i],
    ['knockout halt instruction', /(?:stop|halt|block|pause)[^.\n]{0,80}(?:knockout|screener)|(?:knockout|screener)[^.\n]{0,80}(?:stop|halt|block|pause)/i],
  ];
  for (const [description, pattern] of forbidden) {
    if (pattern.test(source)) errors.push(issue(file, `contains stale ${description}`));
  }
  return errors;
}

export function checkFormFillRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['offline-only runtime marker', /FORM_FILL_RUNTIME\s*=\s*['"]offline-plan-only['"]/],
    ['active-agent browser ownership', /browser_owner:\s*['"]active-agent['"]/],
    ['read-only queue declaration', /queue_mutation:\s*false/],
    ['receipt handoff', /application-receipt\.mjs/i],
  ]);

  const forbidden = [
    ['browser dependency', /from\s+['"]playwright['"]|require\s*\(\s*['"]playwright['"]\s*\)/i],
    ['browser launch/control', /\b(?:chromium|firefox|webkit)\.(?:launch|launchPersistentContext)|\bpage\.(?:goto|click|fill|check|selectOption|setInputFiles)\s*\(/],
    ['queue mutation', /\b(?:mutateQueue|saveQueue|setStatus|updateById)\s*\(/],
    ['wizard navigation allowlist', /\b(?:NAV_ALLOWLIST|findNavButton)\b/],
    ['legacy completion claim', /FORM FILL COMPLETE|BROWSER REMAINS OPEN|status\s*(?::|=)\s*['"]prefilled['"]/i],
  ];
  for (const [description, pattern] of forbidden) {
    if (pattern.test(source)) errors.push(issue(file, `offline helper still contains ${description}`));
  }
  return errors;
}

export function checkOfflineOpenRouterApply(file, source) {
  const errors = requirePatterns(file, source, [
    ['offline draft-only runtime marker', /OPENROUTER_APPLY_RUNTIME\s*=\s*['"]offline-draft-only['"]/],
    ['offline draft-only directive', /OFFLINE DRAFT-ONLY COMPATIBILITY MODE/],
    ['custom workflow context', /readFile\(['"]modes\/_custom\.md['"]\)/],
    ['article-digest candidate context', /readFile\(['"]article-digest\.md['"]\)/],
    ['story-bank candidate context', /readFile\(['"]interview-prep\/story-bank\.md['"]\)/],
    ['voice-dna style-only boundary', /VOICE DNA \(STYLE ONLY[^\n]*NEVER FACTUAL EVIDENCE\)/i],
    ['report context boundary', /report as role\/JD context, not as an independent source of candidate facts/i],
    ['live resolver incompatibility boundary', /cannot satisfy[\s\S]{0,200}--lookup[\s\S]{0,100}--teach[\s\S]{0,300}application-receipt/i],
    ['review-readiness prohibition', /not review-ready/i],
    ['submission prohibition', /Never submit an application/i],
  ]);

  const apply = functionBody(source, 'cmdApply');
  if (!apply) return errors.concat(issue(file, 'cmdApply function is missing'));
  for (const [description, pattern] of [
    ['browser control', /\b(?:chromium|firefox|webkit)\b|\bpage\.(?:goto|click|fill|check|selectOption|setInputFiles)\s*\(/i],
    ['queue or receipt mutation', /\b(?:mutateQueue|saveQueue|setStatus|finalizeRole)\s*\(/],
    ['live-completion claim', /FORM FILL COMPLETE|APPLICATION ANSWERS\s*[─-]|review_ready\s*:\s*true/i],
  ]) {
    if (pattern.test(apply)) errors.push(issue(file, `offline OpenRouter apply command contains ${description}`));
  }
  if (/Generate application form answers based on this evaluation report/i.test(source)) {
    errors.push(issue(file, 'offline OpenRouter command restored report-only live-answer wording'));
  }
  return errors;
}

/**
 * The shared active-agent request core. One module owns the browser-controller
 * lease and the four-active-role cap; both dispatchers (dashboard Fill/Run and
 * the One-shot drain) go through it, so the invariant is structural rather than
 * two copies that must be kept in agreement.
 */
export function checkApplicationRequestCore(file, source) {
  const errors = requirePatterns(file, source, [
    ['four-role concurrency cap', /export const MAX_ACTIVE_APPLICATION_REQUESTS\s*=\s*4\s*;/],
    ['active request state set', /export const ACTIVE_APPLICATION_REQUEST_STATES\s*=\s*new Set\(\['queued', 'in-progress'\]\)/],
    ['single browser-controller lease', /export function applicationControllerLease\s*\(/],
    ['durable request creator', /export function createActiveAgentRequest\s*\(/],
    ['active-agent controller marker', /controller:\s*['"]active-agent['"]/],
  ]);
  // The core records work. It must never drive a browser or move a role's
  // lifecycle status — those belong to the agent and the receipt/lean writers.
  if (/from ['"]playwright['"]|launchPersistentContext|browser_click/.test(source)) {
    errors.push(issue(file, 'the shared request core must never touch a browser'));
  }
  if (/\bsetStatus\s*\(/.test(source)) {
    errors.push(issue(file, 'the shared request core must never change application status'));
  }
  if (!/if \(activeApplicationRequests\(queue\)\.length >= MAX_ACTIVE_APPLICATION_REQUESTS\)/.test(source)) {
    errors.push(issue(file, 'the shared request core does not enforce the active-request cap before creating a request'));
  }
  return errors;
}

/**
 * The durable One-shot chain. It carries the candidate's ORIGINAL Run intent
 * forward so no second click is needed, and it must never manufacture a fresh
 * candidate attestation, open a browser, or reach a fill without the executable
 * asset gate passing first.
 */
export function checkOneShotRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['durable request recorder', /export function recordOneShotRequest\s*\(/],
    ['asset-gate transition', /export function verifyOneShotAssets\s*\(/],
    ['fill dispatch', /export function dispatchOneShotFill\s*\(/],
    ['crash-resume reconciliation', /export function reconciledOneShotState\s*\(/],
    ['shared request core', /from ['"]\.\/application-request\.mjs['"]/],
    ['executable asset gate', /validateApplicationRole\([\s\S]{0,200}requireAssets:\s*true/],
  ]);
  if (/from ['"]playwright['"]|launchPersistentContext|browser_click|page\.goto/.test(source)) {
    errors.push(issue(file, 'the One-shot drain must never touch a browser'));
  }
  // Minting a candidate_selection_confirmation after PREPARE would launder an
  // agent decision into the candidate attestation chain.
  if (/candidate_selection_confirmation\s*=/.test(source) ||
      /I selected these roles for preparation or filling/.test(source)) {
    errors.push(issue(file, 'the One-shot drain must never mint a candidate selection confirmation'));
  }
  const dispatch = functionBody(source, 'dispatchOneShotFill');
  if (!dispatch) {
    errors.push(issue(file, 'dispatchOneShotFill function is missing'));
  } else {
    const gate = dispatch.indexOf('requireAssets: true');
    const create = dispatch.indexOf('createActiveAgentRequest(');
    if (gate < 0 || create < 0 || gate > create) {
      errors.push(issue(file, 'One-shot dispatch does not re-run the asset gate before creating an application request'));
    }
    if (!/request\.state !== 'assets-verified'/.test(dispatch)) {
      errors.push(issue(file, 'One-shot dispatch does not require a proven assets-verified state'));
    }
  }
  return errors;
}

/**
 * Lean finish must prove what it uploaded.
 *
 * The reported npm failure was a candidate uploading their OWN local CV because
 * career-ops generated nothing role-specific. The structural defence is that a
 * finished run binds each observed upload control to a generated `output/` asset
 * by content hash — and that the binding runs BEFORE anything is written or the
 * queue is promoted, so a rejected finish leaves no half-finished state.
 */
export function checkLeanAttachmentGate(file, source) {
  const errors = requirePatterns(file, source, [
    ['attachment gate', /function assertLeanAttachments\s*\(/],
    ['content-hash verification', /function verifyLeanAttachment\s*\(/],
    ['observed upload controls', /export function observedUploadControls\s*\(/],
    ['generated-asset resolver', /resolveApplicationAsset\(/],
    ['role asset binding', /is not one of this role's generated cv_pdf\/cover_letter_paths assets/],
    ['content hash mismatch', /content hash does not match the role asset on disk/],
    ['required-control coverage', /has no verified attachment evidence/],
  ]);
  const finish = functionBody(source, 'finishLean');
  if (!finish) {
    errors.push(issue(file, 'finishLean function is missing'));
    return errors;
  }
  const gate = finish.indexOf('assertLeanAttachments(');
  const report = finish.indexOf('upsertReportSection(');
  const promote = finish.indexOf("setStatus(queue, roleId, 'prefilled')");
  if (gate < 0 || report < 0 || promote < 0 || gate > report || report > promote) {
    errors.push(issue(file, 'lean finish must run the attachment gate before writing the report or promoting to prefilled'));
  }
  // Page observations must carry the machine-extracted controls forward, or a
  // required upload on page 1 could not be proven at finish on page 4.
  if (!/entry\.upload_controls = observedControls/.test(source)) {
    errors.push(issue(file, 'lean page-done does not persist the observed upload controls into the durable ledger'));
  }
  return errors;
}

export function checkDashboardRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['receipt-gate import', /import\s*\{[^}]*reviewReadinessErrors[^}]*\}\s*from\s*['"]\.\/application-receipt\.mjs['"]/s],
    ['durable active-agent request helper', /function enqueueActiveAgentRequest\s*\(/],
    ['active-agent controller marker', /controller:\s*['"]active-agent['"]/],
    ['same-origin CSRF mutation guard', /validateDashboardMutationRequest/],
    ['one-use candidate selection confirmation store', /SelectionConfirmationStore/],
    ['candidate selection confirmation endpoint', /function apiSelectionConfirmation\s*\(/],
    ['one-use submission confirmation store', /SubmissionConfirmationStore/],
    ['submission confirmation endpoint', /function apiSubmissionConfirmation\s*\(/],
  ]);
  const decision = functionBody(source, 'apiRoleDecision');
  if (!decision) return errors.concat(issue(file, 'apiRoleDecision function is missing'));
  const beginDecision = functionBody(source, 'beginCandidateDecision');
  if (!beginDecision) errors.push(issue(file, 'beginCandidateDecision transaction helper is missing'));

  const submitted = beginDecision?.indexOf("decision === 'submitted'") ?? -1;
  const readiness = beginDecision?.indexOf('submissionReadinessErrors(role)') ?? -1;
  if (beginDecision && !/role\.manual_submission\s*=/.test(beginDecision)) {
    errors.push(issue(file, 'manual submitted decisions do not stamp durable candidate manual-submission provenance'));
  }
  const durableIntent = decision.indexOf('beginCandidateDecision(queue, id, decision)');
  const mutate = decision.indexOf('setStatus(queue, id, decision)');
  const trackerPersist = decision.indexOf('writeTrackerTsv(workingRole, decision');
  const reportPersist = decision.indexOf('promoteOrReconcileSubmittedReport');
  if (submitted < 0 || readiness < 0) {
    errors.push(issue(file, 'submitted decisions are not guarded by submissionReadinessErrors(role)'));
  }
  if (durableIntent < 0 || trackerPersist < 0 || mutate < 0 ||
      !(durableIntent < trackerPersist && trackerPersist < mutate)) {
    errors.push(issue(file, 'candidate decision does not durably stage intent before tracker and queue completion'));
  }
  if (reportPersist < 0 || (trackerPersist >= 0 && reportPersist > trackerPersist)) {
    errors.push(issue(file, 'candidate decision does not promote the receipt-bound report before tracker persistence'));
  }
  if (!/transaction\.state\s*=\s*['"]committed['"]/.test(decision) ||
      !/retry_same_decision\s*:\s*true/.test(decision)) {
    errors.push(issue(file, 'candidate decision is not a durable retryable transaction'));
  }
  if (/rollbackApplicationReportSubmission\s*\(/.test(decision)) {
    errors.push(issue(file, 'candidate-confirmed submission must not roll the truthful report state back on an infrastructure failure'));
  }
  // The four-role cap now lives in exactly one module (application-request.mjs)
  // so the dashboard and the One-shot drain cannot diverge. Accept either the
  // legacy local literal or the shared import, but never neither.
  const declaresCapLocally = /MAX_ACTIVE_APPLICATION_REQUESTS\s*=\s*4/.test(source);
  const importsSharedCap = /import\s*\{[^}]*MAX_ACTIVE_APPLICATION_REQUESTS[^}]*\}\s*from\s*['"]\.\/application-request\.mjs['"]/s.test(source);
  if ((!declaresCapLocally && !importsSharedCap) ||
      !/MAX_ACTIVE_APPLICATION_REQUESTS/.test(source) ||
      !/controller_id/.test(source) || !/reviewReady/.test(source) || !/repairRequired/.test(source)) {
    errors.push(issue(file, 'dashboard does not enforce the four-role controller lease and separate filled-receipt lane'));
  }
  if (!/submissionConfirmations\.consume\(id, confirmationNonce\)/.test(decision)) {
    errors.push(issue(file, 'submitted decisions do not require a one-use candidate confirmation nonce'));
  }

  const trackerWriter = functionBody(source, 'writeTrackerTsv');
  if (!trackerWriter) {
    errors.push(issue(file, 'writeTrackerTsv function is missing'));
  } else {
    for (const [description, pattern] of [
      ['submitted receipt-id guard', /decision === ['"]submitted['"] && !receiptId/],
      ['Evaluated-only submission staging', /stagedStatus\s*=\s*decision\s*===\s*['"]submitted['"]\s*\?\s*['"]Evaluated['"]\s*:\s*status/],
      ['staged status in tracker TSV', /role\.company\s*,\s*role\.title\s*,\s*stagedStatus\s*,\s*score/],
      ['canonical set-status delegation', /['"]set-status\.mjs['"]/],
      ['receipt provenance argument', /['"]--receipt['"]/],
      ['exact report disambiguation', /['"]--report['"]/],
      ['manual-submission provenance validation', /manualSubmissionProvenanceError\(role\)/],
      ['manual-submission external delegation', /['"]--external['"]/],
    ]) {
      if (!pattern.test(trackerWriter)) errors.push(issue(file, `tracker decision writer is missing ${description}`));
    }
    if (!source.includes(
      'if (receiptId || role.application_progress?.application_answers_report)',
    ) || !trackerWriter.includes("args.push('--report', reportTarget)")) {
      errors.push(issue(
        file,
        'tracker decision writer uses a fallback job URL as exact report disambiguation',
      ));
    }
    if (/Non-fatal: the TSV|tracker write-back failed|console\.warn\([^\n]*tracker/i.test(trackerWriter)) {
      errors.push(issue(file, 'tracker decision failure is treated as non-fatal'));
    }
  }

  const fill = functionBody(source, 'apiRoleFill');
  if (!fill) errors.push(issue(file, 'apiRoleFill function is missing'));
  else {
    const selectionAt = fill.indexOf('consumeSelectionConfirmation');
    const confirmationRecordAt = fill.indexOf('recordCandidateSelectionConfirmation');
    if (!/enqueueActiveAgentRequest\s*\(/.test(fill)) {
      errors.push(issue(file, 'Fill API does not enqueue canonical active-agent work'));
    }
    if (selectionAt < 0 || confirmationRecordAt < 0 ||
        selectionAt > fill.indexOf('mutateQueue') ||
        confirmationRecordAt > fill.indexOf('recordCandidateSelectionOverride')) {
      errors.push(issue(file, 'Fill API is not bound to a consumed candidate selection intent before override/dispatch'));
    }
    if (!/recordCandidateSelectionOverride\s*\([\s\S]*?['"]dashboard-fill['"]/.test(fill)) {
      errors.push(issue(file, 'Fill API does not durably record an explicit low-score selection override'));
    } else {
      const overrideAt = fill.indexOf('recordCandidateSelectionOverride');
      const qualityAt = fill.indexOf('validateApplicationRole');
      const dispatchAt = fill.indexOf('enqueueActiveAgentRequest');
      if ((qualityAt !== -1 && overrideAt > qualityAt) || (dispatchAt !== -1 && overrideAt > dispatchAt)) {
        errors.push(issue(file, 'Fill API records the low-score override after quality/dispatch instead of before it'));
      }
    }
    if (!/status\s*===\s*['"]scored['"][\s\S]*setStatus\([^;]+['"]prepare-queued['"]/.test(fill)) {
      errors.push(issue(file, 'Fill API does not persist scored dashboard selection as prepare-queued before live work'));
    }
  }
  const run = functionBody(source, 'apiRun');
  if (!run) errors.push(issue(file, 'apiRun function is missing'));
  else {
    const selectionAt = run.indexOf('consumeSelectionConfirmation');
    const confirmationRecordAt = run.indexOf('recordCandidateSelectionConfirmation');
    if (!/enqueueActiveAgentRequest\s*\(/.test(run)) {
      errors.push(issue(file, 'Run API does not enqueue canonical active-agent work'));
    }
    if (selectionAt < 0 || confirmationRecordAt < 0 ||
        selectionAt > run.indexOf('mutateQueue') ||
        confirmationRecordAt > run.indexOf('recordCandidateSelectionOverride')) {
      errors.push(issue(file, 'Run API is not exact-role-set/run-bound to a consumed candidate selection intent'));
    }
    if (!/recordCandidateSelectionOverride\s*\([\s\S]*?['"]dashboard-run['"]/.test(run)) {
      errors.push(issue(file, 'Run API does not durably record explicit low-score selection overrides'));
    } else if (run.indexOf('recordCandidateSelectionOverride') > run.indexOf('enqueueActiveAgentRequest')) {
      errors.push(issue(file, 'Run API records low-score overrides after dispatch instead of before it'));
    }
    if (!/role\.status\s*===\s*['"]scored['"][\s\S]*setStatus\(freshQueue, role\.id, ['"]prepare-queued['"]\)/.test(run)) {
      errors.push(issue(file, 'Run API does not persist checkbox-selected scored roles into PREPARE'));
    }
  }
  const stage = functionBody(source, 'apiRoleStage');
  if (!stage ||
      !/action:\s*['"]stage-prepare['"]/.test(stage) ||
      !/recordCandidateSelectionConfirmation\s*\(/.test(stage) ||
      stage.indexOf('consumeSelectionConfirmation') > stage.indexOf('setStatus(queue, id, target)')) {
    errors.push(issue(file, 'PREPARE drag is not bound to the same one-use candidate selection boundary'));
  }
  const selectionEndpoint = functionBody(source, 'apiSelectionConfirmation');
  if (!selectionEndpoint ||
      !/SELECTION_CONFIRMATION_PHRASE/.test(selectionEndpoint) ||
      !/selectionConfirmations\.issue\s*\(/.test(selectionEndpoint) ||
      !/MAX_ACTIVE_APPLICATION_REQUESTS/.test(selectionEndpoint)) {
    errors.push(issue(file, 'selection confirmation endpoint is missing explicit candidate confirmation or max-four role binding'));
  }
  const threshold = functionBody(source, 'apiSetThreshold');
  if (!threshold) {
    errors.push(issue(file, 'apiSetThreshold function is missing'));
  } else {
    if (!/queue\.settings\.score_threshold\s*=\s*threshold/.test(threshold)) {
      errors.push(issue(file, 'threshold endpoint does not persist the selection/filter preference'));
    }
    if (!/selection_unchanged\s*:\s*true/.test(threshold)) {
      errors.push(issue(file, 'threshold endpoint does not declare that role selection is unchanged'));
    }
    for (const [description, pattern] of [
      ['role collection access', /queue\.roles/],
      ['role status mutation', /\brole\.status\s*=/],
      ['candidate-selection override', /recordCandidateSelectionOverride\s*\(/],
      ['status transition', /\bsetStatus\s*\(/],
      ['prepare queue promotion', /prepare-queued/],
    ]) {
      if (pattern.test(threshold)) {
        errors.push(issue(file, `threshold endpoint contains forbidden ${description}`));
      }
    }
  }
  if (/\bspawn\s*\(|form-fill\.mjs|launchPersistentContext|\bchromium\b/i.test(source)) {
    errors.push(issue(file, 'dashboard still contains a private browser/form-fill execution path'));
  }
  return errors;
}

export function checkMergeTrackerRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['Hired canonical-state support', /CANONICAL_STATES\s*=\s*\[[^\]]*['"]Hired['"]/s],
    ['complete lifecycle import boundary', /LIFECYCLE_STATES\s*=\s*new Set\(\[[^\]]*['"]Applied['"][^\]]*['"]Responded['"][^\]]*['"]Interview['"][^\]]*['"]Offer['"][^\]]*['"]Hired['"][^\]]*['"]Rejected['"]/s],
    ['explicit external-import flag', /process\.argv\.includes\(['"]--external-import['"]\)/],
    ['explicit historical-import flag', /process\.argv\.includes\(['"]--historical-import['"]\)/],
    ['Evaluated lifecycle staging', /function stageLifecycleStatus[\s\S]*addition\.requestedLifecycleStatus\s*=\s*addition\.status[\s\S]*addition\.status\s*=\s*['"]Evaluated['"]/],
    ['canonical lifecycle promotion', /['"]set-status\.mjs['"][\s\S]*promotion\.status[\s\S]*['"]--external['"]/],
    ['durable tracker-import provenance', /\[tracker-import:\$\{IMPORT_PROVENANCE\}\]/],
    ['monotonic PDF metadata upgrade', /pdfUpgrade\s*=\s*sanitizeCell\(addition\.pdf\)\s*===\s*['"]✅['"][\s\S]*sanitizeCell\(duplicate\.pdf\)\s*!==\s*['"]✅['"]/],
    ['exact report identity for PDF metadata upgrade', /pdfUpgrade[\s\S]*sameReportIdentity\(addition\.report,\s*duplicate\.report\)/],
    ['same-or-higher score boundary for PDF metadata upgrade', /pdfUpgrade[\s\S]*\(scoreUpgrade\s*\|\|\s*newScore\s*===\s*oldScore\)/],
    ['duplicate lifecycle preservation during metadata updates', /status:\s*duplicate\.status[\s\S]*pdf:\s*pdfUpgrade\s*\?\s*['"]✅['"]\s*:\s*duplicate\.pdf/],
  ]);
  const release = source.indexOf('trackerLock.release();');
  const promotion = source.indexOf("join(CAREER_OPS, 'set-status.mjs')");
  if (release < 0 || promotion < 0 || promotion < release) {
    errors.push(issue(file, 'lifecycle promotion does not run after the merge tracker lock is released'));
  }
  const move = source.indexOf("renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file))");
  if (promotion < 0 || move < 0 || move < promotion) {
    errors.push(issue(file, 'TSV imports are archived before canonical lifecycle promotion succeeds'));
  }
  return errors;
}

export function checkDashboardClient(file, source) {
  const errors = [];
  const threshold = functionBody(source, 'setThreshold');
  if (!threshold) return [issue(file, 'setThreshold function is missing')];
  if (!/(?:fetch|postJson)\(\s*['"]\/api\/threshold['"]/.test(threshold)) {
    errors.push(issue(file, 'threshold control does not persist through the canonical endpoint'));
  }
  if (!/no roles were queued or changed/i.test(threshold)) {
    errors.push(issue(file, 'threshold UI does not explain that role selection remains unchanged'));
  }
  for (const [description, pattern] of [
    ['auto-queue result counter', /data\.flipped/],
    ['auto-queue claim', /roles?\)?\s+queued for prepare|roles? were queued for prepare/i],
  ]) {
    if (pattern.test(threshold)) errors.push(issue(file, `threshold UI contains stale ${description}`));
  }
  if (!/Requires active-agent L3 completion; candidate input is not requested/.test(source)) {
    errors.push(issue(file, 'legacy unresolved-field lane does not explicitly assign completion to agent L3'));
  }
  if (/title=["']Has unresolved custom\/manual fields["']|>⚠ needs input</.test(source)) {
    errors.push(issue(file, 'dashboard still presents novel fields as candidate/manual input'));
  }
  const dropAction = functionBody(source, 'dropActionFor');
  if (!dropAction || !/roleStatus\s*===\s*['"]filled['"][\s\S]*return null/.test(dropAction)) {
    errors.push(issue(file, 'dashboard drag client does not preserve receipt-gated filled roles'));
  }
  if (!/application-receipt\.mjs --repair-filled/.test(source)) {
    errors.push(issue(file, 'dashboard drag client does not direct corrupt filled rows through canonical repair'));
  }
  if (!/csrfToken\s*=\s*data\.csrf_token/.test(source) || !/X-Career-Ops-CSRF/.test(source)) {
    errors.push(issue(file, 'dashboard client does not bind mutations to the server-issued CSRF token'));
  }
  if (!/function requestSubmittedDecision\s*\(/.test(source) ||
      !/submission-confirmation/.test(source) ||
      !/confirmation_nonce/.test(source)) {
    errors.push(issue(file, 'dashboard client can mark submitted without the explicit nonce confirmation flow'));
  }
  const candidateSelection = functionBody(source, 'requestCandidateSelection');
  const startRun = functionBody(source, 'startRun');
  const fill = functionBody(source, 'doFill');
  const drop = functionBody(source, 'handleDrop');
  if (!candidateSelection ||
      !/\/api\/selection-confirmation/.test(candidateSelection) ||
      !/confirmToast\s*\(/.test(candidateSelection) ||
      !/selection_confirmation_nonce/.test(source) ||
      !/selection_intent_id/.test(source)) {
    errors.push(issue(file, 'dashboard client lacks the explicit one-use candidate role-selection confirmation flow'));
  }
  if (!/requestCandidateSelection\s*\(/.test(startRun) ||
      !/requestCandidateSelection\s*\(/.test(fill) ||
      !/['"]stage-prepare['"]/.test(drop) ||
      !/selectionConfirmationBody\s*\(confirmation\)/.test(source)) {
    errors.push(issue(file, 'bulk Run, single/keyboard Fill, or PREPARE drag can bypass candidate selection intent binding'));
  }
  return errors;
}

export function checkRetiredPrepareApplication(file, source) {
  const errors = requirePatterns(file, source, [
    ['retired tombstone marker', /PREPARE_APPLICATION_RETIRED\s*=\s*true/],
    ['canonical active-agent redirect', /active agent owns the browser|active-agent browser controller/i],
    ['fail-closed exit', /process\.exitCode\s*=\s*2/],
  ]);
  for (const [description, pattern] of [
    ['ATS field-map implementation', /build(?:Greenhouse|Ashby|Lever)Fields|detectAts\s*\(/],
    ['profile data reader', /config\/profile\.yml|readProfile\s*\(/],
    ['manual application handoff', /fill the form[^.\n]*(?:then )?submit/i],
  ]) {
    if (pattern.test(source)) errors.push(issue(file, `retired entrypoint still contains ${description}`));
  }
  return errors;
}

export function checkApplicationScriptEntrypoints(root) {
  const errors = [];
  const pkgFile = 'package.json';
  const pkgSource = readRequired(root, pkgFile, errors);
  if (pkgSource) {
    let pkg;
    try { pkg = JSON.parse(pkgSource); } catch (err) {
      errors.push(issue(pkgFile, `invalid JSON: ${err.message}`));
    }
    if (pkg) {
      if (pkg.scripts?.['prepare:application']) {
        errors.push(issue(pkgFile, 'exposes retired prepare-application workflow'));
      }
      if (pkg.scripts?.fill) {
        errors.push(issue(pkgFile, 'exposes ambiguous legacy fill command'));
      }
      if (pkg.scripts?.['apply:plan'] !== 'node form-fill.mjs') {
        errors.push(issue(pkgFile, 'missing offline-only apply:plan compatibility command'));
      }
    }
  }

  const updaterFile = 'update-system.mjs';
  const updaterSource = readRequired(root, updaterFile, errors);
  if (updaterSource && !/Fail-closed tombstone[\s\S]{0,160}['"]prepare-application\.mjs['"]/.test(updaterSource)) {
    errors.push(issue(updaterFile, 'does not ship the fail-closed prepare-application tombstone'));
  }
  return errors;
}

export function checkReceiptRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['reviewReadinessErrors export', /export function reviewReadinessErrors\s*\(/],
    ['submissionReadinessErrors export', /export function submissionReadinessErrors\s*\(/],
    ['candidate-confirmed report promotion', /export function markApplicationReportSubmitted\s*\(/],
    ['candidate-confirmed report rollback', /export function rollbackApplicationReportSubmission\s*\(/],
    ['finalizeRole export', /export function finalizeRole\s*\(/],
    ['review-ready flag', /review_ready/],
    ['structured preflight evidence gate', /cleanPreflightEvidence/],
    ['bare preflight boolean rejection', /bare verification booleans are not accepted/],
    ['receipt-only filled promotion', /setStatus\([^;]+,\s*['"]filled['"]\s*\)/],
    ['Application Answers persistence gate', /application_answers_report/],
    ['exact Application Answers section parser', /parseApplicationAnswersSection\(source\)/],
    ['full per-control report metadata requirement', /requiredEntryMetadata\s*=\s*\[[\s\S]*'page_index'[\s\S]*'control_id'[\s\S]*'occurrence'[\s\S]*'review_note'/],
    ['exact per-control report comparison', /comparedProperties\s*=\s*\[[\s\S]*'resolution'[\s\S]*'provenance'[\s\S]*'taught'[\s\S]*'review_required'[\s\S]*'review_note'/],
    ['duplicate-consumed report entry rejection', /Application Answers duplicate-consumed field entry/],
    ['unexpected extra report entry rejection', /Application Answers contains an unexpected extra field entry/],
    ['final attachment gate', /assets_verified/],
    ['exact per-field answer ledger', /fields length must equal field_count/],
    ['tamper-evident page fingerprint', /fingerprintForPage/],
    ['executable resolver evidence gate', /validateResolverEvidence/],
    ['resolver snapshot binding', /resolver evidence snapshot_digest/],
    ['stable browser control identity', /control_id/],
    ['unique per-page browser control identity', /field control_id values must be unique within a page/],
    ['structured browser observation gate', /cleanBrowserObservation/],
    ['before/rescan/after observation order', /before → rescan → after/],
    ['populated answer digest gate', /browser populated manifest does not match every receipted answer/],
    ['zero-field final-review restriction', /zero-field receipt is allowed only for an evidenced final review page/],
    ['final submit-boundary observation', /final review receipt requires an observed submit boundary/],
    ['resolver evidence consumption', /delete progress\.pending_resolver_evidence/],
    ['finalizer-owned report state', /replaceApplicationAnswersState[\s\S]*'prefilled'[\s\S]*'filled'/],
    ['role-bound attachment verification', /assertRoleAttachments/],
    ['live upload-control manifest', /cleanUploadControls/],
    ['content-hash-bound attachments', /asset_sha256/],
    ['cover-compatible upload coverage', /cover-compatible upload control was observed but no verified cover letter was attached/],
    ['durable finalization transaction', /stageApplicationFinalization/],
    ['idempotent finalization crash recovery', /export function recoverStagedFinalizationArtifacts/],
    ['handover persistence verification', /handover compliance receipt was not persisted/],
    ['dashboard request authorization gate', /applicationRequestForRun\([\s\S]{0,160}payload\.run_id[\s\S]{0,80}['"]queued['"][\s\S]{0,80}requestedControllerId/],
    ['explicit browser controller binding', /controller_id:\s*controllerId/],
    ['queue-wide controller/tab lease gate', /assertControllerQueueLease\(queue, role, controllerId, tabId\)/],
    ['four-role application concurrency cap', /MAX_ACTIVE_APPLICATION_REQUESTS\s*=\s*4/],
    ['request-to-progress binding', /application_request_id:\s*request\.request_id/],
    ['request in-progress transition', /request\.state\s*=\s*['"]in-progress['"]/],
    ['finalization request-state gate', /applicationRequestForRun\([\s\S]{0,120}progress\.run_id[\s\S]{0,80}['"]in-progress['"][\s\S]{0,80}progress\.controller_id/],
    ['request review-ready transition', /request\.state\s*=\s*['"]review-ready['"]/],
    ['begin-time full asset quality gate', /const assetQualityEvidence\s*=\s*createApplicationQualityEvidence\(role/],
    ['finalize-time asset evidence validation', /validateApplicationQualityEvidence\(role,\s*progress\.asset_quality_evidence/],
    ['finalize-time full asset quality rerun', /const refreshedAssetQualityEvidence\s*=\s*createApplicationQualityEvidence\(role/],
    ['invalid filled receipt repair command', /export function repairFilledRole\s*\(/],
    ['production evidence path redirect guard', /is test-only and cannot redirect production application evidence/],
    ['file-derived evidence protocol stamp', /evidence_protocol:\s*['"]v3['"]/],
    ['file-derived capture stamp', /evidence_capture:\s*(?:evidenceCapture|FILE_DERIVED_CAPTURE|['"]file-derived['"])/],
    ['snapshot-file evidence marker gate', /SNAPSHOT_FILE_CAPTURE|capture !== SNAPSHOT_FILE_CAPTURE/],
    ['verification fallback finalize block', /verification_fallback/],
  ]);
  const finalize = functionBody(source, 'finalizeRole');
  if (finalize) {
    const staged = finalize.indexOf('stageApplicationFinalization(roleId, payload)');
    const recovered = finalize.indexOf('recoverStagedFinalizationArtifacts(staged.transaction)');
    const sideEffectsOwned = finalize.indexOf('finalizedInMemory = true');
    const protectedStatus = finalize.indexOf("setStatus(queue, roleId, 'filled')");
    if (staged < 0 || recovered < 0 || staged > recovered || recovered > sideEffectsOwned) {
      errors.push(issue(file, 'finalizeRole does not stage and recover its durable transaction before filesystem side effects'));
    }
    if (sideEffectsOwned < 0 || protectedStatus < 0 || sideEffectsOwned > protectedStatus) {
      errors.push(issue(file, 'finalizeRole does not arm report/handover rollback before the protected status transition'));
    }
  }
  return errors;
}

export function checkApplicationAnswersRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['prefilled-only CLI authoring state', /CLI_AUTHORABLE_STATE\s*=\s*['"]prefilled['"]/],
    ['non-prefilled authoring rejection', /normalized\.state\s*!==\s*CLI_AUTHORABLE_STATE/],
    ['canonical section locator', /export function locateApplicationAnswersSection\s*\(/],
    ['structured section parser', /export function parseApplicationAnswersSection\s*\(/],
    ['receipt page metadata formatter', /`- Page index: \$\{pageIndex\}`/],
    ['stable control metadata formatter', /`- Control ID: \$\{controlId\}`/],
    ['duplicate-label occurrence formatter', /`- Occurrence: \$\{occurrence\}`/],
    ['teach metadata formatter', /`- Taught: \$\{taught \? 'yes' : 'no'\}`/],
    ['explicit empty review-note formatter', /`- Review note: \$\{reviewNote \|\| '\(none\)'\}`/],
    ['attachment-section parser boundary', /FIELD_SECTION_NAMES/],
  ]);
  if (/--state prefilled\|(?:filled\|)?submitted/.test(source)) {
    errors.push(issue(file, 'CLI usage still advertises direct filled/submitted report authoring'));
  }
  const main = functionBody(source, 'main');
  const gate = main.indexOf('normalized.state !== CLI_AUTHORABLE_STATE');
  const write = main.indexOf('writeFileSync(reportPath');
  if (gate < 0 || write < 0 || gate > write) {
    errors.push(issue(file, 'prefilled-only lifecycle gate does not execute before the report write'));
  }
  return errors;
}

export function checkCanonicalApplyMode(file, source) {
  const errors = requirePatterns(file, source, [
    ['single Workflow section', /^## Workflow\s*$/m],
    ['queue role-ID step', /^## Step 3 — Match or create the queue record\s*$/m],
    ['lean-llm-v1 default', /lean-llm-v1/],
    ['per-page lookup', /apply-page\.mjs lookup/],
    ['L3 completion', /Generate and fill every novel field now \(L3\)/],
    ['lean page-done barrier', /apply-page\.mjs page-done|Record page-done/i],
    ['lean begin', /apply-page\.mjs begin/],
    ['lean finish', /apply-page\.mjs finish/],
    ['lean prefilled completion', /`prefilled`|queue status prefilled|status\s+`?prefilled`?/i],
    ['stable browser control identity', /`control_id`/],
    ['combined review', /^## Step 9 — Present one combined review\s*$/m],
    ['candidate-only submission', /candidate reviews and submits; the agent never clicks a final/i],
    ['non-Playwright draft-only boundary', /Without Playwright[\s\S]{0,360}draft-only checkpoint[\s\S]{0,360}Do not transfer transcription or unfinished live filling/i],
    ['hands-off hidden-employer duplicate handling', /If an agency hides the end employer[\s\S]{0,620}do not stop the batch to ask for[\s\S]{0,80}client name or another authorization/i],
    ['sign-in registration-route scan', /Sign-in form \+ no exact-host credential[\s\S]{0,420}Register[\s\S]{0,80}Create account[\s\S]{0,80}Sign up/i],
    ['registration-route reclassification', /registration route is visible[\s\S]{0,420}classify the resulting page again/i],
    ['existing-account duplicate guard', /candidate has already said[\s\S]{0,220}have an account[\s\S]{0,220}do not create another one/i],
    ['manual-login fallback boundary', /If no registration route is visible[\s\S]{0,300}signed in manually/i],
    ['rejected-login no-overwrite boundary', /Rejected stored credential[\s\S]{0,420}Never create a duplicate[\s\S]{0,120}overwrite the\s+credential/i],
    ['historical receipt-v3 appendix', /receipt-v3|Historical receipt/i],
  ]);
  const workflowCount = (source.match(/^## Workflow\s*$/gm) || []).length;
  if (workflowCount !== 1) errors.push(issue(file, `expected one canonical Workflow section, found ${workflowCount}`));
  if (/^## Step 7b\b/m.test(source)) errors.push(issue(file, 'contains a late Step 7b teach section outside the per-page loop'));
  const ordered = [
    '## Step 1 — Detect the job',
    '## Step 2 — Identify the role',
    '## Step 3 — Match or create the queue record',
    '## Step 4 — Search and load context',
    '## Step 5 — Preflight gate',
    '## Step 5b — Pre-scan for knock-out questions',
    '## Step 6 — Analyze and resolve form fields (per page)',
    '## Step 7 — Final review gate',
    '## Step 8 — Persist application snapshot',
    '## Step 9 — Present one combined review',
    '## Step 10 — Post-apply (only after candidate confirmation)',
  ];
  let previous = -1;
  for (const heading of ordered) {
    const current = source.indexOf(heading);
    if (current < 0 || current <= previous) {
      errors.push(issue(file, `canonical step is missing or out of order: ${heading}`));
      break;
    }
    previous = current;
  }
  return errors;
}

export function checkQueueMode(file, source) {
  const errors = requirePatterns(file, source, [
    ['lock-protected queue mutation contract', /commit each logical change through the[\s\S]{0,120}`mutateQueue\(\)` path/i],
    ['explicit selection after threshold filtering', /threshold only as a dashboard filter\/setting, explicitly select the roles/i],
    ['dashboard request-only boundary', /dashboard Fill\/Run action queues a durable `application_request`/i],
    ['lean or receipt finalizer boundary', /apply-page\.mjs finish|application-receipt\.mjs --finalize|lean-llm-v1/i],
  ]);
  for (const [description, pattern] of [
    ['threshold-driven prepare instruction', /set threshold and prepare/i],
    ['unlocked queue-file write instruction', /Write the updated queue file/i],
  ]) {
    if (pattern.test(source)) errors.push(issue(file, `contains forbidden ${description}`));
  }
  return errors;
}

export function checkCustomApplyContract(file, source) {
  return requirePatterns(file, source, [
    [
      'mandatory six-file current-contract read',
      /read all six current contracts:[\s\S]{0,280}`modes\/_shared\.md`[\s\S]{0,120}`modes\/apply\.md`[\s\S]{0,120}`modes\/_custom\.md`[\s\S]{0,120}`apply-page\.mjs`[\s\S]{0,120}`queue-resolve\.mjs`[\s\S]{0,120}`application-receipt\.mjs`/i,
    ],
    ['fill-every-question rule', /There are no "unsupported" form questions/],
    ['exact-host account state machine', /exact host has no stored entry[\s\S]{0,500}create the account/i],
    ['sign-in registration-route override', /Before parking for human login[\s\S]{0,180}Register \/ Create account \/ Sign up controls/i],
    ['visible registration-route follow', /no exact-host credential exists and a Register path is visible[\s\S]{0,180}follow Register and create the account/i],
    ['park-and-continue login behavior', /parked while the controller continues the other roles/i],
    ['one-browser-controller concurrency rule', /one browser-controller owns all live tabs/i],
    ['all-run hands-off duplicate route decision', /Duplicate handling \(all authorized runs\)[\s\S]{0,520}without an intermediate prompt/i],
    ['lean finish path', /apply-page\.mjs begin[\s\S]*apply-page\.mjs (?:page-done|finish)|lean-llm-v1[\s\S]{0,200}prefilled/i],
    ['receipt-only filled promotion', /only path allowed to promote[\s\S]{0,180}review-ready `filled`/],
  ]);
}

export function checkQueueStoreRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['mutateQueue transaction helper', /export function mutateQueue/],
    ['queue filesystem lock', /QUEUE_LOCK_PATH/],
    ['fail-closed invalid JSON', /refusing to treat an existing store as empty/],
    ['receipt-gated filled status', /status === ['"]filled['"][\s\S]{0,700}finalized review-ready application receipt/],
  ]);
  const dragStart = source.indexOf('const STAGE_DRAG_TARGETS');
  const dragEnd = source.indexOf('// The only stages a drag may legally target', dragStart);
  const dragTable = dragStart >= 0 && dragEnd > dragStart
    ? source.slice(dragStart, dragEnd)
    : '';
  if (!dragTable) {
    errors.push(issue(file, 'stage drag transition table is missing'));
  } else if (/\bfilled\s*:/.test(dragTable)) {
    errors.push(issue(file, 'receipt-gated filled can be demoted by a bare dashboard drag'));
  }
  return errors;
}

export function checkConcurrentStores(root) {
  const errors = [];
  const queueStore = readRequired(root, 'queue-store.mjs', errors);
  errors.push(...checkQueueStoreRuntime('queue-store.mjs', queueStore));
  const resolver = readRequired(root, 'queue-resolve.mjs', errors);
  errors.push(...requirePatterns('queue-resolve.mjs', resolver, [
    ['run/page-bound lookup evidence', /pending_resolver_evidence/],
    ['teach evidence fingerprint', /teach_fingerprint/],
    ['lookup evidence fingerprint', /lookup_fingerprint/],
    ['snapshot digest lookup envelope', /snapshot_digest:\s*requiredDigest\(payload\.snapshot_digest/],
    ['lookup observation timestamp', /observed_at:\s*requiredTimestamp\(payload\.observed_at/],
    ['stable control IDs', /control_id:\s*requiredText\(field\.control_id/],
    ['unique live control IDs', /control_id must be unique within a page/],
  ]));
  errors.push(...checkQueueResolverRuntime('queue-resolve.mjs', resolver));
  for (const file of [
    'dashboard-server.mjs', 'form-fill.mjs', 'queue-resolve.mjs',
    'application-receipt.mjs', 'generation-provenance.mjs',
    'queue-ingest.mjs', 'queue-sweep.mjs',
  ]) {
    const source = readRequired(root, file, errors);
    if (/\bsaveQueue\s*\(/.test(source)) {
      errors.push(issue(file, 'writes a potentially stale whole-queue snapshot instead of mutateQueue'));
    }
  }
  for (const [file, pattern, description] of [
    ['answer-cache.mjs', /export function mutateCache/, 'answer-cache mutation lock'],
    ['screener-store.mjs', /export function mutateScreenerStore/, 'screener-store mutation lock'],
    ['credentials-store.mjs', /refusing account creation\/login/, 'fail-closed credential corruption guard'],
  ]) {
    const source = readRequired(root, file, errors);
    if (!pattern.test(source)) errors.push(issue(file, `missing ${description}`));
  }
  return errors;
}

export function checkCredentialRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['policy-aware random password generator', /export function generatePassword\(policy = \{\}\)/],
    ['displayed min/max length constraints', /minLength[\s\S]*maxLength/],
    ['displayed allowed-symbol constraint', /allowedSymbols/],
    ['DOM\/HTML pattern constraint', /compilePolicyPattern\(firstDefined\(policy,\s*\[['"]pattern['"],\s*['"]htmlPattern['"]/],
    ['password-policy verifier', /export function passwordMeetsPolicy\s*\(/],
    [
      'accepted-registration credential commit API',
      /export function commitAcceptedRegistrationCredentials\s*\(/,
    ],
    ['registration evidence v2', /REGISTRATION_ACCEPTANCE_EVIDENCE_VERSION\s*=\s*2/],
    ['durable registration observation binding API', /export function bindAcceptedRegistrationObservation\s*\(/],
    ['active dashboard request binding', /application_request_id[\s\S]*run_id[\s\S]*controller_id[\s\S]*tab_id/],
    ['Playwright registration observation source', /observation_source\s*!==\s*['"]playwright-mcp['"]/],
    ['durable queue validation before credential commit', /readRegistrationQueueSnapshot\s*\(/],
    ['exact-host registration acceptance binding', /registrationUrl\.host[\s\S]*exactHost/],
    ['final-application evidence exclusion', /application_submission_detected\s*!==\s*false/],
    ['existing exact-host credential overwrite denial', /Exact-host credentials already exist; refusing overwrite/],
    [
      'rejected-password exclusion constraint',
      /rejectedPasswords:\s*new Set\(stringList\(\s*firstDefined\(policy,\s*\[['"]rejectedPasswords['"],\s*['"]rejected_passwords['"]/,
    ],
    ['cryptographic randomness', /randomBytes\s*\(/],
  ]);
  const generate = functionBody(source, 'generatePassword');
  if (!generate) errors.push(issue(file, 'generatePassword function is missing'));
  if (generate) {
    const normalize = generate.indexOf('normalizePasswordPolicy(policy)');
    const candidate = generate.indexOf('candidateForPolicy(normalized)');
    const validate = generate.indexOf('passwordPolicyErrorsNormalized(candidate, normalized)');
    if (normalize < 0 || candidate < normalize || validate < candidate) {
      errors.push(issue(file, 'password generation does not normalize and verify displayed policy constraints'));
    }
  }
  for (const [name, body] of [['generatePassword', generate]]) {
    if (/\b(?:loadStore|saveStore|getCredentials|upsertCredentials)\s*\(/.test(body)) {
      errors.push(issue(file, `${name} reads or persists the credential store before portal acceptance`));
    }
  }
  const commit = functionBody(source, 'commitAcceptedRegistrationCredentials');
  if (!commit) {
    errors.push(issue(file, 'accepted-registration credential commit function is missing'));
  } else {
    const evidence = commit.indexOf('validateAcceptedRegistrationEvidence(');
    const storeLock = commit.indexOf('withStoreLock(');
    const save = commit.indexOf('saveStore(');
    if (evidence < 0 || storeLock < evidence || save < storeLock) {
      errors.push(issue(
        file,
        'credentials can persist before exact-host registration acceptance is validated',
      ));
    }
    if (!/portal_host:\s*exactHost/.test(commit) || !/portal_key:\s*key/.test(commit)) {
      errors.push(issue(
        file,
        'credential commit metadata does not distinguish the exact host from the tenant-qualified portal key',
      ));
    }
  }
  const validateEvidence = functionBody(source, 'validateAcceptedRegistrationEvidence');
  if (!validateEvidence) {
    errors.push(issue(file, 'accepted-registration queue validation function is missing'));
  } else {
    const normalize = validateEvidence.indexOf('acceptedRegistrationEvidence(');
    const queue = validateEvidence.indexOf('readRegistrationQueueSnapshot()');
    const bind = validateEvidence.indexOf('registrationQueueBinding(queue, accepted)');
    if (normalize < 0 || queue < normalize || bind < queue) {
      errors.push(issue(
        file,
        'accepted registration evidence is not independently bound to the durable queue before commit',
      ));
    }
  }
  const bindObservation = functionBody(source, 'bindAcceptedRegistrationObservation');
  if (!bindObservation ||
      bindObservation.indexOf('registrationQueueBinding(') < 0 ||
      bindObservation.indexOf('registration_acceptance =') <
        bindObservation.indexOf('registrationQueueBinding(')) {
    errors.push(issue(file, 'secret-free registration observation is not queue-bound before persistence'));
  }
  const upsert = functionBody(source, 'upsertCredentials');
  if (!upsert || !/commitAcceptedRegistrationCredentials\s*\(/.test(upsert)) {
    errors.push(issue(file, 'legacy upsert does not delegate to the accepted-registration commit gate'));
  }
  return errors;
}

export function checkApplicationSafetyRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['plain Submit registration label', /REGISTRATION_CONFIRM_ACTION[\s\S]*submit/],
    ['conclusive registration evidence helper', /export function isConclusiveRegistrationContext\s*\(/],
    ['registration-form classification evidence', /classification === ['"]registration-form['"]/],
    ['visible registration intent evidence', /registrationIntentVisible === true/],
    ['identity and password field evidence', /identityFieldVisible === true[\s\S]*passwordFieldVisible === true/],
    ['known absence of application form', /applicationFormVisible === false/],
    ['authoritative application-submit signal', /applicationSubmissionDetected/],
  ]);
  const decision = functionBody(source, 'applicationActionDecision');
  if (!decision) return errors.concat(issue(file, 'applicationActionDecision function is missing'));
  const finalGuard = decision.indexOf("applicationSubmissionDetected || phase === 'application-submit'");
  const registration = decision.indexOf("phase === 'registration'");
  const registrationFinalDeny = decision.indexOf('FINAL_APPLICATION_ACTION.test(label)', registration);
  const evidence = decision.indexOf('isConclusiveRegistrationContext(registrationEvidence)', registration);
  const allow = decision.indexOf('REGISTRATION_CONFIRM_ACTION.test(label)', registration);
  if (finalGuard < 0) {
    errors.push(issue(file, 'applicationActionDecision is missing the authoritative application-submit signal guard'));
  }
  if (registration < 0 || (finalGuard >= 0 && registration < finalGuard) ||
      registrationFinalDeny < registration ||
      evidence < registrationFinalDeny || allow < evidence) {
    errors.push(issue(
      file,
      'registration actions are not ordered behind the final-submit guard, job-label deny, and conclusive evidence gate',
    ));
  }
  return errors;
}

export function checkCredentialAndActionSafety(root) {
  const errors = [];
  const credentialsFile = 'credentials-store.mjs';
  const credentials = readRequired(root, credentialsFile, errors);
  if (credentials) errors.push(...checkCredentialRuntime(credentialsFile, credentials));
  const safetyFile = 'application-safety.mjs';
  const safety = readRequired(root, safetyFile, errors);
  if (safety) errors.push(...checkApplicationSafetyRuntime(safetyFile, safety));
  return errors;
}

export function checkQueueResolverRuntime(file, source) {
  const errors = [];
  const live = functionBody(source, 'liveTeach');
  if (!live) return [issue(file, 'liveTeach function is missing')];

  for (const [description, pattern] of [
    ['detached queue staging', /const workingQueue = structuredClone\(before\)/],
    ['detached cache staging', /const stagedCache = structuredClone\(cache \?\? loadCache\(\)\)/],
    ['detached screener staging', /const stagedStore = structuredClone\(store \?\? loadStore\(\)\)/],
    ['non-persisting staged teach', /teachAnswers\(roleId,[\s\S]*queue:\s*workingQueue,[\s\S]*cache:\s*stagedCache,[\s\S]*store:\s*stagedStore,[\s\S]*includeLearningPlan:\s*true/],
  ]) {
    if (!pattern.test(live)) errors.push(issue(file, `live teach is missing ${description}`));
  }

  const queueCommit = live.indexOf('mutateQueue((freshQueue)');
  const freshValidation = live.indexOf('assertPendingEvidence(freshRole, envelope)');
  const draftCommit = live.indexOf('copyStagedTeachDrafts(freshRole, stagedRole, teachItems)');
  const evidenceSeal = live.indexOf('freshEvidence.teach =');
  const crossRoleLearning = live.indexOf('persistCommittedTeachLearning(');
  if (queueCommit < 0 || freshValidation < queueCommit || draftCommit < freshValidation ||
      evidenceSeal < draftCommit || crossRoleLearning < evidenceSeal) {
    errors.push(issue(file, 'live teach does not atomically revalidate evidence, commit drafts, seal evidence, then learn cross-role'));
  }
  if (/\b(?:mutateCache|mutateScreenerStore)\s*\(/.test(live)) {
    errors.push(issue(file, 'liveTeach writes a cross-role store before its queue evidence commit'));
  }

  const learning = functionBody(source, 'persistCommittedTeachLearning');
  if (!learning || !/mutateCache\(applyCache\)/.test(learning) ||
      !/mutateScreenerStore\(applyScreeners\)/.test(learning) ||
      /\b(?:mutateQueue|teachAnswers)\s*\(/.test(learning)) {
    errors.push(issue(file, 'post-commit reusable learning is not isolated from queue persistence'));
  }
  return errors;
}

export function checkTrackerDeleteRuntime(file, source) {
  const errors = requirePatterns(file, source, [
    ['shared tracker lock import', /import\s*\{[^}]*acquireTrackerLock[^}]*trackerLockDirFor[^}]*writeFileAtomic[^}]*\}\s*from\s*['"]\.\/tracker-utils\.mjs['"]/s],
  ]);
  if (/function\s+writeFileAtomic\s*\(/.test(source)) {
    errors.push(issue(file, 'tracker delete keeps a private atomic writer instead of the shared tracker writer'));
  }
  const deletion = functionBody(source, 'deleteApp');
  if (!deletion) return errors.concat(issue(file, 'deleteApp function is missing'));
  const lock = deletion.indexOf('acquireTrackerLock(');
  const read = deletion.indexOf('readFileSync(MD_PATH');
  const write = deletion.indexOf('writeFileAtomic(MD_PATH');
  const release = deletion.indexOf('lock?.release()');
  if (lock < 0 || read < lock || write < read || release < write) {
    errors.push(issue(file, 'tracker delete does not hold the shared lock across read/remove/atomic-write'));
  }
  if (!/finally\s*\{[\s\S]*lock\?\.release\(\)/.test(deletion)) {
    errors.push(issue(file, 'tracker delete does not release the shared lock in finally'));
  }
  if (/process\.exit\s*\(/.test(deletion)) {
    errors.push(issue(file, 'tracker delete can bypass lock cleanup with process.exit'));
  }
  return errors;
}

export function checkWebPdfWorkerRuntime(file, source) {
  const errors = [];
  const pdf = /if \(kind === ["']pdf["']\) \{([\s\S]*?)\n\s*\}\n\s*if \(kind === ["']fix-portal["']\)/.exec(source)?.[1] ?? '';
  if (!pdf) return [issue(file, 'headless PDF worker prompt is missing')];
  // #2172/#2185: the agent tailors CONTENT only and runs with no write tool at
  // all — a prompt injection in the posting or report lands in its context, and
  // tool grants are tool-name-only, so any Write/Edit it held would be unscoped.
  // The platform (a plain Node child process, no CLI sandbox) writes the HTML,
  // renders the PDF, and flips the tracker's PDF column through the canonical
  // locked writer. So the prompt must delegate output explicitly and must never
  // hand the agent a tracker write of ANY shape — canonical CLI or hand-edit.
  if (!/platform writes the HTML, renders the PDF, and updates the tracker's PDF column itself, only after a confirmed successful render/i.test(pdf)) {
    errors.push(issue(file, 'headless PDF worker does not delegate output and PDF-ready metadata to the platform'));
  }
  if (/node\s+(?:set-status|mark-pdf-ready)\.mjs/.test(pdf)) {
    errors.push(issue(file, 'headless PDF worker prompt hands the agent a tracker metadata write'));
  }
  if (/in data\/applications\.md,\s*change the PDF column/i.test(pdf) ||
      /(?:edit|change|replace)[^\n]{0,80}(?:PDF column|PDF cell)[^\n]{0,80}applications\.md/i.test(pdf)) {
    errors.push(issue(file, 'headless PDF worker instructs a direct applications.md metadata edit'));
  }
  return errors;
}

export function checkPeripheralContractSurfaces(root) {
  const errors = [];
  const surfaces = [
    {
      file: 'config/profile.yml',
      userLayer: true,
      patterns: [['single headed browser controller', /one headed browser controller serializes all live tabs/]],
      forbidden: [['parallel headless live fills', /parallel headless fills/i]],
    },
    {
      file: 'modes/_profile.md',
      userLayer: true,
      patterns: [
        ['threshold is only a filter/recommendation', /dashboard filter\/recommendation floor, not[\s\S]{0,60}auto-selection rule/i],
        ['explicit selection is required', /explicitly[\s\S]{0,30}selects every role/i],
      ],
    },
    {
      file: 'modes/pipeline.md',
      patterns: [['expired tracker rows use canonical writer', /set-status\.mjs <tracker#\|company> Discarded/]],
    },
    {
      file: 'CONTRIBUTING.md',
      patterns: [['candidate-only final submission', /candidate alone clicks the final submit control/i]],
      forbidden: [['review-only auto-submit boundary', /enable auto-submitting applications[^\n]*without human review/i]],
    },
    {
      file: 'LEGAL_DISCLAIMER.md',
      patterns: [['candidate-only final submission', /candidate alone clicks the final submit control after review/i]],
      forbidden: [['review-only auto-submit boundary', /^- Auto-submitting applications without human review$/mi]],
    },
    {
      file: 'README.ar.md',
      patterns: [['Arabic candidate-only final submission', /لا ينقر أبداً زر الإرسال النهائي/]],
    },
  ];
  for (const surface of surfaces) {
    const source = surface.userLayer
      ? readUserLayer(root, surface.file)
      : readRequired(root, surface.file, errors);
    if (!source) continue;
    errors.push(...requirePatterns(surface.file, source, surface.patterns));
    for (const [description, pattern] of surface.forbidden ?? []) {
      if (pattern.test(source)) errors.push(issue(surface.file, `contains forbidden ${description}`));
    }
  }
  return errors;
}

export function checkWebRuntime(root) {
  const errors = [];
  const sourceFiles = walkFiles(root, 'web/src', new Set(['.ts', '.tsx']));
  for (const file of sourceFiles) {
    const source = readFileSync(join(root, file), 'utf8');
    const isApplyApi = file.startsWith('web/src/app/api/apply/');
    if (isApplyApi) {
      if (file !== 'web/src/app/api/apply/[[...path]]/route.ts') {
        errors.push(issue(file, 'operation-specific direct-apply endpoint remains instead of the fail-closed catch-all'));
      }
      if (!(/status\s*:\s*410/.test(source) && /canonical/i.test(source))) {
        errors.push(issue(file, 'direct-apply catch-all is not a canonical-flow HTTP 410 response'));
      }
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
          const body = functionBody(source, method).replace(/\s+/g, ' ').trim();
          if (body !== 'return retired();') {
            errors.push(issue(file, `${method} does more than return the fail-closed retired response`));
          }
        }
      }
      if (/request\.json\s*\(|(?:from|import\s*\()\s*['"][^'"]*(?:lib\/apply|playwright)|\bchromium\b/i.test(source)) {
        errors.push(issue(file, 'retired direct-apply API still reads requests or imports a browser implementation'));
      }
      continue;
    }

    if (/fetch\(\s*['"]\/api\/apply\//.test(source)) {
      errors.push(issue(file, 'client calls the retired direct-apply API'));
    }
    if (/from\s+['"]@\/components\/apply\/apply-provider['"]/.test(source)) {
      errors.push(issue(file, 'client imports the retired direct-apply provider'));
    }
    if (/\b(?:setApplyField|startApply)\b/.test(source)) {
      errors.push(issue(file, 'assistant exposes direct apply-proxy mutation actions'));
    }
  }

  for (const file of walkFiles(root, 'web/src/lib/apply', new Set(['.ts', '.tsx']))) {
    errors.push(issue(file, 'legacy direct-apply runtime remains; retire it or delegate to the canonical receipt controller'));
  }
  return errors;
}

export function checkTrackerTUIRuntime(root) {
  const errors = [];
  const dataFile = 'dashboard/internal/data/career.go';
  const dataSource = readRequired(root, dataFile, errors);
  errors.push(...requirePatterns(dataFile, dataSource, [
    ['canonical set-status.mjs delegation', /canonicalStatusWriter[\s\S]*set-status\.mjs[\s\S]*exec\.Command\("node"/],
    ['generic Applied rejection', /generic tracker controls cannot set Applied/],
    ['external lifecycle provenance', /statusNeedsExternalProvenance[\s\S]*args = append\(args, "--external"\)/],
    ['old/new transition validation', /validateTrackerStatusTransition\(app\.Status, newStatus\)/],
  ]));
  if (/return\s+os\.WriteFile\(filePath[\s\S]{0,200}applications\.md/.test(dataSource)
      || /func\s+UpdateApplicationStatusAndNotes[\s\S]{0,2400}os\.WriteFile\(/.test(dataSource)) {
    errors.push(issue(dataFile, 'Go tracker status path directly rewrites applications.md instead of delegating to set-status.mjs'));
  }
  const transitionBody = /func\s+AllowedTrackerStatusTransitions[\s\S]{0,1800}/.exec(dataSource)?.[0] ?? '';
  if (/"(?:Saved|Scored|Prepared|Prefilled|Filled)"/.test(transitionBody)) {
    errors.push(issue(dataFile, 'Go tracker transition list leaks queue-only states into applications.md'));
  }

  for (const file of [
    'dashboard/internal/ui/screens/pipeline.go',
    'dashboard/internal/ui/screens/viewer.go',
  ]) {
    const source = readRequired(root, file, errors);
    if (!/AllowedTrackerStatusTransitions/.test(source)) {
      errors.push(issue(file, 'status picker does not use the guarded tracker transition list'));
    }
    if (/statusOptions\s*=\s*\[\]string\{[^}]*"Applied"/s.test(source)) {
      errors.push(issue(file, 'generic status picker exposes Applied and bypasses receipt confirmation'));
    }
  }
  return errors;
}

export function checkTrackerMetadataWriter(file, source) {
  return requirePatterns(file, source, [
    ['company reveal CLI flag', /a === ['"]--company['"]/],
    ['PDF-ready CLI flag', /a === ['"]--pdf-ready['"]/],
    ['exact numeric selector gate', /\(flags\.company != null \|\| flags\.pdfReady\)[\s\S]*exact numeric tracker #/],
    ['metadata-only status preservation', /newStatus\s*=\s*requestedStatus\s*\?\?\s*oldStatus/],
    ['one-way confidential-company reveal', /oldCompany\s*!==\s*['"]\?['"][\s\S]*company-reveal-conflict/],
    ['monotonic PDF-ready assignment', /parts\[colmap\.pdf\]\s*=\s*['"]✅['"]/],
    ['metadata included in the atomic change set', /changed\s*=\s*statusChanged\s*\|\|\s*noteChanged\s*\|\|\s*companyChanged\s*\|\|\s*pdfChanged/],
    ['shared tracker lock', /acquireTrackerLock\s*\(/],
    ['atomic tracker replacement', /writeFileAtomic\s*\(/],
    ['queue-backed receipt lookup', /import\s*\{\s*loadQueue\s*\}[\s\S]*function verifyCanonicalApplicationReceipt[\s\S]*loadQueue\s*\(/],
    ['read-only queue shadow rejection', /receipt-queue-not-authoritative/],
    ['Applied-only receipt scope', /flags\.receipt\s*&&\s*requestedStatus\s*!==\s*['"]Applied['"]/],
    ['receipt role/report binding requirement', /flags\.receipt\s*&&\s*\(!flags\.role\s*\|\|\s*!flags\.report\)/],
    ['unique queue receipt requirement', /matches\.length\s*===\s*0[\s\S]*matches\.length\s*!==\s*1/],
    ['stable finalized receipt binding', /progress\.handover_receipt_id\s*!==\s*flags\.receipt[\s\S]*request\.receipt_id\s*!==\s*flags\.receipt[\s\S]*progress\.review_ready\s*!==\s*true/],
    ['exact company/role/report receipt match', /queue company does not match[\s\S]*queue role does not match[\s\S]*--report does not exactly bind/],
    ['candidate submission readiness rerun', /submissionReadinessErrors\(role\)/],
    ['submitted Application Answers readiness rerun', /reviewReadinessErrors\(role,\s*\{[^}]*expectedReportState:\s*['"]submitted['"][^}]*\}\)/],
    ['receipt verified before tracker mutation', /if \(flags\.receipt\) verifyCanonicalApplicationReceipt\(target\);/],
  ]);
}

export function checkTrackerMetadataSurfaces(root) {
  const errors = [];
  const surfaces = [
    {
      file: 'modes/tracker.md',
      patterns: [
        ['canonical reveal command', /set-status\.mjs <tracker#> --company/],
        ['reveal lifecycle preservation', /preserves Status, Notes\/provenance, Via, PDF/],
      ],
      forbidden: [['manual Company-cell edit', /Edit the row's Company cell in place/i]],
    },
    {
      file: 'modes/offer-prep.md',
      patterns: [
        ['external Offer transition', /set-status\.mjs <tracker#> Offer --external --note/],
        ['already-Offer note-only path', /already `Offer`[\s\S]*set-status\.mjs <tracker#> --note/],
      ],
    },
    {
      file: 'modes/pdf.md',
      patterns: [
        ['canonical PDF-ready command', /set-status\.mjs <tracker#> --pdf-ready/],
        ['PDF lifecycle preservation', /lifecycle Status,[\s\S]*Notes\/provenance/],
      ],
      forbidden: [['duplicate TSV as the direct PDF path', /Stage one nine-column TSV/]],
    },
    {
      file: 'docs/SCRIPTS.md',
      patterns: [
        ['company reveal usage', /set-status\.mjs <tracker#> --company/],
        ['PDF-ready usage', /set-status\.mjs <tracker#> --pdf-ready/],
      ],
    },
  ];
  for (const surface of surfaces) {
    const source = readRequired(root, surface.file, errors);
    if (!source) continue;
    errors.push(...requirePatterns(surface.file, source, surface.patterns));
    for (const [description, pattern] of surface.forbidden ?? []) {
      if (pattern.test(source)) errors.push(issue(surface.file, `contains forbidden ${description}`));
    }
  }
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const source = readRequired(root, file, errors);
    if (!source) continue;
    errors.push(...requirePatterns(file, source, [
      ['exact company reveal metadata path', /set-status\.mjs[^\n]*--company/],
      ['exact PDF-ready metadata path', /set-status\.mjs[^\n]*--pdf-ready/],
      ['separate import and existing-row writer scopes', /New evaluations enter through an `Evaluated` TSV and `merge-tracker\.mjs`; direct changes to an existing exact row use `set-status\.mjs`/],
    ]));
  }
  return errors;
}

export function auditApplicationContract(root = ROOT) {
  const errors = [];
  {
    const file = 'modes/apply.md';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkCanonicalApplyMode(file, source));
  }
  {
    const file = 'modes/_custom.md';
    const source = readUserLayer(root, file);
    if (source) errors.push(...checkCustomApplyContract(file, source));
  }
  {
    const file = 'modes/queue.md';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkQueueMode(file, source));
  }
  for (const file of LOCALIZED_APPLY_FILES) {
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkLocalizedWrapper(file, source));
  }
  for (const file of LOCALIZED_EVALUATION_FILES) {
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkLocalizedEvaluationWrapper(file, source));
  }
  for (const file of LOCALIZED_PIPELINE_FILES) {
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkLocalizedPipelineWrapper(file, source));
  }
  for (const file of LOCALIZED_SHARED_FILES) {
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkLocalizedSharedOverlay(file, source));
  }

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkInstructionSurface(file, source));
  }
  {
    const file = '.agents/skills/career-ops/SKILL.md';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkInstructionSurface(file, source, { skill: true }));
  }
  {
    const file = 'docs/APPLY_AUTOFILL.md';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkAutofillOverview(file, source));
  }
  {
    const file = 'application-receipt.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkReceiptRuntime(file, source));
  }
  {
    const file = 'application-answers.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkApplicationAnswersRuntime(file, source));
  }
  {
    const file = 'form-fill.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkFormFillRuntime(file, source));
  }
  errors.push(...checkCredentialAndActionSafety(root));
  {
    const file = 'openrouter-runner.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkOfflineOpenRouterApply(file, source));
  }
  {
    const file = 'prepare-application.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkRetiredPrepareApplication(file, source));
  }
  {
    const file = 'application-request.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkApplicationRequestCore(file, source));
  }
  {
    const file = 'lean-application.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkLeanAttachmentGate(file, source));
  }
  {
    const file = 'one-shot-request.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkOneShotRuntime(file, source));
  }
  {
    const file = 'dashboard-server.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkDashboardRuntime(file, source));
  }
  {
    const file = 'merge-tracker.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkMergeTrackerRuntime(file, source));
  }
  {
    const file = 'dashboard/web/app.js';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkDashboardClient(file, source));
  }
  errors.push(...checkWebRuntime(root));
  {
    // #2172/#2185 moved the headless prompts out of the route and into
    // run-prompts.mjs; the route now only orchestrates and renders.
    const file = 'web/src/lib/run-prompts.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkWebPdfWorkerRuntime(file, source));
  }
  errors.push(...checkTrackerTUIRuntime(root));
  {
    const file = 'tracker.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkTrackerDeleteRuntime(file, source));
  }
  {
    const file = 'set-status.mjs';
    const source = readRequired(root, file, errors);
    if (source) errors.push(...checkTrackerMetadataWriter(file, source));
  }
  errors.push(...checkTrackerMetadataSurfaces(root));
  errors.push(...checkPeripheralContractSurfaces(root));
  errors.push(...checkApplicationScriptEntrypoints(root));
  errors.push(...checkConcurrentStores(root));
  return errors;
}

function printResult(errors) {
  if (!errors.length) {
    process.stdout.write(JSON.stringify({ status: 'ok', errors: [] }, null, 2) + '\n');
    return;
  }
  process.stderr.write('Application contract drift detected:\n');
  for (const error of errors) process.stderr.write(`- ${error.file}: ${error.message}\n`);
  process.stderr.write(JSON.stringify({ status: 'drift', errors }, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const errors = auditApplicationContract();
  printResult(errors);
  if (errors.length) process.exitCode = 1;
}
