#!/usr/bin/env node
/**
 * queue-store.mjs -- Shared read/write/query helpers for the apply queue.
 *
 * Single source of queue I/O, with two selectable backends:
 *
 *   local    — the whole queue lives in data/apply-queue.json (atomic writes).
 *              Zero accounts, zero network: the default for a fresh clone.
 *   supabase — cloud-safe discovery columns live in Supabase active_roles /
 *              seen_urls; candidate-generated fields stay in the local sidecar
 *              data/local-enrichments.json. Required for the GitHub discovery
 *              crons (they need a store reachable while the laptop is off).
 *
 * Backend selection (resolveQueueBackend): CAREER_OPS_QUEUE_BACKEND env var,
 * else `queue.backend` in config/profile.yml, else auto — supabase when its
 * env is configured, local otherwise. Pin `queue.backend: supabase` in the
 * profile to fail loud instead of silently falling back to local writes when
 * the Supabase env breaks (a silent fallback would fork the queue state).
 *
 * Nothing in this file invokes any LLM.
 */

import {
  readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmSync, statSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';

import { createSupabaseClient, isSupabaseConfigured } from './supabase-client.mjs';
import { checkUrlLivenessHttp } from './liveness-http.mjs';
import { validateApplicationReceiptIntegrity } from './application-receipt-integrity.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_DATA_DIR redirects the store's files (tests, sandboxes); default
// is the repo's data/ directory.
const DATA_DIR = process.env.CAREER_OPS_DATA_DIR
  ? resolve(process.env.CAREER_OPS_DATA_DIR)
  : join(ROOT, 'data');
export const QUEUE_PATH = join(DATA_DIR, 'apply-queue.json');
export const LOCAL_ENRICHMENTS_PATH = join(DATA_DIR, 'local-enrichments.json');
export const QUEUE_LOCK_PATH = join(DATA_DIR, '.apply-queue.lock');
const TMP_DIR = DATA_DIR;

// --- Status lifecycle ---
// Lean default (lean-llm-v1): new -> scored -> prepare-queued -> prepared -> prefilled -> submitted
// Receipt-v3 (opt-in/historical): prepared -> filled -> submitted
// 'prefilled' = lean review-ready fill (compact Application Answers; candidate
//               Mark Submitted via manual_submission). Also accepts legacy
//               incomplete checkpoints that never finished receipt-v3.
// 'filled'    = receipt-gated review-ready application only; candidate review
//               and final submission are still pending.
export const ACTIVE_STATUSES  = new Set(['new', 'scored', 'prepare-queued', 'prepared', 'prefilled', 'filled']);
export const DONE_STATUSES    = new Set(['submitted', 'skipped', 'reviewed', 'closed']);
export const LANE_STATUSES    = new Set(['scored', 'prepare-queued', 'prepared', 'prefilled', 'filled']); // visible in lanes

// PII guard: only fields in this allowlist can ever be serialized to Supabase.
// Any new field on a role object defaults to the local sidecar until explicitly
// reviewed and added here as cloud-safe discovery data.
export const CLOUD_ROLE_FIELDS = new Set([
  'id',
  'company',
  'title',
  'url',
  'ats',
  'source',
  'location',
  'jd_text',
  'jd_path',
  'status',
  'score',
  'score_raw',
  'size_bucket',
  'eligibility',
  'employment_type',
  'confidence',
  'flags',
  'free_text_fields',
  'upload_fields',
  'ksc_criteria',
  'cover_letter_required',
  'requirements_snippet',
  'created_at',
  'scored_at',
  'prepared_at',
  'prefilled_at',
  'filled_at',
]);

export const LOCAL_ONLY_ROLE_FIELDS = new Set([
  'reason',
  'visa_answer',
  'drafts',
  'cv_pdf',
  'cover_letter_path',
  'cover_letter_paths',
  'ksc_path',
  'decided_at',
  'confirmation_number',
  'confirmation_screenshot',
  'user_override',
  'application_quality_review',
  'generation_provenance',
  'application_progress',
  'application_request',
  'application_finalization_transaction',
  'application_decision_transaction',
  'application_receipt_repairs',
  'review_required_fields',
  'prefill_checkpoint',
  'prior_application_detected_at',
  'prior_application_detected_url',
  'manual_submission',
]);

const EMPTY_QUEUE = () => ({
  version: 1,
  settings: { score_threshold: null, updated_at: null },
  roles: [],
});

const STATUS_TIMESTAMP = {
  scored:           'scored_at',
  prepared:         'prepared_at',
  prefilled:        'prefilled_at',
  filled:           'filled_at',
  submitted:        'decided_at',
  skipped:          'decided_at',
  reviewed:         'decided_at',
  closed:           'decided_at',
  'prepare-queued': null,
};

const STATUS_TRANSITION_AUTH = Symbol('career-ops-status-transition');
// Private capability passed only by mutateQueue() after it captured the
// persisted before-state under the queue lock.  Exported callers cannot mint
// this symbol, so saveQueue() must reconstruct its own persisted before-state
// and cannot be used as a direct protected-status bypass.
const SAVE_TRANSITION_CONTEXT = Symbol('career-ops-save-transition-context');
const RECEIPT_PROTECTED_STATUSES = new Set(['filled', 'submitted']);

function finalizedApplicationReceiptError(role, expectedReportState) {
  try {
    validateApplicationReceiptIntegrity(role, expectedReportState);
    return null;
  } catch (error) {
    return error;
  }
}

// -- Candidate manual-submission provenance -----------------------------------
//
// The durable record that the candidate personally performed the portal
// submission outside the receipt-gated flow. Created only by the dashboard
// decision endpoint after the typed confirmation phrase and one-use nonce.
// It authorizes `submitted` from any active status without a review-ready
// receipt. It never substitutes for receipt evidence on `filled` and never
// authorizes an agent-performed submission.

export const MANUAL_SUBMISSION_PROVENANCE_VERSION = 1;
export const MANUAL_SUBMISSION_SOURCE = 'candidate-dashboard';
export const MANUAL_SUBMISSION_CONFIRMATION = 'I submitted this application in the portal';

export function manualSubmissionProvenanceError(role) {
  const manual = role?.manual_submission;
  if (!manual || typeof manual !== 'object' || Array.isArray(manual)) {
    return 'candidate manual-submission provenance is missing';
  }
  if (manual.version !== MANUAL_SUBMISSION_PROVENANCE_VERSION) {
    return `manual-submission provenance version must be ${MANUAL_SUBMISSION_PROVENANCE_VERSION}`;
  }
  if (manual.source !== MANUAL_SUBMISSION_SOURCE) {
    return `manual-submission provenance source must be '${MANUAL_SUBMISSION_SOURCE}'`;
  }
  if (manual.confirmation !== MANUAL_SUBMISSION_CONFIRMATION) {
    return 'manual-submission provenance is missing the typed candidate confirmation phrase';
  }
  if (typeof manual.confirmed_at !== 'string' || !Number.isFinite(Date.parse(manual.confirmed_at))) {
    return 'manual-submission provenance confirmed_at must be a valid timestamp';
  }
  if (!ACTIVE_STATUSES.has(manual.prior_status)) {
    return `manual-submission provenance prior_status must be an active queue status, not '${manual.prior_status}'`;
  }
  if (typeof manual.transaction_id !== 'string' || manual.transaction_id.trim() === '') {
    return 'manual-submission provenance must record its candidate decision transaction id';
  }
  return null;
}

function assertReceiptProtectedRole(role) {
  if (role?.status === 'filled') {
    const error = finalizedApplicationReceiptError(role, 'filled');
    if (error) {
      throw new Error(
        `role ${role?.id ?? '<unknown>'}: status filled requires a finalized review-ready ` +
        `application receipt: ${error.message}`,
      );
    }
  }
  if (role?.status === 'submitted') {
    if (manualSubmissionProvenanceError(role) === null) return;
    const error = finalizedApplicationReceiptError(role, 'submitted');
    if (error) {
      throw new Error(
        `role ${role?.id ?? '<unknown>'}: status submitted requires candidate-confirmed ` +
        `receipt/report provenance or candidate manual-submission provenance: ${error.message}`,
      );
    }
  }
}

function hasModernApplicationReceiptEvidence(role) {
  return role != null && (
    Object.prototype.hasOwnProperty.call(role, 'application_progress') ||
    Object.prototype.hasOwnProperty.call(role, 'application_request')
  );
}

function queueTransitionSnapshot(queue) {
  return new Map((queue?.roles ?? []).map((role) => [role.id, {
    status: role.status,
    modernReceiptEvidence: hasModernApplicationReceiptEvidence(role),
  }]));
}

function persistedTransitionSnapshot() {
  const persisted = loadShadowQueue();
  if (persisted == null) return new Map();
  validateQueueShape(persisted, 'persisted apply queue');
  return queueTransitionSnapshot(persisted);
}

function validateReceiptProtectedTransitions(beforeTransitions, queue, { consumeAuthorization = true } = {}) {
  for (const role of queue.roles ?? []) {
    const before = beforeTransitions.get(role.id) ?? {
      status: null,
      modernReceiptEvidence: false,
    };
    const previous = before.status;
    const protectedNow = RECEIPT_PROTECTED_STATUSES.has(role.status);
    const modernNow = hasModernApplicationReceiptEvidence(role);
    if (previous !== role.status && protectedNow) {
      const authorization = role[STATUS_TRANSITION_AUTH];
      if (!authorization || authorization.from !== previous || authorization.to !== role.status) {
        throw new Error(`role ${role.id}: protected status ${role.status} must be entered through queue-store.setStatus`);
      }
      // Legacy rows may predate application receipts, so unchanged protected
      // rows remain saveable.  Every *new* transition is checked again here,
      // at the persistence boundary, even though setStatus() also fails early.
      assertReceiptProtectedRole(role);
    } else if (previous === role.status && protectedNow) {
      if (before.modernReceiptEvidence && !modernNow) {
        throw new Error(
          `role ${role.id}: refusing to erase modern application receipt evidence while status remains ${role.status}`,
        );
      }
      // Genuine historical rows have neither application_progress nor
      // application_request and remain saveable for unrelated mutations. Once
      // either field exists, the protected status remains an invariant on every
      // later save instead of only at first promotion.
      if (before.modernReceiptEvidence || modernNow) {
        assertReceiptProtectedRole(role);
      }
    }
    if (consumeAuthorization) delete role[STATUS_TRANSITION_AUTH];
  }
}

// -- Local JSON helpers -------------------------------------------------------

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}; refusing to treat an existing store as empty: ${err.message}`);
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(TMP_DIR, `.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function normalizeSidecar(raw = null) {
  if (raw == null) {
    return { version: 1, settings: {}, roles: {} };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid local-enrichments store; expected a JSON object');
  }
  if (raw.roles && typeof raw.roles === 'object') {
    if (Array.isArray(raw.roles)) throw new Error('Invalid local-enrichments roles map');
    return {
      version: raw.version ?? 1,
      settings: raw.settings ?? {},
      roles: raw.roles ?? {},
    };
  }

  // Backward-compatible shape from the design doc:
  // { "<role-id>": { reason, drafts, ... } }
  const roles = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version' || key === 'settings') continue;
    if (value && typeof value === 'object') roles[key] = value;
  }
  return { version: raw.version ?? 1, settings: raw.settings ?? {}, roles };
}

function loadSidecar() {
  return normalizeSidecar(readJson(LOCAL_ENRICHMENTS_PATH, null));
}

function saveSidecar(sidecar) {
  atomicWriteJson(LOCAL_ENRICHMENTS_PATH, {
    version: 1,
    settings: sidecar.settings ?? {},
    roles: sidecar.roles ?? {},
  });
}

function loadShadowQueue() {
  return readJson(QUEUE_PATH, null);
}

function validateQueueShape(queue, label = 'apply queue') {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    throw new Error(`Invalid ${label}; expected a JSON object`);
  }
  if (queue.settings != null && (typeof queue.settings !== 'object' || Array.isArray(queue.settings))) {
    throw new Error(`Invalid ${label}; settings must be an object`);
  }
  if (queue.roles != null && !Array.isArray(queue.roles)) {
    throw new Error(`Invalid ${label}; roles must be an array`);
  }
  queue.settings = queue.settings ?? {};
  queue.roles = queue.roles ?? [];
  return queue;
}

function saveShadowQueue(queue) {
  atomicWriteJson(QUEUE_PATH, queue);
}

function withQueueLock(fn, timeoutMs = 15_000) {
  mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const staleMs = 120_000;
  const recoverGuardPath = `${QUEUE_LOCK_PATH}.recover`;
  const token = randomUUID();

  const readOwner = (path) => {
    try {
      return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const processIsAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  };
  const canRecover = (path) => {
    const owner = readOwner(path);
    if (owner?.pid) return !processIsAlive(owner.pid);
    try {
      return Date.now() - statSync(path).mtimeMs > staleMs;
    } catch {
      return true;
    }
  };
  const createOwnedLock = (path, ownerToken) => {
    mkdirSync(path, { mode: 0o700 });
    try {
      writeFileSync(join(path, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        started_at: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  };
  const releaseOwnedLock = (path, ownerToken) => {
    if (readOwner(path)?.token === ownerToken) {
      rmSync(path, { recursive: true, force: true });
    }
  };

  while (true) {
    try {
      createOwnedLock(QUEUE_LOCK_PATH, token);
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      const recoverToken = randomUUID();
      let ownsRecoverGuard = false;
      try {
        createOwnedLock(recoverGuardPath, recoverToken);
        ownsRecoverGuard = true;
      } catch (guardError) {
        if (guardError?.code !== 'EEXIST') throw guardError;
        if (canRecover(recoverGuardPath)) {
          rmSync(recoverGuardPath, { recursive: true, force: true });
        }
      }

      if (ownsRecoverGuard) {
        try {
          if (canRecover(QUEUE_LOCK_PATH)) {
            rmSync(QUEUE_LOCK_PATH, { recursive: true, force: true });
            continue;
          }
        } finally {
          releaseOwnedLock(recoverGuardPath, recoverToken);
        }
      }

      if (Date.now() >= deadline) throw new Error('Timed out waiting for apply queue lock');
      // Synchronous 50ms sleep: callers (CLI and dashboard alike) rely on
      // mutateQueue being synchronous, and the application-contract guards pin
      // that call shape. Under cross-process lock contention this blocks the
      // dashboard event loop for up to timeoutMs — an accepted trade-off; an
      // async lock path would have to move in lockstep with the contract
      // verifier patterns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    releaseOwnedLock(QUEUE_LOCK_PATH, token);
  }
}

function dateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function inferSource(role) {
  if (role.source) return role.source;
  if (role.ats === 'greenhouse') return 'greenhouse-api';
  if (role.ats === 'lever') return 'lever-api';
  if (role.ats === 'ashby') return 'ashby-api';
  return 'manual';
}

function normalizeCloudRole(row) {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    ats: row.ats,
    source: row.source ?? inferSource(row),
    location: row.location ?? '',
    jd_text: row.jd_text ?? null,
    jd_path: row.jd_path ?? null,
    size_bucket: row.size_bucket ?? null,
    score_raw: row.score_raw == null ? null : Number(row.score_raw),
    score: row.score == null ? null : Number(row.score),
    eligibility: row.eligibility ?? null,
    employment_type: row.employment_type ?? null,
    confidence: row.confidence ?? null,
    flags: normalizeArray(row.flags),
    free_text_fields: Array.isArray(row.free_text_fields) ? row.free_text_fields : (row.free_text_fields ?? []),
    upload_fields: row.upload_fields ?? null,
    ksc_criteria: row.ksc_criteria ?? null,
    cover_letter_required: !!row.cover_letter_required,
    requirements_snippet: row.requirements_snippet ?? null,
    status: row.status,
    created_at: row.created_at ?? null,
    scored_at: row.scored_at ?? null,
    prepared_at: row.prepared_at ?? null,
    prefilled_at: row.prefilled_at ?? null,
    filled_at: row.filled_at ?? null,
  };
}

export function splitRoleForPersistence(role) {
  const cloud = {};
  const local = {};

  for (const [key, value] of Object.entries(role)) {
    if (value === undefined) continue;
    if (CLOUD_ROLE_FIELDS.has(key)) {
      cloud[key] = value;
    } else {
      // Default-local guard: unclassified fields never go to Supabase.
      local[key] = value;
    }
  }

  cloud.source = inferSource(cloud);
  cloud.flags = normalizeArray(cloud.flags);
  cloud.free_text_fields = Array.isArray(cloud.free_text_fields) ? cloud.free_text_fields : [];
  cloud.cover_letter_required = !!cloud.cover_letter_required;
  cloud.status = cloud.status ?? 'new';
  cloud.ats = cloud.ats ?? 'custom';

  return { cloud, local };
}

export function seenRowForDoneRole(role) {
  if (!DONE_STATUSES.has(role.status)) return null;
  return {
    url: role.url,
    company: role.company ?? null,
    title: role.title ?? null,
    final_status: role.status,
    first_seen: dateOnly(role.created_at),
    decided_at: role.decided_at ?? new Date().toISOString(),
  };
}

export function splitQueueForPersistence(queue, options = {}) {
  const active = [];
  const seen = [];
  const localRoles = {};

  for (const role of queue.roles ?? []) {
    const { cloud, local } = splitRoleForPersistence(role);

    if (role.id && Object.keys(local).length > 0) {
      localRoles[role.id] = local;
    }

    if (ACTIVE_STATUSES.has(role.status)) {
      active.push(cloud);
      continue;
    }

    const seenRow = seenRowForDoneRole(role);
    if (seenRow) seen.push(seenRow);
  }

  for (const row of options.extraSeen ?? []) {
    if (row?.url && row?.final_status) seen.push(row);
  }

  return {
    active,
    seen,
    sidecar: {
      version: 1,
      settings: queue.settings ?? {},
      roles: localRoles,
    },
  };
}

export function mergeCloudAndLocal(activeRows, sidecar) {
  const normalizedSidecar = normalizeSidecar(sidecar);
  const roles = activeRows.map((row) => {
    const cloud = normalizeCloudRole(row);
    const local = normalizedSidecar.roles?.[cloud.id] ?? {};
    return {
      ...cloud,
      decided_at: local.decided_at ?? null,
      ...local,
    };
  });

  return {
    version: 1,
    settings: {
      ...normalizedSidecar.settings,
      score_threshold: normalizedSidecar.settings?.score_threshold ?? null,
      auto_fill_all: normalizedSidecar.settings?.auto_fill_all ?? false,
      updated_at: normalizedSidecar.settings?.updated_at ?? null,
    },
    roles,
  };
}

function loadFromSupabase() {
  const client = createSupabaseClient('dashboard');
  const rows = client.selectSync('active_roles', {
    select: '*',
    query: { order: 'score.desc.nullslast,created_at.asc' },
  });
  const queue = mergeCloudAndLocal(rows ?? [], loadSidecar());
  saveShadowQueue(queue);
  return queue;
}

// -- Backend selection ---------------------------------------------------------

function profileQueueBackend() {
  const path = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(path)) return null;
  try {
    // js-yaml v4: yaml.load() uses DEFAULT_SCHEMA — no arbitrary constructors.
    const profile = yaml.load(readFileSync(path, 'utf-8')) ?? {};
    const backend = profile?.queue?.backend;
    if (backend == null || backend === '') return null;
    if (backend !== 'local' && backend !== 'supabase') {
      throw new Error(`queue.backend must be local or supabase, got '${backend}'`);
    }
    return backend;
  } catch (err) {
    throw new Error(`Cannot resolve queue backend from config/profile.yml: ${err.message}`);
  }
}

/**
 * Pure resolver (overridable for tests): which backend should queue I/O use?
 *   1. CAREER_OPS_QUEUE_BACKEND env var ('local' | 'supabase')
 *   2. config/profile.yml → queue.backend  — the durable per-user pin
 *   3. auto: 'supabase' when its env is configured, else 'local'
 *
 * A user who runs the cloud store should PIN 'supabase' in their profile: with
 * the pin, a broken/missing Supabase env keeps the current fail-loud behavior
 * (read-only shadow + write refusal) instead of silently writing to a local
 * file that would fork the queue state away from the cloud copy.
 */
export function resolveQueueBackend({
  env = process.env,
  profileBackend = profileQueueBackend(),
  supabaseConfigured = isSupabaseConfigured('dashboard'),
} = {}) {
  const envBackend = env.CAREER_OPS_QUEUE_BACKEND;
  if (envBackend === 'local' || envBackend === 'supabase') return envBackend;
  if (profileBackend) return profileBackend;
  return supabaseConfigured ? 'supabase' : 'local';
}

// Resolved once per process: backend flips (env/profile edits) take effect on
// restart, never mid-run — a mid-run flip could split one logical save across
// two stores.
let cachedBackend = null;
export function queueBackend() {
  if (cachedBackend === null) cachedBackend = resolveQueueBackend();
  return cachedBackend;
}

// -- Load / Save --------------------------------------------------------------

export function loadQueue() {
  if (queueBackend() === 'local') {
    const queue = validateQueueShape(loadShadowQueue() ?? EMPTY_QUEUE());
    queue.settings.store_backend = 'local';
    // A queue file inherited from a supabase-mirror era may carry a stale
    // read-only warning — it does not apply to the local backend.
    delete queue.settings.store_warning;
    return queue;
  }

  if (!isSupabaseConfigured('dashboard')) {
    const shadow = loadShadowQueue();
    if (shadow) {
      validateQueueShape(shadow, 'apply queue shadow');
      shadow.settings.store_backend = 'local-shadow';
      shadow.settings.store_warning = 'Supabase env is not configured; writes will fail until SUPABASE_URL and SUPABASE_DASHBOARD_KEY are set.';
      return shadow;
    }
    return EMPTY_QUEUE();
  }

  try {
    return loadFromSupabase();
  } catch (err) {
    const shadow = loadShadowQueue();
    if (!shadow) throw err;
    validateQueueShape(shadow, 'apply queue shadow');
    shadow.settings.store_backend = 'supabase-shadow';
    shadow.settings.store_warning = `Supabase unavailable; read-only local shadow returned: ${err.message}`;
    console.warn(`WARN: ${shadow.settings.store_warning}`);
    return shadow;
  }
}

export function saveQueue(queue, options = {}) {
  const beforeTransitions = options[SAVE_TRANSITION_CONTEXT] instanceof Map
    ? options[SAVE_TRANSITION_CONTEXT]
    : persistedTransitionSnapshot();
  validateReceiptProtectedTransitions(beforeTransitions, queue);
  if (queueBackend() === 'local') {
    queue.settings = queue.settings ?? {};
    queue.settings.updated_at = new Date().toISOString();
    queue.settings.store_backend = 'local';
    // Whole queue in one atomic file write — done roles stay in the file (the
    // tracker remains the durable applied/closed record; keeping them here
    // also keeps buildQueueSeenSets dedup working with zero cloud calls).
    saveShadowQueue(queue);
    return;
  }

  if (!isSupabaseConfigured('dashboard')) {
    throw new Error('Supabase env is not configured; refusing local-only write without replay support');
  }

  queue.settings = queue.settings ?? {};
  queue.settings.updated_at = new Date().toISOString();

  const existingSidecar = loadSidecar();
  const split = splitQueueForPersistence(queue, options);
  const client = createSupabaseClient('dashboard');
  const nextSidecar = {
    version: 1,
    settings: split.sidecar.settings,
    roles: {
      ...existingSidecar.roles,
      ...split.sidecar.roles,
    },
  };

  // Local-only application evidence is part of the same logical queue commit.
  // Persist it BEFORE advancing the cloud status so Supabase can never
  // acknowledge receipt-gated `filled`/`submitted` while the page ledger,
  // application request, or candidate-decision transaction exists only in
  // memory. If the cloud RPC fails, restore the prior sidecar as compensation.
  saveSidecar(nextSidecar);
  try {
    client.rpcSync('save_queue', {
      active_payload: split.active,
      seen_payload: split.seen,
    });
  } catch (err) {
    try {
      saveSidecar(existingSidecar);
    } catch (rollbackErr) {
      throw new Error(
        `${err.message}; local sidecar rollback also failed: ${rollbackErr.message}`,
      );
    }
    throw err;
  }

  // The authoritative cloud rows and their required local evidence are now
  // durable. The whole-queue shadow is only a read fallback/cache; a failure to
  // refresh it must be loud but must not misreport the committed transaction.
  try {
    saveShadowQueue(queue);
  } catch (err) {
    console.warn(
      `WARN: Supabase and local evidence committed but queue shadow refresh failed (${err.message}). ` +
      'The next successful load/save will rebuild the fallback shadow.'
    );
  }
}

/**
 * Serialize a fresh load -> mutation -> save transaction across local agent
 * processes. Callers that may run concurrently must use this helper instead of
 * saving a queue snapshot loaded before another worker's update.
 *
 * The callback must be synchronous. Its return value is passed back after the
 * queue commit succeeds.
 */
export function mutateQueue(mutator, { timeoutMs = 15_000, saveOptions = {} } = {}) {
  if (typeof mutator !== 'function') throw new Error('mutateQueue requires a callback');
  return withQueueLock(() => {
    const queue = loadQueue();
    const beforeTransitions = queueTransitionSnapshot(queue);
    const result = mutator(queue);
    if (result && typeof result.then === 'function') {
      throw new Error('mutateQueue callback must be synchronous');
    }
    // Validate before persistence without consuming the setStatus capability;
    // saveQueue() consumes it at the actual write boundary.  Supplying the
    // private before-state avoids a second, racy disk/cloud snapshot.
    validateReceiptProtectedTransitions(beforeTransitions, queue, { consumeAuthorization: false });
    const guardedSaveOptions = { ...saveOptions };
    Object.defineProperty(guardedSaveOptions, SAVE_TRANSITION_CONTEXT, {
      value: beforeTransitions,
      enumerable: false,
    });
    saveQueue(queue, guardedSaveOptions);
    return result;
  }, timeoutMs);
}

// -- Stage computation: pure function, no I/O ---------------------------------

/**
 * Kanban pipeline stage for the dashboard board view.
 * Maps role.status onto board columns:
 *   'inbox'    — scored, not yet selected      (status: scored)
 *   'todo'     — explicitly selected, waiting for PREPARE (status: prepare-queued;
 *                the dashboard threshold is a filter/setting and never selects)
 *   'prepared' — CV + cover letter + drafts ready (status: prepared)
 *   'review'   — lean review-ready prefilled, legacy incomplete checkpoint, or
 *                receipt-gated filled (status: prefilled | filled; the badge
 *                and execution_protocol distinguish them)
 *   'done'     — terminal (submitted / skipped / reviewed / closed)
 *   null       — not on the board ('new' roles are a counter, not a card)
 *
 * Orthogonal to computeLane(): stage answers "where in the pipeline is this?",
 * lane answers "how carefully must I look at it?" (shown as a badge on the card).
 */
export const STAGE_ORDER = Object.freeze(['inbox', 'todo', 'prepared', 'review', 'done']);

export function computeStage(role) {
  const status = role?.status;
  if (status === 'scored')                            return 'inbox';
  if (status === 'prepare-queued')                    return 'todo';
  if (status === 'prepared')                          return 'prepared';
  if (status === 'filled' || status === 'prefilled')  return 'review';
  if (DONE_STATUSES.has(status))                      return 'done';
  return null; // 'new' and anything unknown
}

// -- Kanban drag transitions: pure function, no I/O ---------------------------
//
// Not every column boundary on the dashboard board is a bare relabel — Prepared
// requires real asset generation (tailored CV + cover letter), In Review requires
// the active browser agent's durable per-page resolver receipts and finalizer, and
// Done requires candidate-confirmed submission. Dragging a card can only ever
// *write a new status directly* for the handful of transitions below, where
// moving the card genuinely is the whole action (select / deselect / send a
// prepared or legacy-prefilled row back to the PREPARE queue). Receipt-gated
// `filled` is deliberately immutable here: valid evidence remains review-ready;
// corrupt historical evidence must use application-receipt.mjs --repair-filled.
// Forward moves into 'prepared', 'review', or 'done' are never produced here —
// those states come from asset preparation, the canonical application-receipt
// finalizer, or the candidate-confirmed decision path.
const STAGE_DRAG_TARGETS = {
  todo: {
    scored:    'prepare-queued', // Inbox → To Do: select for prepare
    prepared:  'prepare-queued', // Prepared → To Do: un-prepare / send back for redo
    prefilled: 'prepare-queued', // Legacy In Review → To Do: restart through PREPARE
  },
  inbox: {
    'prepare-queued': 'scored',  // To Do → Inbox: deselect
  },
};

// The only stages a drag may legally target — derived from the table above so
// the server's input validation can never drift from the transition rules.
export const DRAG_TARGET_STAGES = Object.freeze(Object.keys(STAGE_DRAG_TARGETS));

/**
 * Returns the new status if dragging `role` onto `targetStage` (one of
 * DRAG_TARGET_STAGES) is a legal bare status flip, or null if the drop must be
 * rejected (either because it needs a real action — Prepared/In Review/Done —
 * or isn't a recognized transition at all).
 */
export function stageDragTarget(role, targetStage) {
  return STAGE_DRAG_TARGETS[targetStage]?.[role?.status] ?? null;
}

// -- Lane computation: pure function, no I/O ---------------------------------

/**
 * Returns 'ready' | 'needs-input' | 'review-carefully' | null.
 * null = not yet scored or already decided; not in any active lane.
 */
export function computeLane(role) {
  if (!LANE_STATUSES.has(role.status)) return null;
  if (role.score == null) return null; // not scored yet

  // review-carefully: eligibility issue, ambiguous employment type, or low confidence
  if (
    role.eligibility !== 'ok' ||
    role.employment_type === 'ambiguous' ||
    role.confidence === 'low'
  ) {
    return 'review-carefully';
  }

  // needs-input: a legacy prefill needs active-agent L3, or a review flag exists
  if (Array.isArray(role.flags) && (
    role.flags.includes('agent-l3-required') ||
    role.flags.includes('canonical-apply-receipt-required') ||
    role.flags.includes('manual-field') || // backward compatibility
    role.flags.includes('knockout-flag')
  )) {
    return 'needs-input';
  }
  if (Array.isArray(role.free_text_fields) && role.free_text_fields.some(f => f.kind === 'custom')) {
    return 'needs-input';
  }

  // ready: eligible, confident, and all fields are either standard (drafted in prepare) or absent
  return 'ready';
}

// -- Record helpers -----------------------------------------------------------

export function getById(queue, id) {
  return queue.roles.find(r => r.id === id) ?? null;
}

export function updateById(queue, id, patches) {
  if (patches && Object.prototype.hasOwnProperty.call(patches, 'status')) {
    throw new Error('updateById cannot change status; use queue-store.setStatus so protected transitions are validated');
  }
  const idx = queue.roles.findIndex(r => r.id === id);
  if (idx === -1) return false;
  queue.roles[idx] = { ...queue.roles[idx], ...patches };
  return true;
}

export function setStatus(queue, id, status) {
  const role = getById(queue, id);
  if (!role) return false;
  const previousStatus = role.status;
  if (status === 'filled') {
    const error = finalizedApplicationReceiptError(role, 'filled');
    if (error) {
      throw new Error(
        'status filled requires a finalized review-ready application receipt: ' + error.message,
      );
    }
  }
  if (status === 'submitted') {
    const manualError = manualSubmissionProvenanceError(role);
    if (manualError === null) {
      // Candidate manual-submission provenance authorizes submitted from any
      // active status: the candidate personally performed the portal
      // submission, so no receipt-gated filled state exists to demand.
      if (!ACTIVE_STATUSES.has(role.status) && role.status !== 'submitted') {
        throw new Error(`status submitted with manual provenance requires an active role, not ${role.status}`);
      }
    } else {
      if (role.status !== 'filled' && role.status !== 'submitted') {
        throw new Error(
          `status submitted requires prior receipt-gated filled state or candidate ` +
          `manual-submission provenance (${manualError}), not ${role.status}`,
        );
      }
      const error = finalizedApplicationReceiptError(role, 'submitted');
      if (error) {
        throw new Error(
          'status submitted requires candidate-confirmed receipt/report provenance: ' + error.message,
        );
      }
    }
  }
  const patches = { status };
  const tsField = STATUS_TIMESTAMP[status];
  if (tsField) patches[tsField] = new Date().toISOString();
  Object.assign(role, patches);
  Object.defineProperty(role, STATUS_TRANSITION_AUTH, {
    value: { from: previousStatus, to: status },
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return true;
}

/** Record the candidate's explicit decision to continue below their quality floor. */
export function recordCandidateSelectionOverride(role, minimumScore, source = 'dashboard') {
  if (!role || !Number.isFinite(role.score) || role.score >= minimumScore) return false;
  if (role.user_override?.approved === true) return false;
  role.user_override = {
    approved: true,
    approved_at: new Date().toISOString(),
    source,
    reason: `Candidate explicitly selected this role despite its ${role.score}/5 fit score. The override does not change the score or recommendation.`,
  };
  return true;
}

/** Append a new role stub. Returns false (and does nothing) if the ID already exists. */
export function appendRole(queue, role) {
  if (queue.roles.some(r => r.id === role.id)) return false;
  const now = new Date().toISOString();
  queue.roles.push({
    scored_at: null,
    prepared_at: null,
    decided_at: null,
    ...role,
    source: inferSource(role),
    created_at: role.created_at ?? now,
  });
  return true;
}

// -- Dedup helpers ------------------------------------------------------------

/** Build Sets of IDs, URLs, and company::title pairs already in the queue. */
export function buildQueueSeenSets(queue) {
  const ids          = new Set();
  const urls         = new Set();
  const companyRoles = new Set();
  for (const r of queue.roles) {
    if (r.id) ids.add(r.id);
    if (r.url) urls.add(r.url);
    if (r.company && r.title) {
      companyRoles.add(`${r.company.toLowerCase()}::${r.title.toLowerCase()}`);
    }
  }
  return { ids, urls, companyRoles };
}

export function loadQueueSeenSets(queue = loadQueue(), { role = 'dashboard' } = {}) {
  const sets = buildQueueSeenSets(queue);
  // Cloud dedup rows only apply when the cloud is in play: the cron path checks
  // its own credentials (it always targets Supabase and ignores the local
  // backend pin), while the dashboard path skips cloud reads entirely on the
  // local backend — the local queue file already holds every seen role.
  const useSupabase = role === 'cron'
    ? isSupabaseConfigured('cron')
    : queueBackend() === 'supabase' && isSupabaseConfigured(role);
  if (!useSupabase) return sets;

  const client = createSupabaseClient(role);
  const { ids, urls, companyRoles } = sets;
  const add = (row) => {
    if (row.id) ids.add(row.id);
    if (row.url) urls.add(row.url);
    if (row.company && row.title) {
      companyRoles.add(`${row.company.toLowerCase()}::${row.title.toLowerCase()}`);
    }
  };

  for (const row of client.selectSync('active_roles', { select: 'id,url,company,title' }) ?? []) {
    add(row);
  }
  for (const row of client.selectSync('seen_urls', { select: 'url,company,title' }) ?? []) {
    add(row);
  }
  return sets;
}

/**
 * Insert status='new' stubs via the cron credential (RLS-bounded direct REST).
 * Does NOT call save_queue, does NOT write sidecar or shadow JSON.
 * The cron role has no UPDATE grant and no execute on save_queue.
 *
 * @param {object[]} stubs — array of role objects (built by queue-ingest --cron)
 * @returns {{ inserted: number, skipped: number }}
 */
export async function insertNewStubsCron(stubs) {
  const client = createSupabaseClient('cron');
  const rows = [];
  let skipped = 0;

  for (const stub of stubs) {
    const { cloud } = splitRoleForPersistence(stub);
    // Hard-guard: defence in depth above RLS — only insert status='new'
    if (cloud.status !== 'new') {
      console.warn(`insertNewStubsCron: skipping stub with status='${cloud.status}' (${cloud.url})`);
      skipped++;
      continue;
    }
    rows.push(cloud);
  }

  if (rows.length === 0) return { attempted: 0, inserted: 0, skipped };

  // ON CONFLICT (url) DO NOTHING via PostgREST resolution header.
  // return=representation gives back only the rows actually inserted (duplicates
  // are dropped silently), so resp.length is a true inserted count.
  const resp = client.requestSync('POST', 'active_roles', {
    query: { on_conflict: 'url' },
    body: rows,
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
  });
  const inserted = Array.isArray(resp) ? resp.length : 0;

  return { attempted: rows.length, inserted, skipped };
}

// ── Cron eviction seam ────────────────────────────────────────────────────────

/**
 * App-logic guard for cron eviction — independent of RLS.
 * Only status='new' rows with a STRONG expired HTTP signal are evicted.
 * 'uncertain' (including insufficient_content, bot_challenge, fetch_error)
 * and 'active' are always kept to avoid losing live SPA postings that look
 * empty over plain HTTP.
 *
 * Invariant: only evict verdicts that classifyLiveness() decides BEFORE the
 * hasApplyControl(applyControls) gate (liveness-core.mjs:100). The HTTP path
 * omits applyControls, so any code decided after that gate (listing_page,
 * insufficient_content, no_apply_control) is unreliable — a live board/search
 * page with a visible Apply button would show 'active' in the browser but
 * 'listing_page' over HTTP, causing a false eviction and permanent seen_urls
 * lockout. Strong (pre-gate) codes: http_gone, expired_url, expired_body.
 *
 * Exported so regression tests can prove the guard independently of RLS/network.
 *
 * @param {{ status: string }|null} row
 * @param {{ result: string, code: string }|null} verdict
 * @returns {boolean}
 */
export function shouldEvict(row, verdict) {
  return row?.status === 'new'
    && verdict?.result === 'expired'
    && HTTP_EVICT_CODES.has(verdict?.code);
}

const HTTP_EVICT_CODES = new Set(['http_gone', 'expired_url', 'expired_body']);

/**
 * HTTP-liveness re-check of status='new' rows via the cron credential.
 * Deletes expired stubs and records them in seen_urls(final_status='expired')
 * so they are never re-inserted by the scanner. Mirrors insertNewStubsCron:
 * same credential wiring, same direct-REST pattern, no save_queue RPC.
 *
 * Eviction is conservative by design: only strong expired signals trigger a
 * delete (see shouldEvict). 'uncertain' and 'active' verdicts always keep the row.
 *
 * Write ordering: DELETE first, seen_urls only on confirmed delete.
 * If the DELETE returns 0 rows (status advanced between SELECT and DELETE),
 * seen_urls is NOT written — avoids permanently marking an active URL as expired.
 *
 * @param {{ check?: Function, dryRun?: boolean }} opts
 *   check   — injectable liveness function (url) → {result,code,reason}.
 *             Defaults to checkUrlLivenessHttp. Override in tests.
 *   dryRun  — when true, log would-be evictions but write/delete nothing.
 * @returns {Promise<{ checked: number, evicted: number, kept: number, errors: number, dryRun: boolean }>}
 */
export async function evictExpiredNewStubsCron({ check, dryRun = false } = {}) {
  const live = check ?? checkUrlLivenessHttp;
  const client = createSupabaseClient('cron');

  // SELECT only status='new' rows — the cron's eviction scope.
  const rows = client.selectSync('active_roles', {
    select: 'id,url,company,title,created_at,status',
    query: { status: 'eq.new' },
  }) ?? [];

  let checked = 0, evicted = 0, kept = 0, errors = 0;

  for (const row of rows) {
    if (!row.url) { kept++; continue; }
    checked++;

    let verdict;
    try {
      verdict = await live(row.url);
    } catch (e) {
      errors++;
      console.warn(`evictExpiredNewStubsCron: liveness threw for ${row.url}: ${e.message}`);
      continue;
    }

    if (!shouldEvict(row, verdict)) {
      kept++;
      continue;
    }

    if (dryRun) {
      evicted++;
      console.log(`  WOULD evict: ${row.url}  (${verdict.code})`);
      continue;
    }

    try {
      // Hard-guard: status=eq.new on the DELETE — defence in depth above RLS.
      // If the row has advanced past 'new' since our SELECT (race), the DELETE
      // returns 0 rows and we skip the seen_urls write to avoid a false-expired
      // dedup entry for a URL the human pipeline is actively working on.
      const resp = client.requestSync('DELETE', 'active_roles', {
        query: { id: `eq.${row.id}`, status: 'eq.new' },
        headers: { Prefer: 'return=representation' },
      });
      if ((Array.isArray(resp) ? resp.length : 0) === 0) {
        // Row was already gone or status advanced — skip seen_urls safely.
        kept++;
        continue;
      }

      // Row confirmed deleted. Record in seen_urls so it is never re-inserted.
      // ON CONFLICT (url) DO NOTHING — cron has no UPDATE grant on seen_urls.
      // decided_at left unset (NULL) per architecture doc §3.4.
      client.requestSync('POST', 'seen_urls', {
        query: { on_conflict: 'url' },
        body: [{
          url:          row.url,
          company:      row.company ?? null,
          title:        row.title ?? null,
          final_status: 'expired',
          first_seen:   dateOnly(row.created_at),
        }],
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      });
      evicted++;
    } catch (e) {
      errors++;
      console.warn(`evictExpiredNewStubsCron: failed to evict ${row.url}: ${e.message}`);
    }
  }

  return { checked, evicted, kept, errors, dryRun };
}

// -- Board stats helper (used by server + SPA) --------------------------------
// Risk lanes (ready / needs-input / review-carefully) became per-card badges
// when the kanban board replaced the 3-lane view, so their aggregates are gone
// from the stats payload — computeLane() itself still powers the badges.

export function computeStats(queue) {
  let newCount = 0, doneCount = 0;
  let inbox = 0, todo = 0, prepared = 0, review = 0;
  let scoreSum = 0, scoreCount = 0;

  for (const role of queue.roles) {
    if (role.status === 'new') { newCount++; continue; }
    if (DONE_STATUSES.has(role.status)) { doneCount++; continue; }
    const stage = computeStage(role);
    if (stage === 'inbox')         inbox++;
    else if (stage === 'todo')     todo++;
    else if (stage === 'prepared') prepared++;
    else if (stage === 'review')   review++;
    if (role.score != null) { scoreSum += role.score; scoreCount++; }
  }

  const avgScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null;
  return {
    newCount, doneCount, avgScore,
    inbox, todo, prepared, review,
  };
}
