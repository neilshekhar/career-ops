#!/usr/bin/env node
/**
 * tests/portal-resume-gate.test.mjs — the portal-hosted-resume exemption, run
 * through the REAL gate.
 *
 * The first version of these tests grepped verify-userdata.mjs as source text.
 * That could not see that suppressing `cv-missing` still left the role failing
 * on `cv-source-html-missing` two checks later, so a feature that never worked
 * shipped with a green suite. Everything here calls validateApplicationRole and
 * asserts on the codes it actually returns.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass } from './helpers.mjs';

console.log('\nPortal-hosted resume — real gate behaviour');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-portal-cv-'));
for (const dir of ['config', 'modes', 'output', 'jds', 'data', 'reports']) {
  mkdirSync(join(temp, dir), { recursive: true });
}

writeFileSync(join(temp, 'cv.md'), '# CV\nSQL analysis, forecasting, stakeholder reporting.\n', 'utf8');
writeFileSync(join(temp, 'modes', '_profile.md'), '# Profile\n', 'utf8');
writeFileSync(join(temp, 'voice-dna.md'), '# Voice\nClear and direct.\n', 'utf8');
writeFileSync(join(temp, 'config', 'profile.yml'), [
  'candidate:',
  '  full_name: Test Candidate',
  'application_quality:',
  '  require_fresh_assets: false',
  '  require_quality_manifest: false',
  '  require_generation_provenance: false',
  '  require_candidate_claim_trace: false',
  '  require_banned_term_check: false',
  '  cover_body_words_min: 1',
  '  cover_body_words_max: 500',
  '  cover_required_formats: [md]',
  '',
].join('\n'), 'utf8');

const jdText = (
  'The team needs an analyst to deliver reliable SQL reporting, translate stakeholder '
  + 'requirements, validate data quality, document decisions, and communicate findings. '
).repeat(6);
writeFileSync(join(temp, 'jds', 'analyst.md'), jdText, 'utf8');

try {
  const { buildMarkdown } = await import('../generate-cover-markdown.mjs');
  const { applicationQualityConfig, validateApplicationRole } = await import('../verify-userdata.mjs');
  const { loadApplicationProfile } = await import('../application-source-contract.mjs');

  const profile = loadApplicationProfile(temp);
  const quality = applicationQualityConfig(profile);

  /** A role with a complete COVER set and deliberately no CV of any kind. */
  function roleWithoutCv(id, extra = {}) {
    const payload = {
      candidate: { name: 'Test Candidate' },
      letter: {
        company: 'Alpha Co',
        role_title: 'Analyst',
        locale: 'en',
        opening: 'I am applying to Alpha Co for the analyst role.',
        profile_intro: 'I bring reliable SQL reporting and stakeholder communication.',
        achievements: [],
        problems_section: '',
        closing: 'Thank you for reviewing my application.',
      },
    };
    writeFileSync(join(temp, 'output', `${id}-cover.md`), buildMarkdown(payload), 'utf8');
    writeFileSync(join(temp, 'output', `${id}-cover.payload.json`), JSON.stringify(payload), 'utf8');
    return {
      id,
      company: 'Alpha Co',
      title: 'Analyst',
      url: 'https://www.seek.com.au/job/12345',
      status: 'prepared',
      score: 4.4,
      flags: [],
      employment_type: 'full-time',
      jd_path: 'jds/analyst.md',
      jd_text: jdText,
      cover_letter_paths: {
        md: `output/${id}-cover.md`,
        payload: `output/${id}-cover.payload.json`,
      },
      ...extra,
    };
  }

  const check = (role, settings) => validateApplicationRole(role, {
    root: temp, profile, quality, requireAssets: true, settings,
  });
  const codes = (issues, level = 'error') => issues.filter((i) => i.level === level).map((i) => i.code);

  // ── The toggle off: a CV-less role is rejected, as it always was ──────────
  const offCodes = codes(check(roleWithoutCv('off', { cv_source: 'portal-default' }), { portal_default_cv: false }));
  assert.ok(offCodes.includes('cv-missing'), `expected cv-missing, got ${offCodes.join(', ')}`);
  assert.ok(offCodes.includes('cv-source-html-missing'));
  pass('toggle off — a CV-less role still fails on both CV requirements');

  // Absent settings must behave exactly like the toggle being off.
  const absentCodes = codes(check(roleWithoutCv('absent', { cv_source: 'portal-default' }), undefined));
  assert.ok(absentCodes.includes('cv-missing'));
  pass('absent settings default to the strict behaviour');

  // ── The toggle on, native Seek form: the role PASSES ──────────────────────
  const onIssues = check(roleWithoutCv('on', { cv_source: 'portal-default' }), { portal_default_cv: true });
  const onCodes = codes(onIssues);
  assert.deepEqual(onCodes, [], `expected no errors, got: ${onCodes.join(', ')}`);
  // This is the assertion the source-text version could not make: BOTH CV
  // requirements have to be exempt, not just the first one.
  assert.ok(!onCodes.includes('cv-missing'));
  assert.ok(!onCodes.includes('cv-source-html-missing'));
  assert.ok(codes(onIssues, 'info').includes('cv-portal-default'));
  pass('toggle on + Seek listing — the role passes the real gate, recorded as info');

  // ── The redirect case, end to end through the gate ────────────────────────
  const redirected = roleWithoutCv('redirect', {
    cv_source: 'portal-default',
    application_progress: { application_host: 'boards.greenhouse.io' },
  });
  const redirectCodes = codes(check(redirected, { portal_default_cv: true }));
  assert.ok(
    redirectCodes.includes('cv-missing'),
    `a redirect to an external ATS must re-require the CV, got: ${redirectCodes.join(', ')}`,
  );
  assert.ok(redirectCodes.includes('cv-source-html-missing'));
  pass('redirect to an external ATS re-imposes BOTH CV requirements');

  // A confirmed native host keeps the exemption.
  const confirmed = roleWithoutCv('confirmed', {
    cv_source: 'portal-default',
    application_progress: { application_host: 'www.seek.com.au' },
  });
  assert.deepEqual(codes(check(confirmed, { portal_default_cv: true })), []);
  pass('a confirmed native Seek host keeps the exemption');

  // ── The exemption is CV-scoped, never cover-scoped ───────────────────────
  const noCover = roleWithoutCv('nocover', { cv_source: 'portal-default' });
  delete noCover.cover_letter_paths;
  const noCoverCodes = codes(check(noCover, { portal_default_cv: true }));
  // Production emits cover-format-missing / cover-payload-missing — the first
  // version of this test asserted on `cover-missing`, a code that does not
  // exist, so it passed vacuously.
  assert.ok(
    noCoverCodes.some((code) => code.startsWith('cover-')),
    `a missing cover must still fail under the exemption, got: ${noCoverCodes.join(', ')}`,
  );
  pass('cover letters are still required — the exemption is CV-only');

  // ── A declared-but-broken CV path is never excused ────────────────────────
  const brokenCv = roleWithoutCv('broken', {
    cv_source: 'portal-default',
    cv_pdf: 'output/does-not-exist-cv.pdf',
  });
  assert.ok(
    codes(check(brokenCv, { portal_default_cv: true })).includes('cv-missing'),
    'a declared CV path that does not resolve must still fail',
  );
  pass('the exemption means "no CV was generated", never "a broken path is fine"');

  // ── Without cv_source the exemption never engages ────────────────────────
  assert.ok(codes(check(roleWithoutCv('nosource'), { portal_default_cv: true })).includes('cv-missing'));
  pass('a role that does not declare cv_source: portal-default is unaffected');

  // ── An external ATS listing never qualifies, toggle or not ───────────────
  const external = roleWithoutCv('external', { cv_source: 'portal-default' });
  external.url = 'https://boards.greenhouse.io/acme/jobs/1';
  assert.ok(codes(check(external, { portal_default_cv: true })).includes('cv-missing'));
  pass('a non-board listing URL never qualifies for the exemption');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
