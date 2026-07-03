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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import yaml from 'js-yaml';

import {
  loadQueue, saveQueue, computeLane, computeStage, computeStats,
  setStatus, updateById, ACTIVE_STATUSES, DONE_STATUSES, stageDragTarget,
  DRAG_TARGET_STAGES,
} from './queue-store.mjs';
import { queueDoneStatusFromTracker, parseTrackerDoneRows } from './tracker-status-map.mjs';
import { partitionRunRoles, isDeepEval } from './run-partition.mjs';

const ROOT     = dirname(fileURLToPath(import.meta.url));
const WEB_DIR  = join(ROOT, 'dashboard', 'web');
const APPS_FILE = join(ROOT, 'data', 'applications.md');
const ADDITIONS_DIR = join(ROOT, 'batch', 'tracker-additions');

// ── CLI args ─────────────────────────────────────────────────────────────────

const portArg = process.argv.indexOf('--port');
const PORT    = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 7777;
const HOST    = '127.0.0.1'; // localhost only — never expose externally

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

// Statuses a single deterministic Fill may run from: first fill after PREPARE
// ('prepared') or a headed re-open of an existing fill ('prefilled'/'filled').
const FILLABLE_STATUSES = new Set(['prepared', 'prefilled', 'filled']);

// Tabs/newlines in model-written free text (reason, scraped company/title)
// would inject extra TSV columns or split the row before merge-tracker's own
// markdown-side sanitizeCell ever runs — strip them at the write site.
function tsvCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function writeTrackerTsv(role, decision) {
  mkdirSync(ADDITIONS_DIR, { recursive: true });

  const num    = nextTrackerNum();
  const date   = new Date().toISOString().slice(0, 10);
  const status = DECISION_STATUS[decision] ?? 'Discarded';
  const score  = role.score != null ? `${role.score.toFixed(1)}/5` : 'N/A';
  const pdf    = role.cv_pdf ? '✅' : '❌';
  const report = `[job](${role.url})`;
  const notes  = role.reason ? role.reason.slice(0, 120) : '';

  const tsv = [num, date, role.company, role.title, status, score, pdf, report, notes]
    .map(tsvCell)
    .join('\t');

  const filename = `${num}-${role.id.replace(/:/g, '-').slice(0, 40)}.tsv`;
  writeFileSync(join(ADDITIONS_DIR, filename), tsv + '\n', 'utf-8');

  // Run merge-tracker to keep applications.md in sync
  try {
    execFileSync(process.execPath, ['merge-tracker.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    // Non-fatal: the TSV file is written; user can run merge-tracker manually
    console.warn('WARN: merge-tracker.mjs exited with error:', err.message?.slice(0, 200));
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

function splitTrackerRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function extractUrlFromLinkedReport(target) {
  if (!target || /^https?:\/\//i.test(target)) return null;

  const reportPath = resolve(dirname(APPS_FILE), target);
  if (reportPath !== ROOT && !reportPath.startsWith(`${ROOT}/`)) return null;
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
  for (const line of text.split(/\r?\n/)) {
    const cells = splitTrackerRow(line);
    if (!cells || cells.length < 8 || !/^\d+$/.test(cells[0])) continue;

    const queueStatus = queueDoneStatusFromTracker(cells[5], { includeEvaluated: false });
    if (!queueStatus) continue;

    const url = normalizeJobUrl(extractTrackerUrl(cells[7]));
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

// ── Parallel run ──────────────────────────────────────────────────────────────

function spawnFillDetached(roleId, headless) {
  const args = ['form-fill.mjs', roleId, ...(headless ? ['--headless'] : [])];
  const child = spawn(process.execPath, args, {
    cwd:      ROOT,
    detached: true,
    stdio:    ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return child.pid;
}

async function spawnFillAndWait(roleId, headless, role, runId) {
  return new Promise((resolve) => {
    const args  = ['form-fill.mjs', roleId, ...(headless ? ['--headless'] : [])];
    const child = spawn(process.execPath, args, {
      cwd:   ROOT,
      stdio: 'pipe',
    });

    let stdout = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stdout += d; });

    child.on('close', (code) => {
      const knockoutFlag = stdout.includes('KNOCKOUT');
      const loginWall    = stdout.includes('Login required') || stdout.includes('🔐 Login');
      const event = code === 0
        ? (knockoutFlag ? 'knockout-flag' : loginWall ? 'login-wall' : 'success')
        : 'failure';
      emitActivity(runId, roleId, event, role, { exitCode: code });
      resolve({ event, exitCode: code });
    });
  });
}

function apiRun(req, res) {
  readBody(req, async (body) => {
    const { ids } = safeJson(body) || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return respond(res, 400, { error: 'ids must be a non-empty array' });
    }

    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const profile = loadProfile();
    const concurrency = profile.automation?.fill_concurrency ?? 1;

    const roles = ids
      .map((id) => queue.roles.find((r) => r.id === id))
      .filter(Boolean);

    if (roles.length === 0) {
      return respond(res, 404, { error: 'none of the requested role IDs found' });
    }

    // Partition the run into execution lanes: deterministic (headless parallel) vs
    // login-gated (serial headed) vs agent-path (notice only). deep-eval-marked roles
    // always go to the agent path so a full oferta runs before any fill (the headless
    // server has no LLM) — see modes/apply.md → "Deep-eval marker". The pure logic lives
    // in run-partition.mjs so it can be unit-tested without starting the server.
    const { deterministic, loginGated, agentPath } = partitionRunRoles(roles);

    const runId = `run-${Date.now()}`;

    // Respond immediately — fill runs asynchronously
    respond(res, 200, {
      runId,
      total:       roles.length,
      deterministic: deterministic.length,
      loginGated:  loginGated.length,
      agentPath:   agentPath.length,
      concurrency,
    });

    // ── Agent-path roles — emit notice only (user must run /career-ops apply) ──
    for (const role of agentPath) {
      emitActivity(runId, role.id, 'agent-path', role, {
        message: isDeepEval(role)
          ? `Marked deep-eval — run: /career-ops apply and open ${role.url} (a full oferta runs first if no current report exists)`
          : `Custom ATS — run: /career-ops apply and open ${role.url}`,
      });
    }

    // ── Deterministic fills — bounded parallel, headless ─────────────────────
    if (deterministic.length > 0) {
      const queue2 = [...deterministic];
      const inFlight = new Set();

      const runNext = async () => {
        if (queue2.length === 0) return;
        const role = queue2.shift();
        inFlight.add(role.id);
        emitActivity(runId, role.id, 'started', role);
        await spawnFillAndWait(role.id, true, role, runId);
        inFlight.delete(role.id);
        await runNext();
      };

      const workers = Array.from(
        { length: Math.min(concurrency, deterministic.length) },
        () => runNext()
      );
      // Fire-and-forget — don't await (already responded)
      Promise.all(workers).catch(() => {});
    }

    // ── Login-gated fills — serial, headed, poll-based ───────────────────────
    // Headed fills are designed to stay open (block) for user review, so we
    // cannot await process exit.  Instead: spawn detached, then poll the queue
    // until the role's status advances to 'filled' (or a DONE status), then
    // launch the next one.  The per-role timeout matches login_timeout_min.
    const loginTimeoutMs = (loadProfile().automation?.login_timeout_min ?? 10) * 60 * 1000
      + 5 * 60 * 1000; // add 5 min buffer for fill time after login

    const waitForFilled = async (roleId) => {
      const deadline = Date.now() + loginTimeoutMs;
      while (Date.now() < deadline) {
        const q = loadQueue();
        const r = q.roles.find((x) => x.id === roleId);
        if (r && (r.status === 'filled' || DONE_STATUSES.has(r.status))) return true;
        await new Promise((res) => setTimeout(res, 5_000));
      }
      return false;
    };

    const runSerial = async () => {
      for (const role of loginGated) {
        emitActivity(runId, role.id, 'login-wall', role, {
          message: 'Login required — headed browser opening (serial). Authenticate, then continue.',
        });
        spawnFillDetached(role.id, false); // headed, stays open for user review
        const ok = await waitForFilled(role.id);
        const freshRole = loadQueue().roles.find((r) => r.id === role.id) ?? role;
        emitActivity(runId, role.id, ok ? 'success' : 'failure', freshRole, {
          detail: ok ? 'status reached filled' : 'timeout waiting for login',
        });
      }
    };
    runSerial().catch(() => {});
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
  const trackerReconciled = reconcileQueueWithTracker(queue);
  let trackerReconcileWarning = null;
  if (trackerReconciled.length > 0) {
    // The reconciled statuses are already applied in memory (and rendered
    // below) either way; the save only persists them. Under a persistent
    // Supabase write error, retrying on every poll is an unbounded write
    // storm — back off and let a later poll retry.
    if (Date.now() - reconcileSaveFailedAt < RECONCILE_SAVE_COOLDOWN_MS) {
      trackerReconcileWarning = 'tracker reconciliation persist backing off after a recent failure';
    } else {
      try {
        saveQueue(queue);
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
    .map(r => ({
      ...r,
      lane:               computeLane(r),
      stage:              computeStage(r),
      provenance_summary: provenanceSummary(r.drafts),
    }));

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

  respond(res, 200, { settings, stats, roles: enriched, done });
}

function apiSetThreshold(req, res) {
  readBody(req, (body) => {
    const { value } = safeJson(body) || {};
    const threshold = parseFloat(value);
    if (isNaN(threshold) || threshold < 0 || threshold > 5) {
      return respond(res, 400, { error: 'threshold must be 0–5' });
    }

    const queue = loadQueue();
    queue.settings.score_threshold = threshold;

    // Flip all ready-lane scored roles at or above the threshold to prepare-queued
    let flipped = 0;
    for (const role of queue.roles) {
      if (role.status !== 'scored') continue;
      if (computeLane(role) !== 'ready') continue;
      if (role.score != null && role.score >= threshold) {
        role.status = 'prepare-queued';
        flipped++;
      }
    }

    try {
      saveQueue(queue);
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }
    respond(res, 200, { threshold, flipped });
  });
}

function apiRoleFill(req, res, id) {
  let queue;
  try {
    queue = loadQueue();
  } catch (err) {
    return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
  }
  const role = queue.roles.find(r => r.id === id);
  if (!role) return respond(res, 404, { error: 'role not found' });

  const ats = role.ats;

  // Deep-eval marker: route to the agent path so a full oferta runs before any fill
  // (see modes/apply.md → "Deep-eval marker"). A headless fill here would bypass the
  // oferta-first guarantee, so a marked role is never deterministically filled.
  if (isDeepEval(role)) {
    return respond(res, 200, {
      method: 'agent',
      message: `This role is marked deep-eval. Run: /career-ops apply\nA full oferta runs first if no current report exists, then it fills.\nThen open: ${role.url}`,
    });
  }

  // Agent-driven path for custom/Workday forms
  if (ats === 'custom') {
    return respond(res, 200, {
      method: 'agent',
      message: `This role uses a custom ATS. Run: /career-ops apply\nThen open: ${role.url}`,
    });
  }

  // Asset gate (modes/_custom.md): a deterministic fill attaches role.cv_pdf,
  // so it only makes sense after PREPARE has produced fresh assets. This blocks
  // filling an unprepared role, and a role sent back for redo from re-attaching
  // its stale CV. (The agent-path branches above are guidance-only, so they
  // stay reachable from any status; bulk /api/run keeps its own semantics.)
  if (!FILLABLE_STATUSES.has(role.status)) {
    return respond(res, 409, {
      error: `role is '${role.status}' — run /career-ops queue prepare to generate fresh assets before filling`,
    });
  }

  // Deterministic fill via form-fill.mjs for GH/Lever/Ashby
  const child = spawn(
    process.execPath,
    ['form-fill.mjs', id],
    {
      cwd:      ROOT,
      detached: true,
      stdio:    ['ignore', 'ignore', 'ignore'],
    }
  );
  child.unref();

  respond(res, 200, {
    method:  'form-fill',
    message: `Playwright fill launched for ${role.company} – ${role.title}. The browser will open shortly.`,
  });
}

function apiRoleDecision(req, res, id) {
  readBody(req, (body) => {
    const { decision } = safeJson(body) || {};
    if (!['submitted', 'skipped', 'reviewed'].includes(decision)) {
      return respond(res, 400, { error: 'decision must be submitted | skipped | reviewed' });
    }

    const queue = loadQueue();
    const role = queue.roles.find(r => r.id === id);
    if (!role) return respond(res, 404, { error: 'role not found' });
    if (decision === 'submitted' && role.status === 'prefilled') {
      return respond(res, 409, {
        error: 'prefilled roles must be reopened with headed Fill Form before marking submitted',
      });
    }

    setStatus(queue, id, decision);
    try {
      saveQueue(queue);
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }

    // Write tracker TSV + merge into applications.md
    try {
      writeTrackerTsv(role, decision);
    } catch (err) {
      console.warn('WARN: tracker write-back failed:', err.message);
    }

    respond(res, 200, { id, decision, status: decision });
  });
}

// ── Kanban board — drag-to-move ───────────────────────────────────────────────
//
// Handles ONLY the drags that are a legal bare status flip: Inbox↔To Do
// (select/deselect) and Prepared/In Review → To Do (send back for redo).
// Forward moves into Prepared/In Review/Done are never accepted here — the web
// UI routes those drops to the existing /fill and /decision endpoints instead,
// so a card can never claim to be further along than it actually is.

function apiRoleStage(req, res, id) {
  readBody(req, (body) => {
    const { stage } = safeJson(body) || {};
    if (!DRAG_TARGET_STAGES.includes(stage)) {
      return respond(res, 400, { error: `stage must be ${DRAG_TARGET_STAGES.join(' | ')}` });
    }

    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const role = queue.roles.find(r => r.id === id);
    if (!role) return respond(res, 404, { error: 'role not found' });

    const nextStatus = stageDragTarget(role, stage);
    if (!nextStatus) {
      return respond(res, 409, { error: `cannot move this role to ${stage} — not a valid drag transition` });
    }

    setStatus(queue, id, nextStatus);
    try {
      saveQueue(queue);
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }

    respond(res, 200, { id, stage, status: nextStatus });
  });
}

// ── Deep-eval marker ──────────────────────────────────────────────────────────
//
// Toggles the `deep-eval` flag on a role. This is a pre-apply marker only: it
// records "this role is worth a full oferta evaluation before applying". It does
// NOT run any evaluation (the server has no LLM) and does NOT change status, lane,
// or anything in the fill pipeline. The agent honours the flag at apply time
// (see modes/apply.md → "Deep-eval marker"): a marked role gets a full `oferta`
// first, then fills as normal. To keep that guarantee, the fill/run dispatch routes
// deep-eval-marked roles to the agent path (never headless). Unmarked roles unaffected.

const DEEP_EVAL_FLAG = 'deep-eval';

function apiRoleFlag(req, res, id) {
  readBody(req, (body) => {
    const parsed = safeJson(body) || {};
    const flag = parsed.flag || DEEP_EVAL_FLAG;
    // Safelist: this endpoint only manages the deep-eval marker. Other flags are
    // owned by the scorer/fill pipeline and must not be hand-toggled here.
    if (flag !== DEEP_EVAL_FLAG) {
      return respond(res, 400, { error: `flag must be ${DEEP_EVAL_FLAG}` });
    }

    let queue;
    try {
      queue = loadQueue();
    } catch (err) {
      return respond(res, 503, { error: `queue store unavailable: ${err.message}` });
    }
    const role = queue.roles.find(r => r.id === id);
    if (!role) return respond(res, 404, { error: 'role not found' });

    role.flags = Array.isArray(role.flags) ? role.flags : [];
    const has  = role.flags.includes(flag);
    // Explicit value wins; otherwise toggle.
    const next = typeof parsed.value === 'boolean' ? parsed.value : !has;
    if (next && !has) role.flags.push(flag);
    if (!next && has) role.flags = role.flags.filter(f => f !== flag);

    try {
      saveQueue(queue);
    } catch (err) {
      return respond(res, 503, { error: `queue store write failed: ${err.message}` });
    }

    respond(res, 200, { id, flag, marked: next, flags: role.flags });
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

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf-8')));
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
  res.setHeader('Access-Control-Allow-Origin', `http://${HOST}:${PORT}`);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = new URL(req.url, `http://${HOST}:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  // API routes
  if (path === '/api/queue'    && method === 'GET')  return apiGetQueue(res);
  if (path === '/api/threshold' && method === 'POST') return apiSetThreshold(req, res);
  if (path === '/api/run'      && method === 'POST')  return apiRun(req, res);
  if (path === '/api/activity' && method === 'GET')   return apiActivity(req, res);

  const fillMatch = path.match(/^\/api\/role\/([^/]+)\/fill$/);
  if (fillMatch && method === 'POST') return apiRoleFill(req, res, decodeURIComponent(fillMatch[1]));

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
