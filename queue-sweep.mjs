#!/usr/bin/env node
/**
 * queue-sweep.mjs — Retry-cap lifecycle for unreachable no-JD queue roles.
 *
 * A role that enters the queue without a substantive JD (title-only stub,
 * failed fetch, login-walled portal) must not linger as status:new forever,
 * and must never be scored from its title alone. This module gives those
 * roles a bounded, class-aware lifecycle:
 *
 *   deterministic (login wall / robots / 401 / 403 / captcha / paywall)
 *     — retrying cannot succeed; zero automatic retries. Surfaced in the
 *       end-of-run no-jd list; auto-closed once DETERMINISTIC_GRACE_DAYS
 *       have passed since the first recorded failure.
 *   transient (timeout / 5xx / network / empty or inconclusive page shell)
 *     — worth a bounded number of retries across separate runs. Auto-closed
 *       when TRANSIENT_MAX_ATTEMPTS failures accumulate OR
 *       TRANSIENT_GRACE_DAYS have passed since the first failure.
 *
 * Closure semantics (deliberate):
 *   - status: 'closed' + closed_reason: 'unreachable' — NEVER 'expired'.
 *     Expired is reserved for confirmed closure (ATS API verdict or a
 *     closed-page shell; see evictExpiredNewStubsCron in queue-store.mjs).
 *     A false 'expired' poisons dedup history and pattern stats.
 *   - Only status:'new' roles are swept. Anything the candidate has touched
 *     (scored, prepare-queued, ...) is out of scope by construction.
 *   - Reversible: jd_fetch metadata stays on the record; a pasted JD or an
 *     explicit revive re-enters the role through the normal ingest path.
 *
 * Usage:
 *   node queue-sweep.mjs                        # sweep + save, JSON report
 *   node queue-sweep.mjs --summary              # human-readable table
 *   node queue-sweep.mjs --dry-run              # report only, no writes
 *   node queue-sweep.mjs record <role-id> --reason "<why>" [--class deterministic|transient]
 *                                               # stamp one failed fetch attempt
 *   node queue-sweep.mjs --self-test            # pure-function tests, no I/O
 *
 * Zero model tokens — pure JSON + file I/O.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── Policy constants ─────────────────────────────────────────────────────────

/** Days a deterministic (login/robots) failure may sit unactioned before close. */
export const DETERMINISTIC_GRACE_DAYS = 7;
/** Total failed fetch attempts (first + retries) before a transient role closes. */
export const TRANSIENT_MAX_ATTEMPTS = 3;
/** Days after the first transient failure before the role closes regardless. */
export const TRANSIENT_GRACE_DAYS = 14;
/** Minimum body characters for a JD to count as substantive (responsibilities
 *  and requirements can't fit in less; titles/snippets/shells never reach it). */
export const JD_MIN_SUBSTANTIVE_CHARS = 200;
/** Placeholder written by queue-ingest when an ATS returned no description. */
export const JD_PLACEHOLDER = '(description not available — fetch manually)';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Failure classification ───────────────────────────────────────────────────

const DETERMINISTIC_PATTERNS =
  /\blog[\s-]?in\b|\bsign[\s-]?in\b|\bauth\w*|credential|robots|captcha|paywall|account.required|\b401\b|\b403\b|forbidden|unauthorized|login.wall|login.gated|login.required/i;

/**
 * Classify a fetch-failure reason string.
 * Deterministic failures cannot be fixed by retrying (only by the candidate
 * logging in or pasting the JD); everything else is assumed transient.
 *
 * @param {string} reason - Error message / failure description.
 * @returns {'deterministic'|'transient'}
 */
export function classifyJdFetchFailure(reason) {
  return DETERMINISTIC_PATTERNS.test(String(reason ?? '')) ? 'deterministic' : 'transient';
}

// Strong gone-signals only — mirrors the conservative HTTP_EVICT_CODES stance
// in queue-store.mjs. A 404/410 from an ATS JSON API is authoritative; vaguer
// failures stay in the unreachable (retry-capped) lane, never in expired.
const GONE_PATTERNS = /\b404\b|\b410\b|\bgone\b|not found|no longer (available|active|accepting)/i;

/**
 * Is this fetch failure a confirmed the-posting-is-gone signal (→ close as
 * expired immediately) rather than an unreachable one (→ retry-capped)?
 *
 * @param {string} reason - Error message / failure description.
 * @returns {boolean}
 */
export function isGoneFailure(reason) {
  return GONE_PATTERNS.test(String(reason ?? ''));
}

// ── Substantive-JD check ─────────────────────────────────────────────────────

function defaultReadJdFile(relPath) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

function substantiveLength(text) {
  if (!text) return 0;
  const body = String(text)
    .split('\n')
    // Drop the jds/ file header (title, URL, Source, Location lines) so a
    // long URL can't push a header-only file over the floor.
    .filter((line) => !/^\s*#|^\s*\*\*(URL|Source|Location):\*\*/i.test(line))
    .join('\n')
    .replaceAll(JD_PLACEHOLDER, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length;
}

/**
 * Does the role carry a substantive JD? Same presence definition as the
 * `no-jd` flag in modes/queue.md — jd_text OR the jd_path file — plus a
 * minimum-body floor so placeholders, titles, and page shells don't count.
 *
 * @param {object} role - Queue role record.
 * @param {{ readFile?: (relPath: string) => string|null }} [opts] - Injectable file reader for tests.
 * @returns {boolean}
 */
export function hasSubstantiveJd(role, { readFile = defaultReadJdFile } = {}) {
  if (substantiveLength(role?.jd_text) >= JD_MIN_SUBSTANTIVE_CHARS) return true;
  if (role?.jd_path) {
    const content = readFile(role.jd_path);
    if (substantiveLength(content) >= JD_MIN_SUBSTANTIVE_CHARS) return true;
  }
  return false;
}

// ── Failure recording ────────────────────────────────────────────────────────

/**
 * Stamp one failed JD-fetch attempt onto a role (mutates the role).
 * Attempts accumulate; first_failed_at is sticky; 'deterministic' is sticky
 * (a login wall stays a login wall even if a later probe times out first).
 * Also ensures the 'no-jd' flag is present.
 *
 * @param {object} role - Queue role record (mutated).
 * @param {{ reason: string, failureClass?: 'deterministic'|'transient', now?: string }} opts
 * @returns {object} The updated role.jd_fetch metadata.
 */
export function recordJdFetchFailure(role, { reason, failureClass, now } = {}) {
  const nowIso = now ?? new Date().toISOString();
  const prev = role.jd_fetch ?? {};
  const cls = failureClass ?? classifyJdFetchFailure(reason);
  role.jd_fetch = {
    class: prev.class === 'deterministic' || cls === 'deterministic' ? 'deterministic' : 'transient',
    reason: String(reason ?? 'fetch failed'),
    attempts: (prev.attempts ?? 0) + 1,
    first_failed_at: prev.first_failed_at ?? nowIso,
    last_attempt_at: nowIso,
  };
  role.flags = Array.isArray(role.flags) ? role.flags : [];
  if (!role.flags.includes('no-jd')) role.flags.push('no-jd');
  return role.jd_fetch;
}

// ── Close verdict + sweep ────────────────────────────────────────────────────

/**
 * Should this role be closed as unreachable right now?
 * Pure: no I/O beyond the injectable JD-file reader.
 *
 * @param {object} role - Queue role record.
 * @param {{ now?: Date|string|number, readFile?: Function }} [opts]
 * @returns {{ close: boolean, why: string|null }}
 */
export function unreachableVerdict(role, { now = new Date(), readFile } = {}) {
  if (role?.status !== 'new') return { close: false, why: null };
  if (hasSubstantiveJd(role, readFile ? { readFile } : {})) return { close: false, why: null };
  const meta = role.jd_fetch;
  if (!meta?.first_failed_at) return { close: false, why: null }; // never attempted — surface, don't close

  const ageDays = (new Date(now).getTime() - new Date(meta.first_failed_at).getTime()) / DAY_MS;

  if (meta.class === 'deterministic') {
    if (ageDays >= DETERMINISTIC_GRACE_DAYS) {
      return { close: true, why: `login/robots block unactioned for ${Math.floor(ageDays)}d` };
    }
    return { close: false, why: null };
  }

  if ((meta.attempts ?? 0) >= TRANSIENT_MAX_ATTEMPTS) {
    return { close: true, why: `retry budget exhausted (${meta.attempts} failed attempts)` };
  }
  if (ageDays >= TRANSIENT_GRACE_DAYS) {
    return { close: true, why: `still unreachable ${Math.floor(ageDays)}d after first failure` };
  }
  return { close: false, why: null };
}

/**
 * Sweep the queue: close over-cap unreachable roles, collect the still-open
 * no-jd list for surfacing to the candidate. Mutates the queue in place;
 * the caller decides whether to persist.
 *
 * @param {object} queue - Queue object from loadQueue().
 * @param {{ now?: Date|string|number, readFile?: Function }} [opts]
 * @returns {{ closed: object[], open: object[] }}
 */
export function sweepQueue(queue, { now = new Date(), readFile } = {}) {
  const closed = [];
  const open = [];
  const nowIso = new Date(now).toISOString();

  for (const role of queue.roles ?? []) {
    if (role.status !== 'new') continue;
    if (hasSubstantiveJd(role, readFile ? { readFile } : {})) continue;

    const verdict = unreachableVerdict(role, { now, readFile });
    const summary = {
      id: role.id,
      company: role.company,
      title: role.title,
      url: role.url,
      class: role.jd_fetch?.class ?? 'never-fetched',
      attempts: role.jd_fetch?.attempts ?? 0,
      first_failed_at: role.jd_fetch?.first_failed_at ?? null,
      reason: role.jd_fetch?.reason ?? null,
    };

    if (verdict.close) {
      role.status = 'closed';
      role.decided_at = nowIso;
      role.closed_reason = 'unreachable';
      closed.push({ ...summary, why: verdict.why });
    } else {
      open.push(summary);
    }
  }

  return { closed, open };
}

// ── Self-test (no queue file, no network) ────────────────────────────────────

function selfTest() {
  let failed = 0;
  const ok = (cond, msg) => {
    console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failed++;
  };
  const longJd = 'Responsibilities: build data pipelines. Requirements: Python, SQL. '.repeat(5);
  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

  console.log('\nqueue-sweep.mjs self-tests\n');

  // Classification
  ok(classifyJdFetchFailure('HTTP 403 Forbidden') === 'deterministic', 'classify: 403 → deterministic');
  ok(classifyJdFetchFailure('redirected to sign-in page') === 'deterministic', 'classify: sign-in → deterministic');
  ok(classifyJdFetchFailure('blocked by robots.txt') === 'deterministic', 'classify: robots → deterministic');
  ok(classifyJdFetchFailure('fetch timeout after 30s') === 'transient', 'classify: timeout → transient');
  ok(classifyJdFetchFailure('HTTP 503') === 'transient', 'classify: 503 → transient');
  ok(classifyJdFetchFailure(null) === 'transient', 'classify: null reason → transient');
  ok(isGoneFailure('HTTP 404 Not Found'), 'gone: 404 detected');
  ok(isGoneFailure('ashby: job abc not found in board xero'), 'gone: ATS not-found detected');
  ok(isGoneFailure('HTTP 410 Gone'), 'gone: 410 detected');
  ok(!isGoneFailure('fetch timeout after 30s'), 'gone: timeout is not gone');
  ok(!isGoneFailure('HTTP 403 Forbidden'), 'gone: 403 is not gone');

  // Substantive JD
  ok(hasSubstantiveJd({ jd_text: longJd }), 'substantive: real JD text passes');
  ok(!hasSubstantiveJd({ jd_text: 'Senior Data Engineer' }), 'substantive: title-only fails');
  ok(!hasSubstantiveJd({ jd_text: JD_PLACEHOLDER }), 'substantive: placeholder fails');
  ok(!hasSubstantiveJd({ jd_text: null, jd_path: null }), 'substantive: empty role fails');
  const headerOnly = `# Data Engineer — Acme\n\n**URL:** https://x.example/${'a'.repeat(250)}\n**Source:** api\n**Location:** Melbourne\n\n${JD_PLACEHOLDER}`;
  ok(!hasSubstantiveJd({ jd_path: 'jds/x.md' }, { readFile: () => headerOnly }), 'substantive: header-only jd file fails despite long URL');
  ok(hasSubstantiveJd({ jd_path: 'jds/x.md' }, { readFile: () => `# T — C\n\n${longJd}` }), 'substantive: real jd file passes');
  ok(!hasSubstantiveJd({ jd_path: 'jds/x.md' }, { readFile: () => null }), 'substantive: missing jd file fails');

  // Recording
  const r1 = { status: 'new', flags: [] };
  recordJdFetchFailure(r1, { reason: 'timeout', now: day(0) });
  recordJdFetchFailure(r1, { reason: 'HTTP 403', now: day(2) });
  ok(r1.jd_fetch.attempts === 2, 'record: attempts accumulate');
  ok(r1.jd_fetch.first_failed_at === day(0), 'record: first_failed_at sticky');
  ok(r1.jd_fetch.class === 'deterministic', 'record: transient upgrades to deterministic');
  recordJdFetchFailure(r1, { reason: 'timeout again', now: day(3) });
  ok(r1.jd_fetch.class === 'deterministic', 'record: deterministic is sticky');
  ok(r1.flags.includes('no-jd'), 'record: no-jd flag added');

  // Verdicts
  const det = { status: 'new', jd_fetch: { class: 'deterministic', attempts: 1, first_failed_at: day(0) } };
  ok(!unreachableVerdict(det, { now: day(6) }).close, 'verdict: deterministic kept inside 7d grace');
  ok(unreachableVerdict(det, { now: day(7) }).close, 'verdict: deterministic closes at 7d');
  const tr = { status: 'new', jd_fetch: { class: 'transient', attempts: 2, first_failed_at: day(0) } };
  ok(!unreachableVerdict(tr, { now: day(5) }).close, 'verdict: transient kept under attempts+age caps');
  ok(unreachableVerdict({ ...tr, jd_fetch: { ...tr.jd_fetch, attempts: 3 } }, { now: day(1) }).close, 'verdict: transient closes at 3 attempts');
  ok(unreachableVerdict(tr, { now: day(14) }).close, 'verdict: transient closes at 14d');
  ok(!unreachableVerdict({ status: 'scored', jd_fetch: tr.jd_fetch }, { now: day(30) }).close, 'verdict: only status:new is swept');
  ok(!unreachableVerdict({ status: 'new' }, { now: day(30) }).close, 'verdict: never-fetched roles are surfaced, not closed');
  ok(!unreachableVerdict({ status: 'new', jd_text: longJd, jd_fetch: tr.jd_fetch }, { now: day(30) }).close, 'verdict: substantive JD is never closed');

  // Sweep
  const queue = {
    roles: [
      { id: 'a', status: 'new', company: 'A', title: 'x', jd_fetch: { class: 'deterministic', attempts: 1, first_failed_at: day(0), reason: 'login wall' } },
      { id: 'b', status: 'new', company: 'B', title: 'y', jd_fetch: { class: 'transient', attempts: 1, first_failed_at: day(8), reason: 'timeout' } },
      { id: 'c', status: 'new', company: 'C', title: 'z' },
      { id: 'd', status: 'scored', company: 'D', title: 'w' },
      { id: 'e', status: 'new', company: 'E', title: 'v', jd_text: longJd },
    ],
  };
  const { closed, open } = sweepQueue(queue, { now: day(10), readFile: () => null });
  ok(closed.length === 1 && closed[0].id === 'a', 'sweep: closes only the over-cap role');
  ok(queue.roles[0].status === 'closed' && queue.roles[0].closed_reason === 'unreachable', "sweep: closed as 'unreachable', never 'expired'");
  ok(queue.roles[0].decided_at === day(10), 'sweep: decided_at stamped');
  ok(open.length === 2 && open.some((r) => r.id === 'b') && open.some((r) => r.id === 'c'), 'sweep: surfaces open no-jd roles incl. never-fetched');
  ok(open.find((r) => r.id === 'c').class === 'never-fetched', 'sweep: never-fetched roles labelled');
  ok(queue.roles[3].status === 'scored' && queue.roles[4].status === 'new', 'sweep: scored + substantive roles untouched');

  console.log(failed === 0 ? '\nAll queue-sweep self-tests passed' : `\n${failed} self-test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printSummary({ closed, open }, dryRun) {
  const verb = dryRun ? 'WOULD close' : 'Closed';
  console.log(`\nQueue sweep — ${verb}: ${closed.length}, still open no-jd: ${open.length}\n`);
  for (const r of closed) {
    console.log(`  ✂️  ${r.company} | ${r.title} — ${r.why} [${r.class}]`);
  }
  if (open.length > 0) {
    console.log('\n  Surface to candidate (unscored, awaiting JD):');
    for (const r of open) {
      const age = r.first_failed_at ? `, first failed ${r.first_failed_at.slice(0, 10)}` : '';
      console.log(`  🔍 ${r.company} | ${r.title} — ${r.class}, ${r.attempts} attempt(s)${age}`);
      if (r.reason) console.log(`      last error: ${r.reason}`);
      if (r.url) console.log(`      ${r.url}`);
    }
    console.log('\n  Paste the JD text or log in to unblock; pasted JDs count as a valid retrieval.');
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) return selfTest();

  const { loadQueue, saveQueue, getById } = await import(pathToFileURL(join(ROOT, 'queue-store.mjs')).href);

  if (argv[0] === 'record') {
    const id = argv[1];
    const reasonIdx = argv.indexOf('--reason');
    const classIdx = argv.indexOf('--class');
    const reason = reasonIdx !== -1 ? argv[reasonIdx + 1] : null;
    const failureClass = classIdx !== -1 ? argv[classIdx + 1] : undefined;
    if (!id || !reason) {
      console.error('Usage: node queue-sweep.mjs record <role-id> --reason "<why>" [--class deterministic|transient]');
      process.exit(1);
    }
    if (failureClass && failureClass !== 'deterministic' && failureClass !== 'transient') {
      console.error(`Invalid --class '${failureClass}' (deterministic|transient)`);
      process.exit(1);
    }
    const queue = loadQueue();
    const role = getById(queue, id);
    if (!role) {
      console.error(`Role '${id}' not found in queue`);
      process.exit(1);
    }
    const meta = recordJdFetchFailure(role, { reason, failureClass });
    saveQueue(queue);
    console.log(JSON.stringify({ id, ...meta }, null, 2));
    return;
  }

  const dryRun = argv.includes('--dry-run');
  const summary = argv.includes('--summary');
  const queue = loadQueue();
  const result = sweepQueue(queue);

  if (!dryRun && result.closed.length > 0) saveQueue(queue);

  if (summary) {
    printSummary(result, dryRun);
  } else {
    console.log(JSON.stringify({ dryRun, ...result }, null, 2));
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`queue-sweep failed: ${err.message}`);
    process.exit(1);
  });
}
