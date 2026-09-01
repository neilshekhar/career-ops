/**
 * portal-resume-hosts.mjs — which job boards host the candidate's own resume.
 *
 * Seek and Indeed keep a resume on the candidate's profile and attach it to a
 * NATIVE application themselves, so generating and uploading a tailored CV for
 * one of those is duplicated work. The candidate can turn that off from the
 * dashboard (`settings.portal_default_cv`).
 *
 * That is only true while the application form is still ON the board. Both
 * boards also carry "Apply on company site" listings that hand off to an
 * external ATS — Greenhouse, Lever, Workday, SmartRecruiters, JobAdder — and
 * that ATS has no resume on file. An exemption keyed to where the role was
 * DISCOVERED would then produce an application with no CV attached at all,
 * which is precisely the failure the asset gate exists to prevent.
 *
 * So the exemption keys off `application_host`: the host of the page the form
 * is actually on, recorded when the fill reaches the form. A redirect off the
 * board leaves the role outside this list, the exemption stops applying, and
 * the ordinary "tailored CV required" rule takes over.
 *
 * Cover letters are unaffected in every case — the boards do not host one, so
 * a tailored cover letter is still generated and attached exactly as before.
 */

/**
 * Registrable base domains whose profile carries the candidate's resume.
 * A host matches when it equals one of these or is a subdomain of it, so
 * `au.indeed.com` and `www.seek.com.au` match while `seek.com.au.evil.test`
 * does not. Add a country domain here to extend the exemption to it.
 */
export const PORTAL_RESUME_HOSTS = Object.freeze([
  'seek.com.au',
  'seek.co.nz',
  'indeed.com',
]);

/** Normalize a hostname for comparison: lowercase, no trailing dot, no `www.`. */
function normalizeHost(host) {
  const lowered = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  return lowered.startsWith('www.') ? lowered.slice(4) : lowered;
}

/**
 * Extract a hostname from a URL, or from something already hostname-shaped.
 * Returns '' when nothing usable is present — callers treat that as "not a
 * portal-resume host", which is the fail-closed direction.
 */
export function hostOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    // Not an absolute URL. Accept a bare hostname, but never a path, a
    // credential-bearing authority, or anything with whitespace.
    if (/^[a-z0-9.-]+$/i.test(raw)) return normalizeHost(raw);
    return '';
  }
}

/** Does this host (or URL) belong to a board that hosts the candidate's resume? */
export function hostsCandidateResume(value) {
  const host = hostOf(value);
  if (!host) return false;
  return PORTAL_RESUME_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

/**
 * Is the portal-hosted-resume exemption live for this role?
 *
 * All three must hold, and the host that decides it is the one the FORM is on:
 *   1. the candidate turned the dashboard toggle on,
 *   2. the role records `cv_source: 'portal-default'`, and
 *   3. the application host is a board that hosts their resume.
 *
 * `application_host` is preferred; the role URL is only a fallback for a role
 * that has not reached a form yet. A role that redirected to an external ATS
 * records that ATS as its application host and so fails (3).
 */
export function portalResumeExemptionApplies(role, settings) {
  if (settings?.portal_default_cv !== true) return false;
  if (role?.cv_source !== 'portal-default') return false;
  // The committed observer stores the cross-run authority at role level. A
  // bound progress receipt mirrors it for audit/debugging, but may outlive its
  // original request after a crash and therefore cannot override the durable
  // value on a later PREPARE/gate pass.
  const applyHost = role?.application_host ?? role?.application_progress?.application_host;
  // Once a form has been reached, that host is the ONLY authority: a redirect
  // off the board must not fall back to the (still seek/indeed) role URL.
  if (applyHost) return hostsCandidateResume(applyHost);
  return hostsCandidateResume(role?.url);
}
