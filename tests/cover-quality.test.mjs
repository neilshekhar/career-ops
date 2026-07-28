#!/usr/bin/env node
/**
 * tests/cover-quality.test.mjs — Finding 4 acceptance tests.
 *
 *   1. English configured-greeting output contains the selected fallback + sign-off
 *   2. Non-English output passes with its localized salutation
 *   3. Payload, Markdown, PDF-HTML, and DOCX stay content-consistent
 *   4. Repeated normalized skeletons trigger the configured policy
 *   5. The FULL configured banned-term list is checked (the original audit
 *      scanned a hand-typed subset and missed real hits)
 *   6. Every CV carries a supported template identity
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';

console.log('\nCover greeting, sign-off, banned terms, template identity');

const {
  BANNED_TERMS_BEGIN,
  BANNED_TERMS_END,
  GREETING_LADDERS,
  SIGNOFF_LADDERS,
  bannedTermHits,
  coverSkeletonFingerprints,
  greetingAcceptable,
  parseBannedTerms,
  resolveGreeting,
  resolveSignoff,
  signoffAcceptable,
  skeletonFingerprint,
} = await import('../cover-quality.mjs');
const { buildMarkdown } = await import('../generate-cover-markdown.mjs');
const { buildHtml } = await import('../generate-cover-letter.mjs');
const { validateCoverPayload, applicationQualityConfig } = await import('../verify-userdata.mjs');

// ── 1. The greeting ladder never yields an empty salutation ─────────────────
assert.equal(resolveGreeting({ name: 'Jane Smith', company: 'Acme' }).greeting, 'Dear Jane Smith,');
assert.equal(resolveGreeting({ name: 'Jane Smith', company: 'Acme' }).rung, 'named');
assert.equal(resolveGreeting({ company: 'Acme' }).greeting, 'Dear Acme Hiring Team,');
assert.equal(resolveGreeting({ company: 'Acme' }).rung, 'team');
assert.equal(resolveGreeting({}).greeting, 'Dear Hiring Manager,');
assert.equal(resolveGreeting({}).rung, 'generic');
pass('the greeting ladder walks named → company team → generic and is never empty');

// This is the actual regression: "no name known" used to mean "no greeting".
for (const options of [{}, { company: '' }, { name: '' }, { name: '', company: '' }]) {
  assert.ok(resolveGreeting(options).greeting.length > 0);
}
pass('an unknown hiring contact yields a generic salutation, never an omitted one');

assert.equal(resolveSignoff({}).signoff, 'Kind regards,');
pass('the sign-off default is supplied for the default locale');

// ── 2. Localized salutations pass; a global /^Dear\b.*,$/ would reject them ──
const LOCALE_CASES = [
  ['de', 'Sehr geehrte Damen und Herren,', 'Mit freundlichen Grüßen,'],
  ['ja', 'ご担当者様', '敬具'],
  ['ar', 'حضرة المسؤول المحترم،', 'وتفضلوا بقبول فائق الاحترام،'],
  ['zh', '尊敬的招聘负责人：', '此致敬礼'],
  ['fr', 'Madame, Monsieur,', 'Cordialement,'],
];
for (const [locale, greeting, signoff] of LOCALE_CASES) {
  assert.equal(resolveGreeting({ locale }).greeting, greeting, `${locale} generic greeting`);
  assert.equal(resolveSignoff({ locale }).signoff, signoff, `${locale} sign-off`);
  assert.ok(greetingAcceptable(greeting, { locale }), `${locale} greeting must be acceptable`);
  assert.ok(signoffAcceptable(signoff, { locale }), `${locale} sign-off must be acceptable`);
  // And the brittle English rule really would have failed them.
  assert.ok(!/^Dear\b.*,$/.test(greeting), `${locale} proves the /^Dear.*,$/ rule is wrong`);
}
pass('non-English salutations and sign-offs pass their own locale ladder');

// A named contact must be recorded in the canonical payload context. Merely
// looking like a salutation is not evidence that the name was real.
assert.ok(greetingAcceptable('Sehr geehrte/r Frau Müller,', { locale: 'de', name: 'Frau Müller' }));
assert.ok(greetingAcceptable('Dear Jane Smith,', { locale: 'en', name: 'Jane Smith' }));
assert.ok(!greetingAcceptable('Dear Someone We Did Not Record,', { locale: 'en' }));
assert.ok(!greetingAcceptable('My dear friend', { locale: 'en' }));
pass('a named salutation passes only when the exact contact is recorded');

assert.ok(!greetingAcceptable('', { locale: 'en' }), 'empty greeting must be rejected');
assert.ok(!greetingAcceptable('Hey there!!', { locale: 'en' }), 'a non-ladder salutation is rejected');
assert.ok(!signoffAcceptable('Cheers mate', { locale: 'en' }));
pass('empty and off-ladder salutations/sign-offs are rejected');

// Every shipped locale has both a full greeting ladder and a sign-off.
for (const [locale, ladder] of Object.entries(GREETING_LADDERS)) {
  for (const rung of ['named', 'team', 'generic']) {
    assert.ok(ladder[rung]?.trim(), `${locale} ladder is missing the ${rung} rung`);
  }
  assert.ok(ladder.named.includes('{name}'), `${locale} named rung must interpolate {name}`);
  assert.ok(ladder.team.includes('{company}'), `${locale} team rung must interpolate {company}`);
  assert.ok(SIGNOFF_LADDERS[locale]?.trim(), `${locale} has no sign-off`);
}
pass(`all ${Object.keys(GREETING_LADDERS).length} shipped locales have a complete ladder and sign-off`);

// ── 3. Content consistency across every rendered format ────────────────────
const payload = {
  candidate: { name: 'Test Candidate', email: 'test@example.invalid', location: 'Melbourne' },
  letter: {
    company: 'Acme Analytics',
    role_title: 'Data Scientist',
    city: 'Melbourne',
    date: '2026-07-28',
    locale: 'en',
    greeting: 'Dear Acme Analytics Hiring Team,',
    opening: 'I am applying because the forecasting brief matches what I already do.',
    profile_intro: 'Six years building demand models and reporting pipelines.',
    achievements: [{ lead: 'Cut forecast error', impact: 'from 18% to 9% across 40 lines.' }],
    problems_section: 'Your stock-out problem is a forecasting horizon problem.',
    closing: 'I can start immediately and would value a conversation.',
    signoff: 'Kind regards,',
    signature_name: 'Test Candidate',
  },
};

const markdown = buildMarkdown(payload);
const html = buildHtml(payload);
for (const [format, rendered] of [['Markdown', markdown], ['HTML', html]]) {
  assert.ok(rendered.includes('Dear Acme Analytics Hiring Team,'), `${format} is missing the greeting`);
  assert.ok(rendered.includes('Kind regards,'), `${format} is missing the sign-off`);
  assert.ok(rendered.includes('Test Candidate'), `${format} is missing the signature name`);
}
// The sign-off must come AFTER the closing in both, not float to the top.
assert.ok(markdown.indexOf('Kind regards,') > markdown.indexOf('would value a conversation'));
assert.ok(html.indexOf('Kind regards,') > html.indexOf('would value a conversation'));
// And the signature name must follow the sign-off line. Scope the HTML check to
// <body>: the `.signature-name` selector also appears earlier, in <style>.
assert.ok(markdown.lastIndexOf('Test Candidate') > markdown.indexOf('Kind regards,'));
const htmlBody = html.slice(html.indexOf('<body'));
assert.match(
  htmlBody,
  /<p>Kind regards,<\/p>\s*<p class="signature-name">Test Candidate<\/p>/,
  'the signature name must render immediately after the sign-off line',
);
pass('greeting and sign-off render, in order, in both Markdown and HTML/PDF');

// The DOCX is produced from this Markdown via pandoc, so Markdown consistency IS
// DOCX consistency. Assert the structural carrier explicitly.
assert.match(markdown, /Kind regards,\s{2}\nTest Candidate/, 'sign-off needs a hard break before the name for pandoc');
pass('the Markdown sign-off carries a hard line break so the DOCX keeps the name on its own line');

// No template token may survive substitution.
assert.doesNotMatch(html, /\{\{SIGNOFF_BLOCK\}\}/);
assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'an unsubstituted template token leaked into the HTML');
pass('the cover template has no unsubstituted tokens after rendering');

// A payload with no sign-off still renders (historical payloads stay re-renderable).
const legacy = { ...payload, letter: { ...payload.letter } };
delete legacy.letter.signoff;
delete legacy.letter.signature_name;
delete legacy.letter.greeting;
const legacyHtml = buildHtml(legacy);
assert.doesNotMatch(legacyHtml, /\{\{[A-Z_]+\}\}/);
assert.ok(!legacyHtml.includes('class="signoff"'));
pass('a historical payload without greeting/sign-off still renders cleanly');

// ── The validator enforces both when configured ────────────────────────────
const strict = applicationQualityConfig({
  cover: { greeting_required: true, signoff_required: true },
  application_quality: { cover_body_words_min: 1, cover_body_words_max: 500 },
});
assert.equal(strict.requireGreeting, true);
assert.equal(strict.requireSignoff, true);
assert.deepEqual(validateCoverPayload(payload, strict), []);
pass('a complete letter passes the configured greeting/sign-off gate');

const noGreeting = { ...payload, letter: { ...payload.letter, greeting: '' } };
const greetingErrors = validateCoverPayload(noGreeting, strict);
assert.equal(greetingErrors.length, 1);
assert.match(greetingErrors[0], /has no greeting; the configured fallback for this locale is "Dear Acme Analytics Hiring Team,"/);
pass('a missing greeting fails and the error names the exact fallback to use');

const noSignoff = { ...payload, letter: { ...payload.letter, signoff: '', signature_name: '' } };
const signoffErrors = validateCoverPayload(noSignoff, strict);
assert.equal(signoffErrors.length, 2);
assert.ok(signoffErrors.some((e) => /has no sign-off/.test(e)));
assert.ok(signoffErrors.some((e) => /no signature_name/.test(e)));
pass('a missing sign-off and signature name both fail');

// Greeting/sign-off remain payload-shape controlled when no cover block exists.
const lenient = applicationQualityConfig({ application_quality: { cover_body_words_min: 1, cover_body_words_max: 500 } });
assert.equal(lenient.requireGreeting, false);
assert.equal(lenient.requireSignoff, false);
assert.equal(lenient.requireBannedTermCheck, true);
assert.equal(lenient.requireRoleTailoredCv, true);
assert.deepEqual(validateCoverPayload(noGreeting, lenient), []);
pass('tailoring and banned terms fail closed by default while greeting shape follows the cover block');

// A German letter validated under the German locale passes.
const germanQuality = applicationQualityConfig({
  cover: { greeting_required: true, signoff_required: true },
  application_quality: { cover_locale: 'de', cover_body_words_min: 1, cover_body_words_max: 500 },
});
assert.equal(germanQuality.coverLocale, 'de');
const germanPayload = {
  ...payload,
  letter: {
    ...payload.letter,
    locale: 'de',
    greeting: 'Sehr geehrte Damen und Herren,',
    signoff: 'Mit freundlichen Grüßen,',
  },
};
assert.deepEqual(validateCoverPayload(germanPayload, germanQuality), []);
// An English salutation declared as German must FAIL — proving the check is
// locale-scoped rather than a permissive "any non-empty string".
const mismatchedGermanPayload = {
  ...payload,
  letter: { ...payload.letter, locale: 'de' },
};
assert.ok(validateCoverPayload(mismatchedGermanPayload, germanQuality).length > 0);
pass('acceptance 2: a localized letter passes its locale and an English one fails it');

// The payload locale wins over a different global profile locale for one-off
// localized applications.
const englishProfileQuality = applicationQualityConfig({
  cover: { greeting_required: true, signoff_required: true, locale: 'en' },
  application_quality: { cover_body_words_min: 1, cover_body_words_max: 500 },
});
assert.deepEqual(validateCoverPayload(germanPayload, englishProfileQuality), []);
pass('canonical payload locale overrides the profile locale for a one-off localized letter');

// Locale can also be inferred from language.modes_dir.
assert.equal(
  applicationQualityConfig({ language: { modes_dir: 'modes/ja' } }).coverLocale,
  'ja',
);
pass('the cover locale is inferred from language.modes_dir when not set explicitly');

// ── 5. The FULL canonical banned-term list is parsed and checked ────────────
const voiceDna = readFileSync(join(ROOT, 'voice-dna.md'), 'utf8');
assert.ok(voiceDna.includes(BANNED_TERMS_BEGIN), 'voice-dna.md is missing the banned-term begin marker');
assert.ok(voiceDna.includes(BANNED_TERMS_END), 'voice-dna.md is missing the banned-term end marker');

const parsed = parseBannedTerms(voiceDna);
assert.equal(parsed.parsed, true);
assert.ok(parsed.terms.length > 70, `expected the full list, parsed only ${parsed.terms.length}`);
pass(`the canonical banned-term block parses deterministically (${parsed.terms.length} terms)`);

// Scoping syntax is handled: parentheticals dropped, slashed pairs both registered.
assert.ok(parsed.terms.includes('landscape'), '`landscape (abstract)` must register the bare word');
assert.ok(!parsed.terms.some((t) => t.includes('(')), 'no parsed term may retain a parenthetical');
assert.ok(parsed.terms.includes('intricate') && parsed.terms.includes('intricacies'),
  '`intricate/intricacies` must register both forms');
assert.ok(parsed.terms.includes('cutting-edge'), 'hyphenated terms survive parsing');
for (const term of ['excited', 'passionate', 'stakeholder alignment', 'actionable insights', 'strong track record']) {
  assert.ok(parsed.terms.includes(term), `cover hard ban must be machine-readable: ${term}`);
}
pass('parenthetical scoping and slashed variants are parsed correctly');

// The resolved Finding 4 decision: `predictive` is unbanned.
assert.ok(!parsed.terms.includes('predictive'),
  '`predictive` must be unbanned — it is a real technique name and a live ATS keyword');
assert.ok(voiceDna.includes('`predictive` is deliberately NOT on this list'),
  'the unban must be documented where a future editor will see it');
pass('`predictive` is unbanned and the reason is recorded in the shared policy');

// Real detection, with word boundaries.
const hits = bannedTermHits('We leveraged a seamless, robust and holistic approach.', parsed.terms);
const found = hits.map((hit) => hit.term).sort();
assert.deepEqual(found, ['holistic', 'robust', 'seamless']);
pass('banned-term detection finds every hit in a sentence');

// `align` must not fire on unrelated "alignment"; `harness` must not fire on
// "harnesses". The explicitly banned phrase "stakeholder alignment" is tested
// separately below.
assert.deepEqual(bannedTermHits('Team alignment and wiring harnesses.', parsed.terms), []);
assert.deepEqual(bannedTermHits('We align teams.', parsed.terms).map((h) => h.term), ['align']);
pass('banned-term matching is word-boundary aware (alignment/harnesses do not false-positive)');

// Counts are reported, which is what makes a real audit possible.
assert.deepEqual(
  bannedTermHits('robust robust robust', parsed.terms),
  [{ term: 'robust', count: 3 }],
);
pass('banned-term hits report occurrence counts');

// `predictive modeling` is now clean — the whole point of the decision.
assert.deepEqual(bannedTermHits('Built predictive models for demand planning.', parsed.terms), []);
pass('`predictive modeling` no longer trips the banned-term gate');

assert.deepEqual(
  bannedTermHits('I am excited by this unique opportunity and my strong track record.', parsed.terms)
    .map((hit) => hit.term).sort(),
  ['excited', 'strong track record', 'unique opportunity'],
);
pass('cover-specific hard bans are part of deterministic enforcement');

// Per-user overrides resolve without touching the shared list.
const { resolveBannedTerms } = await import('../cover-quality.mjs');
const overridden = resolveBannedTerms(ROOT, {
  bannedTermsAllow: ['robust'],
  bannedTermsAdd: ['spearheaded'],
});
assert.ok(!overridden.terms.includes('robust'), 'banned_terms_allow must remove a term');
assert.ok(overridden.terms.includes('spearheaded'), 'banned_terms_add must add a term');
assert.ok(overridden.terms.includes('seamless'), 'the rest of the shared list survives');
pass('banned_terms_allow / banned_terms_add override the shared list per user');

// A file with no machine-readable block reports parsed:false rather than an
// empty list that would silently disable enforcement.
assert.equal(parseBannedTerms('# Voice\nJust prose, no block.\n').parsed, false);
assert.equal(parseBannedTerms('').parsed, false);
pass('a policy file with no machine-readable block reports unparseable, not "nothing banned"');

// ── 4. Skeleton fingerprints catch repetition, not legitimate reuse ─────────
const openingA = 'I am applying to Coles because the forecasting brief matches my work.';
const openingB = 'I am applying to Woolworths because the forecasting brief matches my work.';
const fpA = skeletonFingerprint(openingA, { company: 'Coles', title: 'Data Scientist' });
const fpB = skeletonFingerprint(openingB, { company: 'Woolworths', title: 'Data Scientist' });
assert.equal(fpA, fpB, 'two letters differing only by employer name must collide');
pass('acceptance 4: normalized skeletons collide when only the company name differs');

const genuine = skeletonFingerprint(
  'Your stock-out rate is a forecast-horizon problem, and I have fixed exactly that.',
  { company: 'Coles', title: 'Data Scientist' },
);
assert.notEqual(fpA, genuine, 'a genuinely different opening must not collide');
pass('a genuinely rewritten opening produces a different fingerprint');

// Short shared boilerplate (work rights) must not be mistaken for the skeleton:
// only the opening and closing are fingerprinted, never the whole letter.
const prints = coverSkeletonFingerprints(payload, { company: 'Acme Analytics', title: 'Data Scientist' });
assert.ok(prints.opening && prints.closing);
assert.notEqual(prints.opening, prints.closing);
assert.equal(skeletonFingerprint('', {}), null);
assert.equal(skeletonFingerprint('   ', {}), null);
pass('only the opening and closing are fingerprinted; empty text yields no fingerprint');

// ── 6. Template identity ───────────────────────────────────────────────────
const cvTemplate = readFileSync(join(ROOT, 'templates', 'cv-template.html'), 'utf8');
assert.match(cvTemplate, /<meta name="career-ops-template-id" content="cv-template">/);
assert.match(cvTemplate, /<meta name="career-ops-template-version" content="\d+">/);
pass('acceptance 6: the shipped CV template stamps a supported template identity');

const { detectAssetTemplates, SUPPORTED_CV_TEMPLATES } = await import('../generation-provenance.mjs');
assert.ok(SUPPORTED_CV_TEMPLATES.length > 0);
assert.equal(typeof detectAssetTemplates, 'function');
pass('generation provenance exposes template detection over a supported-renderer list');
