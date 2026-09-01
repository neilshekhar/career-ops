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

assert.equal(
  portalResumeExemptionApplies({
    url: 'https://www.seek.com.au/job/1',
    cv_source: 'portal-default',
    application_host: 'boards.greenhouse.io',
    application_progress: { application_host: 'www.seek.com.au' },
  }, on),
  false,
);
pass('the durable role host overrides an abandoned progress receipt');

// ── Every gate that can block a fill must see the toggle ─────────────────────
// Behaviour is covered by tests/portal-resume-gate.test.mjs, which runs the real
// validateApplicationRole. What source text is still the right tool for is
// PROPAGATION: an exemption the CLI honours but the dashboard and One-shot gates
// cannot see is worse than no exemption at all, because it fails only on the
// paths that matter. Each of these call sites must pass queue settings through.
for (const [file, needle] of [
  ['verify-userdata.mjs', /settings: queue\.settings/],
  ['dashboard-server.mjs', /settings: freshQueue\.settings/],
  ['one-shot-request.mjs', /settings: queue\.settings/],
]) {
  assert.match(readFileSync(join(ROOT, file), 'utf8'), needle,
    `${file} must pass queue settings into validateApplicationRole`);
}
const verifyUserdata = readFileSync(join(ROOT, 'verify-userdata.mjs'), 'utf8');
assert.match(verifyUserdata, /settings: options\.settings \?\? \{\}/,
  'quality-evidence construction must fail closed when no queue snapshot is supplied');
assert.doesNotMatch(verifyUserdata, /options\.settings \?\? loadQueue\(\)\.settings/,
  'a pure quality-evidence helper must not perform a hidden live queue read');
// One-shot verifies AND dispatches; both re-run the gate under the lock.
const oneShot = readFileSync(join(ROOT, 'one-shot-request.mjs'), 'utf8');
assert.equal((oneShot.match(/settings: queue\.settings/g) || []).length, 2,
  'both the One-shot verify and dispatch gates must pass settings');
const dashboard = readFileSync(join(ROOT, 'dashboard-server.mjs'), 'utf8');
assert.equal((dashboard.match(/settings: freshQueue\.settings/g) || []).length, 2,
  'both the dashboard Run and individual Fill gates must pass settings');
pass('all verify, dashboard and One-shot asset gates receive the queue settings the exemption depends on');

// ── Every live entry point invokes the committed redirect observer ───────────
// Runtime behaviour (including persistence after the 409) is exercised by
// tests/lean-application.test.mjs. These source assertions pin propagation to
// both protocols and to lookup, which runs before any values are filled.
const receipt = readFileSync(join(ROOT, 'application-receipt.mjs'), 'utf8');
const lean = readFileSync(join(ROOT, 'lean-application.mjs'), 'utf8');
const applyPage = readFileSync(join(ROOT, 'apply-page.mjs'), 'utf8');
assert.match(receipt, /export function recordObservedApplicationHost[\s\S]*?mutateQueue/,
  'the observer must own a committed queue transaction');
assert.match(receipt, /export function beginRole[\s\S]*?recordObservedApplicationHost/,
  'receipt and default begin must observe the reached tab host');
assert.match(receipt, /export function recordRolePage[\s\S]*?recordObservedApplicationHost/,
  'receipt-v3 page writes must re-observe the host');
assert.match(lean, /export function beginLeanOrReceipt[\s\S]*?beginRole/,
  'the lean lifecycle helper must delegate to the host-observing canonical begin');
assert.match(lean, /export function recordLeanPage[\s\S]*?recordObservedApplicationHost/,
  'lean page writes must re-observe the host');
assert.match(lean, /export function finishLean[\s\S]*?recordObservedApplicationHost/,
  'lean finish must re-observe the terminal browser URL');
assert.match(applyPage, /function lookupCommand[\s\S]*?recordObservedApplicationHost/,
  'lookup must revoke a redirect exemption before any form value is filled');
pass('all live begin/page/lookup paths invoke the committed redirect observer');
