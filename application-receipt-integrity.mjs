#!/usr/bin/env node
/**
 * Executable integrity contract for receipt-protected application statuses.
 *
 * application-receipt.mjs creates this evidence only after its full filesystem
 * and browser/resolver readiness gates pass. queue-store.mjs independently
 * revalidates the same role/request/tab/page/artifact binding before allowing a
 * new `filled` or `submitted` transition.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { applicationActionDecision, isFinalApplicationActionLabel } from './application-safety.mjs';
import { APPLICATION_QUALITY_EVIDENCE_VERSION } from './verify-userdata.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEST_ENTRYPOINT = basename(process.argv[1] || '');

function testEvidenceOverrideAllowed() {
  return process.env.NODE_ENV === 'test' &&
    (TEST_ENTRYPOINT.endsWith('.test.mjs') || TEST_ENTRYPOINT === 'test-all.mjs');
}

function reportsRoot() {
  if (testEvidenceOverrideAllowed() && process.env.CAREER_OPS_REPORTS_DIR) {
    return resolve(process.env.CAREER_OPS_REPORTS_DIR);
  }
  return join(ROOT, 'reports');
}

export const APPLICATION_RECEIPT_INTEGRITY_VERSION = 2;
const APPLICATION_RECEIPT_VERSION = 2;
const APPLICATION_REQUEST_VERSION = 1;
const RESOLVER_EVIDENCE_VERSION = 1;
export const APPLICATION_RECEIPT_REQUEST_CONTRACT = Object.freeze([
  'modes/apply.md',
  'modes/_custom.md',
  'queue-resolve.mjs',
  'application-receipt.mjs',
]);
const PREFLIGHT_METHODS = new Set([
  'check-liveness', 'ats-api', 'public-api', 'playwright', 'browser-snapshot',
]);
const BROWSER_PREFLIGHT_METHODS = new Set(['playwright', 'browser-snapshot']);
const FIELD_PROVENANCE = new Set(['deterministic', 'learned', 'cache', 'model']);
const FIELD_RESOLUTION = new Set(['resolved', 'novel']);
const UPLOAD_CONTROL_KINDS = new Set(['cv', 'cover', 'supporting', 'other']);
const REPORT_STATES = new Set(['filled', 'submitted']);
const SHA256 = /^[a-f0-9]{64}$/;
const COMPANY_SUFFIXES = [
  ['proprietary', 'limited'],
  ['pty', 'limited'],
  ['pty', 'ltd'],
  ['incorporated'],
  ['corporation'],
  ['company'],
  ['limited'],
  ['gmbh'],
  ['sarl'],
  ['llc'],
  ['llp'],
  ['plc'],
  ['corp'],
  ['inc'],
  ['ltd'],
  ['pty'],
  ['co'],
];
const COMPANY_PAGE_SUFFIXES = [['career', 'opportunities'], ['careers'], ['jobs']];
const TITLE_DECORATION_WORDS = new Set([
  'all', 'and', 'australia', 'australian', 'au', 'based', 'brisbane', 'canberra',
  'casual', 'contract', 'contractor', 'darwin', 'd', 'f', 'fixed', 'full', 'geelong',
  'genders', 'hobart', 'hybrid', 'in', 'm', 'melbourne', 'month', 'months', 'new',
  'nsw', 'nt', 'on', 'onsite', 'opportunity', 'part', 'permanent', 'perth', 'qld',
  'remote', 'sa', 'site', 'sydney', 'tas', 'temp', 'temporary', 'term', 'time',
  'vic', 'wa', 'year', 'years', 'zealand',
]);
const REQUISITION_FIELDS = [
  'requisition', 'requisition_id', 'requisitionId', 'req_id', 'reqId',
  'job_id', 'jobId', 'posting_id', 'postingId', 'reference_id', 'referenceId',
];
const REQUISITION_QUERY_KEYS = new Set([
  'gh_jid', 'job', 'jobid', 'job_id', 'jobno', 'job_no', 'postingid', 'posting_id',
  'reqid', 'req_id', 'requisition', 'requisitionid', 'requisition_id',
]);
const ABSENT_REQUISITION = /^(?:n\/?a|none|not (?:available|shown|provided|listed)|unknown|unavailable|-+)$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedLabel(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function comparableWords(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripTrailingWords(words, suffixes) {
  let output = [...words];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (output.length <= suffix.length) continue;
      const start = output.length - suffix.length;
      if (suffix.every((word, index) => output[start + index] === word)) {
        output = output.slice(0, start);
        changed = true;
        break;
      }
    }
  }
  return output;
}

function companyKey(value) {
  let words = comparableWords(value);
  if (words[0] === 'company' || words[0] === 'employer' ||
      words[0] === 'organisation' || words[0] === 'organization') {
    words = words.slice(1);
  }
  if (words.length > 1 && words[0] === 'the') words = words.slice(1);
  words = stripTrailingWords(words, COMPANY_PAGE_SUFFIXES);
  words = stripTrailingWords(words, COMPANY_SUFFIXES);
  return words.join(' ');
}

function companiesCompatible(expected, observed) {
  const expectedKey = companyKey(expected);
  const observedKey = companyKey(observed);
  return expectedKey.length > 0 && expectedKey === observedKey;
}

function canonicalRequisition(value) {
  const text = String(value ?? '').trim();
  if (!text || ABSENT_REQUISITION.test(text)) return null;
  const withoutLabel = text.replace(
    /^(?:(?:job|posting|requisition|req(?:uisition)?|reference|ref)\s*(?:id|number|no)?\s*[:#-]?\s*)+/i,
    '',
  );
  const key = comparableWords(withoutLabel).join('');
  if (!key) return null;
  return /^(?:req|jr|r)\d+$/i.test(key) ? key.replace(/^(?:req|jr|r)/i, '') : key;
}

function expectedRequisitions(role) {
  const values = [];
  for (const field of REQUISITION_FIELDS) {
    const value = role?.[field];
    if (typeof value === 'string' || typeof value === 'number') values.push(String(value).trim());
  }
  try {
    const url = new URL(String(role?.url ?? ''));
    for (const [key, value] of url.searchParams) {
      if (REQUISITION_QUERY_KEYS.has(key.toLowerCase()) && value.trim()) values.push(value.trim());
    }
    const path = decodeURIComponent(url.pathname);
    const labelled = path.match(/\/(?:requisition|requisitions)\/([^/?#]+)/i)?.[1];
    if (labelled) values.push(labelled);
    const numericJob = path.match(/\/jobs?\/(\d{3,})\/?$/i)?.[1];
    if (numericJob) values.push(numericJob);
    const prefixedJob = path.match(/\/jobs?\/(?:[^/]+\/)*((?:req|jr|r)[-_]?\d+)\/?$/i)?.[1];
    if (prefixedJob) values.push(prefixedJob);
    const uuidJob = path.match(/\/jobs?\/(?:[^/]+\/)*([0-9a-f]{8}-[0-9a-f-]{27,})\/?$/i)?.[1];
    if (uuidJob) values.push(uuidJob);
  } catch {
    // A malformed URL contributes no requisition identity; company/title still fail closed.
  }
  const seen = new Set();
  return values.filter((value) => {
    const key = canonicalRequisition(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function titleDecorationSegment(value) {
  const words = comparableWords(value);
  return words.some((word) => TITLE_DECORATION_WORDS.has(word)) && words.every(
    (word) => /^\d+$/.test(word) || TITLE_DECORATION_WORDS.has(word),
  );
}

function titleKey(value, role, expectedReqs) {
  let text = String(value ?? '').trim();
  const requisitionKeys = new Set(expectedReqs.map(canonicalRequisition).filter(Boolean));
  const removableSegment = (segment) => {
    if (titleDecorationSegment(segment)) return true;
    if (companiesCompatible(role?.company, segment)) return true;
    const req = canonicalRequisition(segment);
    return req != null && requisitionKeys.has(req);
  };
  let changed = true;
  while (changed && text) {
    changed = false;
    const bracket = text.match(/\s*[([]([^\])]+)[\])]\s*$/);
    if (bracket && removableSegment(bracket[1])) {
      text = text.slice(0, bracket.index).trim();
      changed = true;
      continue;
    }
    const pieces = text.split(/\s+(?:-|–|—|\||•)\s+/);
    if (pieces.length > 1 && removableSegment(pieces.at(-1))) {
      pieces.pop();
      text = pieces.join(' - ').trim();
      changed = true;
      continue;
    }
    if (pieces.length > 1 && companiesCompatible(role?.company, pieces[0])) {
      pieces.shift();
      text = pieces.join(' - ').trim();
      changed = true;
    }
  }
  let words = comparableWords(text);
  if (words[0] === 'job' && words[1] === 'title') words = words.slice(2);
  else if (words[0] === 'title') words = words.slice(1);
  return words.map((word) => (word === 'sr' ? 'senior' : word === 'jr' ? 'junior' : word)).join(' ');
}

/**
 * Derive a destination match from the observed page identity and the selected
 * queue role. The caller-supplied `result` field is intentionally ignored.
 */
export function compareApplicationDestination(role, evidence) {
  const errors = [];
  const expectedReqs = expectedRequisitions(role);
  const observedCompany = String(evidence?.observed_company ?? '').trim();
  const observedTitle = String(evidence?.observed_title ?? '').trim();
  const observedRequisition = String(evidence?.observed_requisition ?? '').trim();

  if (!companiesCompatible(role?.company, observedCompany)) {
    errors.push('observed company materially differs from the selected queue role');
  }
  const expectedTitleKey = titleKey(role?.title, role, expectedReqs);
  const observedTitleKey = titleKey(observedTitle, role, expectedReqs);
  if (!expectedTitleKey || expectedTitleKey !== observedTitleKey) {
    errors.push('observed title materially differs from the selected queue role');
  }

  const observedReqKey = canonicalRequisition(observedRequisition);
  const expectedReqKeys = new Set(expectedReqs.map(canonicalRequisition).filter(Boolean));
  const requisitionCompared = observedReqKey != null && expectedReqKeys.size > 0;
  if (requisitionCompared && !expectedReqKeys.has(observedReqKey)) {
    errors.push('observed requisition materially differs from the selected queue role');
  }

  return {
    matched: errors.length === 0,
    errors,
    expected_requisition: expectedReqs[0] ?? 'not available',
    requisition_compared: requisitionCompared,
  };
}

function push(condition, errors, message) {
  if (!condition) errors.push(message);
}

function expectedReceiptId(role, progress) {
  return `application-receipt:${role?.id ?? ''}:${progress?.run_id ?? ''}`;
}

function fieldManifest(fields) {
  return fields.map((field) => ({
    control_id: field.control_id,
    label: field.label,
    type: field.type,
    required: field.required,
  }));
}

function validateUploadControls(items, errors, prefix) {
  if (!Array.isArray(items)) {
    errors.push(`${prefix} must be an array`);
    return [];
  }
  const seen = new Set();
  items.forEach((item, index) => {
    const name = `${prefix}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${name} must be an object`);
      return;
    }
    push(isText(item.control_id), errors, `${name}.control_id is missing`);
    push(!seen.has(item.control_id), errors, `${name}.control_id is duplicated`);
    seen.add(item.control_id);
    push(isText(item.label), errors, `${name}.label is missing`);
    push(UPLOAD_CONTROL_KINDS.has(item.kind), errors, `${name}.kind is invalid`);
    push(typeof item.required === 'boolean', errors, `${name}.required is invalid`);
    push(typeof item.multiple === 'boolean', errors, `${name}.multiple is invalid`);
    push(typeof item.enabled === 'boolean', errors, `${name}.enabled is invalid`);
    push(item.accepts == null || typeof item.accepts === 'string', errors, `${name}.accepts is invalid`);
  });
  return items;
}

function combinedUploadControls(pages, errors) {
  const map = new Map();
  for (const page of pages) {
    for (const control of validateUploadControls(
      page?.upload_controls,
      errors,
      `page ${page?.page_id ?? page?.page_index} upload_controls`,
    )) {
      const previous = map.get(control.control_id);
      push(!previous || same(previous, control), errors,
        `upload control ${control.control_id} changed identity during the application`);
      map.set(control.control_id, control);
    }
  }
  return [...map.values()];
}

function validateAttachmentCoverage(uploadControls, attachments, notApplicableReason, errors) {
  const controls = new Map(uploadControls.map((control) => [control.control_id, control]));
  const byControl = new Map();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const control = controls.get(attachment.control_id);
    push(Boolean(control), errors,
      `attachment control_id was not observed on the live application: ${attachment.control_id ?? '<missing>'}`);
    push(!control || control.enabled === true, errors,
      `attachment control_id was disabled on the live application: ${attachment.control_id ?? '<missing>'}`);
    if (!byControl.has(attachment.control_id)) byControl.set(attachment.control_id, []);
    byControl.get(attachment.control_id).push(attachment);
  }
  const attachmentList = Array.isArray(attachments) ? attachments : [];
  const enabledControls = uploadControls.filter((control) => control.enabled === true);
  const reason = String(notApplicableReason ?? '').trim();
  push(attachmentList.length === 0 || reason.length === 0, errors,
    'attachments_not_applicable_reason cannot accompany verified attachments');
  push(enabledControls.length === 0 || reason.length === 0, errors,
    'attachments_not_applicable_reason is invalid while an enabled upload control accepts an attachment');
  push(enabledControls.length === 0 || attachmentList.length > 0, errors,
    'enabled upload controls require verified attachment evidence');
  push(enabledControls.length > 0 || attachmentList.length > 0 || reason.length > 0, errors,
    'no enabled upload controls requires attachments_not_applicable_reason');
  for (const control of enabledControls) {
    const attached = byControl.get(control.control_id) ?? [];
    if (control.kind === 'cv') {
      push(attached.some((item) => /(?:cv|resume|résumé)/i.test(String(item.kind ?? ''))), errors,
        `CV upload control has no verified CV attachment: ${control.label}`);
    }
    if (control.kind === 'cover' || control.kind === 'supporting') {
      push(attached.some((item) => /cover/i.test(String(item.kind ?? ''))), errors,
        `cover-compatible upload control has no verified cover-letter attachment: ${control.label}`);
    }
    if (control.kind === 'other' && control.required) {
      push(attached.length > 0, errors, `required upload control has no verified attachment: ${control.label}`);
    }
  }
}

function attachmentIdentity(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    control_id: item.control_id,
    kind: item.kind,
    expected: basename(String(item.expected ?? '')),
    displayed: basename(String(item.displayed ?? '')),
    asset_sha256: item.asset_sha256,
    verified: item.verified === true,
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function roleAssetPaths(role) {
  const covers = role?.cover_letter_paths;
  const values = Array.isArray(covers)
    ? covers
    : (covers && typeof covers === 'object'
      ? Object.values(covers)
      : (typeof covers === 'string' ? [covers] : []));
  if (role?.cover_letter_path) values.push(role.cover_letter_path);
  return new Map([
    ...(isText(role?.cv_pdf) ? [[resolve(ROOT, String(role.cv_pdf)), 'cv']] : []),
    ...values.filter((value) => isText(value)).map((value) => [resolve(ROOT, String(value)), 'cover']),
  ]);
}

function validateAttachments(items, role, errors, prefix) {
  if (!Array.isArray(items)) {
    errors.push(`${prefix} must be an array`);
    return;
  }
  const assets = roleAssetPaths(role);
  const seen = new Set();
  items.forEach((item, index) => {
    const name = `${prefix}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${name} must be an object`);
      return;
    }
    push(isText(item.control_id), errors, `${name}.control_id is missing`);
    push(isText(item.kind), errors, `${name}.kind is missing`);
    push(isText(item.expected), errors, `${name}.expected is missing`);
    push(isText(item.displayed), errors, `${name}.displayed is missing`);
    push(item.verified === true, errors, `${name} is not verified`);
    const expected = basename(String(item.expected ?? ''));
    const displayed = basename(String(item.displayed ?? ''));
    push(expected === displayed && expected.length > 0, errors, `${name} filename binding is invalid`);
    const expectedPath = resolve(ROOT, String(item.expected ?? ''));
    const assetKind = assets.get(expectedPath);
    push(Boolean(assetKind), errors, `${name} is not bound to the exact role application asset path`);
    const declaredKind = String(item.kind ?? '').toLowerCase();
    if (assetKind === 'cv') {
      push(/(?:cv|resume|résumé)/i.test(declaredKind), errors, `${name} kind does not match the CV asset`);
    } else if (assetKind === 'cover') {
      push(/cover/i.test(declaredKind), errors, `${name} kind does not match the cover-letter asset`);
    }
    push(SHA256.test(String(item.asset_sha256 ?? '')), errors, `${name}.asset_sha256 is invalid`);
    if (assetKind && existsSync(expectedPath)) {
      push(sha256(readFileSync(expectedPath)) === item.asset_sha256, errors,
        `${name} content hash no longer matches the role asset`);
    } else if (assetKind) {
      errors.push(`${name} role asset no longer exists`);
    }
    const identity = `${String(item.control_id ?? '')}:${declaredKind}:${item.asset_sha256 ?? ''}`;
    push(!seen.has(identity), errors, `${name} duplicates an attachment receipt`);
    seen.add(identity);
  });
}

function validateQualityEvidence(role, progress, request, errors) {
  const evidence = progress?.asset_quality_evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('asset quality evidence is missing');
    return;
  }
  push(evidence.version === APPLICATION_QUALITY_EVIDENCE_VERSION, errors, 'asset quality evidence version is stale');
  push(evidence.validator === 'verify-userdata.mjs', errors, 'asset quality evidence validator is invalid');
  push(evidence.role_id === role.id, errors, 'asset quality evidence belongs to a different role');
  push(isTimestamp(evidence.validated_at), errors, 'asset quality evidence timestamp is invalid');
  push(SHA256.test(String(evidence.fingerprint ?? '')), errors, 'asset quality evidence fingerprint is invalid');
  push(same(request?.asset_quality_evidence, evidence), errors,
    'application request asset quality evidence differs from the receipt');
}

function validatePreflight(role, progress, errors) {
  const preflight = progress?.preflight;
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
    errors.push('structured preflight evidence is missing');
    return;
  }
  const validateEvidence = (evidence, kind) => {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push(`${kind} preflight evidence is missing`);
      return;
    }
    push(PREFLIGHT_METHODS.has(evidence.method), errors, `${kind} preflight method is invalid`);
    push(isText(evidence.checked_url), errors, `${kind} checked_url is missing`);
    push(isTimestamp(evidence.checked_at), errors, `${kind} checked_at is invalid`);
    const expectedResult = kind === 'liveness' ? 'active' : 'matched';
    push(evidence.result === expectedResult, errors, `${kind} preflight result must be ${expectedResult}`);
    const digest = BROWSER_PREFLIGHT_METHODS.has(evidence.method)
      ? evidence.snapshot_digest
      : evidence.evidence_digest;
    push(SHA256.test(String(digest ?? '')), errors, `${kind} preflight digest is invalid`);
  };
  validateEvidence(preflight.liveness, 'liveness');
  validateEvidence(preflight.destination, 'destination');
  push(preflight.liveness_verified === true, errors, 'derived liveness verification is not true');
  push(preflight.role_match_verified === true, errors, 'derived role-match verification is not true');
  push(preflight.checked_url === preflight.liveness?.checked_url, errors,
    'preflight checked_url differs from liveness evidence');
  push(preflight.destination?.checked_url === progress?.tab?.url, errors,
    'destination preflight is not bound to the recorded tab URL');
  push(preflight.destination?.expected_company === String(role.company ?? ''), errors,
    'destination expected company differs from the queue role');
  push(preflight.destination?.expected_title === String(role.title ?? ''), errors,
    'destination expected title differs from the queue role');
  push(isText(preflight.destination?.observed_company), errors, 'destination observed company is missing');
  push(isText(preflight.destination?.observed_title), errors, 'destination observed title is missing');
  push(isText(preflight.destination?.observed_requisition), errors,
    'destination observed requisition evidence is missing');
  const comparison = compareApplicationDestination(role, preflight.destination);
  for (const error of comparison.errors) errors.push(`destination preflight: ${error}`);
  push(preflight.destination?.expected_requisition === comparison.expected_requisition, errors,
    'destination expected requisition differs from the selected queue role');
  push(preflight.destination?.requisition_compared === comparison.requisition_compared, errors,
    'destination requisition comparison state is invalid');
  push(preflight.role_match_verified === comparison.matched, errors,
    'derived role-match verification does not match observed destination identity');
}

function validateResolverEvidence(page, fields, errors) {
  const evidence = page?.resolver_evidence;
  const prefix = `page ${page?.page_id ?? page?.page_index}`;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push(`${prefix}: resolver evidence is missing`);
    return;
  }
  push(evidence.version === RESOLVER_EVIDENCE_VERSION, errors, `${prefix}: resolver evidence version is stale`);
  push(isText(evidence.evidence_id), errors, `${prefix}: resolver evidence_id is missing`);
  push(page.resolver_evidence_id === evidence.evidence_id, errors,
    `${prefix}: resolver evidence_id binding is invalid`);
  for (const key of ['run_id', 'tab_id', 'page_id', 'page_index', 'url']) {
    push(evidence[key] === page[key], errors, `${prefix}: resolver ${key} differs from the page receipt`);
  }
  push(SHA256.test(String(evidence.snapshot_digest ?? '')), errors,
    `${prefix}: resolver snapshot digest is invalid`);
  push(isTimestamp(evidence.observed_at), errors, `${prefix}: resolver observed_at is invalid`);
  push(isTimestamp(evidence.lookup_completed_at), errors,
    `${prefix}: resolver lookup completion timestamp is invalid`);
  push(Array.isArray(evidence.fields), errors, `${prefix}: resolver fields are missing`);
  push(Array.isArray(evidence.resolved), errors, `${prefix}: resolver resolved ledger is missing`);
  push(Array.isArray(evidence.novel), errors, `${prefix}: resolver novel ledger is missing`);
  if (!Array.isArray(evidence.fields) || !Array.isArray(evidence.resolved) || !Array.isArray(evidence.novel)) return;

  const lookupCore = {
    version: evidence.version,
    evidence_id: evidence.evidence_id,
    run_id: evidence.run_id,
    tab_id: evidence.tab_id,
    page_id: evidence.page_id,
    page_index: evidence.page_index,
    url: evidence.url,
    snapshot_digest: evidence.snapshot_digest,
    observed_at: evidence.observed_at,
    fields: evidence.fields,
    resolved: evidence.resolved,
    novel: evidence.novel,
  };
  push(evidence.lookup_fingerprint === hashJson(lookupCore), errors,
    `${prefix}: resolver lookup fingerprint is invalid`);
  push(evidence.fields.length === fields.length, errors,
    `${prefix}: resolver field count differs from the page receipt`);
  evidence.fields.forEach((field, index) => {
    const actual = fields[index];
    if (!actual) return;
    push(String(field.control_id ?? '').trim() === actual.control_id, errors,
      `${prefix}: resolver control_id differs at field ${index}`);
    push(String(field.label ?? '').trim() === actual.label, errors,
      `${prefix}: resolver label differs at field ${index}`);
    push((String(field.type ?? 'unknown').trim() || 'unknown') === actual.type, errors,
      `${prefix}: resolver type differs at field ${index}`);
    push((field.required === true) === actual.required, errors,
      `${prefix}: resolver required flag differs at field ${index}`);
  });

  const teach = evidence.teach;
  if (!teach || typeof teach !== 'object' || !Array.isArray(teach.answers)) {
    errors.push(`${prefix}: resolver teach evidence is missing`);
    return;
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
  push(teach.teach_fingerprint === hashJson(teachCore), errors,
    `${prefix}: resolver teach fingerprint is invalid`);
  push(isTimestamp(teach.completed_at), errors, `${prefix}: resolver teach completion timestamp is invalid`);
  push(evidence.resolved.length + evidence.novel.length === fields.length, errors,
    `${prefix}: resolver does not classify every page field`);

  const classificationKey = (item) =>
    `${String(item?.control_id ?? '').trim()}\u0000${normalizedLabel(item?.label)}`;
  push(same(
    teach.answers.map(classificationKey),
    evidence.novel.map(classificationKey),
  ), errors, `${prefix}: teach evidence does not cover the novel fields exactly`);

  const resolved = new Map(evidence.resolved.map((item) => [classificationKey(item), item]));
  const novel = new Map(evidence.novel.map((item) => [classificationKey(item), item]));
  const taught = new Map(teach.answers.map((item) => [classificationKey(item), item]));
  for (const field of fields) {
    const key = classificationKey(field);
    if (field.resolution === 'resolved') {
      const item = resolved.get(key);
      push(Boolean(item), errors, `${prefix}: resolved classification is missing for ${field.label}`);
      if (item) {
        push(String(item.answer ?? '') === field.answer, errors,
          `${prefix}: resolved answer differs for ${field.label}`);
        push(String(item.source ?? '').toLowerCase() === field.provenance, errors,
          `${prefix}: resolved provenance differs for ${field.label}`);
        push((item.review_required === true) === field.review_required, errors,
          `${prefix}: resolved review flag differs for ${field.label}`);
        push(String(item.review_note ?? '').trim() === String(field.review_note ?? '').trim(), errors,
          `${prefix}: resolved review note differs for ${field.label}`);
      }
      push(!novel.has(key) && !taught.has(key), errors,
        `${prefix}: resolved field is also classified as novel`);
    } else {
      const novelItem = novel.get(key);
      const taughtItem = taught.get(key);
      push(Boolean(novelItem) && Boolean(taughtItem), errors,
        `${prefix}: novel/teach classification is missing for ${field.label}`);
      if (taughtItem) {
        push(String(taughtItem.answer ?? '') === field.answer, errors,
          `${prefix}: taught answer differs for ${field.label}`);
        push((taughtItem.review_required === true) === field.review_required, errors,
          `${prefix}: taught review flag differs for ${field.label}`);
        push(String(taughtItem.review_note ?? '').trim() === String(field.review_note ?? '').trim(), errors,
          `${prefix}: taught review note differs for ${field.label}`);
      }
      push(!resolved.has(key), errors, `${prefix}: novel field is also classified as resolved`);
    }
  }
  push(new Set(evidence.resolved.map(classificationKey)).size === evidence.resolved.length, errors,
    `${prefix}: duplicate resolver resolved classifications`);
  push(new Set(evidence.novel.map(classificationKey)).size === evidence.novel.length, errors,
    `${prefix}: duplicate resolver novel classifications`);
  push(new Set(teach.answers.map(classificationKey)).size === teach.answers.length, errors,
    `${prefix}: duplicate resolver teach classifications`);
}

function validateObservationStep(step, name, page, manifest, errors) {
  const prefix = `page ${page?.page_id ?? page?.page_index}: browser ${name}`;
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`${prefix} observation is missing`);
    return;
  }
  push(SHA256.test(String(step.snapshot_digest ?? '')), errors, `${prefix} snapshot digest is invalid`);
  push(step.url === page.url, errors, `${prefix} URL differs from the page receipt`);
  push(same(step.field_manifest, manifest), errors, `${prefix} field manifest differs from the page receipt`);
  push(isTimestamp(step.captured_at), errors, `${prefix} captured_at is invalid`);
}

function validateBrowserObservation(page, fields, errors) {
  const observation = page?.browser_observation;
  const prefix = `page ${page?.page_id ?? page?.page_index}`;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    errors.push(`${prefix}: browser observation is missing`);
    return;
  }
  push(observation.source === 'playwright-mcp', errors, `${prefix}: browser source must be playwright-mcp`);
  push(observation.page_kind === 'form' || observation.page_kind === 'review', errors,
    `${prefix}: browser page_kind is invalid`);
  if (fields.length === 0) {
    push(page.final_page === true && observation.page_kind === 'review', errors,
      `${prefix}: zero-field receipt is not an evidenced final review page`);
  }
  const manifest = fieldManifest(fields);
  validateObservationStep(observation.before, 'before', page, manifest, errors);
  validateObservationStep(observation.rescan, 'rescan', page, manifest, errors);
  validateObservationStep(observation.after, 'after', page, manifest, errors);
  push(observation.before?.snapshot_digest === page.resolver_evidence?.snapshot_digest, errors,
    `${prefix}: browser before snapshot differs from resolver lookup`);
  push(observation.before?.captured_at === page.resolver_evidence?.observed_at, errors,
    `${prefix}: browser before timestamp differs from resolver lookup`);
  if (isTimestamp(observation.before?.captured_at) &&
      isTimestamp(observation.rescan?.captured_at) &&
      isTimestamp(observation.after?.captured_at)) {
    const times = [
      Date.parse(observation.before.captured_at),
      Date.parse(observation.rescan.captured_at),
      Date.parse(observation.after.captured_at),
    ];
    push(times[0] <= times[1] && times[1] <= times[2], errors,
      `${prefix}: browser observations are not ordered before/rescan/after`);
  }
  if (fields.length) {
    push(observation.after?.snapshot_digest !== observation.before?.snapshot_digest, errors,
      `${prefix}: post-fill browser snapshot did not change`);
  }
  push(Array.isArray(observation.after?.validation_errors) &&
    observation.after.validation_errors.length === 0, errors,
  `${prefix}: browser validation errors remain`);
  const expectedPopulated = fields.map((field) => ({
    control_id: field.control_id,
    answer_digest: sha256(field.answer),
  }));
  push(same(observation.after?.populated_manifest, expectedPopulated), errors,
    `${prefix}: populated control manifest differs from the receipted answers`);
  if (page.final_page) {
    push(observation.submit_boundary?.present === true, errors,
      `${prefix}: final submit boundary is not evidenced`);
    push(isText(observation.submit_boundary?.control_id), errors,
      `${prefix}: final submit control_id is missing`);
    push(isText(observation.submit_boundary?.label), errors,
      `${prefix}: final submit label is missing`);
    push(isFinalApplicationActionLabel(observation.submit_boundary?.label), errors,
      `${prefix}: final submit label is not a recognized final application action`);
    const decision = applicationActionDecision(observation.submit_boundary?.label, {
      phase: 'application-submit',
      applicationSubmissionDetected: true,
    });
    push(decision.allowed === false && /candidate-only/.test(decision.reason ?? ''), errors,
      `${prefix}: final submit boundary is not governed by the candidate-only action policy`);
  }
}

function validatePage(page, role, progress, errors) {
  const prefix = `page ${page?.page_id ?? page?.page_index}`;
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    errors.push('page receipt must be an object');
    return;
  }
  push(page.run_id === progress.run_id, errors, `${prefix}: run_id differs from the application receipt`);
  push(page.tab_id === progress.tab?.id, errors, `${prefix}: tab_id differs from the application receipt`);
  push(isText(page.page_id), errors, `${prefix}: page_id is missing`);
  push(Number.isInteger(page.page_index) && page.page_index >= 0, errors, `${prefix}: page_index is invalid`);
  push(isText(page.url), errors, `${prefix}: URL is missing`);
  push(Array.isArray(page.fields), errors, `${prefix}: fields are missing`);
  const fields = Array.isArray(page.fields) ? page.fields : [];
  const uploadControls = validateUploadControls(page.upload_controls, errors, `${prefix} upload_controls`);
  push(page.field_count === fields.length, errors, `${prefix}: field_count differs from the field ledger`);
  const controlIds = new Set();
  const counts = { resolved: 0, novel: 0, answered: 0, taught: 0 };
  const provenance = { deterministic: 0, learned: 0, cache: 0, model: 0 };
  const reviewRequired = [];
  fields.forEach((field, index) => {
    const name = `${prefix} field ${index}`;
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      errors.push(`${name} must be an object`);
      return;
    }
    push(isText(field.control_id), errors, `${name} control_id is missing`);
    push(!controlIds.has(field.control_id), errors, `${name} control_id is duplicated`);
    controlIds.add(field.control_id);
    push(isText(field.label), errors, `${name} label is missing`);
    push(isText(field.type), errors, `${name} type is missing`);
    push(typeof field.required === 'boolean', errors, `${name} required flag is invalid`);
    push(isText(field.answer), errors, `${name} answer is blank`);
    push(FIELD_RESOLUTION.has(field.resolution), errors, `${name} resolution is invalid`);
    push(FIELD_PROVENANCE.has(field.provenance), errors, `${name} provenance is invalid`);
    push(typeof field.taught === 'boolean', errors, `${name} taught flag is invalid`);
    push(typeof field.review_required === 'boolean', errors, `${name} review_required flag is invalid`);
    if (field.resolution === 'novel') {
      push(field.provenance === 'model' && field.taught === true, errors,
        `${name} novel answer did not cross L3/teach`);
    } else if (field.resolution === 'resolved') {
      // A role-local L3 answer taught previously is resolved by the live
      // drafts-first layer with model provenance. It is not taught again on
      // this page, and any review flag remains bound by resolver evidence.
      push(field.taught === false, errors,
        `${name} resolved answer must not be taught again`);
    }
    if (field.review_required) {
      push(isText(field.review_note), errors, `${name} review note is missing`);
      reviewRequired.push({
        label: field.label,
        answer: field.answer,
        note: field.review_note,
      });
    } else {
      push(field.review_note == null || String(field.review_note).trim() === '', errors,
        `${name} has an unexpected review note`);
    }
    if (FIELD_RESOLUTION.has(field.resolution)) counts[field.resolution] += 1;
    if (isText(field.answer)) counts.answered += 1;
    if (field.resolution === 'novel' && field.taught === true) counts.taught += 1;
    if (FIELD_PROVENANCE.has(field.provenance)) provenance[field.provenance] += 1;
  });
  push(page.resolved_count === counts.resolved, errors, `${prefix}: resolved_count is invalid`);
  push(page.novel_count === counts.novel, errors, `${prefix}: novel_count is invalid`);
  push(page.answered_count === counts.answered && counts.answered === fields.length, errors,
    `${prefix}: not every field is answered`);
  push(page.taught_count === counts.taught && counts.taught === counts.novel, errors,
    `${prefix}: not every novel field is taught`);
  for (const flag of [
    'lookup_completed', 'l3_completed', 'teach_completed',
    'conditional_rescan_completed', 'verified',
  ]) {
    push(page[flag] === true, errors, `${prefix}: ${flag} is not true`);
  }
  push(Array.isArray(page.validation_errors) && page.validation_errors.length === 0, errors,
    `${prefix}: validation errors remain`);
  push(same(page.provenance_counts, provenance), errors, `${prefix}: provenance counts are invalid`);
  push(same(page.review_required, reviewRequired), errors, `${prefix}: review ledger is invalid`);
  push(page.fingerprint === hashJson({
    url: page.url,
    fields,
    upload_controls: uploadControls,
  }), errors, `${prefix}: page fingerprint is invalid`);
  push(isTimestamp(page.lookup_at), errors, `${prefix}: lookup_at is invalid`);
  push(isTimestamp(page.teach_at), errors, `${prefix}: teach_at is invalid`);
  push(isTimestamp(page.verified_at), errors, `${prefix}: verified_at is invalid`);
  validateAttachments(page.attachments, role, errors, `${prefix} attachments`);
  validateResolverEvidence(page, fields, errors);
  validateBrowserObservation(page, fields, errors);
}

function structuralErrors(role, expectedReportState) {
  const errors = [];
  const progress = role?.application_progress;
  const request = role?.application_request;
  if (!role || typeof role !== 'object' || !isText(role.id)) return ['queue role is missing'];
  if (!REPORT_STATES.has(expectedReportState)) return ['expected report state must be filled or submitted'];
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return ['application progress receipt is missing'];
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return ['dashboard application_request is missing'];
  }

  push(progress.version === APPLICATION_RECEIPT_VERSION, errors, 'application receipt version is stale');
  push(progress.role_id === role.id, errors, 'application receipt belongs to a different role');
  push(isText(progress.run_id), errors, 'application receipt run_id is missing');
  push(progress.application_request_id === request.request_id, errors,
    'application receipt is not bound to its dashboard request');
  push(isText(progress.controller_id), errors, 'application receipt controller_id is missing');
  push(progress.company === String(role.company ?? ''), errors, 'application receipt company differs from the role');
  push(progress.title === String(role.title ?? ''), errors, 'application receipt title differs from the role');
  push(isText(progress.tab?.id), errors, 'application receipt tab_id is missing');
  push(isText(progress.tab?.url), errors, 'application receipt tab URL is missing');
  push(isTimestamp(progress.started_at), errors, 'application receipt started_at is invalid');
  push(isTimestamp(progress.updated_at), errors, 'application receipt updated_at is invalid');
  push(isTimestamp(progress.finalized_at), errors, 'application receipt finalized_at is invalid');
  push(isTimestamp(progress.report_state_finalized_at), errors,
    'application receipt report_state_finalized_at is invalid');
  push(progress.review_ready === true, errors, 'application receipt is not review-ready');
  push(progress.report_state === expectedReportState, errors,
    `application receipt report_state must be ${expectedReportState}`);
  push(isText(progress.application_answers_report), errors, 'Application Answers report path is missing');
  const receiptId = expectedReceiptId(role, progress);
  push(progress.receipt_id === receiptId, errors, 'stable application receipt_id is invalid');
  push(progress.handover_receipt_id === receiptId, errors, 'handover receipt_id is invalid');
  push(progress.pending_resolver_evidence == null, errors, 'unconsumed resolver evidence remains');
  push(progress.assets_verified === true, errors, 'final assets are not verified');
  push(Array.isArray(progress.final_validation_errors) &&
    progress.final_validation_errors.length === 0, errors,
  'final validation errors remain');
  push(isText(progress.final_url), errors, 'final application URL is missing');
  push(Array.isArray(progress.review_required), errors, 'combined review ledger is missing');
  if (expectedReportState === 'submitted') {
    push(isTimestamp(progress.submission_confirmed_at), errors,
      'candidate submission confirmation timestamp is missing');
  } else {
    push(progress.submission_confirmed_at == null, errors,
      'filled receipt unexpectedly contains a submission confirmation');
  }

  push(request.version === APPLICATION_REQUEST_VERSION, errors, 'application request version is stale');
  push(request.request_id === `${progress.run_id}:${role.id}`, errors, 'application request_id is invalid');
  push(request.run_id === progress.run_id, errors, 'application request run_id differs from the receipt');
  push(request.role_id === role.id, errors, 'application request belongs to a different role');
  push(/^dashboard(?:-|$)/.test(String(request.source ?? '')), errors,
    'application request did not originate from the dashboard');
  push(request.state === 'review-ready', errors, 'application request is not review-ready');
  push(request.controller === 'active-agent', errors, 'application request controller is invalid');
  push(request.controller_id === progress.controller_id, errors,
    'application request controller_id differs from the receipt');
  push(request.tab_id === progress.tab?.id, errors, 'application request tab_id differs from the receipt');
  push(request.url === role.url, errors, 'application request URL differs from the queue role');
  push(same(request.contract, APPLICATION_RECEIPT_REQUEST_CONTRACT), errors,
    'application request contract is incomplete');
  push(isTimestamp(request.requested_at), errors, 'application request requested_at is invalid');
  push(request.started_at === progress.started_at, errors, 'application request started_at differs from the receipt');
  push(request.consumed_at === progress.started_at, errors, 'application request consumed_at differs from the receipt');
  push(request.review_ready_at === progress.finalized_at, errors,
    'application request review_ready_at differs from the receipt');
  push(request.completed_at === progress.finalized_at, errors,
    'application request completed_at differs from the receipt');
  push(request.updated_at === progress.finalized_at, errors,
    'application request updated_at differs from the receipt');
  push(request.receipt_id === receiptId, errors, 'application request receipt_id is invalid');

  validatePreflight(role, progress, errors);
  validateQualityEvidence(role, progress, request, errors);

  const pages = Array.isArray(progress.pages) ? progress.pages : [];
  push(pages.length > 0, errors, 'application receipt has no page receipts');
  const pageIds = new Set();
  pages.forEach((page, index) => {
    push(page?.page_index === index, errors, 'application page indexes are not contiguous from zero');
    push(!pageIds.has(page?.page_id), errors, 'application page_id is duplicated');
    pageIds.add(page?.page_id);
    validatePage(page, role, progress, errors);
  });
  const finalPages = pages.filter((page) => page?.final_page === true);
  push(finalPages.length === 1, errors, 'exactly one final review page is required');
  const finalPage = finalPages[0];
  if (finalPage) {
    push(finalPage.page_index === pages.length - 1, errors, 'final review page is not the last page');
    push(progress.final_url === finalPage.url, errors, 'final URL differs from the final-page receipt');
  }
  const combinedReview = pages.flatMap((page) => page?.review_required ?? []);
  push(same(progress.review_required, combinedReview), errors, 'combined review ledger differs from page receipts');
  push(same(role.review_required_fields ?? [], combinedReview.map((item) => item.label)), errors,
    'role review-required field list differs from the receipt');

  const uploadControls = combinedUploadControls(pages, errors);
  push(same(progress.upload_controls ?? [], uploadControls), errors,
    'final upload-control ledger differs from the receipted page manifests');

  validateAttachments(progress.final_attachments, role, errors, 'final attachments');
  validateAttachmentCoverage(
    uploadControls,
    progress.final_attachments,
    progress.attachments_not_applicable_reason,
    errors,
  );
  if (finalPage) {
    push(same(
      attachmentIdentity(progress.final_attachments),
      attachmentIdentity(finalPage.attachments),
    ), errors, 'final attachments differ from the final-page receipt');
  }
  return errors;
}

function reportSection(source) {
  const startMatch = /^## Application Answers[ \t]*$/mi.exec(source);
  if (!startMatch) throw new Error('Application Answers section is missing');
  const start = startMatch.index;
  const afterHeading = start + startMatch[0].length;
  const tail = source.slice(afterHeading);
  const nextMatch = /^## (?!Application Answers\b).+$/m.exec(tail);
  const end = nextMatch ? afterHeading + nextMatch.index : source.length;
  return source.slice(start, end).trimEnd() + '\n';
}

function reportArtifact(progress, expectedReportState) {
  const pathValue = progress.application_answers_report;
  const absolute = resolve(ROOT, pathValue);
  if (!existsSync(absolute)) throw new Error('Application Answers report artifact does not exist');
  const allowedRoot = reportsRoot();
  if (!existsSync(allowedRoot)) throw new Error('canonical reports artifact root does not exist');
  const canonicalRoot = realpathSync(allowedRoot);
  const canonicalReport = realpathSync(absolute);
  const withinReports = relative(canonicalRoot, canonicalReport);
  if (!withinReports || withinReports.startsWith('..') ||
      resolve(canonicalRoot, withinReports) !== canonicalReport) {
    throw new Error('Application Answers report artifact must be inside the canonical reports/ root');
  }
  const section = reportSection(readFileSync(absolute, 'utf8'));
  const state = /^\*\*State:\*\*[ \t]*([^\n]+?)\s*$/mi.exec(section)?.[1]?.trim().toLowerCase();
  const runId = /^\*\*Run ID:\*\*[ \t]*([^\n]+?)\s*$/mi.exec(section)?.[1]?.trim();
  const pageCountValue = /^\*\*Receipt pages:\*\*[ \t]*(\d+)\s*$/mi.exec(section)?.[1];
  const pageCount = pageCountValue == null ? null : Number(pageCountValue);
  if (state !== expectedReportState) {
    throw new Error(`Application Answers artifact state must be ${expectedReportState}`);
  }
  if (runId !== progress.run_id) throw new Error('Application Answers artifact run_id differs from the receipt');
  if (pageCount !== progress.pages.length) {
    throw new Error('Application Answers artifact page count differs from the receipt');
  }
  return {
    path: pathValue,
    state,
    run_id: runId,
    page_count: pageCount,
    section_sha256: sha256(section),
  };
}

function handoverPath() {
  if (testEvidenceOverrideAllowed() && process.env.CAREER_OPS_HANDOVER_PATH) {
    return resolve(process.env.CAREER_OPS_HANDOVER_PATH);
  }
  return join(ROOT, 'handover.md');
}

function handoverArtifact(role, progress) {
  const path = handoverPath();
  if (!existsSync(path)) throw new Error('handover receipt artifact does not exist');
  const marker = `<!-- ${progress.handover_receipt_id} -->`;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.includes(marker));
  if (lines.length !== 1) throw new Error('handover receipt marker must occur exactly once');
  const line = lines[0];
  for (const binding of [
    `role ${role.id}`,
    `run ${progress.run_id}`,
    `final URL ${progress.final_url}`,
    `report ${progress.application_answers_report}`,
    'final application submission not performed by agent.',
  ]) {
    if (!line.includes(binding)) throw new Error(`handover receipt is missing binding: ${binding}`);
  }
  return {
    receipt_id: progress.handover_receipt_id,
    line_sha256: sha256(line),
  };
}

function artifactEvidence(role, expectedReportState) {
  const progress = role.application_progress;
  return {
    report: reportArtifact(progress, expectedReportState),
    handover: handoverArtifact(role, progress),
  };
}

function evidenceCore(role, expectedReportState, sealedAt, artifacts) {
  const progress = structuredClone(role.application_progress);
  delete progress.integrity;
  return {
    contract: 'career-ops/application-receipt-integrity/v1',
    expected_report_state: expectedReportState,
    sealed_at: sealedAt,
    role: {
      id: role.id,
      company: role.company ?? '',
      title: role.title ?? '',
      url: role.url ?? '',
      cv_pdf: role.cv_pdf ?? null,
      cover_letter_path: role.cover_letter_path ?? null,
      cover_letter_paths: role.cover_letter_paths ?? null,
      review_required_fields: role.review_required_fields ?? [],
    },
    application_request: role.application_request,
    application_progress: progress,
    artifacts,
  };
}

export function createApplicationReceiptIntegrity(role, expectedReportState, options = {}) {
  const errors = structuralErrors(role, expectedReportState);
  if (errors.length) {
    throw new Error('application receipt integrity contract failed: ' + errors.join(' | '));
  }
  const sealedAt = new Date(options.sealedAt ?? Date.now()).toISOString();
  if (!isTimestamp(sealedAt)) throw new Error('application receipt integrity sealed_at is invalid');
  const artifacts = artifactEvidence(role, expectedReportState);
  const core = evidenceCore(role, expectedReportState, sealedAt, artifacts);
  return {
    version: APPLICATION_RECEIPT_INTEGRITY_VERSION,
    algorithm: 'sha256',
    contract: core.contract,
    expected_report_state: expectedReportState,
    sealed_at: sealedAt,
    artifacts,
    digest: sha256(canonicalJson(core)),
  };
}

export function applicationReceiptIntegrityErrors(role, expectedReportState, options = {}) {
  const errors = structuralErrors(role, expectedReportState);
  const integrity = role?.application_progress?.integrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    errors.push('application receipt integrity evidence is missing');
    return errors;
  }
  push(integrity.version === APPLICATION_RECEIPT_INTEGRITY_VERSION, errors,
    'application receipt integrity version is stale');
  push(integrity.algorithm === 'sha256', errors, 'application receipt integrity algorithm is invalid');
  push(integrity.contract === 'career-ops/application-receipt-integrity/v1', errors,
    'application receipt integrity contract identifier is invalid');
  push(integrity.expected_report_state === expectedReportState, errors,
    'application receipt integrity report-state binding is invalid');
  push(isTimestamp(integrity.sealed_at), errors, 'application receipt integrity sealed_at is invalid');
  push(SHA256.test(String(integrity.digest ?? '')), errors, 'application receipt integrity digest is invalid');

  let actualArtifacts = integrity.artifacts;
  if (options.verifyArtifacts !== false) {
    try {
      actualArtifacts = artifactEvidence(role, expectedReportState);
      push(same(integrity.artifacts, actualArtifacts), errors,
        'application receipt report/handover artifacts no longer match the seal');
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (isTimestamp(integrity.sealed_at) && actualArtifacts) {
    const core = evidenceCore(role, expectedReportState, integrity.sealed_at, actualArtifacts);
    push(integrity.digest === sha256(canonicalJson(core)), errors,
      'application receipt integrity digest does not match the executable evidence');
  }
  return errors;
}

export function validateApplicationReceiptIntegrity(role, expectedReportState, options = {}) {
  const errors = applicationReceiptIntegrityErrors(role, expectedReportState, options);
  if (errors.length) throw new Error(errors.join(' | '));
  return role.application_progress.integrity;
}
