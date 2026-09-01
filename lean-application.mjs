#!/usr/bin/env node
/**
 * lean-application.mjs — Lean LLM-first live-application lifecycle (lean-llm-v1).
 *
 * Default for new live runs. One observation → L1/L1.5/L2/L3 → fill → optional
 * teach → selective re-observe → compact finish at queue `prefilled`.
 *
 * Does NOT create page receipts or promote to receipt-backed `filled`.
 * Historical receipt-v3 runs continue through application-receipt.mjs.
 */

import { mutateQueue, setStatus } from './queue-store.mjs';
import { closeOneShotRequestOnRole } from './one-shot-request.mjs';
import {
  beginRole,
  recordObservedApplicationHost,
} from './application-receipt.mjs';
import { APPLICATION_ANSWERS_HEADING } from './application-answers.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename, resolve, dirname, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

import { resolveApplicationAsset } from './application-source-contract.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEST_PROJECT_ROOT_ALLOWED = process.env.NODE_ENV === 'test'
  && Boolean(process.env.CAREER_OPS_TEST_PROJECT_ROOT);
const PROJECT_ROOT = TEST_PROJECT_ROOT_ALLOWED
  ? resolve(process.env.CAREER_OPS_TEST_PROJECT_ROOT)
  : ROOT;

export const EXECUTION_PROTOCOL_LEAN = 'lean-llm-v1';
export const EXECUTION_PROTOCOL_RECEIPT = 'receipt-v3';
export const VERIFICATION_MODE_SELECTIVE = 'selective';

export function isLeanProgress(progress) {
  return progress?.execution_protocol === EXECUTION_PROTOCOL_LEAN
    || (progress?.receipt_required === false
      && progress?.execution_protocol !== EXECUTION_PROTOCOL_RECEIPT);
}

/**
 * Teach barrier for lean terminal writers.
 *
 * receipt-v3's `complete` (completeCommand) structurally cannot skip teaching —
 * it invokes liveTeach itself when evidence.teach is unset. Lean has no such
 * auto-teach, so an agent can silently reach a terminal command (page-done or
 * finish) without ever deciding whether a novel answer was worth caching. Gate
 * on the CURRENT pending lookup evidence: any novel field that was never taught
 * (reusable:true or reusable:false, decided per field) blocks the command.
 *
 * A page with no novel fields (pure uploads, fully resolved) has an empty
 * `novel` array and is never gated. A successful `queue-resolve.mjs --teach`
 * — including an explicit no-op teach — seals `pending.teach`, which clears the
 * gate. Each `--lookup` overwrites `pending_resolver_evidence` and resets
 * `teach` to null, so the gate always keys off the most recent observation
 * (re-observe on a risk trigger, accordion expansion, etc.), never a stale one.
 */
export function assertLeanTeachBarrier(progress, command) {
  const pending = progress?.pending_resolver_evidence;
  if (pending && Array.isArray(pending.novel) && pending.novel.length > 0 && !pending.teach) {
    throw new Error(
      'page has untaught novel field(s); run queue-resolve.mjs --teach for this page '
      + '(reusable:true or reusable:false, decided per field) before apply-page.mjs '
      + command,
    );
  }
}

export function isReceiptProgress(progress) {
  return progress?.execution_protocol === EXECUTION_PROTOCOL_RECEIPT
    || progress?.receipt_required === true
    || (progress?.evidence_protocol === 'v3'
      && progress?.receipt_required !== false
      && progress?.execution_protocol !== EXECUTION_PROTOCOL_LEAN);
}

function requiredText(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function roleFromQueue(queue, roleId) {
  const role = queue.roles.find((item) => item.id === roleId);
  if (!role) throw new Error('role not found: ' + roleId);
  return role;
}

/**
 * Begin a live application. Default protocol is lean-llm-v1.
 * Pass execution_protocol: 'receipt-v3' for the historical receipt loop.
 */
export function beginLeanOrReceipt(roleId, payload = {}) {
  const protocol = payload.execution_protocol === EXECUTION_PROTOCOL_RECEIPT
    ? EXECUTION_PROTOCOL_RECEIPT
    : EXECUTION_PROTOCOL_LEAN;
  return structuredClone(beginRole(roleId, {
    ...payload,
    execution_protocol: protocol,
  }));
}

/**
 * Record compact page progress for a lean run (no field manifests / digests).
 */
export function recordLeanPage(roleId, payload = {}) {
  // Commit the observed host before the page transaction. If the form left a
  // board that hosts the candidate's resume, this throws only AFTER the host and
  // PREPARE rewind are durable, so the next quality gate cannot fall back to the
  // Seek/Indeed discovery URL.
  recordObservedApplicationHost(roleId, payload.url, { requireActiveProgress: true });
  return mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    const progress = role.application_progress;
    if (!progress || progress.review_ready || progress.lean_review_ready) {
      throw new Error('an active application run is required');
    }
    if (!isLeanProgress(progress)) {
      throw new Error(
        'recordLeanPage is only valid for lean-llm-v1 runs; use apply-page complete for receipt-v3',
      );
    }
    assertLeanTeachBarrier(progress, 'page-done');
    const pageIndex = Number(payload.page_index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
      throw new Error('page_index must be a non-negative integer');
    }
    const entry = {
      page_index: pageIndex,
      url: requiredText(payload.url, 'url'),
      label: String(payload.label ?? payload.title ?? `page-${pageIndex}`).trim(),
      completed: payload.completed !== false,
      attachments_handled: payload.attachments_handled === true,
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
      final_page: payload.final_page === true,
      recorded_at: new Date().toISOString(),
    };
    // Carry the machine-extracted upload controls from THIS page's observation
    // into the durable lean ledger. `pending_resolver_evidence` is overwritten by
    // every `--lookup`, so without this a multi-page wizard would only ever
    // remember the last page's controls and `finish` could not prove that a
    // required upload on page 1 was actually bound.
    const observedControls = Array.isArray(progress.pending_resolver_evidence?.upload_controls)
      ? structuredClone(progress.pending_resolver_evidence.upload_controls)
      : [];
    entry.upload_controls = observedControls;
    entry.displayed_filenames = Array.isArray(progress.pending_resolver_evidence?.displayed_filenames)
      ? progress.pending_resolver_evidence.displayed_filenames.map(String)
      : [];

    progress.lean_pages = Array.isArray(progress.lean_pages) ? progress.lean_pages : [];
    const existing = progress.lean_pages.findIndex((p) => p.page_index === pageIndex);
    if (existing >= 0) progress.lean_pages[existing] = entry;
    else progress.lean_pages.push(entry);
    progress.lean_pages.sort((a, b) => a.page_index - b.page_index);
    progress.updated_at = entry.recorded_at;
    if (Array.isArray(payload.review_required) && payload.review_required.length) {
      progress.review_required = [
        ...(progress.review_required || []),
        ...payload.review_required,
      ];
    }
    return structuredClone(entry);
  });
}

/**
 * Warnings the candidate must see in the compact review. A recorded verification
 * fallback (an unparseable widget the driver could not verify) hard-blocks
 * receipt-v3 finalize; lean still finishes at `prefilled`, but the unsupported
 * controls must never disappear silently from the review record.
 */
function leanWarnings(payload, progress) {
  const supplied = Array.isArray(payload.warnings) ? payload.warnings.map(String) : [];
  const fallback = progress?.verification_fallback;
  if (!fallback) return supplied;
  const controls = Array.isArray(fallback.control_ids) ? fallback.control_ids.join(', ') : '';
  const note = `Verification fallback recorded on page ${fallback.page_index}: ${fallback.reason}`
    + (controls ? ` (unsupported controls: ${controls})` : '')
    + '. Check these controls yourself before submitting.';
  return supplied.some((item) => item.includes('Verification fallback recorded'))
    ? supplied
    : [...supplied, note];
}

function buildLeanAnswersMarkdown(payload, progress, role, evidence = null) {
  const date = String(payload.date || new Date().toISOString().slice(0, 10));
  const legacy = evidence?.legacy
    ?? (payload.attachments && typeof payload.attachments === 'object' && !Array.isArray(payload.attachments)
      ? payload.attachments
      : {});
  // Prefer the verified evidence; fall back to the legacy filename object.
  const verified = evidence?.attachments ?? [];
  const byKind = (kind) => verified
    .filter((item) => item.kind === kind)
    .map((item) => `${basename(item.displayed)} (sha256 ${item.asset_sha256.slice(0, 12)}…)`)
    .join(', ');
  const attachments = {
    cv: byKind('cv') || legacy.cv || legacy.cv_filename || '',
    cover: byKind('cover') || legacy.cover || legacy.cover_filename || '',
  };
  const important = Array.isArray(payload.important_answers) ? payload.important_answers : [];
  const reviewRequired = Array.isArray(payload.review_required)
    ? payload.review_required
    : (progress.review_required || []);
  const warnings = leanWarnings(payload, progress);
  const pages = progress.lean_pages || [];

  const lines = [
    APPLICATION_ANSWERS_HEADING,
    '',
    `**Date:** ${date}`,
    '**State:** prefilled',
    `**Execution protocol:** ${EXECUTION_PROTOCOL_LEAN}`,
    `**Run ID:** ${progress.run_id}`,
    `**Receipt pages:** 0`,
    `**Lean pages completed:** ${pages.length}`,
    `**Final URL:** ${requiredText(payload.final_url, 'final_url')}`,
    `**Final control:** ${requiredText(payload.final_control, 'final_control')}`,
    `**Agent submitted:** false`,
    '',
    '### Compact lean review',
    '',
    `- Company: ${role.company ?? ''}`,
    `- Role: ${role.title ?? ''}`,
    `- Portal host: ${safeHost(payload.final_url)}`,
    `- CV: ${attachments.cv || '(not recorded)'}`,
    `- Cover: ${attachments.cover || '(not recorded)'}`,
    ...(evidence?.naReason ? [`- Uploads not applicable: ${evidence.naReason}`] : []),
    '',
    '### Important / screening answers',
    '',
  ];
  // Headings and entry metadata keys below are the exact vocabulary
  // `parseApplicationAnswersSection` accepts — a lean review record must stay
  // machine-readable by the same parser the receipt path uses.
  if (!important.length) lines.push('- None beyond deterministic profile fills.');
  else {
    for (const [i, item] of important.entries()) {
      lines.push(`${i + 1}. **${item.label}:** ${answerCell(item.answer)}`);
      if (item.source) lines.push(`   - Provenance: ${item.source}`);
    }
  }
  lines.push('', '### Review-required / other answers', '');
  if (!reviewRequired.length) lines.push('- None.');
  else {
    for (const [i, item] of reviewRequired.entries()) {
      lines.push(`${i + 1}. **${item.label}:** ${answerCell(item.answer)}`);
      lines.push('   - Review required: yes');
      const note = item.note || item.review_note;
      if (note) lines.push(`   - Review note: ${note}`);
    }
  }
  lines.push('', '### Warnings', '');
  if (!warnings.length) lines.push('- None.');
  else warnings.forEach((w, i) => lines.push(`${i + 1}. ${w}`));
  lines.push('');
  return lines.join('\n');
}

// `(blank)` is the canonical marker for an intentionally empty answer (honeypot,
// middle name); an empty cell would make the entry unparseable. Newlines are
// collapsed because this record is the compact review — a continuation line
// starting with `- ` would otherwise be read as unknown entry metadata and
// throw the whole report out of the parser. Full text stays in the live form.
function answerCell(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\s*\n\s*/g, ' ').trim();
  return text === '' ? '(blank)' : text;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// ── Receipt-grade attachment evidence for lean finish ────────────────────────
//
// The reported npm failure was a user uploading their OWN local CV because
// career-ops produced no role-specific asset. The structural defence is that a
// finished run must prove, per upload control, WHICH generated role asset went
// in — by content hash, not by filename alone. `resolveApplicationAsset` only
// accepts `output/…` inside the project, so a local source document on the
// user's disk can never satisfy this.
//
// Shape (array form, receipt-grade):
//   [{control_id, kind, expected, displayed, asset_sha256, verified: true}]
// Legacy object form ({cv: 'name.pdf'}) carries no proof and counts as none.

const ATTACHMENT_KINDS = new Set(['cv', 'cover', 'supporting', 'other']);

function attachmentText(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

/** Every path this role may legitimately upload, by canonical kind. */
function roleUploadableAssets(role) {
  const covers = role?.cover_letter_paths;
  const coverValues = Array.isArray(covers)
    ? [...covers]
    : (covers && typeof covers === 'object'
      ? Object.values(covers)
      : (typeof covers === 'string' ? [covers] : []));
  if (role?.cover_letter_path) coverValues.push(role.cover_letter_path);
  return {
    cv: role?.cv_pdf ? [String(role.cv_pdf)] : [],
    cover: [...new Set(coverValues
      // Never expose the canonical payload JSON (or another renderer sidecar)
      // as something a browser controller may upload. Portal attachments are
      // user-facing document formats only.
      .filter((value) =>
        typeof value === 'string'
        && /\.(?:pdf|docx?|md|txt)$/i.test(value.trim()))
      .map(String))],
  };
}

function sha256Of(absolute) {
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/**
 * Validate one attachment against the role's own generated assets.
 * Throws with an actionable message; never returns a partially trusted record.
 */
function verifyLeanAttachment(role, item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`attachments[${index}] must be an object`);
  }
  const label = `attachments[${index}]`;
  const kind = attachmentText(item.kind, `${label}.kind`).toLowerCase();
  if (!ATTACHMENT_KINDS.has(kind)) {
    throw new Error(`${label}.kind must be cv, cover, supporting, or other`);
  }
  const controlId = attachmentText(item.control_id, `${label}.control_id`);
  const expected = attachmentText(item.expected, `${label}.expected`);
  const displayed = attachmentText(item.displayed, `${label}.displayed`);
  const suppliedSha256 = attachmentText(item.asset_sha256, `${label}.asset_sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(suppliedSha256)) {
    throw new Error(`${label}.asset_sha256 must be a 64-character SHA-256 digest`);
  }
  if (item.verified !== true) {
    throw new Error(`${label} is not verified`);
  }
  if (basename(expected) !== basename(displayed)) {
    throw new Error(
      `${label} displayed filename ${JSON.stringify(displayed)} does not match the expected asset `
      + `${JSON.stringify(basename(expected))} — the portal is holding a different file`,
    );
  }

  const assets = roleUploadableAssets(role);
  const candidates = kind === 'cv' ? assets.cv
    : (kind === 'cover' || kind === 'supporting') ? assets.cover
      : [...assets.cv, ...assets.cover];
  const expectedAbsolute = resolve(PROJECT_ROOT, expected);
  const matched = candidates.find((candidate) => resolve(PROJECT_ROOT, candidate) === expectedAbsolute);
  if (!matched) {
    throw new Error(
      `${label} (${kind}) is not one of this role's generated cv_pdf/cover_letter_paths assets: `
      + `${JSON.stringify(expected)}. career-ops must generate and attach the role's own asset; `
      + 'a local source CV or cover letter is never an upload asset',
    );
  }
  // Generated assets live under output/. Anything else is a source document or
  // an out-of-scope path, and must not reach a portal upload control.
  //
  // Derive the resolver kind from WHICH list matched and the file's own
  // extension, not from the declared `kind`. A `supporting`/`other` attachment
  // may legitimately be one of the cover files, and forcing `cv_pdf` on it would
  // reject a valid asset for having the wrong suffix.
  const assetPath = resolveApplicationAsset(PROJECT_ROOT, matched, assetKindFor(matched, assets));
  if (!assetPath) {
    throw new Error(
      `${label} does not resolve to a generated output/ asset: ${JSON.stringify(matched)}`,
    );
  }
  const actualSha256 = sha256Of(assetPath.absolute);
  if (suppliedSha256 !== actualSha256) {
    throw new Error(
      `${label} content hash does not match the role asset on disk — regenerate and re-attach`,
    );
  }
  return {
    control_id: controlId,
    kind,
    expected: assetPath.relative,
    displayed,
    asset_sha256: suppliedSha256,
    verified: true,
  };
}

/**
 * Map a matched role asset to the kind `resolveApplicationAsset` expects.
 *
 * Keyed on which of the role's own lists the path came from plus its extension,
 * so the check is about the FILE, not about how the agent labelled the control.
 */
function assetKindFor(path, assets) {
  const lower = String(path).toLowerCase();
  if (assets.cv.some((candidate) => resolve(PROJECT_ROOT, candidate) === resolve(PROJECT_ROOT, path))) {
    return lower.endsWith('.html') ? 'cv_html' : 'cv_pdf';
  }
  if (lower.endsWith('.pdf')) return 'cover_pdf';
  if (lower.endsWith('.docx')) return 'cover_docx';
  if (lower.endsWith('.payload.json')) return 'cover_payload';
  return 'cover_md';
}

/**
 * Every enabled upload control observed across the whole run, deduplicated by
 * control_id. Derived from real page observations, not caller assertion.
 */
export function observedUploadControls(progress) {
  const seen = new Map();
  const pages = Array.isArray(progress?.lean_pages) ? progress.lean_pages : [];
  const sources = [
    ...pages.flatMap((page) => (Array.isArray(page.upload_controls) ? page.upload_controls : [])),
    ...(Array.isArray(progress?.pending_resolver_evidence?.upload_controls)
      ? progress.pending_resolver_evidence.upload_controls
      : []),
  ];
  for (const control of sources) {
    if (!control?.control_id) continue;
    const prior = seen.get(control.control_id);
    if (!prior) {
      seen.set(control.control_id, { ...control });
      continue;
    }
    // Merge conservatively rather than picking one observation. A control seen
    // enabled anywhere stays enabled, and seen required anywhere stays required:
    // a later page that re-renders it as optional (or not at all) must not erase
    // an obligation the run already saw.
    seen.set(control.control_id, {
      ...prior,
      ...control,
      enabled: prior.enabled === true || control.enabled === true,
      required: prior.required === true || control.required === true,
      label: prior.label || control.label,
    });
  }
  return [...seen.values()];
}

function observedDisplayedFilenames(progress) {
  const pages = Array.isArray(progress?.lean_pages) ? progress.lean_pages : [];
  const values = [
    ...pages.flatMap((page) =>
      (Array.isArray(page.displayed_filenames) ? page.displayed_filenames : [])),
    ...(Array.isArray(progress?.pending_resolver_evidence?.displayed_filenames)
      ? progress.pending_resolver_evidence.displayed_filenames
      : []),
  ];
  return [...new Set(values.map((value) => basename(String(value))).filter(Boolean))];
}

function attachmentMatchesControl(control, attachment) {
  const controlKind = String(control?.kind || 'other').toLowerCase();
  const attachmentKind = String(attachment?.kind || '').toLowerCase();
  if (controlKind === 'cv') return attachmentKind === 'cv';
  if (controlKind === 'cover') return attachmentKind === 'cover';
  if (controlKind === 'supporting') {
    return attachmentKind === 'cover' || attachmentKind === 'supporting';
  }
  return true;
}

function controlAcceptsAttachment(control, attachment) {
  const raw = control?.accepts;
  const accepts = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? '').split(',');
  const normalized = accepts.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!normalized.length || normalized.includes('*') || normalized.includes('*/*')) return true;
  const filename = basename(attachment.expected).toLowerCase();
  const extension = filename.includes('.') ? `.${filename.split('.').pop()}` : '';
  const mimeByExtension = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };
  return normalized.some((accept) =>
    accept === extension
    || accept === mimeByExtension[extension]
    || (accept.endsWith('/*') && mimeByExtension[extension]?.startsWith(accept.slice(0, -1))));
}

/**
 * Bind attachments to the run's observed upload controls, or prove none applied.
 *
 * Fail-closed: an enabled, required upload control with no verified attachment
 * blocks `finish`. A run that genuinely observed no upload control needs no
 * attachments at all.
 */
function assertLeanAttachments(role, progress, payload) {
  const naReason = String(payload.attachments_not_applicable_reason ?? '').trim();
  const raw = payload.attachments;
  const isArrayForm = Array.isArray(raw);
  const attachments = isArrayForm
    ? raw.map((item, index) => verifyLeanAttachment(role, item, index))
    : [];

  const controls = observedUploadControls(progress);
  const enabled = controls.filter((control) => control.enabled !== false);
  const required = enabled.filter((control) => control.required === true);
  const machineDisplayed = observedDisplayedFilenames(progress);

  if (attachments.length && naReason) {
    throw new Error('attachments_not_applicable_reason cannot accompany verified attachments');
  }

  // Check the supplied evidence FIRST. A typo'd or invented control_id must
  // report itself, not surface as the downstream "required control has no
  // evidence" symptom — the agent needs to know which claim was wrong.
  for (const attachment of attachments) {
    const control = controls.find((item) => item.control_id === attachment.control_id);
    if (!control) {
      throw new Error(
        `attachment control_id was never observed on this application: ${JSON.stringify(attachment.control_id)}`
        + (controls.length
          ? ` (observed: ${controls.map((item) => item.control_id).join(', ')})`
          : ' (no upload controls were observed at all)'),
      );
    }
    if (control.enabled === false) {
      throw new Error(
        `attachment control_id was disabled on the live application: ${JSON.stringify(attachment.control_id)}`,
      );
    }
    if (!attachmentMatchesControl(control, attachment)) {
      throw new Error(
        `attachment kind ${JSON.stringify(attachment.kind)} is incompatible with `
        + `${JSON.stringify(control.kind || 'other')} upload control ${JSON.stringify(control.control_id)}`,
      );
    }
    if (!controlAcceptsAttachment(control, attachment)) {
      throw new Error(
        `attachment ${JSON.stringify(basename(attachment.expected))} is not accepted by `
        + `upload control ${JSON.stringify(control.control_id)} (${String(control.accepts)})`,
      );
    }
    if (machineDisplayed.length > 0
        && !machineDisplayed.includes(basename(attachment.displayed))) {
      throw new Error(
        `attachment displayed filename ${JSON.stringify(attachment.displayed)} was not present in `
        + `the machine-observed portal filenames (${machineDisplayed.join(', ')})`,
      );
    }
  }

  const byControl = new Map();
  for (const attachment of attachments) {
    if (!byControl.has(attachment.control_id)) byControl.set(attachment.control_id, []);
    byControl.get(attachment.control_id).push(attachment);
  }
  for (const control of required) {
    if (!(byControl.get(control.control_id)?.length)) {
      throw new Error(
        `required upload control ${JSON.stringify(control.control_id)}`
        + `${control.label ? ` (${control.label})` : ''} has no verified attachment evidence; `
        + 'bind the role asset with {control_id, kind, expected, displayed, asset_sha256, verified:true} '
        + 'before apply-page.mjs finish',
      );
    }
  }

  if (enabled.length > 0 && naReason) {
    throw new Error(
      'attachments_not_applicable_reason is invalid while an enabled upload control accepts an attachment',
    );
  }
  if (enabled.length > 0 && attachments.length === 0) {
    throw new Error(
      `${enabled.length} enabled upload control(s) were observed but no verified attachment `
      + 'evidence was recorded',
    );
  }
  for (const control of enabled) {
    const attached = byControl.get(control.control_id) ?? [];
    if (control.kind === 'cv' && !attached.some((item) => item.kind === 'cv')) {
      throw new Error(`CV upload control was observed but no verified CV was attached: ${control.label}`);
    }
    if ((control.kind === 'cover' || control.kind === 'supporting')
        && !attached.some((item) => item.kind === 'cover' || item.kind === 'supporting')) {
      throw new Error(`cover-compatible upload control was observed but no verified cover letter was attached: ${control.label}`);
    }
    if (control.multiple === false && attached.length > 1) {
      throw new Error(`upload control ${JSON.stringify(control.control_id)} does not accept multiple attachments`);
    }
  }

  const duplicates = new Set();
  for (const attachment of attachments) {
    const key = `${attachment.control_id}:${attachment.kind}:${attachment.asset_sha256}`;
    if (duplicates.has(key)) {
      throw new Error(`duplicate attachment evidence: ${basename(attachment.expected)}`);
    }
    duplicates.add(key);
  }

  return {
    attachments,
    naReason,
    // Preserve the legacy display object so the compact review still renders
    // filenames for runs that predate receipt-grade evidence.
    legacy: !isArrayForm && raw && typeof raw === 'object' ? raw : null,
    observed_upload_controls: controls,
    observed_displayed_filenames: machineDisplayed,
  };
}

function upsertReportSection(reportPath, sectionMarkdown) {
  const absolute = isAbsolute(reportPath) ? reportPath : resolve(PROJECT_ROOT, reportPath);
  if (!existsSync(absolute)) {
    throw new Error(`application_answers_report does not exist: ${reportPath}`);
  }
  const source = readFileSync(absolute, 'utf8');
  const heading = APPLICATION_ANSWERS_HEADING;
  const start = source.indexOf(heading);
  let next;
  if (start < 0) {
    next = source.trimEnd() + '\n\n' + sectionMarkdown.trimEnd() + '\n';
  } else {
    const after = start + heading.length;
    const rest = source.slice(after);
    const nextHeading = rest.search(/\n## /);
    const end = nextHeading >= 0 ? after + nextHeading : source.length;
    next = source.slice(0, start) + sectionMarkdown.trimEnd() + '\n'
      + source.slice(end).replace(/^\n+/, '');
  }
  writeFileSync(absolute, next);
  return reportPath;
}

/**
 * Finish a lean run: compact review → queue status prefilled.
 * Never promotes to receipt-backed filled.
 */
export function finishLean(roleId, payload = {}) {
  const observedFinalUrl = requiredText(payload.final_url, 'final_url');
  // Recheck the last browser location at the terminal boundary. The normal
  // workflow records the final page first, but this prevents a navigation that
  // occurs between page-done and finish from reviving the discovery URL's
  // portal-resume exemption.
  recordObservedApplicationHost(roleId, observedFinalUrl, { requireActiveProgress: true });
  return mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    const progress = role.application_progress;
    if (!progress || progress.lean_review_ready) {
      throw new Error('an active lean application run is required');
    }
    if (!isLeanProgress(progress)) {
      throw new Error('finishLean is only valid for lean-llm-v1 runs');
    }
    // Close the page-done bypass: an agent can lookup → fill → finish on the
    // final page without ever calling page-done, which would let untaught novel
    // fields slip through the same gap page-done now guards. Gate finish on the
    // current pending evidence before writing the compact review or promoting
    // the queue to prefilled.
    assertLeanTeachBarrier(progress, 'finish');
    if (!Array.isArray(progress.lean_pages) || progress.lean_pages.length === 0) {
      throw new Error('lean finish requires at least one recorded lean page');
    }
    const finalUrl = requiredText(payload.final_url, 'final_url');
    const finalControl = requiredText(payload.final_control, 'final_control');
    const reportPath = requiredText(
      payload.application_answers_report,
      'application_answers_report',
    );

    // Fail-closed attachment gate. Runs BEFORE anything is written or promoted,
    // so a run that cannot prove what it uploaded leaves no half-finished state.
    const attachmentEvidence = assertLeanAttachments(role, progress, payload);

    const section = buildLeanAnswersMarkdown(payload, progress, role, attachmentEvidence);
    upsertReportSection(reportPath, section);

    const now = new Date().toISOString();
    progress.lean_review = {
      execution_protocol: EXECUTION_PROTOCOL_LEAN,
      status: 'prefilled',
      pages_completed: progress.lean_pages.length,
      final_url: finalUrl,
      final_control: finalControl,
      // Receipt-grade evidence: each entry names the exact generated role asset,
      // its content SHA-256, the filename the portal displayed, and the control
      // it went into. `attachments_display` keeps the legacy filename object for
      // runs that predate this evidence.
      attachments: attachmentEvidence.attachments,
      ...(attachmentEvidence.naReason
        ? { attachments_not_applicable_reason: attachmentEvidence.naReason }
        : {}),
      ...(attachmentEvidence.legacy ? { attachments_display: attachmentEvidence.legacy } : {}),
      observed_upload_controls: attachmentEvidence.observed_upload_controls,
      observed_displayed_filenames: attachmentEvidence.observed_displayed_filenames,
      important_answers: payload.important_answers || [],
      review_required: payload.review_required || progress.review_required || [],
      warnings: leanWarnings(payload, progress),
      agent_submitted: false,
      application_answers_report: reportPath,
      finished_at: now,
    };
    progress.final_url = finalUrl;
    progress.application_answers_report = reportPath;
    progress.report_state = 'prefilled';
    progress.updated_at = now;
    // Lean review-ready for candidate Mark Submitted — not receipt review_ready.
    progress.lean_review_ready = true;
    progress.review_ready = false;
    progress.receipt_required = false;

    if (role.application_request) {
      role.application_request.state = 'completed';
      role.application_request.completed_at = now;
      role.application_request.updated_at = now;
    }

    // Close the durable One-shot chain in the same locked mutation that frees
    // the controller slot, so the drain view can never show a finished role as
    // still owing work.
    closeOneShotRequestOnRole(role, now);

    setStatus(queue, roleId, 'prefilled');
    return {
      role_id: roleId,
      status: 'prefilled',
      execution_protocol: EXECUTION_PROTOCOL_LEAN,
      lean_review: structuredClone(progress.lean_review),
      pages_completed: progress.lean_pages.length,
    };
  });
}

export function assertNotLeanForReceiptCommand(progress, command) {
  if (isLeanProgress(progress)) {
    throw new Error(
      `${command} is not valid for lean-llm-v1 runs; use page-done / finish instead `
      + `(or begin with execution_protocol: "receipt-v3" for the historical receipt loop)`,
    );
  }
}

export function assertLeanForLeanCommand(progress, command) {
  if (!isLeanProgress(progress)) {
    throw new Error(
      `${command} is only valid for lean-llm-v1 runs; use complete / finalize for receipt-v3`,
    );
  }
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, roleId, jsonArg] = process.argv;
  try {
    const payload = jsonArg
      ? JSON.parse(jsonArg.startsWith('@') ? readFileSync(jsonArg.slice(1), 'utf8') : jsonArg)
      : {};
    let out;
    if (cmd === 'page-done') out = recordLeanPage(roleId, payload);
    else if (cmd === 'finish') out = finishLean(roleId, payload);
    else {
      process.stderr.write('usage: node lean-application.mjs <page-done|finish> <role-id> \'<json>\'\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(String(err?.stack || err) + '\n');
    process.exit(1);
  }
}
