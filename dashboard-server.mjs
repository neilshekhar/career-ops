#!/usr/bin/env node
/**
 * dashboard-server.mjs — Zero-model-token localhost apply-queue dashboard.
 *
 * Binds to 127.0.0.1 only. Serves the SPA + a JSON REST API over
 * the queue store. Never posts to any ATS. No outbound network calls except
 * queue-store Supabase reads/writes.
 *
 * Usage:
 *   node dashboard-server.mjs              # port 7777
 *   node dashboard-server.mjs --port 8080  # custom port
 *
 * Open: http://127.0.0.1:7777
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

import {
  loadQueue, mutateQueue, computeLane, computeStage, computeStats,
  setStatus, updateById, ACTIVE_STATUSES, stageDragTarget,
  DRAG_TARGET_STAGES, recordCandidateSelectionOverride,
  manualSubmissionProvenanceError,
  MANUAL_SUBMISSION_CONFIRMATION,
  MANUAL_SUBMISSION_PROVENANCE_VERSION,
  MANUAL_SUBMISSION_SOURCE,
} from './queue-store.mjs';
import { queueDoneStatusFromTracker, parseTrackerDoneRows } from './tracker-status-map.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import {
  partitionRunRoles, isDeepEval, FILLABLE_STATUSES, isLeanCompleteRole,
} from './run-partition.mjs';
import { applicationQualityConfig, validateApplicationRole } from './verify-userdata.mjs';
import {
  markApplicationReportSubmitted,
  reviewReadinessErrors,
  submissionReadinessErrors,
} from './application-receipt.mjs';
import {
  MAX_ACTIVE_APPLICATION_REQUESTS,
  createActiveAgentRequest,
} from './application-request.mjs';
import {
  cancelOneShotRequestOnRole,
  isOneShotRole,
  recordOneShotRequest,
  summarizeOneShotRequest,
} from './one-shot-request.mjs';
import {
  DASHBOARD_JSON_BODY_LIMIT,
  SelectionConfirmationStore,
  SubmissionConfirmationStore,
  validateDashboardMutationRequest,
} from './dashboard-auth.mjs';

const ROOT     = dirname(fileURLToPath(import.meta.url));
const WEB_DIR  = join(ROOT, 'dashboard', 'web');
const APPS_FILE = join(ROOT, 'data', 'applications.md');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');

// ── CLI args ─────────────────────────────────────────────────────────────────

const portArg = process.argv.indexOf('--port');
const PORT    = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 7777;
const HOST    = '127.0.0.1'; // localhost only — never expose externally
const DASHBOARD_ORIGIN = `http://${HOST}:${PORT}`;
const DASHBOARD_CSRF_TOKEN = randomUUID();
const selectionConfirmations = new SelectionConfirmationStore();
const submissionConfirmations = new SubmissionConfirmationStore();

// ── MIME types ───────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

// ── Tracker number helper ────────────────────────────────────────────────────

function nextTrackerNum() {
  if (!existsSync(APPS_FILE)) return 1;
  const text = readFileSync(APPS_FILE, 'utf-8');
  let max = 0;
  for (const m of text.matchAll(/^\|\s*(\d+)\s*\|/gm)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// ── Tracker TSV write-back ───────────────────────────────────────────────────

const DECISION_STATUS = {
  submitted: 'Applied',
  skipped:   'SKIP',
  reviewed:  'Discarded',
};

// Tabs/newlines in model-written free text (reason, scraped company/title)
// would inject extra TSV columns or split the row before merge-tracker's own
// markdown-side sanitizeCell ever runs — strip them at the write site.
function tsvCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function writeTrackerTsv(role, decision, { receiptId = null, manualSubmission = false } = {}) {
  mkdirSync(ADDITIONS_DIR, { recursive: true });

  if (decision === 'submitted' && !receiptId && !manualSubmission) {
    throw new Error('candidate-confirmed submission is missing its finalized application receipt id');
  }
  if (receiptId && manualSubmission) {
    throw new Error('a submission records either receipt provenance or candidate manual provenance, never both');
  }
  if (decision === 'submitted' && manualSubmission) {
    const provenanceError = manualSubmissionProvenanceError(role);
    if (provenanceError !== null) {
      throw new Error(`candidate manual submission is missing its dashboard-confirmed provenance: ${provenanceError}`);
    }
  }

  const num    = nextTrackerNum();
  const date   = new Date().toISOString().slice(0, 10);
  const status = DECISION_STATUS[decision] ?? 'Discarded';
  // A TSV addition only establishes the evaluation row. Never write Applied
  // even transiently: candidate-confirmed submission is promoted below by the
  // canonical status writer with the finalized receipt ID.
  const stagedStatus = decision === 'submitted' ? 'Evaluated' : status;
  const numericScore = Number(role.score);
  const score  = Number.isFinite(numericScore) ? `${numericScore.toFixed(1)}/5` : 'N/A';
  const pdf    = role.cv_pdf ? '✅' : '❌';
  const reportTarget = role.application_progress?.application_answers_report || role.url;
  if (!reportTarget) throw new Error('tracker decision requires an application report path or job URL');
  const report = `[${role.application_progress?.application_answers_report ? 'application' : 'job'}](${reportTarget})`;
  const notes  = role.reason ? role.reason.slice(0, 120) : '';

  const tsv = [num, date, role.company, role.title, stagedStatus, score, pdf, report, notes]
    .map(tsvCell)
    .join('\t');

  const safeId = String(role.id ?? 'role').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  const filename = `${num}-${safeId}.tsv`;
  writeFileSync(join(ADDITIONS_DIR, filename), tsv + '\n', 'utf-8');

  // First ensure the row exists, then use the one canonical locked status
  // writer to update an existing row as well. merge-tracker intentionally
  // preserves an existing row's status during dedup, so treating the TSV write
  // alone as success would silently leave Evaluated rows unchanged.
  try {
    execFileSync(process.execPath, ['merge-tracker.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`tracker row merge failed: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
  }

  const args = [
    'set-status.mjs', role.company, status,
    '--role', role.title,
    '--json',
  ];
  // --report reliably matches when the application lifecycle has persisted its
  // own Application Answers report. The role.url fallback can legitimately
  // diverge from an earlier evaluation report's URL header and stall a
  // skip/review/manual-submit decision. --receipt requires --report, so always
  // pair those even during a retry.
  if (receiptId || role.application_progress?.application_answers_report) {
    args.push('--report', reportTarget);
  }
  if (notes) args.push('--note', notes);
  if (receiptId) args.push('--receipt', receiptId);
  // Candidate manual submissions have no finalized receipt to verify; the
  // typed-confirmation provenance validated above is recorded through the
  // canonical external-progression path instead.
  if (decision === 'submitted' && manualSubmission) args.push('--external');
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return JSON.parse(output);
  } catch (err) {
    let detail = String(err.stderr || err.message).trim();
    try {
      const parsed = JSON.parse(String(err.stdout || ''));
      detail = parsed.error || detail;
    } catch { /* keep stderr detail */ }
    throw new Error(`canonical tracker status update failed: ${detail.slice(0, 300)}`);
  }
}

// ── Candidate-decision transaction ──────────────────────────────────────────

const DECISION_TRANSACTION_VERSION = 1;

function decisionTransactionFor(role, decision) {
  const transaction = role?.application_decision_transaction;
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return null;
  if (transaction.version !== DECISION_TRANSACTION_VERSION || transaction.role_id !== role.id) {
    throw new Error('candidate decision transaction is malformed or belongs to another role');
  }
  if (transaction.decision !== decision) {
    const err = new Error(
      `candidate decision '${transaction.decision}' is already pending; finish it before recording '${decision}'`,
    );
    err.httpCode = 409;
    throw err;
  }
  return transaction;
}

function beginCandidateDecision(queue, id, decision) {
  const role = queue.roles.find((item) => item.id === id);
  if (!role) {
    const err = new Error('role not found');
    err.httpCode = 404;
    throw err;
  }

  const existing = decisionTransactionFor(role, decision);
  if (existing?.state === 'committed' && role.status === decision) {
    return { role: structuredClone(role), transaction: structuredClone(existing), alreadyCommitted: true };
  }
  if (existing && ['pending', 'report-promoted', 'tracker-written'].includes(existing.state)) {
    if (decision === 'submitted') {
      const manualResume = existing.mode === 'manual' &&
        (ACTIVE_STATUSES.has(role.status) || role.status === 'submitted');
      const receiptResume = existing.mode !== 'manual' &&
        (role.status === 'filled' || role.status === 'submitted');
      if (!manualResume && !receiptResume) {
        const err = new Error(`pending submitted transaction cannot resume from role status '${role.status}'`);
        err.httpCode = 409;
        throw err;
      }
    }
    return { role: structuredClone(role), transaction: structuredClone(existing), alreadyCommitted: false };
  }

  let manualMode = false;
  if (decision === 'submitted') {
    const receiptErrors = submissionReadinessErrors(role);
    const receiptReady = role.status === 'filled' && receiptErrors.length === 0;
    if (!receiptReady) {
      if (!ACTIVE_STATUSES.has(role.status)) {
        if (role.status !== 'filled') {
          receiptErrors.unshift(`role status is '${role.status}', not receipt-gated 'filled'`);
        }
        const err = new Error('application cannot be marked submitted until its durable per-page receipt is review-ready');
        err.httpCode = 409;
        err.receiptErrors = receiptErrors;
        throw err;
      }
      // Candidate manual submission: no review-ready receipt exists, but the
      // role is still active and the candidate typed the confirmation phrase
      // for the one-use nonce consumed before this transaction began. That
      // attestation — not a receipt — is the durable submission provenance.
      manualMode = true;
    }
  }

  const startedAt = new Date().toISOString();
  const receiptId = decision === 'submitted' && !manualMode ? role.application_progress?.receipt_id : null;
  const transaction = {
    version: DECISION_TRANSACTION_VERSION,
    transaction_id: `candidate-decision:${role.id}:${decision}:${receiptId ?? randomUUID()}`,
    role_id: role.id,
    decision,
    ...(decision === 'submitted' ? { mode: manualMode ? 'manual' : 'receipt' } : {}),
    receipt_id: receiptId,
    state: 'pending',
    candidate_confirmed_at: startedAt,
    started_at: startedAt,
    updated_at: startedAt,
  };
  role.application_decision_transaction = transaction;
  if (manualMode) {
    role.manual_submission = {
      version: MANUAL_SUBMISSION_PROVENANCE_VERSION,
      source: MANUAL_SUBMISSION_SOURCE,
      confirmation: MANUAL_SUBMISSION_CONFIRMATION,
      confirmed_at: startedAt,
      prior_status: role.status,
      transaction_id: transaction.transaction_id,
    };
  }
  return { role: structuredClone(role), transaction: structuredClone(transaction), alreadyCommitted: false };
}

function assertDecisionTransaction(role, transactionId, decision) {
  const transaction = decisionTransactionFor(role, decision);
  if (!transaction || transaction.transaction_id !== transactionId) {
    throw new Error('candidate decision transaction changed before it could be completed');
  }
  return transaction;
}

/**
 * A retry can observe the report already promoted while the queue still carries
 * the pre-promotion progress fields. Reconcile that narrow, receipt-bound state
 * before asking the idempotent report helper to validate it again.
 */
function promoteOrReconcileSubmittedReport(role, transaction) {
  try {
    return markApplicationReportSubmitted(role);
  } catch (firstError) {
    if (transaction?.decision !== 'submitted') throw firstError;
    const progress = role?.application_progress;
    if (!progress) throw firstError;
    const previousState = progress.report_state;
    const previousConfirmedAt = progress.submission_confirmed_at;
    progress.report_state = 'submitted';
    progress.submission_confirmed_at = previousConfirmedAt ?? transaction.candidate_confirmed_at;
    try {
      return markApplicationReportSubmitted(role);
    } catch (retryError) {
      progress.report_state = previousState;
      if (previousConfirmedAt == null) delete progress.submission_confirmed_at;
      else progress.submission_confirmed_at = previousConfirmedAt;
      throw retryError;
    }
  }
}

// ── Tracker → queue reconciliation ───────────────────────────────────────────

function normalizeJobUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';

    // Only remove obvious tracking params. Some job boards use query params
    // as the actual job identity, so never blanket-strip url.search.
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrlFromLinkedReport(target) {
  if (!target || /^https?:\/\//i.test(target)) return null;

  const reportPath = resolve(dirname(APPS_FILE), target);
  // A hardcoded `${ROOT}/` prefix never matches on Windows, where resolve()
  // returns backslashes — the guard then rejected every legitimate report.
  // relative() + isAbsolute keeps the traversal protection on every platform.
  const rel = relative(ROOT, reportPath);
  // `..` as a segment, not a prefix — a file named "..x.md" is inside ROOT.
  const escapes = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (reportPath !== ROOT && escapes) return null;
  if (!existsSync(reportPath)) return null;

  try {
    return readFileSync(reportPath, 'utf-8')
      .match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/im)?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractTrackerUrl(reportCell) {
  if (!reportCell) return null;

  const linkTarget = reportCell.match(/\]\(([^)]+)\)/)?.[1] ?? null;
  if (linkTarget && /^https?:\/\//i.test(linkTarget)) return linkTarget;

  return (
    reportCell.match(/https?:\/\/[^\s|)]+/i)?.[0] ??
    extractUrlFromLinkedReport(linkTarget) ??
    null
  );
}

function loadTrackerTerminalStatusesByUrl() {
  const statusesByUrl = new Map();
  if (!existsSync(APPS_FILE)) return statusesByUrl;

  const text = readFileSync(APPS_FILE, 'utf-8');
  const lines = text.split(/\r?\n/);
  const colmap = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;

    const queueStatus = queueDoneStatusFromTracker(row.status, { includeEvaluated: false });
    if (!queueStatus) continue;

    const url = normalizeJobUrl(extractTrackerUrl(row.report));
    if (url && !statusesByUrl.has(url)) statusesByUrl.set(url, queueStatus);
  }

  return statusesByUrl;
}

function reconcileQueueWithTracker(queue) {
  const terminalByUrl = loadTrackerTerminalStatusesByUrl();
  if (terminalByUrl.size === 0) return [];

  const changed = [];
  for (const role of queue.roles ?? []) {
    if (!ACTIVE_STATUSES.has(role.status)) continue;
    const normalizedRoleUrl = normalizeJobUrl(role.url);
    const terminalStatus = normalizedRoleUrl ? terminalByUrl.get(normalizedRoleUrl) : null;
    if (!terminalStatus) continue;

    const previousStatus = role.status;
    if (setStatus(queue, role.id, terminalStatus)) {
      changed.push({
        id: role.id,
        company: role.company,
        title: role.title,
        from: previousStatus,
        to: terminalStatus,
      });
    }
  }

  return changed;
}

// ── Profile loader ────────────────────────────────────────────────────────────

function loadProfile() {
  const path = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(path)) return {};
  try {
    // js-yaml v4: yaml.load() uses DEFAULT_SAFE_SCHEMA — no arbitrary constructors.
    return yaml.load(readFileSync(path, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

// ── Activity feed (SSE) ───────────────────────────────────────────────────────

const activityClients = new Set();
const activityLog     = []; // in-memory ring buffer (last 200 events)
const MAX_ACTIVITY    = 200;

function emitActivity(runId, roleId, event, role, extra = {}) {
  const entry = {
    runId,
    roleId,
    event,  // started | success | login-wall | knockout-flag | failure | agent-path
    company: role?.company ?? '',
    title:   role?.title   ?? '',
    ts:      new Date().toISOString(),
    ...extra,
  };
  activityLog.push(entry);
  if (activityLog.length > MAX_ACTIVITY) activityLog.shift();

  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of activityClients) {
    try { client.write(data); } catch { activityClients.delete(client); }
  }
}

function apiActivity(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': `http://${HOST}:${PORT}`,
  });
  res.write('retry: 3000\n\n');
  // Send recent history to the new subscriber
  for (const entry of activityLog.slice(-50)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  activityClients.add(res);
  req.on('close', () => activityClients.delete(res));
}

// ── Canonical active-agent dispatch ──────────────────────────────────────────

const MAX_BULK_PREPARE_SELECTIONS = 500;

/**
 * Persist a work request without touching a browser or changing application
 * status. The interactive agent consumes this record and owns the exact tab for
 * the whole extract/resolve/L3/teach/verify/receipt run.
 *
 * Delegates to the shared core in `application-request.mjs` so the dashboard and
 * the one-shot drain enforce the very same browser-controller lease and
 * four-active-role cap — one implementation, not two copies that must agree.
 */
function enqueueActiveAgentRequest(queue, role, runId, source = 'dashboard') {
  return createActiveAgentRequest(queue, role, runId, source);
}

const SELECTION_CONFIRMATION_PHRASE = 'I selected these roles for preparation or filling';
const SELECTION_ACTIONS = new Set(['run', 'fill', 'stage-prepare']);

function exactQueueRoles(queue, ids) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  const roles = uniqueIds.map((id) => queue.roles.find((role) => role.id === id));
  return roles.every(Boolean) ? roles : null;
}

function selectionRoleStates(roles) {
  return Object.fromEntries(roles.map((role) => [role.id, role.status]));
}

function recordCandidateSelectionConfirmation(role, confirmation, source) {
  role.candidate_selection_confirmation = {
    version: 1,
    intent_id: confirmation.intentId,
    action: confirmation.action,
    role_ids: [...confirmation.roleIds],
    role_states: { ...confirmation.roleStates },
    source,
    confirmed_at: new Date(confirmation.issuedAt).toISOString(),
    consumed_at: new Date(confirmation.consumedAt).toISOString(),
  };
}

function assertSelectionRoleState(role, confirmation) {
  if (confirmation.roleStates[role.id] !== role.status) {
    const err = new Error(`candidate selection is stale because ${role.id} changed state`);
    err.httpCode = 409;
    throw err;
  }
}

function consumeSelectionConfirmation({ action, ids, nonce, intentId, roles }) {
  const confirmation = selectionConfirmations.consume({
    action,
    roleIds: ids,
    roleStates: selectionRoleStates(roles),
    nonce,
    intentId,
  });
  if (!confirmation.accepted) {
    const err = new Error(confirmation.reason);
    err.httpCode = 403;
    throw err;
  }
  return confirmation;
}

function apiSelectionConfirmation(req, res) {
  readBody(req, res, (body) => {
    const parsed = safeJson(body) || {};
    const action = String(parsed.action ?? '').trim();
    const ids = [...new Set((Array.isArray(parsed.ids) ? parsed.ids : []).map(String))];
    if (parsed.confirmation !== SELECTION_CONFIRMATION_PHRASE) {
      return respond(res, 400, { error: 'explicit candidate role-selection confirmation is required' });
    }
    if (!SELECTION_ACTIONS.has(action)) {
      return respond(res, 400, { error: 'selection action must be run | fill | stage-prepare' });
    }
    // A One-shot Run may record a large durable PREPARE batch which the active
    // controller later drains in groups of four. Ordinary live-fill runs remain
    // capped at four. The role-aware cap is enforced below after loading the
    // queue; this first bound only prevents oversized request bodies.
    const selectionLimit = action === 'fill' ? 1 : MAX_BULK_PREPARE_SELECTIONS;
    if (ids.length === 0 || ids.length > selectionLimit) {
      return respond(res, 400, {
        error: `selection must contain 1–${selectionLimit} unique role IDs`,
      });
    }
    if (action === 'fill' && ids.length !== 1) {
      return respond(res, 400, { error: `${action} selection must contain exactly one role ID` });
    }

    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const roles = exactQueueRoles(queue, ids);
    if (!roles) return respond(res, 404, { error: 'one or more selected role IDs were not found' });
    if (action === 'run'
        && ids.length > MAX_ACTIVE_APPLICATION_REQUESTS
        && !roles.every((role) => isOneShotRole(queue, role))) {
      return respond(res, 400, {
        error: `ordinary browser-controller runs are limited to ${MAX_ACTIVE_APPLICATION_REQUESTS} roles; larger selections require One-shot on every role`,
      });
    }
    if (action === 'stage-prepare' &&
        roles.some((role) => stageDragTarget(role, 'todo') !== 'prepare-queued')) {
      return respond(res, 409, {
        error: 'one or more roles are not eligible for candidate-confirmed PREPARE selection',
      });
    }

    const issued = selectionConfirmations.issue({
      roleIds: ids,
      action,
      roleStates: selectionRoleStates(roles),
    });
    return respond(res, 200, {
      selection_confirmation_nonce: issued.nonce,
      selection_intent_id: issued.intentId,
      role_ids: issued.roleIds,
      action,
      expires_in_seconds: 300,
    });
  });
}

function apiBulkPrepare(req, res) {
  readBody(req, res, (body) => {
    const {
      ids,
      selection_confirmation_nonce: selectionNonce,
      selection_intent_id: selectionIntentId,
    } = safeJson(body) || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return respond(res, 400, { error: 'ids must be a non-empty array' });
    }
    const uniqueIds = [...new Set(ids.map(String))];
    if (uniqueIds.length > MAX_BULK_PREPARE_SELECTIONS) {
      return respond(res, 400, {
        error: `bulk PREPARE is limited to ${MAX_BULK_PREPARE_SELECTIONS} roles`,
      });
    }

    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const roles = exactQueueRoles(queue, uniqueIds);
    if (!roles) {
      return respond(res, 404, { error: 'one or more selected role IDs were not found' });
    }

    let selectionConfirmation;
    try {
      selectionConfirmation = consumeSelectionConfirmation({
        action: 'stage-prepare',
        ids: uniqueIds,
        nonce: selectionNonce,
        intentId: selectionIntentId,
        roles,
      });
    } catch (err) {
      return respond(res, err.httpCode ?? 403, { error: err.message });
    }

    const quality = applicationQualityConfig(loadProfile());
    let result;
    try {
      result = mutateQueue((freshQueue) => {
        const freshRoles = exactQueueRoles(freshQueue, uniqueIds);
        if (!freshRoles) {
          const err = new Error('one or more selected role IDs were not found');
          err.httpCode = 404;
          throw err;
        }

        for (const role of freshRoles) {
          assertSelectionRoleState(role, selectionConfirmation);
          if (stageDragTarget(role, 'todo') !== 'prepare-queued') {
            const err = new Error(`${role.id} is no longer eligible for PREPARE selection`);
            err.httpCode = 409;
            throw err;
          }
        }

        let selectionOverridesRecorded = 0;
        for (const role of freshRoles) {
          recordCandidateSelectionConfirmation(
            role,
            selectionConfirmation,
            'dashboard-bulk-prepare',
          );
          if (recordCandidateSelectionOverride(
            role,
            quality.minimumApplyScore,
            'dashboard-bulk-prepare',
          )) selectionOverridesRecorded++;
          setStatus(freshQueue, role.id, 'prepare-queued');
        }
        return {
          moved: freshRoles.length,
          selectionOverridesRecorded,
        };
      });
    } catch (err) {
      return respond(res, err.httpCode ?? 503, {
        error: err.httpCode ? err.message : `queue store write failed: ${err.message}`,
      });
    }

    respond(res, 200, {
      moved: result.moved,
      status: 'prepare-queued',
      selection_overrides_recorded: result.selectionOverridesRecorded,
    });
  });
}

function apiRun(req, res) {
  readBody(req, res, (body) => {
    const {
      ids,
      selection_confirmation_nonce: selectionNonce,
      selection_intent_id: selectionIntentId,
    } = safeJson(body) || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return respond(res, 400, { error: 'ids must be a non-empty array' });
    }
    const uniqueIds = [...new Set(ids.map(String))];
    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const roles = exactQueueRoles(queue, uniqueIds);

    if (!roles) {
      return respond(res, 404, { error: 'one or more requested role IDs were not found' });
    }
    if (uniqueIds.length > MAX_ACTIVE_APPLICATION_REQUESTS
        && !roles.every((role) => isOneShotRole(queue, role))) {
      return respond(res, 400, {
        error: `ordinary browser-controller runs are limited to ${MAX_ACTIVE_APPLICATION_REQUESTS} roles; larger selections require One-shot on every role`,
      });
    }

    let selectionConfirmation;
    try {
      selectionConfirmation = consumeSelectionConfirmation({
        action: 'run',
        ids: uniqueIds,
        nonce: selectionNonce,
        intentId: selectionIntentId,
        roles,
      });
    } catch (err) {
      return respond(res, err.httpCode ?? 403, { error: err.message });
    }

    const profile = loadProfile();
    const quality = applicationQualityConfig(profile);
    const selectedIds = new Set(roles.map((role) => role.id));

    const runId = `run-${selectionConfirmation.intentId}`;

    let dispatch;
    try {
      dispatch = mutateQueue((freshQueue) => {
        const requested = [];
        const selectedForPrepare = [];
        const reviewReady = [];
        const repairRequired = [];
        const notPrepared = [];
        const qualityBlocked = [];
        let selectionOverridesRecorded = 0;
        let oneShotRequested = 0;
        for (const role of freshQueue.roles) {
          if (!selectedIds.has(role.id)) continue;
          assertSelectionRoleState(role, selectionConfirmation);
          recordCandidateSelectionConfirmation(role, selectionConfirmation, 'dashboard-run');
          if (recordCandidateSelectionOverride(
            role,
            quality.minimumApplyScore,
            'dashboard-run',
          )) selectionOverridesRecorded++;
          if (role.status === 'filled') {
            const receiptErrors = applicationReviewErrors(role);
            if (receiptErrors.length === 0) reviewReady.push(structuredClone(role));
            else repairRequired.push({ role: structuredClone(role), receiptErrors });
            continue;
          }
          // A finished lean run sits on `prefilled` but is review-ready, not
          // resumable. Never re-dispatch it: the candidate owns submission.
          if (isLeanCompleteRole(role)) {
            reviewReady.push(structuredClone(role));
            continue;
          }
          // A One-shot selection always enters the durable PREPARE chain, even
          // when an older asset set exists. This makes >4-role batching real:
          // the Run click records every selected role and `next` releases at
          // most four through the browser-controller gate.
          if (isOneShotRole(freshQueue, role)
              && (role.status === 'scored'
                || role.status === 'prepare-queued'
                || FILLABLE_STATUSES.has(role.status))) {
            if (role.status === 'scored') setStatus(freshQueue, role.id, 'prepare-queued');
            const oneShot = recordOneShotRequest(role, selectionConfirmation.intentId, {
              source: 'dashboard-run',
            });
            if (!oneShot.reused) oneShotRequested++;
            selectedForPrepare.push(structuredClone(role));
            continue;
          }
          // Dashboard checkbox selection is the durable PREPARE selection.
          // It never creates a consumable live-application request until fresh
          // role-specific assets and provenance have passed PREPARE.
          //
          // Under One-shot the candidate authorized the WHOLE chain with this
          // one click, so the intent is carried forward in a durable
          // `one_shot_request` the active agent drains (prepare → gate → fill →
          // prefilled). Without it the selection stays durable but the execution
          // does not, which is exactly how a selected To Do role used to stall
          // short of In Review. The record never launches anything here.
          if (role.status === 'scored') {
            setStatus(freshQueue, role.id, 'prepare-queued');
            selectedForPrepare.push(structuredClone(role));
            continue;
          }
          if (role.status === 'prepare-queued') {
            selectedForPrepare.push(structuredClone(role));
            continue;
          }
          if (!FILLABLE_STATUSES.has(role.status)) {
            notPrepared.push(structuredClone(role));
            continue;
          }
          const qualityIssues = validateApplicationRole(role, {
            root: ROOT,
            profile,
            quality,
            requireAssets: true,
            // Queue settings carry the portal-hosted-resume toggle; without
            // them this gate would demand a tailored CV the candidate
            // deliberately did not generate.
            settings: freshQueue.settings,
            // Sibling roles with real assets, so an untailored CV or a recycled
            // cover body is caught before a live fill request is created.
            peers: freshQueue.roles,
          }).filter((item) => item.level === 'error');
          if (qualityIssues.length) {
            qualityBlocked.push({ role: structuredClone(role), qualityIssues });
            continue;
          }
          const queued = enqueueActiveAgentRequest(freshQueue, role, runId, 'dashboard-run');
          requested.push({
            role: structuredClone(role),
            request: queued.request,
            reused: queued.reused,
          });
        }
        return {
          requested,
          selectedForPrepare,
          reviewReady,
          repairRequired,
          notPrepared,
          qualityBlocked,
          selectionOverridesRecorded,
          oneShotRequested,
        };
      });
    } catch (err) {
      return respond(res, err.httpCode ?? 503, {
        error: err.httpCode ? err.message : `could not queue active-agent application work: ${err.message}`,
      });
    }

    for (const { role, request, reused } of dispatch.requested) {
      emitActivity(runId, role.id, 'agent-path', role, {
        requestId: request.request_id,
        message: reused
          ? `Existing active-agent request preserved for ${role.url}; no live tab or run was overwritten.`
          : isDeepEval(role)
          ? `Canonical active-agent work queued for ${role.url}; complete oferta first when required, then every L3/teach/verify page receipt.`
          : `Canonical active-agent work queued for ${role.url}; the active agent owns the tab and every L3/teach/verify page receipt.`,
      });
    }
    for (const role of dispatch.selectedForPrepare) {
      const oneShot = summarizeOneShotRequest(role);
      emitActivity(runId, role.id, 'agent-path', role, {
        message: oneShot
          ? `⚡ One-shot queued for agent — durable request ${oneShot.request_id}. The active agent runs PREPARE, the asset gate, then the live fill through to prefilled. No second click is needed; nothing is submitted.`
          : `Selected for PREPARE — generate and verify the current role's tailored CV and cover before any live form request.`,
        ...(oneShot ? { oneShot } : {}),
      });
    }
    for (const role of dispatch.reviewReady) {
      emitActivity(runId, role.id, 'success', role, {
        message: isLeanCompleteRole(role)
          ? 'Lean run already reached its final review boundary; no browser work was launched. Review the open tab, submit it yourself, then Mark Submitted.'
          : 'Durable application receipt is already review-ready; no browser work was launched.',
      });
    }
    for (const { role, receiptErrors } of dispatch.repairRequired) {
      emitActivity(runId, role.id, 'failure', role, {
        message: `Filled receipt is invalid and was not overwritten. Run application-receipt.mjs --repair-filled ${role.id}, then restart the role.`,
        receiptErrors,
      });
    }
    for (const role of dispatch.notPrepared) {
      emitActivity(runId, role.id, 'failure', role, {
        message: `Role is '${role.status}' and cannot enter PREPARE/live filling from this state. Score or repair it first.`,
      });
    }
    for (const { role, qualityIssues } of dispatch.qualityBlocked) {
      emitActivity(runId, role.id, 'failure', role, {
        message: `Prepared assets failed the executable quality gate: ${qualityIssues.map((item) => item.code).join(', ')}`,
        issues: qualityIssues,
      });
    }

    respond(res, 200, {
      runId,
      controller: 'active-agent',
      controllerId: dispatch.requested[0]?.request?.controller_id ?? null,
      total: roles.length,
      agentPath: dispatch.requested.length,
      prepareQueued: dispatch.selectedForPrepare.length,
      reviewReady: dispatch.reviewReady.length,
      repairRequired: dispatch.repairRequired.length,
      notPrepared: dispatch.notPrepared.length,
      qualityBlocked: dispatch.qualityBlocked.length,
      selectionOverridesRecorded: dispatch.selectionOverridesRecorded,
      oneShotRequested: dispatch.oneShotRequested,
      requestIds: dispatch.requested.map((item) => item.request.request_id),
    });
  });
}

// ── Provenance summary helper ─────────────────────────────────────────────────

function provenanceSummary(drafts = {}) {
  let deterministic = 0;
  let modelReasoned = 0;
  for (const v of Object.values(drafts)) {
    if (v.source === 'model') modelReasoned++;
    else deterministic++;
  }
  const total = deterministic + modelReasoned;
  return total > 0
    ? `${deterministic}/${total} deterministic, ${modelReasoned} model-reasoned`
    : null;
}

function applicationReviewErrors(role) {
  // `submissionReadinessErrors` accepts both the normal review-ready `filled`
  // report and an already-promoted `submitted` report left by a retryable queue
  // backend failure. Either state must suppress a second browser fill.
  const errors = submissionReadinessErrors(role);
  if (role?.status !== 'filled') {
    errors.unshift(`role status is '${role?.status ?? 'missing'}', not receipt-gated 'filled'`);
  }
  return errors;
}

// ── API handlers ─────────────────────────────────────────────────────────────

// Reconciliation-persist backoff: a GET must not become a per-poll write storm
// when Supabase writes are failing (the reconciled view still renders from
// memory; only persistence is deferred).
const RECONCILE_SAVE_COOLDOWN_MS = 5 * 60 * 1000;
let reconcileSaveFailedAt = 0;

function apiGetQueue(res) {
  let queue;
  try {
    queue = loadQueue();
  } catch (err) {
    return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
  }
  let trackerReconciled = [];
  let trackerReconcileWarning = null;
  try {
    trackerReconciled = reconcileQueueWithTracker(queue);
  } catch (err) {
    // Tracker reconciliation is a convenience projection for the dashboard.
    // A malformed or temporarily unreadable tracker must not take the queue API
    // down or mutate the already-loaded queue.
    trackerReconcileWarning = `tracker reconciliation could not be evaluated: ${err.message}`;
    console.warn(`WARN: ${trackerReconcileWarning}`);
  }
  if (trackerReconciled.length > 0) {
    // The reconciled statuses are already applied in memory (and rendered
    // below) either way; the save only persists them. Under a persistent
    // Supabase write error, retrying on every poll is an unbounded write
    // storm — back off and let a later poll retry.
    if (Date.now() - reconcileSaveFailedAt < RECONCILE_SAVE_COOLDOWN_MS) {
      trackerReconcileWarning = 'tracker reconciliation persist backing off after a recent failure';
    } else {
      try {
        queue = mutateQueue((freshQueue) => {
          reconcileQueueWithTracker(freshQueue);
          return structuredClone(freshQueue);
        });
        reconcileSaveFailedAt = 0;
      } catch (err) {
        reconcileSaveFailedAt = Date.now();
        trackerReconcileWarning = `tracker reconciliation could not persist: ${err.message}`;
        console.warn(`WARN: ${trackerReconcileWarning}`);
      }
    }
  }
  const stats = computeStats(queue);

  const enriched = queue.roles
    .filter(r => ACTIVE_STATUSES.has(r.status))
    .map((r) => {
      const receiptErrors = applicationReviewErrors(r);
      return {
        ...r,
        lane:               computeLane(r),
        stage:              computeStage(r),
        provenance_summary: provenanceSummary(r.drafts),
        submission_ready:   r.status === 'filled' && receiptErrors.length === 0,
        manual_submission_allowed:
          ACTIVE_STATUSES.has(r.status) && !(r.status === 'filled' && receiptErrors.length === 0),
        receipt_errors:     receiptErrors,
        // Durable One-shot chain state. `queued_for_agent` is the honest UI
        // signal when no agent session is running: the work is recorded and
        // resumable, not silently dropped.
        one_shot:           summarizeOneShotRequest(r),
      };
    });

  // Done column: sourced from the tracker (applications.md), not the queue store —
  // done roles are evicted from active_roles into seen_urls on save, so the tracker
  // is the durable record of what was applied / closed.
  let done = [];
  try {
    if (existsSync(APPS_FILE)) {
      done = parseTrackerDoneRows(readFileSync(APPS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.warn('WARN: could not parse tracker done rows:', err.message?.slice(0, 200));
  }

  const settings = { ...(queue.settings ?? {}) };
  if (trackerReconciled.length > 0) settings.tracker_reconciled = trackerReconciled.length;
  if (trackerReconcileWarning) settings.tracker_reconcile_warning = trackerReconcileWarning;

  respond(res, 200, {
    csrf_token: DASHBOARD_CSRF_TOKEN,
    settings,
    stats,
    roles: enriched,
    done,
  });
}

function apiSetThreshold(req, res) {
  readBody(req, res, (body) => {
    const { value } = safeJson(body) || {};
    const threshold = parseFloat(value);
    if (isNaN(threshold) || threshold < 0 || threshold > 5) {
      return respond(res, 400, { error: 'threshold must be 0–5' });
    }

    try {
      mutateQueue((queue) => {
        queue.settings.score_threshold = threshold;
      });
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }
    // The threshold is a dashboard selection/filter preference only. Candidate
    // selection remains an explicit checkbox/drag action and this endpoint must
    // never promote, queue, or otherwise mutate an individual role.
    respond(res, 200, { threshold, selection_unchanged: true });
  });
}

// Global one-shot default: when settings.auto_fill_all is true, PREPARE chains
// straight into the fill for every explicitly selected role it prepares (see modes/queue.md →
// "One-shot auto-fill"), without needing the per-role auto-fill flag. Stored in
// queue settings so the prepare agent reads it from the same store. It never selects
// a role; flipping it never launches anything from the server.
function apiSetAutoFillAll(req, res) {
  readBody(req, res, (body) => {
    const { value } = safeJson(body) || {};
    if (typeof value !== 'boolean') {
      return respond(res, 400, { error: 'value must be a boolean' });
    }

    try {
      mutateQueue((queue) => { queue.settings.auto_fill_all = value; });
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }
    respond(res, 200, { auto_fill_all: value });
  });
}

// Portal-hosted resume (settings.portal_default_cv): Seek/Indeed attach the
// candidate's own profile resume to a NATIVE application, so PREPARE skips CV
// generation for those and the asset gate accepts the absence. It is decided at
// fill time by the host the FORM is on, so a "apply on company site" listing
// that redirects to an external ATS still requires a tailored CV
// (portal-resume-hosts.mjs). Cover letters are always generated regardless.
// Stored in queue settings so the prepare agent reads it from the same store.
// It never selects a role and never launches anything from the server.
function apiSetPortalDefaultCv(req, res) {
  readBody(req, res, (body) => {
    const { value } = safeJson(body) || {};
    if (typeof value !== 'boolean') {
      return respond(res, 400, { error: 'value must be a boolean' });
    }

    try {
      mutateQueue((queue) => { queue.settings.portal_default_cv = value; });
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }
    respond(res, 200, { portal_default_cv: value });
  });
}

function apiRoleFill(req, res, id) {
  readBody(req, res, (body) => {
  const parsed = safeJson(body) || {};
  let initialQueue;
  try {
    initialQueue = loadQueue();
  } catch (err) {
    return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
  }
  const initialRole = initialQueue.roles.find((item) => item.id === id);
  if (!initialRole) return respond(res, 404, { error: 'role not found' });

  let selectionConfirmation;
  try {
    selectionConfirmation = consumeSelectionConfirmation({
      action: 'fill',
      ids: [id],
      nonce: parsed.selection_confirmation_nonce,
      intentId: parsed.selection_intent_id,
      roles: [initialRole],
    });
  } catch (err) {
    return respond(res, err.httpCode ?? 403, { error: err.message });
  }

  const runId = `fill-${selectionConfirmation.intentId}`;
  const profile = loadProfile();
  const quality = applicationQualityConfig(profile);
  let dispatch;
  try {
    dispatch = mutateQueue((freshQueue) => {
      const freshRole = freshQueue.roles.find((item) => item.id === id);
      if (!freshRole) {
        const err = new Error('role not found');
        err.httpCode = 404;
        throw err;
      }
      assertSelectionRoleState(freshRole, selectionConfirmation);
      recordCandidateSelectionConfirmation(freshRole, selectionConfirmation, 'dashboard-fill');
      const overrideRecorded = recordCandidateSelectionOverride(
        freshRole,
        quality.minimumApplyScore,
        'dashboard-fill',
      );
      // `filled` is not a resumable begin state. Persist the explicit selection
      // override, then preserve a valid receipt or direct corrupt legacy state
      // through the one repair command instead of silently demoting it.
      if (freshRole.status === 'filled') {
        const freshReceiptErrors = applicationReviewErrors(freshRole);
        if (freshReceiptErrors.length === 0) {
          return {
            reviewReady: true,
            role: structuredClone(freshRole),
            overrideRecorded,
          };
        }
        return {
          repairRequired: true,
          role: structuredClone(freshRole),
          receiptErrors: freshReceiptErrors,
          overrideRecorded,
        };
      }

      if (freshRole.status === 'scored') {
        setStatus(freshQueue, freshRole.id, 'prepare-queued');
        // Same One-shot carry-forward as apiRun: one candidate click authorizes
        // the whole chain, so the intent becomes a durable agent-drained record
        // instead of a role that quietly parks at To Do.
        if (isOneShotRole(freshQueue, freshRole)) {
          recordOneShotRequest(freshRole, selectionConfirmation.intentId, {
            source: 'dashboard-fill',
          });
        }
        return {
          preparationQueued: true,
          role: structuredClone(freshRole),
          overrideRecorded,
        };
      }
      if (freshRole.status === 'prepare-queued' && isOneShotRole(freshQueue, freshRole)) {
        recordOneShotRequest(freshRole, selectionConfirmation.intentId, {
          source: 'dashboard-fill',
        });
        return {
          preparationQueued: true,
          role: structuredClone(freshRole),
          overrideRecorded,
        };
      }

      // A finished lean run is review-ready on `prefilled`; re-filling it would
      // discard the compact review and risk duplicating a live application.
      if (isLeanCompleteRole(freshRole)) {
        return {
          reviewReady: true,
          role: structuredClone(freshRole),
          overrideRecorded,
        };
      }

      // ATS type and deep-eval flags never bypass PREPARE. A selected scored
      // role becomes prepare-queued; only prepared/prefilled roles can receive
      // a consumable active-agent application request.
      if (!FILLABLE_STATUSES.has(freshRole.status)) {
        return {
          notPrepared: true,
          role: structuredClone(freshRole),
          overrideRecorded,
        };
      }

      const qualityIssues = validateApplicationRole(freshRole, {
        root: ROOT,
        profile,
        quality,
        requireAssets: true,
        peers: freshQueue.roles,
      }).filter((item) => item.level === 'error');
      if (qualityIssues.length > 0) {
        return {
          qualityIssues,
          role: structuredClone(freshRole),
          overrideRecorded,
        };
      }
      const queued = enqueueActiveAgentRequest(freshQueue, freshRole, runId, 'dashboard-fill');
      return {
        reviewReady: false,
        role: structuredClone(freshRole),
        request: queued.request,
        reused: queued.reused,
        overrideRecorded,
      };
    });
  } catch (err) {
    return respond(res, err.httpCode ?? 503, {
      error: err.httpCode ? err.message : `could not queue active-agent application work: ${err.message}`,
      receipt_errors: err.receiptErrors,
    });
  }

  if (dispatch.repairRequired) {
    return respond(res, 409, {
      error: `filled receipt is invalid and cannot be resumed; run application-receipt.mjs --repair-filled ${dispatch.role.id} before filling again`,
      receipt_errors: dispatch.receiptErrors,
      repair_required: true,
      selection_override_recorded: dispatch.overrideRecorded,
    });
  }

  if (dispatch.notPrepared) {
    return respond(res, 409, {
      error: `role is '${dispatch.role.status}' — run /career-ops queue prepare to generate fresh assets before filling`,
      selection_override_recorded: dispatch.overrideRecorded,
    });
  }

  if (dispatch.preparationQueued) {
    const oneShot = summarizeOneShotRequest(dispatch.role);
    emitActivity(runId, id, 'agent-path', dispatch.role, {
      message: oneShot
        ? `⚡ One-shot queued for agent — durable request ${oneShot.request_id}. PREPARE, the asset gate, and the live fill run without another click; nothing is submitted.`
        : `Selected for PREPARE — generate and verify the current role's tailored CV and cover before live filling.`,
      ...(oneShot ? { oneShot } : {}),
    });
    return respond(res, 202, {
      method: 'prepare-queued',
      status: dispatch.role.status,
      message: oneShot
        ? `${dispatch.role.company} – ${dispatch.role.title} is queued for the agent under One-shot. No live form request was created yet.`
        : `${dispatch.role.company} – ${dispatch.role.title} is selected for PREPARE. No live form request was created.`,
      selection_override_recorded: dispatch.overrideRecorded,
      ...(oneShot ? { one_shot: oneShot } : {}),
    });
  }

  if (dispatch.qualityIssues?.length) {
    return respond(res, 409, {
      error: `application quality gate failed: ${dispatch.qualityIssues.map((item) => `${item.code}: ${item.message}`).join(' | ')}`,
      issues: dispatch.qualityIssues,
      selection_override_recorded: dispatch.overrideRecorded,
    });
  }

  if (dispatch.reviewReady) {
    return respond(res, 200, {
      method: 'review-ready',
      message: `Durable application receipt verified for ${dispatch.role.company} – ${dispatch.role.title}. No browser work was launched.`,
      receipt_errors: [],
      selection_override_recorded: dispatch.overrideRecorded,
    });
  }

  const { request } = dispatch;
  const role = dispatch.role;
  const agentSpecial = role.ats === 'custom' || isDeepEval(role);

  emitActivity(request.run_id, id, 'agent-path', role, {
    requestId: request.request_id,
    message: agentSpecial && isDeepEval(role)
      ? `Canonical active-agent work queued; complete oferta first when required, then own the live tab through every receipt page. Open: ${role.url}`
      : `Canonical active-agent work queued; the active agent owns the live tab through every L3/teach/verify receipt page. Open: ${role.url}`,
  });

  respond(res, 200, {
    method: 'agent',
    runId: request.run_id,
    requestId: request.request_id,
    controller: 'active-agent',
    controllerId: request.controller_id,
    reused: dispatch.reused,
    selectionOverrideRecorded: dispatch.overrideRecorded,
    message: dispatch.reused
      ? `Existing active-agent application request preserved for ${role.company} – ${role.title}; no live run or tab was overwritten.`
      : `Canonical active-agent application work queued for ${role.company} – ${role.title}. No private browser was launched.`,
  });
  });
}

const SUBMISSION_CONFIRMATION_PHRASE = MANUAL_SUBMISSION_CONFIRMATION;

function apiSubmissionConfirmation(req, res, id) {
  readBody(req, res, (body) => {
    const parsed = safeJson(body) || {};
    if (parsed.confirmation !== SUBMISSION_CONFIRMATION_PHRASE) {
      return respond(res, 400, { error: 'explicit portal-submission confirmation is required' });
    }
    let role;
    try {
      role = loadQueue().roles.find((item) => item.id === id);
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    if (!role) return respond(res, 404, { error: 'role not found' });
    const errors = applicationReviewErrors(role);
    if (errors.length === 0) {
      return respond(res, 200, {
        confirmation_nonce: submissionConfirmations.issue(id),
        expires_in_seconds: 300,
        mode: 'receipt',
      });
    }
    if (!ACTIVE_STATUSES.has(role.status)) {
      return respond(res, 409, {
        error: 'a valid receipt-bound filled application is required before submission can be confirmed',
        receipt_errors: errors,
      });
    }
    // No review-ready receipt exists, but the role is still active: the
    // candidate may record a portal submission they performed personally. The
    // typed confirmation phrase validated above plus this one-use nonce become
    // the durable manual provenance; no agent path issues this confirmation.
    return respond(res, 200, {
      confirmation_nonce: submissionConfirmations.issue(id),
      expires_in_seconds: 300,
      mode: 'manual',
      receipt_errors: errors,
    });
  });
}

function apiRoleDecision(req, res, id) {
  readBody(req, res, (body) => {
    const { decision, confirmation_nonce: confirmationNonce } = safeJson(body) || {};
    if (!['submitted', 'skipped', 'reviewed'].includes(decision)) {
      return respond(res, 400, { error: 'decision must be submitted | skipped | reviewed' });
    }

    if (decision === 'submitted') {
      const confirmation = submissionConfirmations.consume(id, confirmationNonce);
      if (!confirmation.accepted) {
        return respond(res, 403, { error: confirmation.reason });
      }
    }

    let started;
    try {
      // A retry may find that the report file was promoted to `submitted`
      // before the queue commit failed. Reading the already-durable pending
      // transaction must not perform a no-op queue save: the queue validator
      // correctly rejects the temporary filled-role/submitted-report split.
      // New decisions still persist their intent under the queue lock first.
      const currentQueue = loadQueue();
      const currentRole = currentQueue.roles.find((item) => item.id === id);
      const pending = currentRole ? decisionTransactionFor(currentRole, decision) : null;
      started = pending && ['pending', 'report-promoted', 'tracker-written'].includes(pending.state)
        ? beginCandidateDecision(currentQueue, id, decision)
        : mutateQueue((queue) => beginCandidateDecision(queue, id, decision));
    } catch (err) {
      if (err.httpCode) {
        return respond(res, err.httpCode, { error: err.message, receipt_errors: err.receiptErrors });
      }
      return respond(res, 503, { error: `candidate decision persistence failed: ${err.message}` });
    }

    if (started.alreadyCommitted) {
      return respond(res, 200, {
        id,
        decision,
        status: decision,
        transaction_id: started.transaction.transaction_id,
        receipt_id: decision === 'submitted' ? started.role.application_progress?.receipt_id : undefined,
        idempotent: true,
      });
    }

    const transactionId = started.transaction.transaction_id;
    const manualMode = started.transaction.mode === 'manual';
    let workingRole = started.role;
    let report = null;
    let tracker = null;
    try {
      if (decision === 'submitted' && !manualMode) {
        // Candidate confirmation is the authority for the report transition.
        // Keep the promoted report on the in-memory working role until the
        // final queue mutation can promote receipt state and role status
        // together. Persisting report_state=submitted while status is still
        // filled would violate the queue's receipt-integrity invariant.
        // Manual submissions have no receipt-bound report to promote: their
        // provenance is the candidate attestation stamped at transaction begin.
        report = promoteOrReconcileSubmittedReport(workingRole, started.transaction);
      }

      tracker = writeTrackerTsv(workingRole, decision, {
        receiptId: decision === 'submitted' && !manualMode ? workingRole.application_progress?.receipt_id : null,
        manualSubmission: decision === 'submitted' && manualMode,
      });

      const result = mutateQueue((queue) => {
        const role = queue.roles.find((item) => item.id === id);
        if (!role) throw new Error('role disappeared before its candidate decision could commit');
        const transaction = assertDecisionTransaction(role, transactionId, decision);
        if (decision === 'submitted' && !manualMode) {
          promoteOrReconcileSubmittedReport(role, transaction);
        }
        transaction.state = 'tracker-written';
        transaction.tracker = tracker;
        transaction.updated_at = new Date().toISOString();
        cancelOneShotRequestOnRole(
          role,
          `candidate recorded the role as ${decision}`,
          transaction.updated_at,
        );
        setStatus(queue, id, decision);
        transaction.state = 'committed';
        transaction.completed_at = new Date().toISOString();
        transaction.updated_at = transaction.completed_at;
        return { role: structuredClone(role), transaction: structuredClone(transaction) };
      });

      return respond(res, 200, {
        id,
        decision,
        status: decision,
        tracker,
        report,
        transaction_id: result.transaction.transaction_id,
        receipt_id: decision === 'submitted' && !manualMode ? result.role.application_progress?.receipt_id : undefined,
        ...(decision === 'submitted'
          ? { provenance: manualMode ? 'candidate-manual' : 'application-receipt' }
          : {}),
      });
    } catch (err) {
      return respond(res, 503, {
        error: `candidate decision transaction is pending and safe to retry: ${err.message}`,
        transaction_id: transactionId,
        retry_same_decision: true,
      });
    }

  });
}

// ── Kanban board — drag-to-move ───────────────────────────────────────────────
//
// Handles ONLY the drags that are a legal bare status flip: Inbox↔To Do
// (select/deselect), Prepared → To Do, and legacy Prefilled → To Do.
// Receipt-gated Filled is immutable here: valid evidence stays review-ready,
// while corrupt historical evidence must pass the explicit repair command.
// Forward moves into Prepared/In Review/Done are never accepted here — the web
// UI routes those drops to the existing /fill and /decision endpoints instead,
// so a card can never claim to be further along than it actually is.

function apiRoleStage(req, res, id) {
  readBody(req, res, (body) => {
    const {
      stage,
      selection_confirmation_nonce: selectionNonce,
      selection_intent_id: selectionIntentId,
    } = safeJson(body) || {};
    if (!DRAG_TARGET_STAGES.includes(stage)) {
      return respond(res, 400, { error: `stage must be ${DRAG_TARGET_STAGES.join(' | ')}` });
    }

    let selectionConfirmation = null;
    if (stage === 'todo') {
      let queue;
      try {
        queue = loadQueue();
      } catch (err) {
        return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
      }
      const role = queue.roles.find((item) => item.id === id);
      if (!role) return respond(res, 404, { error: 'role not found' });
      if (stageDragTarget(role, stage) === 'prepare-queued') {
        try {
          selectionConfirmation = consumeSelectionConfirmation({
            action: 'stage-prepare',
            ids: [id],
            nonce: selectionNonce,
            intentId: selectionIntentId,
            roles: [role],
          });
        } catch (err) {
          return respond(res, err.httpCode ?? 403, { error: err.message });
        }
      }
    }

    let nextStatus;
    try {
      nextStatus = mutateQueue((queue) => {
        const role = queue.roles.find((item) => item.id === id);
        if (!role) {
          const err = new Error('role not found');
          err.httpCode = 404;
          throw err;
        }
        if (role.status === 'filled' && stage === 'todo') {
          const receiptErrors = applicationReviewErrors(role);
          const err = new Error(receiptErrors.length === 0
            ? 'receipt-gated filled roles remain review-ready and cannot be dragged backward'
            : `filled receipt is invalid; run application-receipt.mjs --repair-filled ${role.id} before restarting it`);
          err.httpCode = 409;
          err.receiptErrors = receiptErrors;
          throw err;
        }
        const target = stageDragTarget(role, stage);
        if (!target) {
          const err = new Error(`cannot move this role to ${stage} — not a valid drag transition`);
          err.httpCode = 409;
          throw err;
        }
        if (target === 'prepare-queued') {
          if (!selectionConfirmation) {
            const err = new Error('candidate selection confirmation is required before PREPARE');
            err.httpCode = 403;
            throw err;
          }
          assertSelectionRoleState(role, selectionConfirmation);
          recordCandidateSelectionConfirmation(role, selectionConfirmation, 'dashboard-drag');
          const quality = applicationQualityConfig(loadProfile());
          recordCandidateSelectionOverride(role, quality.minimumApplyScore, 'dashboard-drag');
        }
        if (target === 'scored') {
          cancelOneShotRequestOnRole(role, 'candidate moved the role back to Inbox');
        }
        setStatus(queue, id, target);
        return target;
      });
    } catch (err) {
      if (err.httpCode) {
        return respond(res, err.httpCode, {
          error: err.message,
          receipt_errors: err.receiptErrors,
          repair_required: Array.isArray(err.receiptErrors) && err.receiptErrors.length > 0,
        });
      }
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }

    respond(res, 200, { id, stage, status: nextStatus });
  });
}

// ── Toggleable markers (deep-eval, auto-fill) ─────────────────────────────────
//
// Toggles a hand-set marker flag on a role. Markers only record intent — the
// endpoint does NOT run any evaluation or fill (the server has no LLM) and does
// NOT change status, lane, or anything in the fill pipeline. The agent honours
// each marker later:
//   - `deep-eval` (see modes/apply.md → "Deep-eval marker"): a marked role gets a
//     full `oferta` first, then fills as normal. To keep that guarantee, the
//     fill/run dispatch routes deep-eval-marked roles to the active-agent path;
//     the server never launches a browser.
//   - `auto-fill` (see modes/queue.md → "One-shot auto-fill"): PREPARE queues an
//     active-agent application request instead of parking at Prepared. The agent
//     still stops before submit and uses the fresh PREPARE assets.
// Unmarked roles are unaffected.

const DEEP_EVAL_FLAG = 'deep-eval';
const AUTO_FILL_FLAG = 'auto-fill';
const TOGGLEABLE_FLAGS = new Set([DEEP_EVAL_FLAG, AUTO_FILL_FLAG]);

function apiRoleFlag(req, res, id) {
  readBody(req, res, (body) => {
    const parsed = safeJson(body) || {};
    const flag = parsed.flag || DEEP_EVAL_FLAG;
    // Safelist: this endpoint only manages the hand-set markers. Other flags are
    // owned by the scorer/fill pipeline and must not be hand-toggled here.
    if (!TOGGLEABLE_FLAGS.has(flag)) {
      return respond(res, 400, { error: `flag must be one of: ${[...TOGGLEABLE_FLAGS].join(' | ')}` });
    }

    let result;
    try {
      result = mutateQueue((queue) => {
        const role = queue.roles.find((item) => item.id === id);
        if (!role) {
          const err = new Error('role not found');
          err.httpCode = 404;
          throw err;
        }
        role.flags = Array.isArray(role.flags) ? role.flags : [];
        const has = role.flags.includes(flag);
        const next = typeof parsed.value === 'boolean' ? parsed.value : !has;
        if (next && !has) role.flags.push(flag);
        if (!next && has) role.flags = role.flags.filter((item) => item !== flag);
        return { next, flags: [...role.flags] };
      });
    } catch (err) {
      if (err.httpCode) return respond(res, err.httpCode, { error: err.message });
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }

    respond(res, 200, { id, flag, marked: result.next, flags: result.flags });
  });
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function respond(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, res, cb) {
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  req.on('data', (chunk) => {
    if (rejected) return;
    bytes += chunk.length;
    if (bytes > DASHBOARD_JSON_BODY_LIMIT) {
      rejected = true;
      respond(res, 413, { error: `request body exceeds ${DASHBOARD_JSON_BODY_LIMIT} bytes` });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!rejected) cb(Buffer.concat(chunks).toString('utf-8'));
  });
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not found');
    return;
  }
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}

// ── Request router ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS — localhost only; this extra header prevents other pages from reading
  // the API if a browser happens to have a tab open with cross-origin XHR.
  res.setHeader('Access-Control-Allow-Origin', DASHBOARD_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Career-Ops-CSRF');

  if (req.method === 'OPTIONS') {
    if (req.headers.origin && req.headers.origin !== DASHBOARD_ORIGIN) {
      return respond(res, 403, { error: 'cross-origin dashboard mutation is forbidden' });
    }
    res.writeHead(204); res.end(); return;
  }

  const url    = new URL(req.url, `http://${HOST}:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  if (method === 'POST') {
    const authorization = validateDashboardMutationRequest(req.headers, {
      expectedOrigin: DASHBOARD_ORIGIN,
      csrfToken: DASHBOARD_CSRF_TOKEN,
    });
    if (!authorization.allowed) {
      return respond(res, authorization.status, { error: authorization.reason });
    }
  }

  // API routes
  if (path === '/api/queue'    && method === 'GET')  return apiGetQueue(res);
  if (path === '/api/threshold' && method === 'POST') return apiSetThreshold(req, res);
  if (path === '/api/autofill'  && method === 'POST') return apiSetAutoFillAll(req, res);
  if (path === '/api/portal-default-cv' && method === 'POST') return apiSetPortalDefaultCv(req, res);
  if (path === '/api/roles/prepare' && method === 'POST') return apiBulkPrepare(req, res);
  if (path === '/api/run'      && method === 'POST')  return apiRun(req, res);
  if (path === '/api/activity' && method === 'GET')   return apiActivity(req, res);

  if (path === '/api/selection-confirmation' && method === 'POST') {
    return apiSelectionConfirmation(req, res);
  }

  const fillMatch = path.match(/^\/api\/role\/([^/]+)\/fill$/);
  if (fillMatch && method === 'POST') return apiRoleFill(req, res, decodeURIComponent(fillMatch[1]));

  const submissionConfirmationMatch = path.match(/^\/api\/role\/([^/]+)\/submission-confirmation$/);
  if (submissionConfirmationMatch && method === 'POST') {
    return apiSubmissionConfirmation(req, res, decodeURIComponent(submissionConfirmationMatch[1]));
  }

  const decisionMatch = path.match(/^\/api\/role\/([^/]+)\/decision$/);
  if (decisionMatch && method === 'POST') return apiRoleDecision(req, res, decodeURIComponent(decisionMatch[1]));

  const stageMatch = path.match(/^\/api\/role\/([^/]+)\/stage$/);
  if (stageMatch && method === 'POST') return apiRoleStage(req, res, decodeURIComponent(stageMatch[1]));

  const flagMatch = path.match(/^\/api\/role\/([^/]+)\/flag$/);
  if (flagMatch && method === 'POST') return apiRoleFlag(req, res, decodeURIComponent(flagMatch[1]));

  // Static SPA files
  if (path === '/' || path === '/index.html') {
    return serveStatic(res, join(WEB_DIR, 'index.html'));
  }
  if (path.startsWith('/dashboard/web/')) {
    const rel = path.slice('/dashboard/web/'.length);
    return serveStatic(res, join(WEB_DIR, rel));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`career-ops apply queue dashboard`);
  console.log(`→  http://${HOST}:${PORT}`);
  console.log(`Serving Supabase active_roles via queue-store  (localhost only)`);
  console.log(`Press Ctrl+C to stop.\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try --port ${PORT + 1}`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
