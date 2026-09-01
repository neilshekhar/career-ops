#!/usr/bin/env node
/**
 * one-shot-request.mjs — Durable One-shot work request + state machine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The candidate turns on One-shot, selects roles, and presses Run. Their intent
 * is a single authorization for the whole chain: deep-eval (if marked) → PREPARE
 * → machine asset gate → live fill → `prefilled` review. The dashboard cannot
 * honour that by itself — it never launches a browser and never fills a form —
 * so before this module the desire was durable but the *execution* was not: a
 * `prepare-queued` role selected under One-shot simply sat there if the agent
 * session ended.
 *
 * This module makes the chain executable and resumable. It records the
 * candidate's ORIGINAL selection intent and carries it forward. The agent never
 * mints a fresh `candidate_selection_confirmation` after PREPARE: that record is
 * a candidate attestation, and forging one would launder an agent decision into
 * the provenance chain that `credentials-store.mjs` and `application-receipt.mjs`
 * trace back to. One click, carried forward — nothing invented.
 *
 * BOUNDARIES (unchanged by this module)
 * -------------------------------------
 *   - Never touches a browser. Never fills a form. Never submits anything.
 *   - Never selects a role. Turning One-shot on selects nothing by itself;
 *     a request only exists because the candidate explicitly selected the role
 *     and confirmed the selection.
 *   - Never creates an `application_request` whose assets have not passed
 *     `validateApplicationRole(..., requireAssets: true)`.
 *   - Enforces the one-controller lease and the four-active-role cap through the
 *     shared core in `application-request.mjs`.
 *
 * STATES
 * ------
 *   prepare-requested → preparing → assets-verified → fill-requested
 *                     → filling → review-ready            (terminal)
 *
 *   Parking states: blocked | retryable | candidate-action-required
 *   Candidate cancellation: cancelled                         (terminal)
 *   Parking records `parked_from` so `resume` returns to the exact prior state.
 *
 * CLI
 * ---
 *   node one-shot-request.mjs list [--json]
 *   node one-shot-request.mjs next [--json]
 *   node one-shot-request.mjs claim <role-id>
 *   node one-shot-request.mjs deep-eval-complete <role-id> <reports/path.md>
 *   node one-shot-request.mjs verify <role-id>
 *   node one-shot-request.mjs dispatch <role-id>
 *   node one-shot-request.mjs park <role-id> <blocked|retryable|candidate-action-required> [reason]
 *   node one-shot-request.mjs resume <role-id> [reason]
 *   node one-shot-request.mjs reconcile
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

import { loadQueue, mutateQueue } from './queue-store.mjs';
import { isDeepEval, FILLABLE_STATUSES } from './run-partition.mjs';
import { applicationQualityConfig, validateApplicationRole } from './verify-userdata.mjs';
import {
  MAX_ACTIVE_APPLICATION_REQUESTS,
  availableApplicationRequestSlots,
  createActiveAgentRequest,
} from './application-request.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const ONE_SHOT_REQUEST_VERSION = 1;
export const ONE_SHOT_CONTROLLER = 'active-agent';
/** Source recorded on the derived `application_request`. `application-receipt.mjs`
 *  requires a `dashboard*` source, and this work does originate from the
 *  candidate's dashboard One-shot Run. */
export const ONE_SHOT_REQUEST_SOURCE = 'dashboard-one-shot';

export const ONE_SHOT_ACTIVE_STATES = Object.freeze([
  'prepare-requested',
  'preparing',
  'assets-verified',
  'fill-requested',
  'filling',
]);
export const ONE_SHOT_TERMINAL_STATES = Object.freeze(['review-ready']);
export const ONE_SHOT_CANCELLED_STATES = Object.freeze(['cancelled']);
export const ONE_SHOT_PARKED_STATES = Object.freeze([
  'blocked',
  'retryable',
  'candidate-action-required',
]);
export const ONE_SHOT_STATES = Object.freeze([
  ...ONE_SHOT_ACTIVE_STATES,
  ...ONE_SHOT_TERMINAL_STATES,
  ...ONE_SHOT_CANCELLED_STATES,
  ...ONE_SHOT_PARKED_STATES,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  'prepare-requested': ['preparing'],
  preparing: ['assets-verified'],
  'assets-verified': ['fill-requested'],
  'fill-requested': ['filling'],
  filling: ['review-ready'],
});

function nowIso() {
  return new Date().toISOString();
}

function httpError(message, code) {
  const err = new Error(message);
  err.httpCode = code;
  return err;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function selectionSnapshotForRole(role, selectionIntentId) {
  const confirmation = role?.candidate_selection_confirmation;
  const intentId = String(selectionIntentId || '').trim();
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    throw httpError('a durable candidate_selection_confirmation is required before recording One-shot work', 409);
  }
  const roleIds = Array.isArray(confirmation.role_ids)
    ? [...new Set(confirmation.role_ids.map(String))].sort()
    : [];
  const states = confirmation.role_states && typeof confirmation.role_states === 'object'
    ? Object.fromEntries(roleIds.map((id) => [id, String(confirmation.role_states[id] || '')]))
    : {};
  const snapshot = {
    version: confirmation.version,
    intent_id: String(confirmation.intent_id || ''),
    action: String(confirmation.action || ''),
    role_ids: roleIds,
    role_states: states,
    source: String(confirmation.source || ''),
    confirmed_at: String(confirmation.confirmed_at || ''),
    consumed_at: String(confirmation.consumed_at || ''),
  };
  if (snapshot.version !== 1 || snapshot.intent_id !== intentId) {
    throw httpError('candidate selection confirmation does not match the One-shot intent', 409);
  }
  if (!['run', 'fill'].includes(snapshot.action)
      || !['dashboard-run', 'dashboard-fill'].includes(snapshot.source)) {
    throw httpError('One-shot work must originate from a candidate-confirmed dashboard Run/Fill action', 409);
  }
  if (!roleIds.includes(String(role.id)) || !states[String(role.id)]) {
    throw httpError('candidate selection confirmation is not bound to this role and its selected state', 409);
  }
  if (!Number.isFinite(Date.parse(snapshot.confirmed_at))
      || !Number.isFinite(Date.parse(snapshot.consumed_at))) {
    throw httpError('candidate selection confirmation timestamps are invalid', 409);
  }
  return snapshot;
}

function validateStoredSelection(role, request) {
  const snapshot = request?.selection_confirmation;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw httpError('One-shot request is missing its immutable candidate selection snapshot', 409);
  }
  if (request.selection_intent_id !== snapshot.intent_id
      || request.selection_confirmation_sha256 !== sha256(canonicalJson(snapshot))) {
    throw httpError('One-shot candidate selection binding is missing or has been tampered with', 409);
  }
  if (!Array.isArray(snapshot.role_ids) || !snapshot.role_ids.includes(String(role.id))
      || !['run', 'fill'].includes(snapshot.action)) {
    throw httpError('One-shot candidate selection snapshot does not authorize this role/action', 409);
  }
  return snapshot;
}

function applicationBinding(role, request) {
  const applicationRequest = role?.application_request;
  if (!applicationRequest || !request?.application_request_id || !request?.application_run_id) {
    return null;
  }
  if (applicationRequest.request_id !== request.application_request_id
      || applicationRequest.run_id !== request.application_run_id
      || applicationRequest.role_id !== role.id
      || applicationRequest.controller_id !== request.application_controller_id) {
    return null;
  }
  return applicationRequest;
}

function progressBinding(role, request) {
  const applicationRequest = applicationBinding(role, request);
  const progress = role?.application_progress;
  if (!applicationRequest || !progress) return null;
  if (progress.application_request_id !== applicationRequest.request_id
      || progress.run_id !== applicationRequest.run_id
      || progress.role_id !== role.id
      || progress.controller_id !== applicationRequest.controller_id) {
    return null;
  }
  return { applicationRequest, progress };
}

export function isOneShotActive(request) {
  return ONE_SHOT_ACTIVE_STATES.includes(request?.state);
}

export function isOneShotParked(request) {
  return ONE_SHOT_PARKED_STATES.includes(request?.state);
}

/**
 * A role is one-shot when the candidate turned on the queue-wide One-shot
 * toggle, or flagged this specific card with `auto-fill`.
 */
export function isOneShotRole(queue, role) {
  if (queue?.settings?.auto_fill_all === true) return true;
  return Array.isArray(role?.flags) && role.flags.includes('auto-fill');
}

function validOneShotRequest(request) {
  return Boolean(request)
    && typeof request === 'object'
    && !Array.isArray(request)
    && request.version === ONE_SHOT_REQUEST_VERSION
    && ONE_SHOT_STATES.includes(request.state);
}

function appendHistory(request, state, note) {
  request.history = Array.isArray(request.history) ? request.history : [];
  request.history.push({ state, at: nowIso(), ...(note ? { note: String(note) } : {}) });
  // Bounded: this record lives in the queue sidecar and is read on every drain.
  if (request.history.length > 40) request.history = request.history.slice(-40);
}

/**
 * Record the candidate's One-shot intent for a role they explicitly selected.
 *
 * Idempotent per role: an already-active or parked request is preserved (its
 * `updated_at` refreshed) rather than replaced, so pressing Run twice never
 * duplicates work or discards in-flight progress.
 *
 * @param {object} role                  Queue role, mutated in place.
 * @param {string} selectionIntentId     The candidate's confirmed selection intent.
 * @param {object} [options]
 * @param {string} [options.source]      Which dashboard action recorded it.
 * @returns {{request: object, reused: boolean}}
 */
export function recordOneShotRequest(role, selectionIntentId, options = {}) {
  const intentId = String(selectionIntentId || '').trim();
  if (!intentId) throw new Error('a candidate selection intent id is required');
  const selection = selectionSnapshotForRole(role, intentId);
  const existing = role.one_shot_request;
  if (validOneShotRequest(existing) && (isOneShotActive(existing) || isOneShotParked(existing))) {
    validateStoredSelection(role, existing);
    existing.updated_at = nowIso();
    return { request: structuredClone(existing), reused: true };
  }
  const requestedAt = nowIso();
  const request = {
    version: ONE_SHOT_REQUEST_VERSION,
    request_id: `one-shot:${intentId}:${role.id}`,
    selection_intent_id: intentId,
    role_id: role.id,
    source: String(options.source || 'dashboard-run'),
    requested_at: requestedAt,
    updated_at: requestedAt,
    state: 'prepare-requested',
    deep_eval_required: isDeepEval(role),
    controller: ONE_SHOT_CONTROLLER,
    selection_confirmation: selection,
    selection_confirmation_sha256: sha256(canonicalJson(selection)),
    history: [],
  };
  appendHistory(request, 'prepare-requested', 'candidate One-shot Run');
  role.one_shot_request = request;
  return { request: structuredClone(request), reused: false };
}

/** Compact view for the dashboard payload / agent listings. */
export function summarizeOneShotRequest(role) {
  const request = role?.one_shot_request;
  if (!validOneShotRequest(request)) return null;
  return {
    state: request.state,
    request_id: request.request_id,
    selection_intent_id: request.selection_intent_id,
    deep_eval_required: request.deep_eval_required === true,
    requested_at: request.requested_at,
    updated_at: request.updated_at,
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.parked_from ? { parked_from: request.parked_from } : {}),
    // What the dashboard shows when no agent is running. The dashboard cannot
    // honestly promise completion; it can honestly promise the work is durable.
    queued_for_agent: isOneShotActive(request) && request.state !== 'review-ready',
  };
}

/**
 * Derive the request state from durable facts the rest of the system already
 * writes, so a crashed or restarted agent session resumes without a new click.
 *
 * Pure: returns the state this request SHOULD be in, or null for no change.
 */
export function reconciledOneShotState(role) {
  const request = role?.one_shot_request;
  if (!validOneShotRequest(request)) return null;
  try {
    validateStoredSelection(role, request);
  } catch {
    // Never advance work whose candidate authorization cannot be proven. The
    // explicit commands surface the integrity error; passive dashboard reads
    // simply leave the request parked at its last durable state.
    return null;
  }
  if (isOneShotParked(request)) return null; // parking is a human/agent decision
  if (['scored', 'submitted', 'skipped', 'reviewed', 'closed'].includes(role.status)) {
    return request.state === 'cancelled' ? null : 'cancelled';
  }
  const binding = progressBinding(role, request);
  const progress = binding?.progress;
  const finished = Boolean(binding) && (
    progress.lean_review_ready === true
    || progress.review_ready === true
    || role.status === 'prefilled'
    || role.status === 'filled'
  );
  if (finished) return request.state === 'review-ready' ? null : 'review-ready';
  if (ONE_SHOT_TERMINAL_STATES.includes(request.state)
      || ONE_SHOT_CANCELLED_STATES.includes(request.state)) return null;
  if (progress && request.state !== 'filling') return 'filling';
  // A durable application_request exists but the browser run has not begun.
  if (!progress && applicationBinding(role, request)?.state === 'queued'
      && ['assets-verified', 'prepare-requested', 'preparing'].includes(request.state)) {
    return 'fill-requested';
  }
  return null;
}

function applyReconciliation(role) {
  const next = reconciledOneShotState(role);
  if (!next) return false;
  role.one_shot_request.state = next;
  role.one_shot_request.updated_at = nowIso();
  appendHistory(role.one_shot_request, next, 'reconciled from durable role state');
  return true;
}

/**
 * Close the chain in place when the live run reaches the candidate review
 * boundary. Pure mutator with no queue I/O: callers (lean finish, the receipt
 * finalizer) already hold the queue lock inside their own mutation.
 *
 * Safe to call on a role that never had a one-shot request.
 *
 * @param {object} role  Queue role, mutated in place.
 * @param {string} [at]  ISO timestamp of the finish, for a coherent record.
 * @returns {boolean}    Whether a request was closed.
 */
export function closeOneShotRequestOnRole(role, at = nowIso()) {
  const request = role?.one_shot_request;
  if (!validOneShotRequest(request)) return false;
  if (request.state === 'review-ready') return false;
  if (isOneShotParked(request) || request.state === 'cancelled') return false;
  const binding = progressBinding(role, request);
  const progress = binding?.progress;
  if (!binding || !(progress.lean_review_ready === true || progress.review_ready === true)) {
    return false;
  }
  request.state = 'review-ready';
  request.updated_at = at;
  delete request.parked_from;
  delete request.reason;
  appendHistory(request, 'review-ready', 'live run reached the candidate review boundary');
  return true;
}

export function cancelOneShotRequestOnRole(role, reason = 'candidate revoked the queued work', at = nowIso()) {
  const request = role?.one_shot_request;
  if (!validOneShotRequest(request)
      || request.state === 'review-ready'
      || request.state === 'cancelled') return false;
  request.state = 'cancelled';
  request.reason = String(reason || '').trim() || 'candidate revoked the queued work';
  request.updated_at = at;
  delete request.parked_from;
  appendHistory(request, 'cancelled', request.reason);
  const applicationRequest = applicationBinding(role, request);
  if (applicationRequest && ['queued', 'in-progress', 'parked'].includes(applicationRequest.state)) {
    applicationRequest.state = 'cancelled';
    applicationRequest.updated_at = at;
    applicationRequest.cancelled_at = at;
  }
  return true;
}

/** Reconcile every one-shot request against durable role state. */
export function reconcileOneShotRequests() {
  return mutateQueue((queue) => {
    const changed = [];
    for (const role of queue.roles ?? []) {
      if (applyReconciliation(role)) {
        changed.push({ role_id: role.id, state: role.one_shot_request.state });
      }
    }
    return { reconciled: changed.length, changed };
  });
}

function roleOrThrow(queue, roleId) {
  const role = (queue.roles ?? []).find((item) => item.id === roleId);
  if (!role) throw httpError(`role not found: ${roleId}`, 404);
  return role;
}

function requestOrThrow(role) {
  const request = role.one_shot_request;
  if (!validOneShotRequest(request)) {
    throw httpError(`role ${role.id} has no durable one_shot_request`, 409);
  }
  validateStoredSelection(role, request);
  return request;
}

function transition(request, to, note) {
  const allowed = ALLOWED_TRANSITIONS[request.state] || [];
  if (!allowed.includes(to)) {
    throw httpError(
      `one-shot request cannot move ${request.state} → ${to}`
      + (allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (state is terminal or parked; resume it first)'),
      409,
    );
  }
  request.state = to;
  request.updated_at = nowIso();
  delete request.reason;
  appendHistory(request, to, note);
}

function loadProfile(root = ROOT) {
  const path = join(root, 'config', 'profile.yml');
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function resolveDeepEvaluationReport(root, reportPath) {
  const value = String(reportPath || '').trim();
  if (!value) throw httpError('deep evaluation completion requires a report path', 400);
  const absolute = resolve(root, value);
  const canonicalRoot = realpathSync(root);
  const reportsRoot = realpathSync(join(root, 'reports'));
  let canonical;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw httpError(`deep evaluation report does not exist: ${value}`, 409);
  }
  if (canonical !== reportsRoot && !canonical.startsWith(reportsRoot + sep)) {
    throw httpError('deep evaluation report must be inside reports/', 409);
  }
  const relativePath = relative(canonicalRoot, canonical).split(sep).join('/');
  const contents = readFileSync(canonical);
  if (!contents.includes(Buffer.from('## Machine Summary'))) {
    throw httpError('deep evaluation report has no Machine Summary evidence', 409);
  }
  return { path: relativePath, sha256: createHash('sha256').update(contents).digest('hex') };
}

function deepEvaluationErrors(request, root) {
  if (request.deep_eval_required !== true) return [];
  const record = request.deep_evaluation;
  if (!record || typeof record !== 'object') return ['deep evaluation completion evidence is missing'];
  let current;
  try {
    current = resolveDeepEvaluationReport(root, record.report_path);
  } catch (error) {
    return [error.message];
  }
  if (current.sha256 !== record.report_sha256) return ['deep evaluation report changed after completion was recorded'];
  if (!Number.isFinite(Date.parse(record.completed_at || ''))) {
    return ['deep evaluation completion timestamp is invalid'];
  }
  return [];
}

export function completeOneShotDeepEvaluation(roleId, reportPath, options = {}) {
  const root = options.root || ROOT;
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    if (request.state !== 'preparing' || request.deep_eval_required !== true) {
      throw httpError('deep evaluation evidence is only recorded for a flagged request in preparing state', 409);
    }
    const report = resolveDeepEvaluationReport(root, reportPath);
    request.deep_evaluation = {
      report_path: report.path,
      report_sha256: report.sha256,
      completed_at: nowIso(),
    };
    request.updated_at = request.deep_evaluation.completed_at;
    appendHistory(request, 'preparing', 'required deep evaluation completed');
    return structuredClone(request.deep_evaluation);
  });
}

/** `prepare-requested` → `preparing`. The agent has picked the role up. */
export function claimOneShotRequest(roleId) {
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    applyReconciliation(role);
    transition(request, 'preparing', 'agent claimed the PREPARE work');
    return structuredClone(request);
  });
}

/**
 * `preparing` → `assets-verified`.
 *
 * Runs the executable asset gate. A failed gate CANNOT reach `assets-verified`,
 * so it can never reach `fill-requested` either — that is the structural reason
 * a bad asset set cannot produce an `application_request`.
 */
export function verifyOneShotAssets(roleId, options = {}) {
  const root = options.root || ROOT;
  const profile = options.profile || loadProfile(root);
  const quality = options.quality || applicationQualityConfig(profile);
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    applyReconciliation(role);
    if (!FILLABLE_STATUSES.has(role.status)) {
      throw httpError(
        `role is '${role.status}'; PREPARE must reach 'prepared' before the asset gate can pass`,
        409,
      );
    }
    validateStoredSelection(role, request);
    const deepErrors = deepEvaluationErrors(request, root);
    if (deepErrors.length) {
      throw httpError(`deep evaluation gate failed: ${deepErrors.join('; ')}`, 409);
    }
    const errors = validateApplicationRole(role, {
      root, profile, quality, requireAssets: true,
      // Sibling roles with real assets, so the contextual tailoring gate can see
      // an untailored CV or a recycled cover body before a live fill is queued.
      peers: queue.roles,
      // Queue settings carry the portal-hosted-resume toggle; without them this
      // gate rejects a CV-less role the dashboard gate already accepted.
      settings: queue.settings,
    })
      .filter((item) => item.level === 'error');
    if (errors.length) {
      const err = httpError(
        `asset gate failed: ${errors.map((item) => item.code).join(', ')}`,
        409,
      );
      err.issues = errors;
      throw err;
    }
    transition(request, 'assets-verified', 'validateApplicationRole(requireAssets) passed');
    return { request: structuredClone(request), issues: [] };
  });
}

/**
 * `assets-verified` → `fill-requested`, creating exactly one idempotent
 * `application_request` from the candidate's ORIGINAL selection intent.
 *
 * No new candidate confirmation is minted or required. The asset gate is
 * re-run inside the same locked mutation so a file that changed between
 * `verify` and `dispatch` cannot slip through.
 */
export function dispatchOneShotFill(roleId, options = {}) {
  const root = options.root || ROOT;
  const profile = options.profile || loadProfile(root);
  const quality = options.quality || applicationQualityConfig(profile);
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    applyReconciliation(role);
    if (request.state !== 'assets-verified') {
      throw httpError(
        `one-shot request is '${request.state}'; run verify first so the asset gate is proven before dispatch`,
        409,
      );
    }
    if (!FILLABLE_STATUSES.has(role.status)) {
      throw httpError(`role is '${role.status}' and cannot receive a live application request`, 409);
    }
    validateStoredSelection(role, request);
    const deepErrors = deepEvaluationErrors(request, root);
    if (deepErrors.length) {
      throw httpError(`deep evaluation gate failed at dispatch: ${deepErrors.join('; ')}`, 409);
    }
    // Re-run the gate under the lock: verify and dispatch are separate commands,
    // and an asset could have been regenerated or truncated in between.
    const errors = validateApplicationRole(role, {
      root, profile, quality, requireAssets: true,
      // Sibling roles with real assets, so the contextual tailoring gate can see
      // an untailored CV or a recycled cover body before a live fill is queued.
      peers: queue.roles,
      // Queue settings carry the portal-hosted-resume toggle; without them this
      // gate rejects a CV-less role the dashboard gate already accepted.
      settings: queue.settings,
    })
      .filter((item) => item.level === 'error');
    if (errors.length) {
      const err = httpError(
        `asset gate failed at dispatch: ${errors.map((item) => item.code).join(', ')}`,
        409,
      );
      err.issues = errors;
      throw err;
    }
    const runId = `one-shot-${request.selection_intent_id}`;
    const queued = createActiveAgentRequest(queue, role, runId, ONE_SHOT_REQUEST_SOURCE);
    request.application_request_id = queued.request.request_id;
    request.application_run_id = queued.request.run_id;
    request.application_controller_id = queued.request.controller_id;
    transition(
      request,
      'fill-requested',
      queued.reused
        ? 'existing active-agent request preserved'
        : 'active-agent application request created from the candidate One-shot intent',
    );
    return {
      request: structuredClone(request),
      application_request: queued.request,
      reused: queued.reused,
    };
  });
}

/** `fill-requested` → `filling`. Recorded when the browser run actually begins. */
export function markOneShotFilling(roleId) {
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    if (!applicationBinding(role, request)) {
      throw httpError('One-shot filling transition is not bound to its application request', 409);
    }
    transition(request, 'filling', 'browser controller started the live run');
    return structuredClone(request);
  });
}

/** `filling` → `review-ready`. The candidate now reviews and submits manually. */
export function completeOneShotRequest(roleId) {
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    applyReconciliation(role);
    if (request.state === 'review-ready') return structuredClone(request);
    if (!closeOneShotRequestOnRole(role)) {
      throw httpError('One-shot cannot complete before its bound live run reaches review-ready', 409);
    }
    return structuredClone(request);
  });
}

/** Park an active request without losing where it was. */
export function parkOneShotRequest(roleId, state, reason = '') {
  if (!ONE_SHOT_PARKED_STATES.includes(state)) {
    throw httpError(`park state must be one of: ${ONE_SHOT_PARKED_STATES.join(', ')}`, 400);
  }
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    if (!isOneShotActive(request)) {
      throw httpError(`one-shot request is '${request.state}' and cannot be parked`, 409);
    }
    request.parked_from = request.state;
    request.state = state;
    request.reason = String(reason || '').trim() || 'no reason recorded';
    request.updated_at = nowIso();
    const applicationRequest = applicationBinding(role, request);
    if (applicationRequest && ['queued', 'in-progress'].includes(applicationRequest.state)) {
      request.parked_application_request_state = applicationRequest.state;
      applicationRequest.state = 'parked';
      applicationRequest.updated_at = request.updated_at;
    }
    appendHistory(request, state, request.reason);
    return structuredClone(request);
  });
}

/** Return a parked request to the state it was parked from. */
export function resumeOneShotRequest(roleId, reason = '') {
  return mutateQueue((queue) => {
    const role = roleOrThrow(queue, roleId);
    const request = requestOrThrow(role);
    if (!isOneShotParked(request)) {
      throw httpError(`one-shot request is '${request.state}' and is not parked`, 409);
    }
    const target = ONE_SHOT_ACTIVE_STATES.includes(request.parked_from)
      ? request.parked_from
      : 'prepare-requested';
    const applicationRequest = applicationBinding(role, request);
    if (applicationRequest?.state === 'parked'
        && availableApplicationRequestSlots(queue) === 0) {
      throw httpError(
        `browser-controller already has ${MAX_ACTIVE_APPLICATION_REQUESTS} active roles; finish or park one before resuming this request`,
        409,
      );
    }
    request.state = target;
    delete request.parked_from;
    delete request.reason;
    request.updated_at = nowIso();
    if (applicationRequest?.state === 'parked') {
      applicationRequest.state = request.parked_application_request_state === 'in-progress'
        ? 'in-progress'
        : 'queued';
      applicationRequest.updated_at = request.updated_at;
    }
    delete request.parked_application_request_state;
    appendHistory(request, target, String(reason || 'resumed').trim());
    applyReconciliation(role);
    return structuredClone(request);
  });
}

/**
 * The agent's drain view. Ordered oldest-request-first so a long-waiting role is
 * never starved, and capped by the real remaining controller slots so callers
 * batch in groups of at most four instead of discovering the cap by 409.
 */
export function listOneShotRequests(options = {}) {
  const queue = options.queue || loadQueue();
  const rows = (queue.roles ?? [])
    .filter((role) => validOneShotRequest(role.one_shot_request))
    .map((role) => {
      const reconciled = reconciledOneShotState(role);
      const request = role.one_shot_request;
      return {
        role_id: role.id,
        company: role.company ?? null,
        title: role.title ?? null,
        url: role.url ?? null,
        status: role.status,
        score: role.score ?? null,
        state: reconciled || request.state,
        stale_state: reconciled ? request.state : null,
        deep_eval_required: request.deep_eval_required === true,
        selection_intent_id: request.selection_intent_id,
        requested_at: request.requested_at,
        ...(request.reason ? { reason: request.reason } : {}),
      };
    })
    .sort((left, right) => String(left.requested_at).localeCompare(String(right.requested_at)));

  const slots = availableApplicationRequestSlots(queue);
  return {
    max_active_roles: MAX_ACTIVE_APPLICATION_REQUESTS,
    available_slots: slots,
    pending: rows.filter((row) => ONE_SHOT_ACTIVE_STATES.includes(row.state)),
    parked: rows.filter((row) => ONE_SHOT_PARKED_STATES.includes(row.state)),
    review_ready: rows.filter((row) => row.state === 'review-ready'),
    all: rows,
  };
}

/**
 * The next batch the agent should work, never larger than the free controller
 * slots. Roles already past dispatch do not consume a new slot.
 */
export function nextOneShotBatch(options = {}) {
  const listing = listOneShotRequests(options);
  const needsSlot = listing.pending.filter((row) =>
    ['prepare-requested', 'preparing', 'assets-verified'].includes(row.state));
  const inFlight = listing.pending.filter((row) =>
    ['fill-requested', 'filling'].includes(row.state));
  return {
    max_active_roles: listing.max_active_roles,
    available_slots: listing.available_slots,
    in_flight: inFlight,
    batch: needsSlot.slice(0, listing.available_slots),
    deferred: needsSlot.slice(listing.available_slots),
    parked: listing.parked,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const USAGE = `Usage:
  node one-shot-request.mjs list                 Every durable one-shot request
  node one-shot-request.mjs next                 The next batch (bounded by free slots)
  node one-shot-request.mjs claim <role-id>      prepare-requested -> preparing
  node one-shot-request.mjs deep-eval-complete <role-id> <reports/path.md>
  node one-shot-request.mjs verify <role-id>     preparing -> assets-verified (runs the asset gate)
  node one-shot-request.mjs dispatch <role-id>   assets-verified -> fill-requested (+ application_request)
  node one-shot-request.mjs filling <role-id>    fill-requested -> filling
  node one-shot-request.mjs complete <role-id>   filling -> review-ready
  node one-shot-request.mjs park <role-id> <blocked|retryable|candidate-action-required> [reason]
  node one-shot-request.mjs resume <role-id> [reason]
  node one-shot-request.mjs reconcile            Re-derive states from durable role facts

Nothing here opens a browser, fills a form, or submits an application.
`;

async function cli(argv) {
  const [command, roleId, ...rest] = argv;
  switch (command) {
    case 'list':
      return listOneShotRequests();
    case 'next':
      return nextOneShotBatch();
    case 'reconcile':
      return reconcileOneShotRequests();
    case 'claim':
      return claimOneShotRequest(roleId);
    case 'verify':
      return verifyOneShotAssets(roleId);
    case 'deep-eval-complete':
      return completeOneShotDeepEvaluation(roleId, rest.join(' '));
    case 'dispatch':
      return dispatchOneShotFill(roleId);
    case 'filling':
      return markOneShotFilling(roleId);
    case 'complete':
      return completeOneShotRequest(roleId);
    case 'park':
      return parkOneShotRequest(roleId, rest[0], rest.slice(1).join(' '));
    case 'resume':
      return resumeOneShotRequest(roleId, rest.join(' '));
    default:
      process.stderr.write(USAGE);
      process.exit(command ? 1 : 0);
      return null;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2).filter((item) => item !== '--json');
  cli(argv)
    .then((result) => { if (result != null) printJson(result); })
    .catch((error) => {
      printJson({
        error: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      });
      process.exit(1);
    });
}
