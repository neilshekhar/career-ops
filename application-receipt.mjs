#!/usr/bin/env node
/**
 * Durable live-application workflow ledger.
 *
 * This module does not drive a browser or call a model. It records evidence that
 * the canonical per-page workflow happened, is the only supported promotion
 * path from a new prepared run (or a legacy prefilled checkpoint) to review-ready
 * filled, and owns the receipt-bound report transition after candidate-confirmed
 * submission.
 */

import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';

import { mutateQueue, loadQueue, setStatus } from './queue-store.mjs';
import {
  normalizeApplicationAnswerLabel,
  normalizeApplicationAnswerValue,
  parseApplicationAnswersSection,
} from './application-answers.mjs';
import {
  createApplicationQualityEvidence,
  validateApplicationQualityEvidence,
} from './verify-userdata.mjs';
import {
  APPLICATION_RECEIPT_REQUEST_CONTRACT,
  compareApplicationDestination,
  createApplicationReceiptIntegrity,
  validateApplicationReceiptIntegrity,
} from './application-receipt-integrity.mjs';
import { applicationActionDecision, isFinalApplicationActionLabel } from './application-safety.mjs';
import { isLeanCompleteRole } from './run-partition.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEST_ENTRYPOINT = basename(process.argv[1] || '');
const TEST_PROJECT_ROOT_ALLOWED = process.env.NODE_ENV === 'test'
  && (TEST_ENTRYPOINT.endsWith('.test.mjs') || TEST_ENTRYPOINT === 'test-all.mjs');
const APPLICATION_PROJECT_ROOT = TEST_PROJECT_ROOT_ALLOWED && process.env.CAREER_OPS_TEST_PROJECT_ROOT
  ? resolve(process.env.CAREER_OPS_TEST_PROJECT_ROOT)
  : ROOT;
function testOnlyPathOverride(envName, fallback) {
  const value = process.env[envName];
  if (!value) return fallback;
  if (!TEST_PROJECT_ROOT_ALLOWED) {
    throw new Error(`${envName} is test-only and cannot redirect production application evidence`);
  }
  return resolve(value);
}
const HANDOVER_PATH = testOnlyPathOverride('CAREER_OPS_HANDOVER_PATH', join(ROOT, 'handover.md'));
const HANDOVER_LOCK_PATH = HANDOVER_PATH + '.lock';
const REPORTS_DIR = testOnlyPathOverride('CAREER_OPS_REPORTS_DIR', join(ROOT, 'reports'));
export const APPLICATION_RECEIPT_VERSION = 2;
const APPLICATION_FINALIZATION_TRANSACTION_VERSION = 1;
const RESOLVER_EVIDENCE_VERSION = 1;
const APPLICATION_REQUEST_VERSION = 1;
// Evidence-protocol v3: new runs are stamped
// FILE_DERIVED_CAPTURE at begin, and their page receipts only accept resolver
// evidence staged from a real snapshot file (queue-resolve stamps it
// SNAPSHOT_FILE_CAPTURE). Hand-authored envelopes are mechanically rejected on
// stamped runs; historical stored runs (no stamp) keep validating unchanged.
const FILE_DERIVED_CAPTURE = 'file-derived';
const SNAPSHOT_FILE_CAPTURE = 'snapshot-file';
const MAX_ACTIVE_APPLICATION_REQUESTS = 4;
const ACTIVE_APPLICATION_REQUEST_STATES = new Set(['queued', 'in-progress']);
const BEGIN_ALLOWED_STATUSES = new Set(['prepared', 'prefilled']);
const FINALIZE_ALLOWED_STATUSES = new Set(['prepared', 'prefilled']);
const PREFLIGHT_METHODS = new Set(['check-liveness', 'ats-api', 'public-api', 'playwright', 'browser-snapshot']);
const BROWSER_PREFLIGHT_METHODS = new Set(['playwright', 'browser-snapshot']);

function iso(value = null) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error('invalid timestamp: ' + value);
  return d.toISOString();
}

function requiredText(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(name + ' is required');
  return out;
}

function nonNegativeInteger(value, name) {
  const out = Number(value);
  if (!Number.isInteger(out) || out < 0) throw new Error(name + ' must be a non-negative integer');
  return out;
}

function requiredBoolean(value, name) {
  if (value !== true && value !== false) throw new Error(name + ' must be boolean');
  return value;
}

function requiredDigest(value, name) {
  const out = requiredText(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error(`${name} must be a SHA-256 hex digest`);
  return out;
}

function cleanPreflightEvidence(value, kind, role, fallbackUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${kind}_evidence is required; bare verification booleans are not accepted`);
  }
  const method = requiredText(value.method, `${kind}_evidence.method`).toLowerCase();
  if (!PREFLIGHT_METHODS.has(method)) throw new Error(`unsupported ${kind} evidence method: ${method}`);
  const checkedUrl = requiredText(value.checked_url ?? fallbackUrl, `${kind}_evidence.checked_url`);
  const result = requiredText(value.result, `${kind}_evidence.result`).toLowerCase();
  const expectedResult = kind === 'liveness' ? 'active' : 'matched';
  if (result !== expectedResult) throw new Error(`${kind}_evidence.result must be ${expectedResult}`);
  const browserMethod = BROWSER_PREFLIGHT_METHODS.has(method);
  const digest = browserMethod
    ? requiredDigest(value.snapshot_digest ?? value.dom_digest, `${kind}_evidence.snapshot_digest`)
    : requiredDigest(value.evidence_digest, `${kind}_evidence.evidence_digest`);
  const out = {
    method,
    checked_url: checkedUrl,
    result,
    checked_at: iso(value.checked_at),
    ...(browserMethod ? { snapshot_digest: digest } : { evidence_digest: digest }),
  };
  if (kind === 'destination') {
    out.observed_company = requiredText(value.observed_company, 'destination_evidence.observed_company');
    out.observed_title = requiredText(value.observed_title, 'destination_evidence.observed_title');
    out.observed_requisition = requiredText(
      value.observed_requisition,
      'destination_evidence.observed_requisition (use "not shown" when absent)',
    );
    out.expected_company = String(role?.company ?? '').trim();
    out.expected_title = String(role?.title ?? '').trim();
    const comparison = compareApplicationDestination(role, out);
    if (!comparison.matched) {
      throw new Error(`destination_evidence.result cannot self-attest a role match: ${comparison.errors.join('; ')}`);
    }
    out.expected_requisition = comparison.expected_requisition;
    out.requisition_compared = comparison.requisition_compared;
  }
  return out;
}

function cleanPreflight(payload, role, fallbackUrl) {
  const liveness = cleanPreflightEvidence(payload.liveness_evidence, 'liveness', role, fallbackUrl);
  const destination = cleanPreflightEvidence(payload.destination_evidence, 'destination', role, fallbackUrl);
  if (destination.checked_url !== fallbackUrl) {
    throw new Error('destination evidence checked_url must match the recorded browser tab URL');
  }
  return {
    liveness,
    destination,
    liveness_verified: liveness.result === 'active',
    role_match_verified: destination.result === 'matched',
    checked_url: liveness.checked_url,
  };
}

function parseJsonArg(arg) {
  if (!arg) throw new Error('JSON payload is required');
  const raw = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload must be a JSON object');
  }
  return value;
}

function cleanReviewItems(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('review_required must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('review_required[' + index + '] must be an object');
    }
    return {
      label: requiredText(item.label, 'review_required[' + index + '].label'),
      answer: requiredText(item.answer, 'review_required[' + index + '].answer'),
      note: requiredText(item.note ?? item.review_note, 'review_required[' + index + '].note'),
    };
  });
}

const FIELD_PROVENANCE = new Set(['deterministic', 'learned', 'cache', 'model']);
const FIELD_RESOLUTION = new Set(['resolved', 'novel']);
const UPLOAD_CONTROL_KINDS = new Set(['cv', 'cover', 'supporting', 'other']);

// Machine-verification warnings (evidence-protocol v3): fields whose rendered
// value could not be byte-compared after conservative normalization (custom
// widgets, reformatted display values). They never silently pass — each one is
// carried on the page receipt and surfaced in the candidate's combined review.
function cleanVerificationWarnings(value, fields) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('verification_warnings must be an array');
  const known = new Set(fields.map((field) => field.control_id));
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`verification_warnings[${index}] must be an object`);
    }
    const controlId = requiredText(item.control_id, `verification_warnings[${index}].control_id`);
    if (!known.has(controlId)) {
      throw new Error(`verification_warnings[${index}] references an unreceipted control: ${controlId}`);
    }
    return {
      control_id: controlId,
      label: requiredText(item.label, `verification_warnings[${index}].label`),
      reason: requiredText(item.reason, `verification_warnings[${index}].reason`),
      verified_in_snapshot: false,
    };
  });
}

function cleanUploadControls(value) {
  if (!Array.isArray(value)) {
    throw new Error('upload_controls must be an array captured from the live page');
  }
  const controls = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`upload_controls[${index}] must be an object`);
    }
    const kind = requiredText(item.kind, `upload_controls[${index}].kind`).toLowerCase();
    if (!UPLOAD_CONTROL_KINDS.has(kind)) {
      throw new Error(`upload_controls[${index}].kind must be cv, cover, supporting, or other`);
    }
    return {
      control_id: requiredText(item.control_id, `upload_controls[${index}].control_id`),
      label: requiredText(item.label, `upload_controls[${index}].label`),
      kind,
      required: requiredBoolean(item.required, `upload_controls[${index}].required`),
      multiple: requiredBoolean(item.multiple, `upload_controls[${index}].multiple`),
      enabled: requiredBoolean(item.enabled, `upload_controls[${index}].enabled`),
      accepts: String(item.accepts ?? '').trim() || null,
    };
  });
  const ids = controls.map((item) => item.control_id);
  if (new Set(ids).size !== ids.length) throw new Error('upload control_id values must be unique within a page');
  return controls;
}

function cleanFields(value, expectedCount) {
  if (!Array.isArray(value)) throw new Error('fields must be an array');
  if (value.length !== expectedCount) throw new Error('fields length must equal field_count');
  const fields = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('fields[' + index + '] must be an object');
    }
    const resolution = requiredText(item.resolution, 'fields[' + index + '].resolution').toLowerCase();
    const provenance = requiredText(item.provenance, 'fields[' + index + '].provenance').toLowerCase();
    if (!FIELD_RESOLUTION.has(resolution)) throw new Error('invalid field resolution: ' + resolution);
    if (!FIELD_PROVENANCE.has(provenance)) throw new Error('invalid field provenance: ' + provenance);
    const taught = requiredBoolean(item.taught, 'fields[' + index + '].taught');
    if (resolution === 'novel' && !taught) throw new Error('every novel field must be taught before the page receipt');
    if (resolution === 'resolved' && taught) throw new Error('resolved fields must not be counted as novel teach operations');
    const reviewRequired = requiredBoolean(item.review_required ?? false, 'fields[' + index + '].review_required');
    const reviewNote = String(item.review_note ?? '').trim();
    if (reviewRequired && !reviewNote) throw new Error('review-required field is missing review_note');
    const allowBlankAnswer = /\bhoneypot\b/i.test(String(item.label || ''))
      || /\b(middle(?:\s+name)?|second name|maiden name|custom pronoun)\b/i.test(String(item.label || ''));
    const rawAnswer = String(item.answer ?? '');
    const answer = allowBlankAnswer && !rawAnswer.trim()
      ? ''
      : requiredText(item.answer, 'fields[' + index + '].answer');
    return {
      control_id: requiredText(item.control_id, 'fields[' + index + '].control_id'),
      label: requiredText(item.label, 'fields[' + index + '].label'),
      type: requiredText(item.type ?? 'unknown', 'fields[' + index + '].type'),
      required: requiredBoolean(item.required, 'fields[' + index + '].required'),
      answer,
      resolution,
      provenance,
      taught,
      review_required: reviewRequired,
      review_note: reviewNote || null,
    };
  });
  const controlIds = fields.map((field) => field.control_id);
  if (new Set(controlIds).size !== controlIds.length) {
    throw new Error('field control_id values must be unique within a page');
  }
  return fields;
}

function fingerprintForPage(url, fields, uploadControls = []) {
  return createHash('sha256').update(JSON.stringify({
    url,
    fields,
    upload_controls: uploadControls,
  })).digest('hex');
}

function evidenceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedLabel(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function validateResolverEvidence(payload, progress, evidence, fields) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('executable resolver evidence is missing; run queue-resolve --lookup and --teach for this page');
  }
  if (evidence.version !== RESOLVER_EVIDENCE_VERSION) throw new Error('resolver evidence version is stale');
  const evidenceId = requiredText(payload.resolver_evidence_id, 'resolver_evidence_id');
  if (evidenceId !== evidence.evidence_id) throw new Error('resolver_evidence_id does not match pending executable evidence');

  const expectedContext = {
    run_id: requiredText(payload.run_id ?? progress?.run_id, 'run_id'),
    tab_id: requiredText(payload.tab_id ?? progress?.tab?.id, 'tab_id'),
    page_id: requiredText(payload.page_id, 'page_id'),
    page_index: nonNegativeInteger(payload.page_index, 'page_index'),
    url: requiredText(payload.url, 'url'),
  };
  for (const [key, value] of Object.entries(expectedContext)) {
    if (evidence[key] !== value) throw new Error(`resolver evidence ${key} does not match the page receipt`);
  }
  if (!Array.isArray(evidence.fields) || !Array.isArray(evidence.resolved) || !Array.isArray(evidence.novel)) {
    throw new Error('resolver lookup evidence is malformed');
  }
  const lookupCore = {
    version: evidence.version,
    evidence_id: evidence.evidence_id,
    run_id: evidence.run_id,
    tab_id: evidence.tab_id,
    page_id: evidence.page_id,
    page_index: evidence.page_index,
    url: evidence.url,
    snapshot_digest: requiredDigest(evidence.snapshot_digest, 'resolver evidence snapshot_digest'),
    observed_at: iso(evidence.observed_at),
    fields: evidence.fields,
    resolved: evidence.resolved,
    novel: evidence.novel,
  };
  if (evidence.lookup_fingerprint !== evidenceHash(lookupCore)) {
    throw new Error('resolver lookup evidence fingerprint is invalid');
  }
  if (!evidence.lookup_completed_at) throw new Error('resolver lookup completion timestamp is missing');

  const teach = evidence.teach;
  if (!teach || typeof teach !== 'object' || !Array.isArray(teach.answers)) {
    throw new Error('executable teach evidence is missing; run queue-resolve --teach for this page');
  }
  const teachCore = {
    evidence_id: evidence.evidence_id,
    run_id: evidence.run_id,
    tab_id: evidence.tab_id,
    page_id: evidence.page_id,
    page_index: evidence.page_index,
    url: evidence.url,
    snapshot_digest: evidence.snapshot_digest,
    observed_at: evidence.observed_at,
    answers: teach.answers,
  };
  if (teach.teach_fingerprint !== evidenceHash(teachCore)) {
    throw new Error('resolver teach evidence fingerprint is invalid');
  }
  if (!teach.completed_at) throw new Error('resolver teach completion timestamp is missing');

  if (evidence.fields.length !== fields.length) {
    throw new Error('page field ledger does not match the executable lookup field set');
  }
  const labels = evidence.fields.map((field) => normalizedLabel(field.label));
  if (labels.some((label) => !label)) throw new Error('resolver evidence field labels must be non-empty');
  evidence.fields.forEach((field, index) => {
    const actual = fields[index];
    if (String(field.control_id).trim() !== actual.control_id ||
        String(field.label).trim() !== actual.label ||
        (String(field.type ?? 'unknown').trim() || 'unknown') !== actual.type ||
        (field.required === true) !== actual.required) {
      throw new Error(`field ${index} does not match the executable lookup evidence`);
    }
  });

  const bucket = (items, name) => {
    const out = new Map();
    for (const item of items) {
      const key = `${requiredText(item.control_id, `resolver ${name} control_id`)}\u0000${normalizedLabel(item.label)}`;
      if (!key) throw new Error(`resolver ${name} evidence has an empty label`);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(item);
    }
    return out;
  };
  const resolvedByLabel = bucket(evidence.resolved, 'resolved');
  const novelByLabel = bucket(evidence.novel, 'novel');
  const taughtByLabel = bucket(teach.answers, 'teach');
  if (evidence.resolved.length + evidence.novel.length !== fields.length) {
    throw new Error('resolver evidence does not classify every extracted page field');
  }
  if (JSON.stringify(teach.answers.map((item) => `${item.control_id}\u0000${normalizedLabel(item.label)}`)) !==
      JSON.stringify(evidence.novel.map((item) => `${item.control_id}\u0000${normalizedLabel(item.label)}`))) {
    throw new Error('teach evidence does not cover every novel lookup field');
  }

  for (const field of fields) {
    const key = `${field.control_id}\u0000${normalizedLabel(field.label)}`;
    if (field.resolution === 'resolved') {
      const resolved = resolvedByLabel.get(key)?.shift();
      if (!resolved) throw new Error(`resolved classification is missing for: ${field.label}`);
      if (field.resolution !== 'resolved' || field.taught !== false) {
        throw new Error(`resolved field ledger disagrees with lookup evidence: ${field.label}`);
      }
      if (String(resolved.answer) !== field.answer || String(resolved.source).toLowerCase() !== field.provenance) {
        throw new Error(`resolved answer/provenance disagrees with lookup evidence: ${field.label}`);
      }
      if ((resolved.review_required === true) !== field.review_required) {
        throw new Error(`resolved review flag disagrees with lookup evidence: ${field.label}`);
      }
      if (String(resolved.review_note ?? '').trim() !== String(field.review_note ?? '').trim()) {
        throw new Error(`resolved review note disagrees with lookup evidence: ${field.label}`);
      }
    } else {
      const novel = novelByLabel.get(key)?.shift();
      const taught = taughtByLabel.get(key)?.shift();
      if (!novel || !taught) throw new Error(`novel/teach classification is missing for: ${field.label}`);
      if (field.resolution !== 'novel' || field.provenance !== 'model' || field.taught !== true) {
        throw new Error(`novel field ledger disagrees with teach evidence: ${field.label}`);
      }
      if (String(taught.answer) !== field.answer || (taught.review_required === true) !== field.review_required) {
        throw new Error(`novel answer/review flag disagrees with teach evidence: ${field.label}`);
      }
      const evidenceNote = String(taught.review_note ?? '').trim();
      if (evidenceNote !== String(field.review_note ?? '').trim()) {
        throw new Error(`novel review note disagrees with teach evidence: ${field.label}`);
      }
    }
  }
  const leftovers = [...resolvedByLabel.values(), ...novelByLabel.values(), ...taughtByLabel.values()]
    .reduce((count, items) => count + items.length, 0);
  if (leftovers) throw new Error('resolver evidence contains unconsumed field classifications');

  return {
    version: evidence.version,
    evidence_id: evidence.evidence_id,
    snapshot_digest: lookupCore.snapshot_digest,
    observed_at: lookupCore.observed_at,
    lookup_fingerprint: evidence.lookup_fingerprint,
    lookup_completed_at: iso(evidence.lookup_completed_at),
    teach_fingerprint: teach.teach_fingerprint,
    teach_completed_at: iso(teach.completed_at),
  };
}

function cleanAttachments(value, options = {}) {
  const allowEmpty = options.allowEmpty ?? true;
  const naReason = String(options.naReason ?? '').trim();
  const items = value == null ? [] : value;
  if (!Array.isArray(items)) throw new Error('attachments must be an array');
  if (!items.length && !allowEmpty && !naReason) {
    throw new Error('attachments or attachments_not_applicable_reason is required');
  }
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('attachments[' + index + '] must be an object');
    }
    const expected = requiredText(item.expected, 'attachments[' + index + '].expected');
    const displayed = requiredText(item.displayed, 'attachments[' + index + '].displayed');
    if (requiredBoolean(item.verified, 'attachments[' + index + '].verified') !== true) {
      throw new Error('attachments[' + index + '] is not verified');
    }
    if (basename(expected) !== basename(displayed)) {
      throw new Error('attachments[' + index + '] displayed filename does not match expected asset');
    }
    return {
      control_id: requiredText(item.control_id, 'attachments[' + index + '].control_id'),
      kind: requiredText(item.kind, 'attachments[' + index + '].kind'),
      expected,
      displayed,
      asset_sha256: item.asset_sha256 == null
        ? null
        : requiredDigest(item.asset_sha256, 'attachments[' + index + '].asset_sha256'),
      verified: true,
    };
  });
}

function roleAssetPaths(role) {
  const covers = role?.cover_letter_paths;
  const coverValues = Array.isArray(covers)
    ? covers
    : (covers && typeof covers === 'object' ? Object.values(covers) : (typeof covers === 'string' ? [covers] : []));
  if (role?.cover_letter_path) coverValues.push(role.cover_letter_path);
  return {
    cv: role?.cv_pdf ? [String(role.cv_pdf)] : [],
    cover: [...new Set(coverValues.filter((value) => typeof value === 'string' && value.trim()).map(String))],
  };
}

function assertRoleAttachments(role, value, options = {}) {
  const attachments = cleanAttachments(value, options);
  const assets = roleAssetPaths(role);
  const seenKinds = new Set();
  for (const attachment of attachments) {
    const kind = attachment.kind.toLowerCase();
    let candidates;
    let canonicalKind;
    if (/(?:cv|resume|résumé)/i.test(kind)) {
      candidates = assets.cv;
      canonicalKind = 'cv';
    } else if (/cover/.test(kind)) {
      candidates = assets.cover;
      canonicalKind = 'cover';
    } else {
      candidates = [...assets.cv, ...assets.cover];
      canonicalKind = 'other';
    }
    const expectedPath = resolve(ROOT, attachment.expected);
    const matched = candidates.find((candidate) => resolve(ROOT, candidate) === expectedPath);
    if (!matched) {
      throw new Error(`attachment ${attachment.kind} is not one of this role's cv_pdf/cover_letter_paths assets`);
    }
    if (/^https?:\/\//i.test(matched)) {
      throw new Error('application attachment evidence must reference a local validated asset');
    }
    const absolute = resolve(ROOT, matched);
    if (!existsSync(absolute)) {
      throw new Error(`role attachment asset does not exist: ${matched}`);
    }
    const assetSha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (attachment.asset_sha256 && attachment.asset_sha256 !== assetSha256) {
      throw new Error(`attachment ${attachment.kind} content hash does not match the role asset`);
    }
    attachment.asset_sha256 = assetSha256;
    const dedupeKey = `${attachment.control_id}:${canonicalKind}:${assetSha256}`;
    if (seenKinds.has(dedupeKey)) throw new Error(`duplicate final attachment evidence: ${basename(matched)}`);
    seenKinds.add(dedupeKey);
  }
  return attachments;
}

function attachmentIdentity(items) {
  return items.map((item) => ({
    control_id: item.control_id,
    kind: item.kind,
    expected: basename(item.expected),
    displayed: basename(item.displayed),
    asset_sha256: item.asset_sha256,
    verified: item.verified === true,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function uploadControlMap(pages = [], current = []) {
  const map = new Map();
  for (const control of [...pages.flatMap((page) => page.upload_controls ?? []), ...current]) {
    const previous = map.get(control.control_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(control)) {
      throw new Error(`upload control ${control.control_id} changed identity during the application`);
    }
    map.set(control.control_id, control);
  }
  return map;
}

function assertAttachmentCoverage(uploadControls, attachments, notApplicableReason = '') {
  const controls = new Map(uploadControls.map((control) => [control.control_id, control]));
  for (const attachment of attachments) {
    const control = controls.get(attachment.control_id);
    if (!control) {
      throw new Error(`attachment control_id was not observed on the live application: ${attachment.control_id}`);
    }
    if (!control.enabled) {
      throw new Error(`attachment control_id was disabled on the live application: ${attachment.control_id}`);
    }
  }
  const byControl = new Map();
  for (const attachment of attachments) {
    if (!byControl.has(attachment.control_id)) byControl.set(attachment.control_id, []);
    byControl.get(attachment.control_id).push(attachment);
  }
  const enabledControls = uploadControls.filter((control) => control.enabled);
  const reason = String(notApplicableReason).trim();
  if (attachments.length > 0 && reason) {
    throw new Error('attachments_not_applicable_reason cannot accompany verified attachments');
  }
  if (enabledControls.length > 0 && reason) {
    throw new Error('attachments_not_applicable_reason is invalid while an enabled upload control accepts an attachment');
  }
  if (enabledControls.length > 0 && attachments.length === 0) {
    throw new Error('enabled upload controls require verified attachment evidence');
  }
  for (const control of enabledControls) {
    const attached = byControl.get(control.control_id) ?? [];
    if (control.kind === 'cv' && !attached.some((item) => /(?:cv|resume|résumé)/i.test(item.kind))) {
      throw new Error(`CV upload control was observed but no verified CV was attached: ${control.label}`);
    }
    if ((control.kind === 'cover' || control.kind === 'supporting') &&
        !attached.some((item) => /cover/i.test(item.kind))) {
      throw new Error(`cover-compatible upload control was observed but no verified cover letter was attached: ${control.label}`);
    }
    if (control.kind === 'other' && control.required && attached.length === 0) {
      throw new Error(`required upload control has no verified attachment: ${control.label}`);
    }
  }
  if (enabledControls.length === 0 && attachments.length === 0 && !reason) {
    throw new Error('no enabled upload controls requires attachments_not_applicable_reason');
  }
}

function cleanProvenance(value, fieldCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provenance_counts is required');
  }
  const out = {
    deterministic: nonNegativeInteger(value.deterministic ?? 0, 'provenance_counts.deterministic'),
    learned: nonNegativeInteger(value.learned ?? 0, 'provenance_counts.learned'),
    cache: nonNegativeInteger(value.cache ?? 0, 'provenance_counts.cache'),
    model: nonNegativeInteger(value.model ?? 0, 'provenance_counts.model'),
  };
  const total = Object.values(out).reduce((sum, n) => sum + n, 0);
  if (total !== fieldCount) throw new Error('provenance_counts must sum to field_count');
  return out;
}

const PAGE_KINDS = new Set(['form', 'review']);

function observationManifest(fields) {
  return fields.map((field) => ({
    control_id: field.control_id,
    label: field.label,
    type: field.type,
    required: field.required,
  }));
}

function cleanObservationManifest(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    return {
      control_id: requiredText(item.control_id, `${name}[${index}].control_id`),
      label: requiredText(item.label, `${name}[${index}].label`),
      type: requiredText(item.type ?? 'unknown', `${name}[${index}].type`),
      required: requiredBoolean(item.required, `${name}[${index}].required`),
    };
  });
}

function cleanObservationStep(value, name, url, expectedManifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`browser_observation.${name} is required`);
  }
  const stepUrl = requiredText(value.url, `browser_observation.${name}.url`);
  if (stepUrl !== url) throw new Error(`browser_observation.${name}.url does not match the page receipt`);
  const manifest = cleanObservationManifest(
    value.field_manifest,
    `browser_observation.${name}.field_manifest`,
  );
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error(`browser_observation.${name}.field_manifest does not match the receipted controls`);
  }
  return {
    snapshot_digest: requiredDigest(
      value.snapshot_digest,
      `browser_observation.${name}.snapshot_digest`,
    ),
    url: stepUrl,
    field_manifest: manifest,
    captured_at: iso(value.captured_at),
  };
}

function cleanBrowserObservation(value, { fields, url, resolverEvidence, finalPage }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser_observation is required; verification booleans cannot receipt a page');
  }
  if (requiredText(value.source, 'browser_observation.source').toLowerCase() !== 'playwright-mcp') {
    throw new Error('browser_observation.source must be playwright-mcp');
  }
  const pageKind = requiredText(value.page_kind, 'browser_observation.page_kind').toLowerCase();
  if (!PAGE_KINDS.has(pageKind)) throw new Error('browser_observation.page_kind must be form or review');
  if (fields.length === 0 && (!finalPage || pageKind !== 'review')) {
    throw new Error('a zero-field receipt is allowed only for an evidenced final review page');
  }
  const manifest = observationManifest(fields);
  const before = cleanObservationStep(value.before, 'before', url, manifest);
  const rescan = cleanObservationStep(value.rescan, 'rescan', url, manifest);
  const after = cleanObservationStep(value.after, 'after', url, manifest);
  if (before.snapshot_digest !== resolverEvidence.snapshot_digest) {
    throw new Error('browser_observation.before snapshot does not match queue-resolve lookup evidence');
  }
  if (before.captured_at !== resolverEvidence.observed_at) {
    throw new Error('browser_observation.before timestamp does not match queue-resolve lookup evidence');
  }
  const times = [before, rescan, after].map((step) => Date.parse(step.captured_at));
  if (times[1] < times[0] || times[2] < times[1]) {
    throw new Error('browser observations must be ordered before → rescan → after');
  }
  if (fields.length > 0 && after.snapshot_digest === before.snapshot_digest) {
    throw new Error('post-fill browser snapshot must differ from the pre-fill snapshot');
  }
  const validationErrors = value.after.validation_errors ?? [];
  if (!Array.isArray(validationErrors)) {
    throw new Error('browser_observation.after.validation_errors must be an array');
  }
  if (validationErrors.length) throw new Error('browser observation still has validation errors');
  const populated = value.after.populated_manifest;
  if (!Array.isArray(populated)) {
    throw new Error('browser_observation.after.populated_manifest must be an array');
  }
  const cleanedPopulated = populated.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`browser_observation.after.populated_manifest[${index}] must be an object`);
    }
    return {
      control_id: requiredText(
        item.control_id,
        `browser_observation.after.populated_manifest[${index}].control_id`,
      ),
      answer_digest: requiredDigest(
        item.answer_digest,
        `browser_observation.after.populated_manifest[${index}].answer_digest`,
      ),
    };
  });
  const expectedPopulated = fields.map((field) => ({
    control_id: field.control_id,
    answer_digest: createHash('sha256').update(field.answer).digest('hex'),
  }));
  if (JSON.stringify(cleanedPopulated) !== JSON.stringify(expectedPopulated)) {
    throw new Error('browser populated manifest does not match every receipted answer');
  }
  let submitBoundary = null;
  if (finalPage) {
    const raw = value.submit_boundary;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.present !== true) {
      throw new Error('final review receipt requires an observed submit boundary');
    }
    submitBoundary = {
      present: true,
      control_id: requiredText(raw.control_id, 'browser_observation.submit_boundary.control_id'),
      label: requiredText(raw.label, 'browser_observation.submit_boundary.label'),
    };
    if (!isFinalApplicationActionLabel(submitBoundary.label)) {
      throw new Error('final review submit boundary label is not a recognized final application action');
    }
    const decision = applicationActionDecision(submitBoundary.label, {
      phase: 'application-submit',
      applicationSubmissionDetected: true,
    });
    if (decision.allowed || !/candidate-only/.test(decision.reason ?? '')) {
      throw new Error('final review submit boundary did not pass the candidate-only action policy');
    }
  }
  return {
    source: 'playwright-mcp',
    page_kind: pageKind,
    before,
    rescan,
    after: {
      ...after,
      populated_manifest: cleanedPopulated,
      validation_errors: [],
    },
    ...(submitBoundary ? { submit_boundary: submitBoundary } : {}),
  };
}

function applicationRequestForRun(role, runIdValue, expectedState, controllerIdValue = null) {
  const request = role?.application_request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('a durable queued dashboard application_request is required before receipt begin');
  }
  if (request.version !== APPLICATION_REQUEST_VERSION) {
    throw new Error('application_request version is stale');
  }
  if (request.controller !== 'active-agent') {
    throw new Error('application_request controller must be active-agent');
  }
  const controllerId = requiredText(request.controller_id, 'application_request.controller_id');
  if (controllerIdValue != null && requiredText(controllerIdValue, 'controller_id') !== controllerId) {
    throw new Error('application_request controller_id does not match the browser controller');
  }
  if (request.state !== expectedState) {
    throw new Error(`application_request state must be ${expectedState}`);
  }
  if (requiredText(request.role_id, 'application_request.role_id') !== role.id) {
    throw new Error('application_request belongs to a different role');
  }
  const runId = requiredText(runIdValue ?? request.run_id, 'run_id');
  if (requiredText(request.run_id, 'application_request.run_id') !== runId) {
    throw new Error('application_request run_id does not match the receipt run');
  }
  if (requiredText(request.request_id, 'application_request.request_id') !== `${runId}:${role.id}`) {
    throw new Error('application_request request_id does not match its role/run');
  }
  if (!/^dashboard(?:-|$)/.test(requiredText(request.source, 'application_request.source'))) {
    throw new Error('application_request must originate from the dashboard');
  }
  if (JSON.stringify(request.contract) !== JSON.stringify(APPLICATION_RECEIPT_REQUEST_CONTRACT)) {
    throw new Error('application_request contract is missing or stale');
  }
  iso(request.requested_at);
  return { request, runId, controllerId };
}

function assertControllerQueueLease(queue, role, controllerId, tabId) {
  if (!queue) return;
  const lease = queue.settings?.application_controller;
  if (!lease || lease.version !== 1 || lease.controller !== 'active-agent') {
    throw new Error('queue browser-controller lease is missing or stale');
  }
  if (requiredText(lease.controller_id, 'application_controller.controller_id') !== controllerId) {
    throw new Error('application request does not belong to the queue browser-controller lease');
  }
  if (Number(lease.max_active_roles) !== MAX_ACTIVE_APPLICATION_REQUESTS) {
    throw new Error(`application controller concurrency must be ${MAX_ACTIVE_APPLICATION_REQUESTS}`);
  }
  const active = (queue.roles ?? []).filter(
    (item) => ACTIVE_APPLICATION_REQUEST_STATES.has(item?.application_request?.state),
  );
  if (active.length > MAX_ACTIVE_APPLICATION_REQUESTS) {
    throw new Error(`browser-controller has more than ${MAX_ACTIVE_APPLICATION_REQUESTS} active roles`);
  }
  for (const item of queue.roles ?? []) {
    if (item.id === role.id) continue;
    const otherRequest = item.application_request;
    if (ACTIVE_APPLICATION_REQUEST_STATES.has(otherRequest?.state) &&
        otherRequest.controller_id !== controllerId) {
      throw new Error('multiple browser-controller leases are active in the same queue');
    }
    if (item.application_progress?.tab?.id === tabId) {
      throw new Error(`browser tab ${tabId} is already bound to role ${item.id}`);
    }
  }
}

export function beginApplicationProgress(role, payload = {}, { queue = null } = {}) {
  if (!role?.id) throw new Error('role is required');
  if (!BEGIN_ALLOWED_STATUSES.has(role.status)) {
    throw new Error(`application receipt may begin only from: ${[...BEGIN_ALLOWED_STATUSES].join(', ')}`);
  }
  // A finished lean run also lands on `prefilled`, so status alone no longer
  // proves the role is resumable. Receipt-v3 is protected by `filled` being
  // outside BEGIN_ALLOWED_STATUSES; lean needs this explicit gate or a second
  // begin would overwrite the compact review and duplicate a live application.
  if (isLeanCompleteRole(role)) {
    throw new Error(
      'this role already completed a lean-llm-v1 run and is awaiting the candidate\'s own review '
      + '(queue status prefilled, lean_review_ready). Beginning again would discard the compact '
      + 'review and risk a duplicate application. Use the dashboard Mark Submitted, or explicitly '
      + 'reset the role first if the candidate confirms the fill must be redone.',
    );
  }
  const tab = payload.tab && typeof payload.tab === 'object' ? payload.tab : {};
  const tabId = requiredText(tab.id ?? tab.tab_id, 'tab.id');
  const requestedControllerId = requiredText(payload.controller_id, 'controller_id');
  const { request, runId, controllerId } = applicationRequestForRun(
    role,
    payload.run_id,
    'queued',
    requestedControllerId,
  );
  assertControllerQueueLease(queue, role, controllerId, tabId);
  const now = iso(payload.started_at);
  const tabUrl = requiredText(tab.url ?? payload.url ?? role.url, 'tab.url');
  const preflight = cleanPreflight(payload, role, tabUrl);
  const assetQualityEvidence = createApplicationQualityEvidence(role, {
    root: APPLICATION_PROJECT_ROOT,
  });
  // Default live runs use lean-llm-v1 (selective verification, finish→prefilled).
  // Opt into the historical receipt-v3 loop with execution_protocol: 'receipt-v3'
  // (or legacy evidence_protocol / receipt_required / inline-test capture for
  // repair suites and historical callers).
  const requestedProtocol = String(payload.execution_protocol || '').trim();
  const leanDefault = requestedProtocol !== 'receipt-v3'
    && payload.receipt_required !== true
    && payload.evidence_protocol !== 'v3'
    && payload.evidence_capture !== 'inline-test';
  const executionProtocol = leanDefault ? 'lean-llm-v1' : 'receipt-v3';

  // receipt-v3: every production run demands file-derived evidence. The inline-test
  // escape exists only for the suite's synthetic envelopes and is gated on the
  // same test-entrypoint check as the path overrides — NODE_ENV alone is not
  // enough to weaken a live run. Lean runs never require page receipts.
  const evidenceCapture = executionProtocol === 'receipt-v3'
    ? (payload.evidence_capture === 'inline-test' && TEST_PROJECT_ROOT_ALLOWED
      ? 'inline-test'
      : FILE_DERIVED_CAPTURE)
    : 'selective';
  const progress = {
    version: APPLICATION_RECEIPT_VERSION,
    run_id: runId,
    role_id: role.id,
    application_request_id: request.request_id,
    controller_id: controllerId,
    execution_protocol: executionProtocol,
    verification_mode: executionProtocol === 'lean-llm-v1' ? 'selective' : 'receipt',
    receipt_required: executionProtocol === 'receipt-v3',
    ...(executionProtocol === 'receipt-v3'
      ? { evidence_protocol: 'v3', evidence_capture: evidenceCapture }
      : { evidence_capture: evidenceCapture }),
    company: role.company ?? '',
    title: role.title ?? '',
    tab: {
      id: tabId,
      url: tabUrl,
      title: String(tab.title ?? '').trim(),
    },
    preflight,
    asset_quality_evidence: assetQualityEvidence,
    started_at: now,
    updated_at: now,
    pages: [],
    lean_pages: [],
    review_required: [],
    review_ready: false,
    lean_review_ready: false,
  };
  role.application_progress = progress;
  request.state = 'in-progress';
  request.started_at = now;
  request.consumed_at = now;
  request.updated_at = now;
  request.tab_id = progress.tab.id;
  request.asset_quality_evidence = assetQualityEvidence;
  return progress;
}

export function validatePageReceipt(payload, progress = null, executableEvidence = null, role = null) {
  const runId = requiredText(payload.run_id ?? progress?.run_id, 'run_id');
  if (progress && runId !== progress.run_id) throw new Error('page receipt run_id does not match active run');

  const fieldCount = nonNegativeInteger(payload.field_count, 'field_count');
  const url = requiredText(payload.url, 'url');
  const fields = cleanFields(payload.fields, fieldCount);
  const uploadControls = cleanUploadControls(payload.upload_controls);
  const finalPage = requiredBoolean(payload.final_page ?? false, 'final_page');
  const resolvedCount = fields.filter((field) => field.resolution === 'resolved').length;
  const novelCount = fields.filter((field) => field.resolution === 'novel').length;
  const answeredCount = fields.filter((field) => field.answer != null).length;
  const taughtCount = fields.filter((field) => field.resolution === 'novel' && field.taught).length;

  if (payload.resolved_count != null && nonNegativeInteger(payload.resolved_count, 'resolved_count') !== resolvedCount) {
    throw new Error('resolved_count does not match fields');
  }
  if (payload.novel_count != null && nonNegativeInteger(payload.novel_count, 'novel_count') !== novelCount) {
    throw new Error('novel_count does not match fields');
  }
  if (payload.answered_count != null && nonNegativeInteger(payload.answered_count, 'answered_count') !== answeredCount) {
    throw new Error('answered_count does not match fields');
  }
  if (payload.taught_count != null && nonNegativeInteger(payload.taught_count, 'taught_count') !== taughtCount) {
    throw new Error('taught_count does not match fields');
  }
  if (answeredCount !== fieldCount) throw new Error('every extracted field must be answered');
  if (taughtCount !== novelCount) throw new Error('every novel answer must cross the teach barrier');
  if (requiredBoolean(payload.lookup_completed, 'lookup_completed') !== true) throw new Error('lookup is incomplete');
  if (requiredBoolean(payload.l3_completed, 'l3_completed') !== true) throw new Error('L3/no-novel decision is incomplete');
  if (requiredBoolean(payload.teach_completed, 'teach_completed') !== true) throw new Error('teach barrier is incomplete');
  if (requiredBoolean(payload.conditional_rescan_completed, 'conditional_rescan_completed') !== true) {
    throw new Error('conditional-field rescan is incomplete');
  }
  if (requiredBoolean(payload.verified, 'verified') !== true) throw new Error('page verification is incomplete');

  const validationErrors = payload.validation_errors ?? [];
  if (!Array.isArray(validationErrors)) throw new Error('validation_errors must be an array');
  if (validationErrors.length) throw new Error('page still has validation errors');

  const provenanceCounts = fields.reduce((counts, field) => {
    counts[field.provenance] += 1;
    return counts;
  }, { deterministic: 0, learned: 0, cache: 0, model: 0 });
  if (payload.provenance_counts != null) {
    const supplied = cleanProvenance(payload.provenance_counts, fieldCount);
    if (JSON.stringify(supplied) !== JSON.stringify(provenanceCounts)) {
      throw new Error('provenance_counts does not match fields');
    }
  }
  const reviewRequired = fields.filter((field) => field.review_required).map((field) => ({
    label: field.label,
    answer: field.answer,
    note: field.review_note,
  }));
  if (payload.review_required != null) {
    const supplied = cleanReviewItems(payload.review_required);
    if (JSON.stringify(supplied) !== JSON.stringify(reviewRequired)) {
      throw new Error('review_required does not match the field ledger');
    }
  }
  const fingerprint = fingerprintForPage(url, fields, uploadControls);
  if (payload.fingerprint != null && requiredText(payload.fingerprint, 'fingerprint') !== fingerprint) {
    throw new Error('page fingerprint does not match the field ledger');
  }
  const resolverEvidence = validateResolverEvidence(
    payload,
    progress,
    executableEvidence ?? payload.resolver_evidence,
    fields,
  );
  const browserObservation = cleanBrowserObservation(payload.browser_observation, {
    fields,
    url,
    resolverEvidence,
    finalPage,
  });
  if (JSON.stringify(validationErrors) !== JSON.stringify(browserObservation.after.validation_errors)) {
    throw new Error('validation_errors does not match the browser observation');
  }

  const knownUploadControls = [...uploadControlMap(progress?.pages ?? [], uploadControls).values()];
  const attachments = role
    ? assertRoleAttachments(role, payload.attachments, { allowEmpty: true })
    : cleanAttachments(payload.attachments, { allowEmpty: true });
  if (role) {
    for (const attachment of attachments) {
      if (!knownUploadControls.some((control) => control.control_id === attachment.control_id)) {
        throw new Error(`attachment control_id was not observed on the live application: ${attachment.control_id}`);
      }
    }
  }
  const verificationWarnings = cleanVerificationWarnings(payload.verification_warnings, fields);

  return {
    run_id: runId,
    tab_id: requiredText(payload.tab_id ?? progress?.tab?.id, 'tab_id'),
    page_id: requiredText(payload.page_id, 'page_id'),
    page_index: nonNegativeInteger(payload.page_index, 'page_index'),
    url,
    fingerprint,
    fields,
    upload_controls: uploadControls,
    field_count: fieldCount,
    resolved_count: resolvedCount,
    novel_count: novelCount,
    answered_count: answeredCount,
    taught_count: taughtCount,
    lookup_completed: true,
    l3_completed: true,
    teach_completed: true,
    conditional_rescan_completed: true,
    verified: true,
    validation_errors: [],
    attachments,
    resolver_evidence_id: resolverEvidence.evidence_id,
    resolver_evidence: structuredClone(executableEvidence ?? payload.resolver_evidence),
    browser_observation: browserObservation,
    provenance_counts: provenanceCounts,
    review_required: reviewRequired,
    ...(verificationWarnings.length ? { verification_warnings: verificationWarnings } : {}),
    final_page: finalPage,
    lookup_at: resolverEvidence.lookup_completed_at,
    teach_at: resolverEvidence.teach_completed_at,
    verified_at: iso(payload.verified_at),
  };
}

export function recordPageReceipt(role, payload) {
  const progress = role?.application_progress;
  if (!progress || progress.review_ready) throw new Error('begin an active application run before recording pages');
  const evidence = progress.pending_resolver_evidence;
  if (!evidence) {
    // Live --page evidence must come from the queue-resolve staging step; a
    // payload-inline resolver_evidence blob is caller-authored and never
    // acceptable here. The inline fallback in validatePageReceipt exists only
    // for re-validating already-stored page receipts.
    throw new Error('executable resolver evidence is missing; run apply-page.mjs lookup for this page');
  }
  if (progress.evidence_capture === FILE_DERIVED_CAPTURE && evidence.capture !== SNAPSHOT_FILE_CAPTURE) {
    throw new Error(
      'hand-authored resolver evidence is not accepted on this run; ' +
      'stage the page from its snapshot file with apply-page.mjs lookup (evidence-protocol v3)',
    );
  }
  const page = validatePageReceipt(payload, progress, evidence, role);
  if (page.tab_id !== progress.tab.id) throw new Error('page receipt belongs to a different browser tab');
  const pages = Array.isArray(progress.pages) ? progress.pages : [];
  const sameIndex = pages.find((item) => item.page_index === page.page_index);
  if (sameIndex && sameIndex.page_id !== page.page_id) {
    throw new Error('page_index already belongs to a different page');
  }
  progress.pages = pages.filter((item) => item.page_id !== page.page_id).concat(page)
    .sort((a, b) => a.page_index - b.page_index);
  progress.review_required = progress.pages.flatMap((item) => item.review_required ?? []);
  progress.verification_warnings = progress.pages.flatMap((item) => (item.verification_warnings ?? [])
    .map((warning) => ({ page_index: item.page_index, ...warning })));
  delete progress.pending_resolver_evidence;
  progress.updated_at = new Date().toISOString();
  return page;
}

// ── Verification fallback (evidence-protocol v3, controlled degradation) ─────
//
// When a portal widget genuinely cannot be machine-extracted or machine-
// verified, the driver records a durable fallback block instead of inventing a
// generic escape hatch: the run keeps its history, but it can never finalize
// to review-ready `filled` — the role stays in the manual-review path and the
// dashboard surfaces the reason. Recording a fallback is allowed only while a
// run is active, and never for a page already receipted.
export function recordVerificationFallback(role, payload = {}) {
  const progress = role?.application_progress;
  if (!progress || progress.review_ready || progress.lean_review_ready) {
    throw new Error('an active application run is required to record a verification fallback');
  }
  const reason = requiredText(payload.reason, 'fallback reason');
  const controls = Array.isArray(payload.control_ids) ? payload.control_ids.map(String) : [];
  if (!controls.length) throw new Error('fallback control_ids must list the unsupported controls');
  progress.verification_fallback = {
    version: 1,
    reason,
    control_ids: controls,
    url: requiredText(payload.url, 'fallback url'),
    page_index: nonNegativeInteger(payload.page_index, 'fallback page_index'),
    snapshot_digest: payload.snapshot_digest == null
      ? null
      : requiredDigest(payload.snapshot_digest, 'fallback snapshot_digest'),
    recorded_at: new Date().toISOString(),
  };
  progress.updated_at = progress.verification_fallback.recorded_at;
  return structuredClone(progress.verification_fallback);
}

export function reviewReadinessErrors(role, {
  requirePersistedHandover = true,
  expectedReportState = 'filled',
  expectedIntegrityState = expectedReportState,
  verifyIntegrityArtifacts = true,
} = {}) {
  const progress = role?.application_progress;
  const errors = [];
  if (!progress) return ['application progress receipt is missing'];
  if (progress.version !== APPLICATION_RECEIPT_VERSION) errors.push('application progress receipt version is stale');
  if (!progress.run_id) errors.push('run_id is missing');
  if (!progress.controller_id) errors.push('browser controller_id is missing');
  if (!progress.tab?.id || !progress.tab?.url) errors.push('tab ledger entry is incomplete');
  try {
    const expectedRequestState = progress.review_ready ? 'review-ready' : 'in-progress';
    const { request } = applicationRequestForRun(
      role,
      progress.run_id,
      expectedRequestState,
      progress.controller_id,
    );
    if (progress.application_request_id !== request.request_id) {
      errors.push('application progress is not bound to its dashboard application_request');
    }
    const checkedQuality = validateApplicationQualityEvidence(
      role,
      progress.asset_quality_evidence,
      { root: APPLICATION_PROJECT_ROOT, maxAgeMs: Number.POSITIVE_INFINITY },
    );
    if (request.asset_quality_evidence?.fingerprint !== checkedQuality.fingerprint) {
      errors.push('dashboard application_request asset quality evidence does not match the receipt');
    }
  } catch (err) {
    errors.push('dashboard application_request authorization is invalid: ' + err.message);
  }
  try {
    const checked = cleanPreflight({
      liveness_evidence: progress.preflight?.liveness,
      destination_evidence: progress.preflight?.destination,
    }, role, progress.tab?.url);
    if (progress.preflight?.liveness_verified !== checked.liveness_verified) {
      errors.push('derived posting liveness state does not match its evidence');
    }
    if (progress.preflight?.role_match_verified !== checked.role_match_verified) {
      errors.push('derived company/role match state does not match its evidence');
    }
  } catch (err) {
    errors.push('structured preflight evidence is invalid: ' + err.message);
  }
  if (!Array.isArray(progress.pages) || !progress.pages.length) errors.push('no page receipts recorded');
  if (progress.pending_resolver_evidence) errors.push('unconsumed resolver evidence remains for the active page');
  if (progress.verification_fallback) {
    errors.push('run recorded a verification fallback (' + progress.verification_fallback.reason +
      ') — manual candidate review is required; this run cannot be review-ready');
  }

  const pages = Array.isArray(progress.pages) ? progress.pages : [];
  if (pages.length) {
    const indexes = pages.map((page) => page.page_index);
    const expected = Array.from({ length: pages.length }, (_, index) => index);
    if (JSON.stringify(indexes) !== JSON.stringify(expected)) errors.push('page indexes are not contiguous from zero');
    const finalPages = pages.filter((page) => page.final_page);
    if (finalPages.length !== 1) errors.push('exactly one final review page receipt is required');
    if (finalPages.length === 1 && finalPages[0].page_index !== pages.length - 1) {
      errors.push('final review page must be the last contiguous page');
    }
    for (const page of pages) {
      try {
        validatePageReceipt(page, progress, page.resolver_evidence, role);
        if (page.tab_id !== progress.tab?.id) errors.push('page ' + page.page_id + ': browser tab does not match the run ledger');
        if (progress.evidence_capture === FILE_DERIVED_CAPTURE &&
            page.resolver_evidence?.capture !== SNAPSHOT_FILE_CAPTURE) {
          errors.push('page ' + page.page_id + ': resolver evidence was not derived from a snapshot file (evidence-protocol v3)');
        }
      } catch (err) {
        errors.push('page ' + (page.page_id ?? page.page_index) + ': ' + err.message);
      }
    }
  }
  if (!progress.application_answers_report) {
    errors.push('Application Answers report persistence is missing');
  } else {
    try { validateApplicationAnswersReport(progress.application_answers_report, progress, expectedReportState); }
    catch (err) { errors.push(err.message); }
  }
  if (!progress.handover_receipt_id) {
    errors.push('handover compliance receipt is missing');
  } else if (requirePersistedHandover) {
    try {
      const handover = readFileSync(HANDOVER_PATH, 'utf8');
      if (!handover.includes('<!-- ' + progress.handover_receipt_id + ' -->')) {
        errors.push('handover compliance receipt was not persisted');
      }
    } catch (err) {
      errors.push('handover compliance receipt is unreadable: ' + err.message);
    }
  }
  if (!progress.receipt_id || progress.receipt_id !== progress.handover_receipt_id) {
    errors.push('stable finalized receipt_id is missing or does not match the handover receipt');
  }
  if (!progress.assets_verified) {
    errors.push('final attachment verification is missing');
  } else {
    try {
      const checkedAttachments = assertRoleAttachments(role, progress.final_attachments, {
        allowEmpty: false,
        naReason: progress.attachments_not_applicable_reason,
      });
      const observedUploadControls = [...uploadControlMap(pages).values()];
      assertAttachmentCoverage(
        observedUploadControls,
        checkedAttachments,
        progress.attachments_not_applicable_reason,
      );
      if (JSON.stringify(progress.upload_controls ?? []) !== JSON.stringify(observedUploadControls)) {
        errors.push('final upload-control ledger differs from the receipted page manifests');
      }
      const finalPage = pages.find((page) => page.final_page);
      if (finalPage && JSON.stringify(attachmentIdentity(checkedAttachments)) !==
          JSON.stringify(attachmentIdentity(finalPage.attachments ?? []))) {
        errors.push('final attachments differ from the verified final-page receipt');
      }
    } catch (err) {
      errors.push('final attachment verification is invalid: ' + err.message);
    }
  }
  if (progress.final_validation_errors?.length) errors.push('final page still has validation errors');
  if (progress.review_ready !== true) errors.push('review_ready is not true');
  if (expectedIntegrityState === 'filled' || expectedIntegrityState === 'submitted') {
    try {
      validateApplicationReceiptIntegrity(role, expectedIntegrityState, {
        verifyArtifacts: verifyIntegrityArtifacts,
      });
    } catch (err) {
      errors.push('application receipt integrity is invalid: ' + err.message);
    }
  }
  return errors;
}

export function validateApplicationAnswersReport(pathValue, progress = null, expectedState = 'filled') {
  const absolute = resolve(ROOT, requiredText(pathValue, 'application_answers_report'));
  const withinReports = relative(REPORTS_DIR, absolute);
  if (!withinReports || withinReports.startsWith('..') || resolve(REPORTS_DIR, withinReports) !== absolute) {
    throw new Error('application_answers_report must be a file inside reports/');
  }
  if (!existsSync(absolute)) throw new Error('application_answers_report does not exist');
  const source = readFileSync(absolute, 'utf8');
  const parsed = parseApplicationAnswersSection(source);
  const state = requiredText(expectedState, 'expected report state').toLowerCase();
  if (!parsed.state || parsed.state.toLowerCase() !== state) {
    throw new Error(`Application Answers must be persisted with State: ${state}`);
  }
  if (progress?.pages) {
    if (!parsed.runId || parsed.runId !== progress.run_id) {
      throw new Error('Application Answers Run ID does not match the active application receipt');
    }
    if (parsed.pageCount == null || Number(parsed.pageCount) !== progress.pages.length) {
      throw new Error('Application Answers Receipt pages does not match the active application receipt');
    }

    const expectedEntries = [];
    const occurrences = new Map();
    const orderedPages = [...progress.pages].sort((left, right) => left.page_index - right.page_index);
    for (const page of orderedPages) {
      for (const field of page.fields ?? []) {
        const label = normalizeApplicationAnswerLabel(field.label);
        const occurrence = (occurrences.get(label) ?? 0) + 1;
        occurrences.set(label, occurrence);
        expectedEntries.push({
          label,
          answer: normalizeApplicationAnswerValue(field.answer),
          page: normalizeApplicationAnswerLabel(page.page_id),
          page_index: page.page_index,
          control_id: normalizeApplicationAnswerLabel(field.control_id),
          occurrence,
          resolution: String(field.resolution ?? '').trim().toLowerCase(),
          provenance: String(field.provenance ?? '').trim().toLowerCase(),
          taught: field.taught,
          review_required: field.review_required,
          review_note: String(field.review_note ?? '').replace(/\s+/g, ' ').trim() || null,
        });
      }
    }

    const requiredEntryMetadata = [
      'page', 'page_index', 'control_id', 'occurrence', 'resolution',
      'provenance', 'taught', 'review_required', 'review_note',
    ];
    for (const [index, entry] of parsed.entries.entries()) {
      for (const property of requiredEntryMetadata) {
        if (entry[property] === undefined) {
          throw new Error(
            `Application Answers entry ${index + 1} is missing receipt metadata: ${property}`,
          );
        }
      }
    }

    const identity = (entry) => JSON.stringify([
      entry.page_index,
      entry.page,
      entry.control_id,
      entry.occurrence,
    ]);
    const reportEntries = new Map();
    for (const entry of parsed.entries) {
      const key = identity(entry);
      if (reportEntries.has(key)) {
        throw new Error(
          `Application Answers duplicate-consumed field entry: ${entry.label} ` +
          `(page ${entry.page_index}, control ${entry.control_id}, occurrence ${entry.occurrence})`,
        );
      }
      reportEntries.set(key, entry);
    }

    const comparedProperties = [
      'label', 'answer', 'page', 'page_index', 'control_id', 'occurrence',
      'resolution', 'provenance', 'taught', 'review_required', 'review_note',
    ];
    for (const expected of expectedEntries) {
      const key = identity(expected);
      const actual = reportEntries.get(key);
      if (!actual) {
        throw new Error(
          `Application Answers is missing receipted field occurrence: ${expected.label} ` +
          `(page ${expected.page_index}, control ${expected.control_id}, occurrence ${expected.occurrence})`,
        );
      }
      for (const property of comparedProperties) {
        if (actual[property] !== expected[property]) {
          throw new Error(
            `Application Answers ${property} does not exactly match the receipted field ` +
            `${expected.label} (page ${expected.page_index}, control ${expected.control_id}, ` +
            `occurrence ${expected.occurrence})`,
          );
        }
      }
      reportEntries.delete(key);
    }
    if (reportEntries.size) {
      const extra = reportEntries.values().next().value;
      throw new Error(
        `Application Answers contains an unexpected extra field entry: ${extra.label} ` +
        `(page ${extra.page_index}, control ${extra.control_id}, occurrence ${extra.occurrence})`,
      );
    }
  }
  return relative(ROOT, absolute);
}

function replaceApplicationAnswersState(pathValue, fromState, toState) {
  const absolute = resolve(ROOT, requiredText(pathValue, 'application_answers_report'));
  const source = readFileSync(absolute, 'utf8');
  const parsed = parseApplicationAnswersSection(source);
  const statePattern = /^(\*\*State:\*\*[ \t]*)([^\n]+?)([ \t]*)$/mi;
  const match = statePattern.exec(parsed.section);
  if (!match || match[2].trim().toLowerCase() !== fromState.toLowerCase()) {
    throw new Error(`Application Answers state changed before finalization (expected ${fromState})`);
  }
  const stateOffset = parsed.start + match.index;
  const replacement = match[1] + toState + match[3];
  const updated = parsed.source.slice(0, stateOffset) + replacement +
    parsed.source.slice(stateOffset + match[0].length);
  const tmp = absolute + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, updated, 'utf8');
  renameSync(tmp, absolute);
  return { absolute, source };
}

function applicationAnswersState(pathValue) {
  const absolute = resolve(ROOT, requiredText(pathValue, 'application_answers_report'));
  const withinReports = relative(REPORTS_DIR, absolute);
  if (!withinReports || withinReports.startsWith('..') || resolve(REPORTS_DIR, withinReports) !== absolute) {
    throw new Error('application_answers_report must be a file inside reports/');
  }
  if (!existsSync(absolute)) throw new Error('application_answers_report does not exist');
  const source = readFileSync(absolute, 'utf8');
  const parsed = parseApplicationAnswersSection(source);
  if (!parsed.state) throw new Error('Application Answers State is missing');
  return { absolute, relative: relative(ROOT, absolute), state: parsed.state.toLowerCase(), source };
}

/**
 * Candidate-confirmed submission may be retried after a partial queue-store
 * failure. Both a freshly review-ready `filled` report and an already promoted
 * `submitted` report therefore satisfy this gate; every other receipt invariant
 * remains mandatory.
 */
export function submissionReadinessErrors(role) {
  const report = role?.application_progress?.application_answers_report;
  if (!report) return reviewReadinessErrors(role);
  try {
    const current = applicationAnswersState(report);
    if (current.state !== 'filled' && current.state !== 'submitted') {
      return [`Application Answers state must be filled or submitted before candidate confirmation (found ${current.state})`];
    }
    const progressState = role?.application_progress?.report_state;
    if (progressState !== 'filled' && progressState !== 'submitted') {
      return [`application receipt report_state must be filled or submitted before candidate confirmation (found ${progressState ?? 'missing'})`];
    }
    if (current.state === 'filled' && progressState !== 'filled') {
      return ['Application Answers is filled but the receipt report_state is not filled'];
    }
    // A retry may observe the report already promoted to submitted while the
    // queue mutation that updates progress/integrity did not commit. Validate
    // the prior filled seal without re-reading the intentionally changed report
    // artifact, then immediately refresh the submitted seal below.
    const partialSubmittedRetry = current.state === 'submitted' && progressState === 'filled';
    return reviewReadinessErrors(role, {
      expectedReportState: current.state,
      expectedIntegrityState: progressState,
      verifyIntegrityArtifacts: !partialSubmittedRetry,
    });
  } catch (err) {
    return [err.message];
  }
}

/**
 * Promote the receipt-bound report after the candidate confirms that the final
 * portal submission happened. This is idempotent so a failed queue commit can
 * be retried without rewriting or duplicating the report.
 */
export function markApplicationReportSubmitted(role) {
  const errors = submissionReadinessErrors(role);
  if (errors.length) throw new Error('submission-readiness gate failed: ' + errors.join(' | '));
  const progress = role.application_progress;
  const current = applicationAnswersState(progress.application_answers_report);
  if (current.state === 'submitted') {
    progress.report_state = 'submitted';
    progress.submission_confirmed_at = progress.submission_confirmed_at ?? new Date().toISOString();
    progress.integrity = createApplicationReceiptIntegrity(role, 'submitted');
    return {
      changed: false,
      path: current.relative,
      state: 'submitted',
      receipt_id: progress.receipt_id,
      run_id: progress.run_id,
    };
  }

  const transition = replaceApplicationAnswersState(
    progress.application_answers_report,
    'filled',
    'submitted',
  );
  progress.report_state = 'submitted';
  progress.submission_confirmed_at = new Date().toISOString();
  progress.integrity = createApplicationReceiptIntegrity(role, 'submitted');
  return {
    changed: true,
    path: relative(ROOT, transition.absolute),
    state: 'submitted',
    receipt_id: progress.receipt_id,
    run_id: progress.run_id,
  };
}

/** Roll back only the report state written by markApplicationReportSubmitted. */
export function rollbackApplicationReportSubmission(role, transition) {
  if (!transition?.changed) return false;
  const progress = role?.application_progress;
  if (!progress || transition.receipt_id !== progress.receipt_id || transition.run_id !== progress.run_id) {
    throw new Error('refusing to roll back a submission report transition from another receipt/run');
  }
  replaceApplicationAnswersState(progress.application_answers_report, 'submitted', 'filled');
  progress.report_state = 'filled';
  delete progress.submission_confirmed_at;
  progress.integrity = createApplicationReceiptIntegrity(role, 'filled');
  return true;
}

function removeHandoverReceipt(receiptId) {
  if (!receiptId || !existsSync(HANDOVER_PATH)) return;
  withHandoverLock(() => {
    const source = readFileSync(HANDOVER_PATH, 'utf8');
    const lines = source.split('\n').filter((line) => !line.includes(`<!-- ${receiptId} -->`));
    const tmp = HANDOVER_PATH + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, lines.join('\n'), 'utf8');
    renameSync(tmp, HANDOVER_PATH);
  });
}

function demoteApplicationAnswersReport(pathValue, runId) {
  try {
    const absolute = resolve(ROOT, requiredText(pathValue, 'application_answers_report'));
    if (!existsSync(absolute)) return;
    const parsed = parseApplicationAnswersSection(readFileSync(absolute, 'utf8'));
    if (parsed.state?.toLowerCase() !== 'filled') return;
    if (runId && parsed.runId !== runId) return;
    replaceApplicationAnswersState(pathValue, 'filled', 'prefilled');
  } catch {
    // Preserve the original finalization error. Verification will continue to
    // fail closed if a filesystem rollback itself is unavailable.
  }
}

function receiptLine(role, progress) {
  const counts = progress.pages.reduce((acc, page) => {
    for (const key of Object.keys(acc)) acc[key] += Number(page.provenance_counts?.[key] ?? 0);
    return acc;
  }, { deterministic: 0, learned: 0, cache: 0, model: 0 });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return '- <!-- ' + progress.handover_receipt_id + ' --> **' + role.company + ' — ' + role.title +
    '** · role ' + role.id + ' · run ' + progress.run_id + ' · pages ' + progress.pages.length +
    ' · fields ' + total + ' · provenance D/L/C/M ' + counts.deterministic + '/' + counts.learned +
    '/' + counts.cache + '/' + counts.model + ' · review-required ' + progress.review_required.length +
    ' · final URL ' + progress.final_url + ' · report ' + progress.application_answers_report +
    ' · final application submission not performed by agent.';
}

function withHandoverLock(fn, timeoutMs = 15_000) {
  mkdirSync(dirname(HANDOVER_PATH), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(HANDOVER_LOCK_PATH, { mode: 0o700 });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(HANDOVER_LOCK_PATH).mtimeMs > 120_000) {
          rmSync(HANDOVER_LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch { /* another process may have released it */ }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for handover receipt lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(HANDOVER_LOCK_PATH, { recursive: true, force: true });
  }
}

function persistHandoverReceipt(role, progress) {
  return withHandoverLock(() => {
    if (!existsSync(HANDOVER_PATH)) throw new Error('handover.md is required for application completion');
    const source = readFileSync(HANDOVER_PATH, 'utf8');
    const marker = progress.handover_receipt_id;
    const line = receiptLine(role, progress);
    const section = '## Application Compliance Receipts';
    const lines = source.split('\n');
    const existing = lines.findIndex((item) => item.includes('<!-- ' + marker + ' -->'));
    if (existing >= 0) {
      lines[existing] = line;
    } else {
      let sectionIndex = lines.indexOf(section);
      if (sectionIndex < 0) {
        const sessionIndex = lines.indexOf('## Session Log');
        sectionIndex = sessionIndex >= 0 ? sessionIndex : lines.length;
        lines.splice(sectionIndex, 0, section, '', line, '');
      } else {
        lines.splice(sectionIndex + 2, 0, line);
      }
    }
    const tmp = HANDOVER_PATH + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, lines.join('\n'), 'utf8');
    renameSync(tmp, HANDOVER_PATH);
  });
}

export function finalizeApplicationProgress(role, payload) {
  const progress = role?.application_progress;
  if (!progress || progress.review_ready) throw new Error('an active application run is required');
  if (progress.verification_fallback) {
    throw new Error('this run recorded a verification fallback (' +
      progress.verification_fallback.reason +
      '); it cannot become review-ready — the candidate reviews and submits this application manually');
  }
  if (!FINALIZE_ALLOWED_STATUSES.has(role.status)) {
    throw new Error(`application receipt may finalize only from: ${[...FINALIZE_ALLOWED_STATUSES].join(', ')}`);
  }
  if (requiredText(payload.run_id ?? progress.run_id, 'run_id') !== progress.run_id) {
    throw new Error('finalize run_id does not match active run');
  }
  const { request } = applicationRequestForRun(
    role,
    progress.run_id,
    'in-progress',
    progress.controller_id,
  );
  if (progress.application_request_id !== request.request_id) {
    throw new Error('active application progress belongs to a different application_request');
  }
  validateApplicationQualityEvidence(role, progress.asset_quality_evidence, {
    root: APPLICATION_PROJECT_ROOT,
    maxAgeMs: Number.POSITIVE_INFINITY,
  });
  const refreshedAssetQualityEvidence = createApplicationQualityEvidence(role, {
    root: APPLICATION_PROJECT_ROOT,
  });
  const finalPages = progress.pages?.filter((page) => page.final_page) ?? [];
  if (finalPages.length !== 1 || finalPages[0].page_index !== progress.pages.length - 1) {
    throw new Error('exactly one verified final-page receipt, at the last page index, is required');
  }

  const originalProgress = structuredClone(progress);
  const originalRequest = structuredClone(request);
  const hadReviewFields = Object.prototype.hasOwnProperty.call(role, 'review_required_fields');
  const originalReviewFields = structuredClone(role.review_required_fields ?? null);
  let reportPromotion = null;
  let receiptId = null;
  try {
    progress.final_url = requiredText(payload.final_url, 'final_url');
    if (progress.final_url !== finalPages[0].url) {
      throw new Error('final_url must match the verified final-page receipt URL');
    }
    // application-answers writes a non-review-ready `prefilled` snapshot. This
    // finalizer alone promotes that report line to `filled`, after every other
    // gate has passed.
    progress.application_answers_report = validateApplicationAnswersReport(
      payload.application_answers_report,
      progress,
      'prefilled',
    );
    const finalErrors = payload.validation_errors ?? [];
    if (!Array.isArray(finalErrors) || finalErrors.length) {
      throw new Error('final validation errors must be an empty array');
    }
    progress.final_validation_errors = [];
    progress.final_attachments = assertRoleAttachments(role, payload.attachments, {
      allowEmpty: false,
      naReason: payload.attachments_not_applicable_reason,
    });
    const observedUploadControls = [...uploadControlMap(progress.pages).values()];
    assertAttachmentCoverage(
      observedUploadControls,
      progress.final_attachments,
      payload.attachments_not_applicable_reason,
    );
    progress.upload_controls = observedUploadControls;
    if (JSON.stringify(attachmentIdentity(progress.final_attachments)) !==
        JSON.stringify(attachmentIdentity(finalPages[0].attachments ?? []))) {
      throw new Error('final attachments do not match the verified final-page receipt');
    }
    progress.attachments_not_applicable_reason = String(payload.attachments_not_applicable_reason ?? '').trim();
    progress.asset_quality_evidence = refreshedAssetQualityEvidence;
    request.asset_quality_evidence = refreshedAssetQualityEvidence;
    progress.assets_verified = true;
    progress.review_required = progress.pages.flatMap((page) => page.review_required ?? []);
    role.review_required_fields = progress.review_required.map((item) => item.label);
    progress.finalized_at = iso(payload.finalized_at);
    progress.updated_at = progress.finalized_at;
    progress.review_ready = true;
    receiptId = 'application-receipt:' + role.id + ':' + progress.run_id;
    progress.receipt_id = receiptId;
    progress.handover_receipt_id = receiptId;
    request.state = 'review-ready';
    request.review_ready_at = progress.finalized_at;
    request.completed_at = progress.finalized_at;
    request.updated_at = progress.finalized_at;
    request.receipt_id = progress.receipt_id;

    const errors = reviewReadinessErrors(role, {
      requirePersistedHandover: false,
      expectedReportState: 'prefilled',
      expectedIntegrityState: null,
    });
    if (errors.length) throw new Error('review-readiness gate failed: ' + errors.join(' | '));

    persistHandoverReceipt(role, progress);
    reportPromotion = replaceApplicationAnswersState(
      progress.application_answers_report,
      'prefilled',
      'filled',
    );
    progress.report_state = 'filled';
    progress.report_state_finalized_at = new Date().toISOString();
    progress.integrity = createApplicationReceiptIntegrity(role, 'filled');

    const persistedErrors = reviewReadinessErrors(role);
    if (persistedErrors.length) {
      throw new Error('persisted review-readiness gate failed: ' + persistedErrors.join(' | '));
    }
    return progress;
  } catch (err) {
    if (reportPromotion) {
      const tmp = reportPromotion.absolute + '.' + randomUUID() + '.tmp';
      writeFileSync(tmp, reportPromotion.source, 'utf8');
      renameSync(tmp, reportPromotion.absolute);
    }
    removeHandoverReceipt(receiptId);
    role.application_progress = originalProgress;
    role.application_request = originalRequest;
    if (hadReviewFields) role.review_required_fields = originalReviewFields;
    else delete role.review_required_fields;
    throw err;
  }
}

function roleFromQueue(queue, roleId) {
  const role = queue.roles.find((item) => item.id === roleId);
  if (!role) throw new Error('role not found: ' + roleId);
  return role;
}

export function beginRole(roleId, payload) {
  return mutateQueue((queue) => beginApplicationProgress(
    roleFromQueue(queue, roleId),
    payload,
    { queue },
  ));
}

export function recordRolePage(roleId, payload) {
  return mutateQueue((queue) => recordPageReceipt(roleFromQueue(queue, roleId), payload));
}

export function recordRoleFallback(roleId, payload) {
  return mutateQueue((queue) => recordVerificationFallback(roleFromQueue(queue, roleId), payload));
}

function finalizationPayloadDigest(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function finalizationReceiptId(roleId, runId) {
  return `application-receipt:${roleId}:${runId}`;
}

function stageApplicationFinalization(roleId, payload) {
  return mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    const runId = requiredText(payload.run_id ?? role.application_progress?.run_id, 'run_id');
    const reportPath = requiredText(payload.application_answers_report, 'application_answers_report');
    const payloadDigest = finalizationPayloadDigest(payload);

    if (role.status === 'filled') {
      const errors = reviewReadinessErrors(role);
      if (errors.length) {
        throw new Error('filled role has an invalid receipt; use --repair-filled before retrying: ' + errors.join(' | '));
      }
      if (role.application_progress?.run_id !== runId) {
        throw new Error('finalize retry belongs to a different completed run');
      }
      return {
        already_committed: true,
        progress: structuredClone(role.application_progress),
      };
    }

    const progress = role.application_progress;
    if (!progress || progress.review_ready) throw new Error('an active application run is required');
    if (!FINALIZE_ALLOWED_STATUSES.has(role.status)) {
      throw new Error(`application receipt may finalize only from: ${[...FINALIZE_ALLOWED_STATUSES].join(', ')}`);
    }
    if (progress.run_id !== runId) throw new Error('finalize run_id does not match active run');

    const existing = role.application_finalization_transaction;
    if (existing && existing.state !== 'committed') {
      if (existing.version !== APPLICATION_FINALIZATION_TRANSACTION_VERSION ||
          existing.role_id !== roleId || existing.run_id !== runId ||
          existing.payload_digest !== payloadDigest || existing.report_path !== reportPath) {
        throw new Error('a different application finalization transaction is already pending');
      }
      existing.attempts = Number(existing.attempts ?? 1) + 1;
      existing.updated_at = new Date().toISOString();
      return { transaction: structuredClone(existing), resumed: true };
    }

    const now = new Date().toISOString();
    role.application_finalization_transaction = {
      version: APPLICATION_FINALIZATION_TRANSACTION_VERSION,
      transaction_id: `application-finalization:${roleId}:${runId}`,
      role_id: roleId,
      run_id: runId,
      report_path: reportPath,
      receipt_id: finalizationReceiptId(roleId, runId),
      payload_digest: payloadDigest,
      state: 'staged',
      attempts: 1,
      started_at: now,
      updated_at: now,
    };
    return {
      transaction: structuredClone(role.application_finalization_transaction),
      resumed: false,
    };
  });
}

export function recoverStagedFinalizationArtifacts(transaction) {
  if (!transaction || transaction.state === 'committed') return;
  // A process may have died after writing one or both filesystem artifacts but
  // before the queue commit. The durable staged transaction makes that window
  // recoverable: restore the pre-finalization artifacts, then rerun the normal
  // verified finalizer idempotently.
  demoteApplicationAnswersReport(transaction.report_path, transaction.run_id);
  removeHandoverReceipt(transaction.receipt_id);
}

export function finalizeRole(roleId, payload) {
  const staged = stageApplicationFinalization(roleId, payload);
  if (staged.already_committed) return staged.progress;
  recoverStagedFinalizationArtifacts(staged.transaction);

  let finalizedInMemory = false;
  try {
    return mutateQueue((queue) => {
      const role = roleFromQueue(queue, roleId);
      const transaction = role.application_finalization_transaction;
      if (!transaction || transaction.state !== 'staged' ||
          transaction.run_id !== requiredText(payload.run_id, 'run_id') ||
          transaction.payload_digest !== finalizationPayloadDigest(payload)) {
        throw new Error('durable application finalization transaction is missing or stale');
      }
      const progress = finalizeApplicationProgress(role, payload);
      // finalizeApplicationProgress has already written the report/handover
      // side effects. Mark that boundary before the protected status call so
      // any later validation or persistence failure rolls those artifacts back.
      finalizedInMemory = true;
      setStatus(queue, roleId, 'filled');
      transaction.state = 'committed';
      transaction.completed_at = new Date().toISOString();
      transaction.updated_at = transaction.completed_at;
      transaction.receipt_id = progress.receipt_id;
      return progress;
    });
  } catch (err) {
    // A queue backend failure can happen after the callback's report/handover
    // side effects. Roll them back so the durable report never advertises a
    // review-ready state that the queue did not commit.
    if (finalizedInMemory) {
      demoteApplicationAnswersReport(payload.application_answers_report, payload.run_id);
      removeHandoverReceipt(finalizationReceiptId(roleId, payload.run_id));
    }
    throw err;
  }
}

/**
 * Repair only a legacy/corrupt `filled` row that cannot satisfy the executable
 * receipt gate. The failed ledger is archived locally, the role returns to
 * `prepared`, and the next dashboard request starts a fresh preserved tab/run.
 * Valid review-ready or candidate-submission transactions are never demoted.
 */
export function repairFilledRole(roleId) {
  const repaired = mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    if (role.status !== 'filled') {
      throw new Error(`repair-filled requires role status filled, not ${role.status}`);
    }
    if (role.application_decision_transaction &&
        role.application_decision_transaction.state !== 'committed') {
      throw new Error('candidate decision transaction is pending; retry that decision instead of repairing the receipt');
    }
    if (role.application_progress?.report_state === 'submitted') {
      throw new Error('submitted report recovery must use the candidate decision transaction, not repair-filled');
    }
    const errors = reviewReadinessErrors(role);
    if (errors.length === 0) {
      throw new Error('refusing to repair a valid review-ready application receipt');
    }
    const repairedAt = new Date().toISOString();
    const archivedProgress = structuredClone(role.application_progress ?? null);
    const archivedRequest = structuredClone(role.application_request ?? null);
    role.application_receipt_repairs = [
      ...(Array.isArray(role.application_receipt_repairs) ? role.application_receipt_repairs : []),
      {
        repaired_at: repairedAt,
        previous_status: role.status,
        errors,
        application_progress: archivedProgress,
        application_request: archivedRequest,
      },
    ];
    delete role.application_progress;
    delete role.application_request;
    delete role.review_required_fields;
    setStatus(queue, roleId, 'prepared');
    return {
      role_id: roleId,
      status: role.status,
      repaired_at: repairedAt,
      errors,
      archived_progress: archivedProgress,
    };
  });

  // Cleanup happens only after the safer prepared state is durable. A stale
  // invalid report/handover line cannot authorize anything; the next prefill
  // rewrites the report section, while these best-effort steps reduce clutter.
  const archived = repaired.archived_progress;
  if (archived?.application_answers_report) {
    demoteApplicationAnswersReport(archived.application_answers_report, archived.run_id);
  }
  removeHandoverReceipt(archived?.receipt_id ?? archived?.handover_receipt_id);
  delete repaired.archived_progress;
  return repaired;
}

/**
 * Repair a stuck non-committed finalization transaction. A malformed or stale
 * staged transaction otherwise dead-ends the role: `--finalize` refuses to
 * restage over it, so the role stays `prepared`/`prefilled` even though the
 * browser form is complete. The failed transaction is archived locally, its
 * partial report/handover artifacts are rolled back, and the next `--finalize`
 * starts a fresh transaction from the same page evidence. Committed
 * transactions (already-final receipts) are never touched.
 */
export function repairFinalizationTransaction(roleId) {
  const repaired = mutateQueue((queue) => {
    const role = roleFromQueue(queue, roleId);
    const transaction = role.application_finalization_transaction;
    if (!transaction) {
      throw new Error('no application finalization transaction exists to repair');
    }
    if (transaction.state === 'committed') {
      throw new Error('refusing to repair a committed finalization transaction; the receipt is already final');
    }
    if (role.status === 'filled') {
      throw new Error('filled roles are repaired with --repair-filled, not --repair-finalization');
    }
    if (role.application_decision_transaction &&
        role.application_decision_transaction.state !== 'committed') {
      throw new Error('candidate decision transaction is pending; retry that decision instead of repairing finalization');
    }
    const repairedAt = new Date().toISOString();
    const archived = structuredClone(transaction);
    role.application_receipt_repairs = [
      ...(Array.isArray(role.application_receipt_repairs) ? role.application_receipt_repairs : []),
      {
        repaired_at: repairedAt,
        previous_status: role.status,
        kind: 'finalization-transaction',
        finalization_transaction: archived,
      },
    ];
    delete role.application_finalization_transaction;
    return {
      role_id: roleId,
      status: role.status,
      repaired_at: repairedAt,
      archived_transaction_id: archived.transaction_id ?? null,
      archived_transaction: archived,
    };
  });

  // Roll back any artifacts the failed staging attempt may have written, only
  // after the cleared state is durable. Both helpers tolerate missing or
  // already-consistent artifacts, and a malformed transaction may lack these
  // fields entirely.
  const archived = repaired.archived_transaction;
  if (archived?.report_path) {
    demoteApplicationAnswersReport(archived.report_path, archived.run_id ?? null);
  }
  if (archived?.receipt_id) removeHandoverReceipt(archived.receipt_id);
  delete repaired.archived_transaction;
  return repaired;
}

export function verifyRole(roleId) {
  const queue = loadQueue();
  const role = roleFromQueue(queue, roleId);
  const errors = reviewReadinessErrors(role);
  return { role_id: roleId, review_ready: errors.length === 0, errors };
}

async function main() {
  const [cmd, roleId, jsonArg] = process.argv.slice(2);
  if (!cmd || !roleId) {
    throw new Error('usage: application-receipt.mjs --begin|--page|--finalize|--verify|--repair-filled|--repair-finalization <role-id> [json|@file]');
  }
  let result;
  if (cmd === '--verify') result = verifyRole(roleId);
  else if (cmd === '--repair-filled') result = repairFilledRole(roleId);
  else if (cmd === '--repair-finalization') result = repairFinalizationTransaction(roleId);
  else {
    const payload = parseJsonArg(jsonArg);
    if (cmd === '--begin') result = beginRole(roleId, payload);
    else if (cmd === '--page') result = recordRolePage(roleId, payload);
    else if (cmd === '--finalize') result = finalizeRole(roleId, payload);
    else throw new Error('unknown command: ' + cmd);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (cmd === '--verify' && !result.review_ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    process.stderr.write('application-receipt: ' + err.message + '\n');
    process.exit(1);
  });
}
