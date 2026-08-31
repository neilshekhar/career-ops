#!/usr/bin/env node
/**
 * tests/portal-resume-hosts.test.mjs — the portal-hosted-resume exemption.
 *
 * The whole risk of this feature is a listing that LOOKS like Seek/Indeed but
 * whose Apply button hands off to an external ATS with no resume on file. If
 * the exemption keyed off the discovery URL, that application would go out with
 * no CV attached at all. These assertions pin the host that decides it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';
import {
  PORTAL_RESUME_HOSTS,
  hostOf,
  hostsCandidateResume,
  portalResumeExemptionApplies,
} from '../portal-resume-hosts.mjs';

console.log('\nPortal-hosted resume exemption');

// ── Host matching ────────────────────────────────────────────────────────────
for (const url of [
  'https://www.seek.com.au/job/12345',
  'https://seek.com.au/job/12345',
  'https://au.indeed.com/viewjob?jk=abc',
  'https://indeed.com/viewjob?jk=abc',
  'https://SEEK.COM.AU/job/1',
  'https://seek.co.nz/job/9',
]) {
  assert.equal(hostsCandidateResume(url), true, `${url} should be a portal-resume host`);
}
pass('Seek and Indeed listings (incl. country subdomains and case variants) match');

for (const url of [
  'https://boards.greenhouse.io/acme/jobs/1',
  'https://jobs.lever.co/acme/1',
  'https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1',
  'https://careers.smartrecruiters.com/acme/1',
  'https://acme.jobadder.com/1',
  'https://www.linkedin.com/jobs/view/1',
]) {
  assert.equal(hostsCandidateResume(url), false, `${url} must NOT be a portal-resume host`);
}
pass('external ATS hosts never qualify — they hold no resume for the candidate');

// A lookalike host must not inherit the exemption by suffix confusion.
for (const spoof of [
  'https://seek.com.au.evil.test/job/1',
  'https://indeed.com.attacker.example/viewjob',
  'https://notseek.com.au/job/1',
  'https://myindeed.com/viewjob',
]) {
  assert.equal(hostsCandidateResume(spoof), false, `${spoof} must not match by suffix confusion`);
}
pass('lookalike domains do not inherit the exemption');

assert.equal(hostsCandidateResume(''), false);
assert.equal(hostsCandidateResume(null), false);
assert.equal(hostsCandidateResume(undefined), false);
assert.equal(hostsCandidateResume('not a url'), false);
assert.equal(hostOf('https://user:pass@seek.com.au/x'), 'seek.com.au');
pass('missing or malformed input fails closed, and credentials do not confuse the host');

// ── The exemption itself ─────────────────────────────────────────────────────
const seekRole = { url: 'https://www.seek.com.au/job/1', cv_source: 'portal-default' };
const on = { portal_default_cv: true };

assert.equal(portalResumeExemptionApplies(seekRole, on), true);
pass('toggle on + portal-default source + Seek host → exemption applies');

assert.equal(portalResumeExemptionApplies(seekRole, { portal_default_cv: false }), false);
assert.equal(portalResumeExemptionApplies(seekRole, {}), false);
assert.equal(portalResumeExemptionApplies(seekRole, undefined), false);
pass('the toggle is required — default (absent) means no exemption');

assert.equal(portalResumeExemptionApplies({ ...seekRole, cv_source: undefined }, on), false);
assert.equal(portalResumeExemptionApplies({ ...seekRole, cv_source: 'tailored' }, on), false);
pass('a role must actually declare cv_source: portal-default');

// THE redirect case: discovered on Seek, form served by an external ATS.
const redirected = {
  url: 'https://www.seek.com.au/job/1',
  cv_source: 'portal-default',
  application_progress: { application_host: 'boards.greenhouse.io' },
};
assert.equal(
  portalResumeExemptionApplies(redirected, on),
  false,
  'a Seek listing that redirects to an external ATS must lose the exemption',
);
pass('redirect to an external ATS revokes the exemption — the form host decides, not the listing');

// ...and the same role while it is still on the board keeps it.
assert.equal(
  portalResumeExemptionApplies(
    { ...redirected, application_progress: { application_host: 'www.seek.com.au' } },
    on,
  ),
  true,
);
pass('a native Seek form keeps the exemption once the host is confirmed');

// A recorded host is authoritative even when the listing URL still says Seek —
// otherwise a redirect could fall back to the discovery URL and re-qualify.
assert.equal(
  portalResumeExemptionApplies(
    { url: 'https://www.seek.com.au/job/1', cv_source: 'portal-default', application_host: 'acme.wd3.myworkdayjobs.com' },
    on,
  ),
  false,
);
pass('a recorded application host overrides the listing URL, never the reverse');

// ── The gate honours it, and only it ─────────────────────────────────────────
const gate = readFileSync(join(ROOT, 'verify-userdata.mjs'), 'utf8');
assert.match(gate, /portalResumeExemptionApplies\(role, options\.settings\)/,
  'the asset gate must consult the exemption before erroring on a missing CV');
assert.match(gate, /settings: queue\.settings/,
  'queue settings must reach validateApplicationRole or the toggle can never be seen');
assert.match(gate, /'cv-missing'/,
  'the hard cv-missing error must still exist for every non-exempt role');
pass('verify-userdata.mjs gates the exemption and keeps cv-missing for everyone else');

// The cover letter is never part of this exemption.
assert.doesNotMatch(
  gate,
  /portalResumeExemptionApplies[\s\S]{0,400}cover-missing/,
  'the portal exemption must never be extended to cover letters',
);
pass('cover letters stay required — the boards host a resume, not a cover letter');
