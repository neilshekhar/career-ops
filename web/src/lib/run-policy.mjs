// Per-kind policy for the headless worker route, in ONE table.
//
// Pure JS (no TS types) so the route can import it AND a `node --test` unit test
// can exercise the real decision, matching status-alias.mjs / funnel-tiles.mjs.
// A Next route handler cannot be imported from node --test, so policy that lives
// inline in route.ts can only ever be checked by grepping its source — which is
// how an unvalidated `kind` survived: every rule was its own `kind === "..."`
// comparison, `kind` itself was never validated, and buildPrompt fell through to
// the evaluation prompt. A typo therefore ran a real evaluation with the
// required-script check, the cv.md check, the persistence verification and the
// tracker write token all silently skipped.
//
// Deriving every rule from this table, and refusing a kind that is not in it,
// makes that class of drift impossible rather than merely unlikely.

import { isShellSafeCompanyName } from "./run-prompts.mjs";

/**
 * @typedef {object} KindPolicy
 * @property {string|null} requiresScript  checkout file the kind needs, or null
 * @property {boolean} requiresCv          run is meaningless without cv.md
 * @property {boolean} persists            writes to reports/ and is verified
 * @property {boolean} holdsTrackerWrite   mutates the tracker; needs the token
 * @property {boolean} shellSafeInput      input reaches a shell command
 */

/** @type {Record<string, KindPolicy>} */
export const KIND_POLICY = {
  evaluate: {
    requiresScript: "modes/oferta.md",
    requiresCv: true,
    persists: true,
    holdsTrackerWrite: true,
    shellSafeInput: false,
  },
  pdf: {
    requiresScript: "generate-pdf.mjs",
    requiresCv: true,
    persists: false,
    holdsTrackerWrite: true,
    shellSafeInput: false,
  },
  "fix-portal": {
    requiresScript: "verify-portals.mjs",
    requiresCv: false,
    persists: false,
    holdsTrackerWrite: false,
    // The fix-portal prompt interpolates the company name into a quoted Bash
    // command and that worker still holds Bash. Names arrive from public ATS
    // listings, not only the user's typing.
    shellSafeInput: true,
  },
  research: {
    requiresScript: null,
    requiresCv: false,
    persists: false,
    holdsTrackerWrite: false,
    shellSafeInput: false,
  },
};

export const RUN_KINDS = Object.keys(KIND_POLICY);

/**
 * Resolve the policy for a request, or the 400 it should be refused with.
 *
 * Refuses rather than sanitizes an unsafe company name: a silently rewritten
 * name would repair the wrong portal, which is worse than an error.
 *
 * @param {{kind?: unknown, input?: unknown}} request
 * @returns {{ok: true, kind: string, policy: KindPolicy} | {ok: false, status: number, error: string}}
 */
export function resolveRunPolicy({ kind = "evaluate", input } = {}) {
  if (typeof input !== "string" || input === "") {
    return { ok: false, status: 400, error: "input must be a non-empty string" };
  }
  // `Object.keys`-backed lookup, not `in`: a prototype key such as
  // "constructor" or "toString" must not resolve to a policy object.
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(KIND_POLICY, kind)) {
    return {
      ok: false,
      status: 400,
      error: `unknown kind '${String(kind)}' — expected one of ${RUN_KINDS.join(", ")}`,
    };
  }
  const policy = KIND_POLICY[kind];
  if (policy.shellSafeInput && !isShellSafeCompanyName(input)) {
    return {
      ok: false,
      status: 400,
      error: "company name contains characters that are not safe to run in a shell command",
    };
  }
  return { ok: true, kind, policy };
}
