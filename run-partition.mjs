/**
 * run-partition.mjs — pure partition logic for the dashboard's batch "Run" dispatch.
 *
 * Splits a set of queue roles into the three execution lanes the dashboard fills by:
 *   - deterministic: headless parallel form-fill.mjs (GH/Lever/Ashby, no login wall)
 *   - loginGated:    serial headed fill behind a login wall
 *   - agentPath:     notice only — the candidate must run `/career-ops apply`
 *
 * deep-eval-marked roles ALWAYS go to agentPath so a full `oferta` runs before any
 * fill (the headless server has no LLM) — see modes/apply.md → "Deep-eval marker".
 *
 * Pure + side-effect-free so it can be unit-tested without starting the HTTP server
 * (importing dashboard-server.mjs would call server.listen).
 */

export const isDeepEval = (role) => (role.flags || []).includes('deep-eval');
const isLoginRequired = (role) => (role.flags || []).includes('login-required');

export function partitionRunRoles(roles) {
  const agentPath = roles.filter((r) => r.ats === 'custom' || isDeepEval(r));
  const deterministic = roles.filter((r) =>
    r.ats !== 'custom' && !isDeepEval(r) && !isLoginRequired(r)
  );
  const loginGated = roles.filter((r) =>
    isLoginRequired(r) && r.ats !== 'custom' && !isDeepEval(r)
  );
  return { deterministic, loginGated, agentPath };
}
