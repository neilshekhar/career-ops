/**
 * run-partition.mjs — pure partition logic for the dashboard's batch "Run" dispatch.
 *
 * Splits a set of queue roles into three mutually exclusive classifications:
 *   - agentPath:     a durable work request for the one active-agent browser
 *                    controller running `/career-ops apply`
 *   - filledCheck:   receipt validation only — a `filled` row is either already
 *                    review-ready or needs explicit receipt repair; it is never
 *                    queued into a begin gate that only accepts prepared/prefilled
 *   - notPrepared:   notice only — asset gate: the role has no fresh PREPARE
 *                    assets, so live application work must not start yet
 *
 * The dashboard never launches Chromium, Playwright, or form-fill.mjs. ATS type
 * and deep-eval flags never bypass PREPARE: every role needs a fresh prepared
 * state before the dashboard can create consumable live-application work.
 *
 * The asset gate (FILLABLE_STATUSES) applies to ordinary ATS roles: only a role
 * PREPARE has produced assets for ('prepared'), or a legacy checkpoint being
 * resumed ('prefilled'), may be queued. `filled` is receipt-owned terminal review
 * state for live filling and is partitioned separately. A scored selection is
 * promoted durably to `prepare-queued` by dashboard-server.mjs; it is not an
 * application request until PREPARE succeeds and the role reaches `prepared`.
 * dashboard-server.mjs imports FILLABLE_STATUSES for the single-card Fill endpoint
 * too, so single and bulk fills can never drift.
 *
 * Pure + side-effect-free so it can be unit-tested without starting the HTTP server
 * (importing dashboard-server.mjs would call server.listen).
 */

export const isDeepEval = (role) => (role.flags || []).includes('deep-eval');

// Statuses accepted by the dashboard's ordinary application-request gate.
// `prefilled` is a legacy non-review-ready checkpoint; no dashboard path creates it.
export const FILLABLE_STATUSES = new Set(['prepared', 'prefilled']);

export function partitionRunRoles(roles) {
  const filledCheck = roles.filter((role) => role.status === 'filled');
  const agentPath = roles.filter(
    (role) => role.status !== 'filled' && FILLABLE_STATUSES.has(role.status),
  );
  const notPrepared = roles.filter(
    (role) => role.status !== 'filled' && !FILLABLE_STATUSES.has(role.status),
  );
  return { agentPath, filledCheck, notPrepared };
}
