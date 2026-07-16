#!/usr/bin/env node

/**
 * set-status.mjs — canonical CLI to update an existing tracker row (#1428).
 *
 * data/applications.md is a shared surface with multiple readers and writers.
 * One canonical write path is safer than N agents hand-editing markdown, so
 * modes (apply Step 9, followup, batch) call this instead of editing the table.
 *
 * Usage:
 *   node set-status.mjs <tracker#|company> [<state>] [--note "..."] [--role "..."] [--report <path-or-url>] [--company "..."] [--pdf-ready] [--receipt <id> | --external] [--dry-run] [--json]
 *
 * Row resolution:
 *   - numeric argument → exact match on the # column
 *   - otherwise → company match (normalized, same key as merge-tracker dedup);
 *     multiple hits are narrowed with --role (fuzzy, role-matcher.mjs), and
 *     anything still ambiguous fails with a numbered candidate list.
 *
 * State validation is strict against templates/states.yml (labels, ids, and
 * aliases resolve to the canonical label; anything else is rejected before the
 * tracker is touched). --note appends to the Notes cell with "; " and is
 * idempotent — re-running the same command is always safe.
 *
 * The read-modify-write runs under the shared tracker lock (tracker-utils.mjs,
 * same lock as merge-tracker.mjs) and the file is replaced atomically. Only the
 * explicitly requested cells of the matched row change; every other cell
 * round-trips untouched. Metadata-only company reveal and PDF-ready writes
 * require the exact numeric tracker # and preserve lifecycle state and
 * provenance byte-for-byte.
 *
 * Exit codes: 0 success (including no-op re-runs) · 1 usage error,
 * non-canonical state, unreadable states.yml, or non-retryable lock/write failure ·
 * 2 row not found or unreadable tracker · 3 ambiguous company match ·
 * 4 tracker lock timeout (busy — retry later).
 *
 * When the new status is Applied, the JSON output carries
 * `"followupSeedCandidate": true` — the hook point for seeding
 * data/follow-ups.md with the default cadence (#1430, not implemented here).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { loadQueue } from './queue-store.mjs';
import { reviewReadinessErrors, submissionReadinessErrors } from './application-receipt.mjs';
import {
  rebuildRow, resolveTrackerPath, trackerLockDirFor, acquireTrackerLock,
  writeFileAtomic, loadCanonicalStates, resolveCanonicalState, normalizeCompany, cell,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_AMBIGUOUS = 3;
const EXIT_LOCK_TIMEOUT = 4;

const USAGE = `Usage: node set-status.mjs <tracker#|company> [<state>] [--note "..."] [--role "..."] [--report <path-or-url>] [--company "..."] [--pdf-ready] [--receipt <id> | --external] [--dry-run] [--json]

  <tracker#|company> Row selector: tracker # (exact) or company name (normalized match)
  <state>            Optional canonical state from templates/states.yml (aliases accepted)
  --note "..."       Append to the Notes cell ("; "-separated, idempotent)
  --role "..."       Disambiguate when several rows share the company (fuzzy match)
  --report <value>    Disambiguate by the Report cell's exact local path or job URL
  --company "..."    Reveal a ? Company cell on an exact numeric tracker # (one-way, idempotent)
  --pdf-ready        Mark PDF ✅ on an exact numeric tracker # (monotonic, idempotent)
  --receipt <id>      Verify and record the exact finalized queue receipt (Applied only; requires --role and --report)
  --external         Confirm an application/progression happened outside the canonical live-application receipt flow
  --dry-run          Resolve and validate, but write nothing
  --json             Machine-readable output on stdout (errors included)`;

// ── argument parsing ─────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = {
  note: null,
  role: null,
  report: null,
  company: null,
  pdfReady: false,
  receipt: null,
  external: false,
  dryRun: false,
  json: false,
};

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--note' || a === '--role' || a === '--report' || a === '--company' || a === '--receipt') {
    // Never consume a following flag as the value: "--note --dry-run" would
    // silently disable dry-run and turn a preview into a real write.
    const value = rawArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      failUsage(`Missing value for ${a}`);
    }
    flags[
      a === '--note' ? 'note'
        : a === '--role' ? 'role'
          : a === '--report' ? 'report'
            : a === '--company' ? 'company'
              : 'receipt'
    ] = value;
    i++;
  }
  else if (a === '--pdf-ready') { flags.pdfReady = true; }
  else if (a === '--external') { flags.external = true; }
  else if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (positional.length < 1 || positional.length > 2) {
  failUsage(positional.length === 0 ? null : `Expected a selector and at most one state, got ${positional.length} positional arguments`);
}

if (flags.external && flags.receipt) {
  failUsage('--receipt and --external are mutually exclusive provenance modes');
}
if (flags.receipt && (!/^[^\s|\[\]\r\n]{1,512}$/.test(flags.receipt))) {
  failUsage('--receipt must be a 1-512 character opaque identifier without whitespace, pipes, or brackets');
}

const [selector, stateInput = null] = positional;
const hasMutation = stateInput != null || flags.note != null || flags.company != null || flags.pdfReady;
if (!hasMutation) {
  failUsage('Provide a state, --note, --company, or --pdf-ready');
}
if ((flags.company != null || flags.pdfReady) && !/^\d+$/.test(selector)) {
  failUsage('--company and --pdf-ready require the exact numeric tracker # selector');
}
if (stateInput == null && (flags.external || flags.receipt)) {
  failUsage('--external and --receipt only apply when an explicit state is supplied');
}
if (flags.company != null) {
  const rawCompany = String(flags.company).trim();
  if (!rawCompany || rawCompany === '?' || rawCompany === '—' || rawCompany === '-' || /[|\r\n]/.test(rawCompany)) {
    failUsage('--company requires a real single-line company name without pipes');
  }
  flags.company = cell(rawCompany);
}

/**
 * Emit a structured error and exit.
 *
 * With --json the error object goes to stdout so callers parse one stream; the
 * human-readable message always goes to stderr.
 *
 * @param {number} exitCode - Process exit code (see EXIT_* contract above).
 * @param {string} code - Stable machine-readable error code.
 * @param {string} message - Human-readable explanation.
 * @param {object} [extra] - Extra JSON fields (e.g. candidates).
 * @returns {never}
 */
function failWith(exitCode, code, message, extra = {}) {
  if (flags.json) {
    console.log(JSON.stringify({ error: message, code, ...extra }));
  }
  console.error(`❌ ${message}`);
  process.exit(exitCode);
}

/**
 * Print usage (plus an optional specific complaint) and exit 1.
 *
 * With --json a structured usage-error payload goes to stdout (same shape as
 * failWith) so machine callers always parse one stream. failUsage can fire
 * mid-argv-parse — before flags.json is settled — so JSON mode is detected
 * from the raw argv directly.
 *
 * @param {string|null} message - What was wrong with the invocation, if known.
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Expected <tracker#|company> plus a state or metadata mutation';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

// ── state validation (before anything touches the tracker) ──────

let requestedStatus = null;
if (stateInput != null) {
  let states;
  try {
    states = loadCanonicalStates(STATES_FILE);
  } catch (err) {
    failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
  }
  requestedStatus = resolveCanonicalState(stateInput, states);
  if (!requestedStatus) {
    const valid = states.map(s => s.label).join(' · ');
    failWith(EXIT_USAGE, 'invalid-state', `"${stateInput}" is not a canonical state. Valid states: ${valid}`);
  }
}
if (flags.receipt && requestedStatus !== 'Applied') {
  failUsage('--receipt is valid only for the canonical Applied transition');
}
if (flags.receipt && (!flags.role || !flags.report)) {
  failUsage('--receipt requires both --role and --report to bind one exact queue role and tracker row');
}
if (flags.receipt && (flags.company != null || flags.pdfReady)) {
  failUsage('--receipt cannot be combined with --company or --pdf-ready metadata mutations');
}

// ── tracker access ───────────────────────────────────────────────

const APPS_FILE = resolveTrackerPath(CAREER_OPS);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

function reportTarget(value) {
  const raw = String(value ?? '').trim();
  const markdown = /\]\(([^)]+)\)/.exec(raw)?.[1]?.trim();
  return markdown || raw;
}

function normalizeReportIdentity(value, { fromTracker = false } = {}) {
  const target = reportTarget(value);
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      url.protocol = url.protocol.toLowerCase();
      url.hostname = url.hostname.toLowerCase();
      url.hash = '';
      return `url:${url.toString()}`;
    } catch {
      return `url:${target}`;
    }
  }
  const absolute = isAbsolute(target)
    ? resolvePath(target)
    : resolvePath(fromTracker ? dirname(APPS_FILE) : CAREER_OPS, target);
  return `file:${absolute}`;
}

function canonicalTrackerText(value) {
  return cell(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Verify that --receipt names the one finalized queue role bound to this exact
 * tracker row. The dashboard promotes the Application Answers report to
 * `submitted` before invoking this process, while the persisted queue role may
 * still be `filled` until the dashboard's outer queue transaction commits.
 */
function verifyCanonicalApplicationReceipt(target) {
  let queue;
  try {
    queue = loadQueue();
  } catch (err) {
    failWith(EXIT_USAGE, 'receipt-load-failure', `Cannot load the apply queue to verify --receipt: ${err.message}`);
  }
  if (/shadow$/.test(String(queue?.settings?.store_backend ?? ''))) {
    failWith(
      EXIT_USAGE,
      'receipt-queue-not-authoritative',
      'Cannot verify --receipt from a read-only queue shadow; restore the configured queue backend and retry',
    );
  }
  const matches = (queue?.roles ?? []).filter(
    (role) => role?.application_progress?.receipt_id === flags.receipt,
  );
  if (matches.length === 0) {
    failWith(EXIT_USAGE, 'receipt-not-found', `No queue role has finalized receipt "${flags.receipt}"`);
  }
  if (matches.length !== 1) {
    failWith(EXIT_USAGE, 'receipt-ambiguous', `Receipt "${flags.receipt}" is duplicated across ${matches.length} queue roles`);
  }

  const role = matches[0];
  const progress = role.application_progress ?? {};
  const request = role.application_request ?? {};
  const mismatches = [];
  if (progress.handover_receipt_id !== flags.receipt || request.receipt_id !== flags.receipt) {
    mismatches.push('receipt is not stable across application progress, handover, and application_request');
  }
  if (progress.review_ready !== true || !progress.finalized_at) {
    mismatches.push('queue receipt is not finalized review-ready evidence');
  }
  if (role.status !== 'filled' && role.status !== 'submitted') {
    mismatches.push(`queue role status is ${role.status ?? 'missing'}, not filled/submitted`);
  }

  const expectedCompany = canonicalTrackerText(target.company);
  const expectedRole = canonicalTrackerText(target.role);
  if (canonicalTrackerText(role.company) !== expectedCompany) {
    mismatches.push('queue company does not match the exact tracker row');
  }
  if (canonicalTrackerText(role.title) !== expectedRole) {
    mismatches.push('queue role does not match the exact tracker row');
  }
  if (canonicalTrackerText(flags.role) !== expectedRole || canonicalTrackerText(flags.role) !== canonicalTrackerText(role.title)) {
    mismatches.push('--role does not exactly bind the tracker and queue role');
  }

  const trackerReport = normalizeReportIdentity(target.report, { fromTracker: true });
  const requestedReport = normalizeReportIdentity(flags.report);
  const queueReport = normalizeReportIdentity(progress.application_answers_report);
  if (!trackerReport || !requestedReport || !queueReport ||
      trackerReport !== requestedReport || requestedReport !== queueReport) {
    mismatches.push('--report does not exactly bind the tracker row and receipt report');
  }
  if (mismatches.length) {
    failWith(EXIT_USAGE, 'receipt-mismatch', `Receipt verification failed: ${mismatches.join('; ')}`);
  }

  // submissionReadinessErrors performs the public candidate-confirmation gate;
  // the explicit submitted-state pass prevents a still-`filled` report from
  // being accepted merely because that helper also supports pre-promotion use.
  const readinessErrors = [
    ...submissionReadinessErrors(role),
    ...reviewReadinessErrors(role, { expectedReportState: 'submitted' }),
  ];
  if (readinessErrors.length) {
    failWith(
      EXIT_USAGE,
      'receipt-not-ready',
      `Receipt "${flags.receipt}" is not valid submitted application evidence: ${[...new Set(readinessErrors)].join(' | ')}`,
    );
  }
  return role;
}

/**
 * Find the tracker row matching the CLI selector.
 *
 * @param {object[]} rows - Parsed data rows (parseTrackerRow output + lineIdx).
 * @returns {object} The single matched row. Exits the process on 0 or 2+ matches.
 */
function resolveRow(rows) {
  if (/^\d+$/.test(selector)) {
    const num = parseInt(selector, 10);
    const row = rows.find(r => r.num === num);
    if (!row) {
      failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row with #${num}`);
    }
    return row;
  }

  const key = normalizeCompany(selector);
  if (!key) failUsage(`Selector "${selector}" is empty after normalization`);
  let matches = rows.filter(r => normalizeCompany(r.company) === key);

  if (matches.length === 0) {
    failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row with company matching "${selector}"`);
  }
  if (flags.report) {
    const wantedReport = normalizeReportIdentity(flags.report);
    const narrowed = matches.filter(r => normalizeReportIdentity(r.report, { fromTracker: true }) === wantedReport);
    if (narrowed.length === 0) {
      failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row for "${selector}" has Report matching "${flags.report}"`);
    }
    matches = narrowed;
  }
  if (matches.length > 1 && flags.role) {
    const narrowed = matches.filter(r => roleFuzzyMatch(r.role, flags.role));
    if (narrowed.length === 1) return narrowed[0];
    // Fall through with the original list so the candidates stay visible.
  }
  if (matches.length > 1) {
    const candidates = matches.map(r => ({ num: r.num, company: r.company, role: r.role }));
    const listing = candidates.map(c => `#${c.num}\t${c.company}\t${c.role}`).join('\n');
    failWith(EXIT_AMBIGUOUS, 'ambiguous',
      `Company "${selector}" matches ${matches.length} rows — pass the # or narrow with --role:\n${listing}`,
      { candidates });
  }
  return matches[0];
}

// ── locked read-modify-write ─────────────────────────────────────

// Dry-run never writes, so it must not hold the exclusive lock: a read-only
// preview should not block (or be blocked by) merge-tracker or another
// set-status writer. A stale read is acceptable for a preview.
let lock = null;
if (!flags.dryRun) {
  try {
    lock = await acquireTrackerLock(trackerLockDirFor(APPS_FILE), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
      staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
      tracker: APPS_FILE,
    });
  } catch (err) {
    // Exit 4 means "lock is busy — retry later" and must stay reserved for
    // the actual timeout. Filesystem/configuration failures (EACCES on the
    // lock dir, unwritable owner.json, …) are not retryable and fail as a
    // config error instead.
    if (err?.code === 'LOCK_TIMEOUT') {
      failWith(EXIT_LOCK_TIMEOUT, 'lock-timeout', err.message);
    }
    failWith(EXIT_USAGE, 'lock-error', `Cannot acquire tracker lock: ${err.message}`);
  }
}
// Safety net: failWith/failUsage/resolveRow call process.exit() directly and
// skip the explicit release below. release() is idempotent, so both firing
// on the happy path is fine.
if (lock) process.once('exit', () => lock.release());

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}
const lines = content.split('\n');
const colmap = resolveColumns(lines);

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row) rows.push({ ...row, lineIdx: i });
}
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${APPS_FILE} has no data rows`);
}

const target = resolveRow(rows);
const oldStatus = target.status;
const newStatus = requestedStatus ?? oldStatus;
if (flags.receipt) verifyCanonicalApplicationReceipt(target);
const progressionStates = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);
const priorApplicationStates = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired']);
if (stateInput != null && newStatus !== oldStatus && progressionStates.has(newStatus) && !priorApplicationStates.has(oldStatus) && !flags.external && !flags.receipt) {
  failWith(
    EXIT_USAGE,
    'external-confirmation-required',
    `Refusing ${oldStatus} → ${newStatus} without evidence. Canonical live applications must use the receipt-gated dashboard decision; for a genuinely external or historical application/reply, rerun with --external.`,
  );
}
const requestedNote = flags.note != null ? cell(flags.note) : null;
const provenanceMarker = flags.external
  ? '[external-status]'
  : flags.receipt
    ? `[application-receipt:${flags.receipt}]`
    : null;
const noteEntries = [requestedNote, provenanceMarker].filter(Boolean);
const note = noteEntries.join('; ') || null;

// Rebuild only the matched line. Metadata-only writes intentionally leave the
// Status and Notes cells (including lifecycle provenance) untouched.
const parts = lines[target.lineIdx].split('|').map(s => s.trim());
while (parts.length <= Math.max(colmap.status, colmap.company, colmap.pdf ?? 0, colmap.notes ?? 0)) parts.push('');

const statusChanged = parts[colmap.status] !== newStatus;
parts[colmap.status] = newStatus;

const oldCompany = parts[colmap.company] ?? '';
let companyChanged = false;
if (flags.company != null) {
  if (oldCompany !== '?' && oldCompany !== flags.company) {
    failWith(
      EXIT_USAGE,
      'company-reveal-conflict',
      `Refusing to rename Company "${oldCompany}" to "${flags.company}". --company may only reveal a ? cell; correct an erroneous non-confidential row through an explicit data migration.`,
    );
  }
  companyChanged = oldCompany !== flags.company;
  parts[colmap.company] = flags.company;
}

const oldPdf = colmap.pdf == null ? null : (parts[colmap.pdf] ?? '');
let pdfChanged = false;
if (flags.pdfReady) {
  if (colmap.pdf == null) {
    failWith(EXIT_USAGE, 'no-pdf-column', 'Tracker has no PDF column — cannot apply --pdf-ready');
  }
  pdfChanged = parts[colmap.pdf] !== '✅';
  parts[colmap.pdf] = '✅';
}

let noteChanged = false;
if (noteEntries.length > 0) {
  if (colmap.notes == null) {
    failWith(EXIT_USAGE, 'no-notes-column', 'Tracker has no Notes column — cannot apply --note');
  }
  let existing = parts[colmap.notes] ?? '';
  for (const entry of noteEntries) {
    // Delimiter-aware idempotency: the entry counts as already present only
    // when it appears as a whole "; "-delimited item (or as the entire field).
    // Matching boundaries instead of splitting preserves notes that themselves
    // contain semicolons. Provenance markers are appended independently, so a
    // pre-existing human note is not duplicated merely because provenance was
    // added later.
    const hasEntry = existing === entry
      || existing.startsWith(`${entry}; `)
      || existing.endsWith(`; ${entry}`)
      || existing.includes(`; ${entry}; `);
    if (!hasEntry) {
      existing = existing && existing !== '—' && existing !== '-' ? `${existing}; ${entry}` : entry;
      noteChanged = true;
    }
  }
  parts[colmap.notes] = existing;
}

const changed = statusChanged || noteChanged || companyChanged || pdfChanged;

if (changed && !flags.dryRun) {
  lines[target.lineIdx] = rebuildRow(parts);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    // Same structured error contract as every other failure path — a raw
    // stack trace on stdout/stderr would break --json consumers.
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}
lock?.release();

// ── report ───────────────────────────────────────────────────────

const result = {
  changed,
  num: target.num,
  company: parts[colmap.company],
  role: target.role,
  oldStatus,
  newStatus,
  ...(flags.company != null ? { oldCompany, newCompany: parts[colmap.company] } : {}),
  ...(flags.pdfReady ? { oldPdf, newPdf: parts[colmap.pdf] } : {}),
  ...(note != null ? { note } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  ...(flags.external ? { provenance: 'external-confirmed' } : {}),
  ...(flags.receipt ? { provenance: 'application-receipt', receiptId: flags.receipt } : {}),
  // Fire the #1430 hook only on an actual transition INTO Applied — an
  // idempotent re-run of an already-Applied row must not invite a consumer
  // to seed a duplicate follow-up.
  ...(statusChanged && newStatus === 'Applied' ? { followupSeedCandidate: true } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const updates = [];
  if (statusChanged) updates.push(`Status ${oldStatus} → ${newStatus}`);
  if (companyChanged) updates.push(`Company ${oldCompany} → ${parts[colmap.company]}`);
  if (pdfChanged) updates.push(`PDF ${oldPdf || 'blank'} → ✅`);
  if (noteChanged) updates.push(`Notes + ${note}`);
  const summary = updates.length ? updates.join('; ') : 'requested values already present';
  const verb = flags.dryRun ? 'would update' : changed ? 'updated' : 'unchanged';
  console.log(`✅ #${target.num} ${parts[colmap.company]} — ${target.role}: ${verb} (${summary})`);
  if (statusChanged && !flags.dryRun && newStatus === 'Applied') {
    console.error('ℹ️  Status is Applied — consider seeding follow-ups in data/follow-ups.md (#1430: node followup-cadence.mjs)');
  }
}
process.exit(EXIT_OK);
