#!/usr/bin/env node
/**
 * apply-page.mjs — Dual-protocol live-application page driver.
 *
 * Default for new begins: lean-llm-v1
 *   observe → lookup → fill → optional teach → page-done → … → finish → prefilled
 *
 * Opt-in historical: receipt-v3 (execution_protocol: "receipt-v3")
 *   snapshot → lookup → fill → complete (after-snapshot + page receipt) → finalize → filled
 *
 * The LLM agent stays the only browser driver. Digests/manifests for receipt-v3
 * are derived from snapshot files; lean never requires page receipts.
 *
 * Lean loop:
 *   1. browser_snapshot (or compact field observe)
 *   2. node apply-page.mjs lookup <role> '{"page_index":N,"url":...,"snapshot":"<file>"}'
 *   3. fill resolved + novel answers; teach reusable novels only
 *   4. node apply-page.mjs page-done <role> '{"page_index":N,"url":...}'
 *   5. Next/Continue (never final submit) — selective re-observe only when needed
 *   6. node apply-page.mjs finish <role> '{"final_url":...,"final_control":...,"application_answers_report":...}'
 *
 * Receipt-v3 loop (explicit begin stamp only):
 *   lookup → fill → complete(after_snapshot) → finalize → filled
 */

import { readFileSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';

import { loadQueue } from './queue-store.mjs';
import { liveResolveFromSnapshot, liveTeach } from './queue-resolve.mjs';
import {
  beginRole, recordRolePage, finalizeRole, recordRoleFallback,
} from './application-receipt.mjs';
import {
  readSnapshotFile, extractFields, extractDisplayedFilenames,
  extractValidationAlerts, findSubmitBoundary, compareFieldSets,
  verifyPopulatedValues, isCriticalField,
} from './snapshot-extract.mjs';
import {
  isLeanProgress,
  recordLeanPage,
  finishLean,
  assertNotLeanForReceiptCommand,
  EXECUTION_PROTOCOL_LEAN,
  EXECUTION_PROTOCOL_RECEIPT,
} from './lean-application.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NOVEL_OPTION_CAP = 40; // bounded-L3: never dump giant option lists at the model

function readJsonArg(jsonArg, command) {
  if (!jsonArg) throw new Error(`${command}: JSON payload is required`);
  const raw = jsonArg.startsWith('@') ? readFileSync(jsonArg.slice(1), 'utf-8') : jsonArg;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${command} expects JSON: ${err.message}`);
  }
}

function requiredText(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function roleAndProgress(roleId) {
  const role = loadQueue().roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);
  const progress = role.application_progress;
  if (!progress || progress.review_ready || progress.lean_review_ready) {
    throw new Error('an active application run is required; start with apply-page.mjs begin');
  }
  return { role, progress };
}

// ── begin ─────────────────────────────────────────────────────────────────────

function beginCommand(roleId, payload) {
  // Default lean-llm-v1 unless caller explicitly requests receipt-v3.
  const progress = beginRole(roleId, payload);
  const lean = isLeanProgress(progress);
  return {
    run_id: progress.run_id,
    role_id: progress.role_id,
    tab_id: progress.tab.id,
    execution_protocol: progress.execution_protocol
      ?? (lean ? EXECUTION_PROTOCOL_LEAN : EXECUTION_PROTOCOL_RECEIPT),
    verification_mode: progress.verification_mode
      ?? (lean ? 'selective' : 'receipt'),
    receipt_required: progress.receipt_required === true,
    ...(progress.evidence_protocol ? { evidence_protocol: progress.evidence_protocol } : {}),
    ...(progress.evidence_capture ? { evidence_capture: progress.evidence_capture } : {}),
    started_at: progress.started_at,
    next: lean
      ? 'observe the first wizard page, then apply-page.mjs lookup; finish with page-done / finish (never complete/finalize)'
      : 'browser_snapshot the first wizard page, then apply-page.mjs lookup',
  };
}

// ── lookup ────────────────────────────────────────────────────────────────────

function lookupCommand(roleId, payload) {
  const { progress } = roleAndProgress(roleId);
  const pageIndex = payload.page_index;
  const url = requiredText(payload.url, 'lookup.url');
  const snapshotPath = requiredText(payload.snapshot, 'lookup.snapshot');
  const excludeControls = Array.isArray(payload.exclude_controls) ? payload.exclude_controls : [];

  const out = liveResolveFromSnapshot(roleId, {
    pageIndex, url, snapshotPath, excludeControls,
  });

  const currentById = new Map(out.extraction.fields.map((field) => [field.control_id, field.value]));
  const lean = isLeanProgress(progress);
  return {
    role: `${out.company} – ${out.title}`,
    run_id: out.run_id,
    page_id: out.page_id,
    page_index: out.page_index,
    execution_protocol: progress.execution_protocol
      ?? (lean ? EXECUTION_PROTOCOL_LEAN : EXECUTION_PROTOCOL_RECEIPT),
    evidence_id: out.evidence_id,
    snapshot_digest: out.snapshot_digest,
    field_count: out.resolved.length + out.novel.length,
    resolved: out.resolved.map((item) => ({
      control_id: item.control_id,
      label: item.label,
      answer: item.answer,
      source: item.source,
      ...(item.review_required ? { review_required: true, review_note: item.review_note } : {}),
    })),
    novel: out.novel.map((item) => {
      const options = Array.isArray(item.options) ? item.options : [];
      const current = String(currentById.get(item.control_id) ?? '');
      return {
        control_id: item.control_id,
        label: item.label,
        type: item.type,
        required: item.required,
        options: options.slice(0, NOVEL_OPTION_CAP),
        ...(options.length > NOVEL_OPTION_CAP ? { options_truncated: options.length } : {}),
        ...(current ? { current } : {}),
        ...(item.help ? { help: item.help } : {}),
      };
    }),
    upload_controls: out.extraction.upload_controls,
    displayed_filenames: out.extraction.displayed_filenames,
    next: lean
      ? 'fill resolved answers, answer every novel question, teach reusable novels only, then apply-page.mjs page-done (selective re-observe only if risk triggers fire)'
      : 'fill resolved answers, answer every novel question, browser_snapshot, then apply-page.mjs complete',
  };
}

// ── complete ──────────────────────────────────────────────────────────────────

function orderedTeachAnswers(evidence, answers) {
  const novel = evidence.novel ?? [];
  const byControl = new Map();
  for (const answer of answers) {
    const controlId = requiredText(answer.control_id, 'answers[].control_id');
    if (byControl.has(controlId)) throw new Error(`duplicate answer for control: ${controlId}`);
    byControl.set(controlId, answer);
  }
  const resolvedIds = new Set((evidence.resolved ?? []).map((item) => item.control_id));
  for (const controlId of byControl.keys()) {
    if (resolvedIds.has(controlId)) {
      throw new Error(`control ${controlId} was already resolved; resolved answers cannot be overridden — fix the draft/profile and re-run lookup`);
    }
    if (!novel.some((item) => item.control_id === controlId)) {
      throw new Error(`answer references an unknown control: ${controlId} (not novel on this page — re-run lookup if the form changed)`);
    }
  }
  const missing = novel.filter((item) => !byControl.has(item.control_id));
  if (missing.length) {
    throw new Error('every novel question needs an answer; missing: ' +
      missing.map((item) => `${item.control_id} (${item.label})`).join(', '));
  }
  return novel.map((item) => {
    const supplied = byControl.get(item.control_id);
    const reviewRequired = supplied.review_required === true;
    // Anti-bot honeypots and intentionally blank optional identity fields
    // (middle name / custom pronoun) must stay empty; requiredText would force
    // a fabricated value into the trap or the form.
    const allowEmpty = /\bhoneypot\b/i.test(String(item.label ?? ''))
      || /\b(middle(?:\s+name)?|second name|maiden name|custom pronoun)\b/i.test(String(item.label ?? ''));
    const answer = allowEmpty
      ? String(supplied.answer ?? '').trim()
      : requiredText(supplied.answer, `answer for ${item.label}`);
    if (/\bhoneypot\b/i.test(String(item.label ?? '')) && answer) {
      throw new Error(`honeypot answer must be empty (got ${JSON.stringify(answer)})`);
    }
    return {
      control_id: item.control_id,
      label: item.label,
      type: item.type ?? 'textarea',
      answer,
      reusable: supplied.reusable === true && !reviewRequired,
      review_required: reviewRequired,
      review_note: reviewRequired
        ? requiredText(supplied.review_note, `review_note for ${item.label}`)
        : null,
    };
  });
}

function teachMatchesAnswers(teach, ordered) {
  const key = (items) => JSON.stringify(items.map((item) => [item.control_id, item.answer]));
  return key(teach.answers ?? []) === key(ordered);
}

function buildFieldLedger(evidence, teachAnswers) {
  const resolvedById = new Map((evidence.resolved ?? []).map((item) => [item.control_id, item]));
  const taughtById = new Map(teachAnswers.map((item) => [item.control_id, item]));
  return (evidence.fields ?? []).map((field) => {
    const resolved = resolvedById.get(field.control_id);
    if (resolved) {
      return {
        control_id: field.control_id,
        label: field.label,
        type: field.type,
        required: field.required === true,
        answer: resolved.answer,
        resolution: 'resolved',
        provenance: resolved.source,
        taught: false,
        review_required: resolved.review_required === true,
        review_note: resolved.review_note ?? null,
      };
    }
    const taught = taughtById.get(field.control_id);
    if (!taught) throw new Error(`field is neither resolved nor answered: ${field.control_id} (${field.label})`);
    return {
      control_id: field.control_id,
      label: field.label,
      type: field.type,
      required: field.required === true,
      answer: taught.answer,
      resolution: 'novel',
      provenance: 'model',
      taught: true,
      review_required: taught.review_required === true,
      review_note: taught.review_note ?? null,
    };
  });
}

function attachmentEvidence(attachments, afterChips) {
  if (attachments == null) return [];
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  return attachments.map((item, index) => {
    const path = requiredText(item.path, `attachments[${index}].path`);
    const controlId = requiredText(item.control_id, `attachments[${index}].control_id`);
    const kind = requiredText(item.kind, `attachments[${index}].kind`);
    const expectedBase = basename(path);
    const displayed = afterChips.find((chip) => basename(chip) === expectedBase);
    if (!displayed) {
      throw new Error(`attachment ${expectedBase} is not visible in the after-fill snapshot ` +
        `(portal-displayed files: ${afterChips.join(', ') || 'none'})`);
    }
    const absolute = resolve(ROOT, path);
    statSync(absolute); // must exist locally; receipt re-hashes against role assets
    return {
      control_id: controlId,
      kind,
      expected: path,
      displayed,
      asset_sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      verified: true,
    };
  });
}

function completeCommand(roleId, payload) {
  const { role, progress } = roleAndProgress(roleId);
  assertNotLeanForReceiptCommand(progress, 'complete');
  const evidence = progress.pending_resolver_evidence;
  if (!evidence) {
    throw new Error('no staged lookup evidence for this page; run apply-page.mjs lookup first');
  }
  if (evidence.capture !== 'snapshot-file' || !evidence.snapshot_path) {
    throw new Error('staged evidence is not snapshot-file derived; re-run apply-page.mjs lookup');
  }

  // The before-file must still exist unchanged: its bytes anchor the receipt.
  const beforeSnap = readSnapshotFile(evidence.snapshot_path);
  if (beforeSnap.digest !== evidence.snapshot_digest) {
    throw new Error('the before-fill snapshot file changed since lookup; re-run lookup on a fresh snapshot');
  }

  const afterPath = requiredText(payload.after_snapshot, 'complete.after_snapshot');
  const afterSnap = readSnapshotFile(afterPath);
  const rescanSnap = payload.rescan_snapshot
    ? readSnapshotFile(requiredText(payload.rescan_snapshot, 'complete.rescan_snapshot'))
    : afterSnap;

  const fieldCount = (evidence.fields ?? []).length;
  if (fieldCount > 0 && afterSnap.digest === beforeSnap.digest) {
    throw new Error('after-fill snapshot is identical to the before snapshot; fill the page, re-snapshot, then complete');
  }

  // Conditional-field policy: any control added or removed since lookup makes
  // the staged evidence stale — hard fail with the exact re-lookup step.
  // Controls the lookup explicitly excluded stay excluded here.
  const excluded = new Set(evidence.excluded_controls ?? []);
  const afterFields = extractFields(afterSnap.tree)
    .filter((field) => !excluded.has(field.control_id));
  const diff = compareFieldSets(evidence.fields ?? [], afterFields);
  if (diff.added.length) {
    throw new Error('conditional field(s) appeared after filling: ' +
      diff.added.map((field) => `${field.control_id} (${field.label})`).join(', ') +
      ' — re-run apply-page.mjs lookup on the new snapshot, answer the new question(s), then complete');
  }
  if (diff.removed.length) {
    throw new Error('field(s) disappeared after filling: ' +
      diff.removed.map((field) => `${field.control_id} (${field.label})`).join(', ') +
      ' — re-run apply-page.mjs lookup on the new snapshot');
  }

  const alerts = extractValidationAlerts(afterSnap.tree);
  if (alerts.length) {
    throw new Error('the portal shows validation errors; fix them, re-snapshot, then complete: ' + alerts.join(' | '));
  }

  const ordered = orderedTeachAnswers(evidence, Array.isArray(payload.answers) ? payload.answers : []);

  // Machine verification of populated values (v3.1 §7) runs BEFORE the teach
  // barrier so a wrong answer or unfilled control fails without committing
  // anything: critical fields must match after conservative normalization;
  // anything else degrades to a warning that rides on the page receipt into
  // the combined review.
  const ledger = buildFieldLedger(evidence, ordered);
  const verification = verifyPopulatedValues(afterSnap.tree, ledger.map((field) => ({
    control_id: field.control_id,
    answer: field.answer,
  })));
  const failures = verification.filter((item) => !item.verified);
  const criticalFailures = failures.filter((item) => {
    const field = ledger.find((entry) => entry.control_id === item.control_id);
    return isCriticalField(field?.label);
  });
  if (criticalFailures.length) {
    throw new Error('critical field(s) failed populated-value verification: ' +
      criticalFailures.map((item) => {
        const field = ledger.find((entry) => entry.control_id === item.control_id);
        return `${item.control_id} (${field?.label}) rendered ${JSON.stringify(item.rendered ?? '')}`;
      }).join('; ') +
      ' — fix the value in the browser, re-snapshot, and re-run complete');
  }
  const warnings = failures.map((item) => {
    const field = ledger.find((entry) => entry.control_id === item.control_id);
    return {
      control_id: item.control_id,
      label: field?.label ?? item.control_id,
      reason: item.reason ?? 'rendered value could not be machine-verified',
    };
  });

  // Teach barrier — machine-ordered from staged novel evidence; idempotent on
  // retries (a later receipt failure re-enters complete with teach done).
  if (evidence.teach) {
    if (!teachMatchesAnswers(evidence.teach, ordered)) {
      throw new Error('this page was already taught with different answers; re-run lookup to restage the page');
    }
  } else {
    liveTeach(roleId, JSON.stringify({
      run_id: evidence.run_id,
      tab_id: evidence.tab_id,
      page_id: evidence.page_id,
      page_index: evidence.page_index,
      url: evidence.url,
      snapshot_digest: evidence.snapshot_digest,
      observed_at: evidence.observed_at,
      evidence_id: evidence.evidence_id,
      answers: ordered,
    }));
  }

  const finalPage = payload.final_page === true;
  let submitBoundary = null;
  if (finalPage) {
    const boundaries = findSubmitBoundary(afterSnap.tree);
    if (!boundaries.length) {
      throw new Error('final page requires an observed submit boundary control in the snapshot');
    }
    submitBoundary = { present: true, control_id: boundaries[0].control_id, label: boundaries[0].label };
  }

  const afterChips = extractDisplayedFilenames(afterSnap.tree);
  const attachments = attachmentEvidence(payload.attachments, afterChips);

  const manifest = ledger.map((field) => ({
    control_id: field.control_id,
    label: field.label,
    type: field.type,
    required: field.required,
  }));
  const observationStep = (snap) => ({
    snapshot_digest: snap.digest,
    url: evidence.url,
    field_manifest: manifest,
    captured_at: snap.observed_at,
  });

  const receiptPayload = {
    run_id: evidence.run_id,
    tab_id: evidence.tab_id,
    page_id: evidence.page_id,
    page_index: evidence.page_index,
    url: evidence.url,
    field_count: fieldCount,
    fields: ledger,
    upload_controls: evidence.upload_controls ?? [],
    final_page: finalPage,
    lookup_completed: true,
    l3_completed: true,
    teach_completed: true,
    conditional_rescan_completed: true,
    verified: true,
    validation_errors: [],
    resolver_evidence_id: evidence.evidence_id,
    attachments,
    ...(warnings.length ? { verification_warnings: warnings } : {}),
    browser_observation: {
      source: 'playwright-mcp',
      page_kind: finalPage ? 'review' : 'form',
      before: {
        snapshot_digest: evidence.snapshot_digest,
        url: evidence.url,
        field_manifest: manifest,
        captured_at: evidence.observed_at,
      },
      rescan: observationStep(rescanSnap),
      after: {
        ...observationStep(afterSnap),
        populated_manifest: ledger.map((field) => ({
          control_id: field.control_id,
          answer_digest: createHash('sha256').update(field.answer).digest('hex'),
        })),
        validation_errors: [],
      },
      ...(submitBoundary ? { submit_boundary: submitBoundary } : {}),
    },
    verified_at: afterSnap.observed_at,
  };

  const page = recordRolePage(roleId, receiptPayload);
  return {
    role: `${role.company ?? ''} – ${role.title ?? ''}`,
    page_id: page.page_id,
    page_index: page.page_index,
    fingerprint: page.fingerprint.slice(0, 16),
    field_count: page.field_count,
    resolved_count: page.resolved_count,
    novel_count: page.novel_count,
    review_required: (page.review_required ?? []).length,
    verification_warnings: warnings,
    final_page: finalPage,
    ...(submitBoundary ? { submit_boundary: submitBoundary.label } : {}),
    next: finalPage
      ? 'run apply-page.mjs finalize with the Application Answers report; NEVER press the submit control'
      : 'press Next/Continue in the browser (never a final submit control), snapshot the next page, then lookup',
  };
}

// ── finalize ──────────────────────────────────────────────────────────────────

function finalizeCommand(roleId, payload) {
  const { role, progress } = roleAndProgress(roleId);
  assertNotLeanForReceiptCommand(progress, 'finalize');
  const finalPage = (progress.pages ?? []).find((page) => page.final_page);
  if (!finalPage) throw new Error('record the final review page with apply-page.mjs complete before finalize');

  // Attachments: reuse the exact control/hash-bound evidence from the final
  // page receipt unless the caller supplies its own (finalize revalidates
  // against role assets either way).
  const attachments = payload.attachments ?? finalPage.attachments ?? [];
  const progressOut = finalizeRole(roleId, {
    run_id: progress.run_id,
    final_url: payload.final_url ?? finalPage.url,
    application_answers_report: requiredText(payload.application_answers_report, 'finalize.application_answers_report'),
    attachments,
    ...(payload.attachments_not_applicable_reason
      ? { attachments_not_applicable_reason: payload.attachments_not_applicable_reason }
      : {}),
    validation_errors: [],
    ...(payload.finalized_at ? { finalized_at: payload.finalized_at } : {}),
  });
  return {
    role: `${role.company ?? ''} – ${role.title ?? ''}`,
    receipt_id: progressOut.receipt_id,
    review_ready: progressOut.review_ready,
    report_state: progressOut.report_state,
    pages: progressOut.pages.length,
    verification_warnings: (progressOut.verification_warnings ?? []).length,
    review_required: (progressOut.review_required ?? []).length,
    next: 'present the combined review; the candidate reviews every tab and submits manually',
  };
}

// ── page-done (lean) ──────────────────────────────────────────────────────────

function pageDoneCommand(roleId, payload) {
  const { progress } = roleAndProgress(roleId);
  if (!isLeanProgress(progress)) {
    throw new Error(
      'page-done is only valid for lean-llm-v1 runs; use complete for receipt-v3',
    );
  }
  const entry = recordLeanPage(roleId, payload);
  return {
    execution_protocol: EXECUTION_PROTOCOL_LEAN,
    page_index: entry.page_index,
    url: entry.url,
    final_page: entry.final_page === true,
    next: entry.final_page
      ? 'run apply-page.mjs finish with compact review + Application Answers report; NEVER press the submit control'
      : 'press Next/Continue in the browser (never a final submit control), observe the next page, then lookup',
  };
}

// ── finish (lean) ─────────────────────────────────────────────────────────────

function finishCommand(roleId, payload) {
  const { role, progress } = roleAndProgress(roleId);
  if (!isLeanProgress(progress)) {
    throw new Error(
      'finish is only valid for lean-llm-v1 runs; use finalize for receipt-v3',
    );
  }
  const out = finishLean(roleId, payload);
  return {
    role: `${role.company ?? ''} – ${role.title ?? ''}`,
    status: out.status,
    execution_protocol: EXECUTION_PROTOCOL_LEAN,
    pages_completed: out.pages_completed,
    lean_review: out.lean_review,
    next: 'present the compact lean review; the candidate reviews and submits manually, then Mark Submitted on the dashboard',
  };
}

// ── fallback ──────────────────────────────────────────────────────────────────

function fallbackCommand(roleId, payload) {
  const { progress } = roleAndProgress(roleId);
  if (isLeanProgress(progress)) {
    // Lean can still mark unsupported widgets for manual review without receipts.
    const block = recordRoleFallback(roleId, payload);
    return {
      recorded: true,
      execution_protocol: EXECUTION_PROTOCOL_LEAN,
      reason: block.reason,
      control_ids: block.control_ids,
      page_index: block.page_index,
      consequence: 'lean run stays on the manual-review path; finish at prefilled only after the candidate can review the affected controls',
    };
  }
  const block = recordRoleFallback(roleId, payload);
  return {
    recorded: true,
    reason: block.reason,
    control_ids: block.control_ids,
    page_index: block.page_index,
    consequence: 'this run can never become review-ready `filled`; the role stays in the manual-review path and the candidate reviews/submits by hand',
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const COMMANDS = {
  begin: beginCommand,
  lookup: lookupCommand,
  'page-done': pageDoneCommand,
  finish: finishCommand,
  complete: completeCommand,
  finalize: finalizeCommand,
  fallback: fallbackCommand,
};

function main() {
  const [, , cmd, roleId, jsonArg] = process.argv;
  const handler = COMMANDS[cmd];
  if (!handler || !roleId) {
    process.stderr.write(
      'usage: node apply-page.mjs <begin|lookup|page-done|finish|complete|finalize|fallback> <role-id> \'<json|@file>\'\n',
    );
    process.exit(1);
  }
  const payload = readJsonArg(jsonArg, cmd);
  const out = handler(roleId, payload);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`apply-page ${process.argv[2] ?? ''}: ${err.message}\n`);
    process.exit(1);
  }
}

export {
  lookupCommand, completeCommand, beginCommand, finalizeCommand, fallbackCommand,
  pageDoneCommand, finishCommand,
};
