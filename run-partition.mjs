/**
 * run-partition.mjs — pure partition logic for the dashboard's batch "Run" dispatch.
 *
 * Splits a set of queue roles into the execution lanes the dashboard fills by:
 *   - deterministic: headless parallel form-fill.mjs — FIRST fills only
 *                    (status 'prepared', no login wall). Headless output is
 *                    'prefilled', which is correct for a first pass.
 *   - loginGated:    serial headed fill behind a login wall
 *   - headedReopen:  serial headed re-open of an existing fill
 *                    ('prefilled'/'filled', no login wall). Re-opens must be
 *                    HEADED: a headless pass would rewrite an already
 *                    headed-reviewed 'filled' role back to 'prefilled',
 *                    silently discarding its reviewed state.
 *   - agentPath:     notice only — the candidate must run `/career-ops apply`
 *   - notPrepared:   notice only — asset gate: the role has no fresh PREPARE
 *                    assets, so launching form-fill.mjs would attach a stale
 *                    or missing CV
 *
 * deep-eval-marked roles ALWAYS go to agentPath so a full `oferta` runs before any
 * fill (the headless server has no LLM) — see modes/apply.md → "Deep-eval marker".
 *
 * The asset gate (FILLABLE_STATUSES) applies to every fill lane: only a role that
 * PREPARE has produced assets for ('prepared'), or an existing fill being re-opened
 * ('prefilled'/'filled'), may launch form-fill.mjs. agentPath is guidance-only, so
 * it stays reachable from any status — the apply flow runs PREPARE itself.
 * dashboard-server.mjs imports FILLABLE_STATUSES for the single-card Fill endpoint
 * too, so single and bulk fills can never drift.
 *
 * Pure + side-effect-free so it can be unit-tested without starting the HTTP server
 * (importing dashboard-server.mjs would call server.listen).
 */

export const isDeepEval = (role) => (role.flags || []).includes('deep-eval');
const isLoginRequired = (role) => (role.flags || []).includes('login-required');

// Statuses a deterministic fill may run from: first fill after PREPARE
// ('prepared') or a headed re-open of an existing fill ('prefilled'/'filled').
export const FILLABLE_STATUSES = new Set(['prepared', 'prefilled', 'filled']);

// Statuses that mean "a fill already exists" — bulk runs must re-open these
// headed, never headless (see headedReopen above).
export const REOPEN_STATUSES = new Set(['prefilled', 'filled']);

export function partitionRunRoles(roles) {
  const agentPath = roles.filter((r) => r.ats === 'custom' || isDeepEval(r));
  const fillCandidates = roles.filter((r) => r.ats !== 'custom' && !isDeepEval(r));
  const notPrepared = fillCandidates.filter((r) => !FILLABLE_STATUSES.has(r.status));
  const deterministic = fillCandidates.filter(
    (r) => r.status === 'prepared' && !isLoginRequired(r)
  );
  const loginGated = fillCandidates.filter(
    (r) => FILLABLE_STATUSES.has(r.status) && isLoginRequired(r)
  );
  const headedReopen = fillCandidates.filter(
    (r) => REOPEN_STATUSES.has(r.status) && !isLoginRequired(r)
  );
  return { deterministic, loginGated, headedReopen, agentPath, notPrepared };
}
