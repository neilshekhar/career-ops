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
import { beginApplicationProgress } from './application-receipt.mjs';
import { APPLICATION_ANSWERS_HEADING } from './application-answers.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
  return mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    const progress = beginApplicationProgress(role, {
      ...payload,
      execution_protocol: protocol,
    }, { queue });
    return structuredClone(progress);
  });
}

/**
 * Record compact page progress for a lean run (no field manifests / digests).
 */
export function recordLeanPage(roleId, payload = {}) {
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

function buildLeanAnswersMarkdown(payload, progress, role) {
  const date = String(payload.date || new Date().toISOString().slice(0, 10));
  const attachments = payload.attachments && typeof payload.attachments === 'object'
    ? payload.attachments
    : {};
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
    `- CV: ${attachments.cv || attachments.cv_filename || '(not recorded)'}`,
    `- Cover: ${attachments.cover || attachments.cover_filename || '(not recorded)'}`,
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

    const section = buildLeanAnswersMarkdown(payload, progress, role);
    upsertReportSection(reportPath, section);

    const now = new Date().toISOString();
    progress.lean_review = {
      execution_protocol: EXECUTION_PROTOCOL_LEAN,
      status: 'prefilled',
      pages_completed: progress.lean_pages.length,
      final_url: finalUrl,
      final_control: finalControl,
      attachments: payload.attachments || {},
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
