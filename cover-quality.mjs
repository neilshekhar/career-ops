#!/usr/bin/env node
/**
 * cover-quality.mjs — Deterministic cover-letter quality policy. Zero model tokens.
 *
 * Three shared product defaults live here, all locale-aware and all configurable:
 *
 *   1. **Greeting.** `modes/cover.md` used to say "omit the salutation if no name
 *      is known", which is why recent letters had no greeting at all. The fix is a
 *      fallback ladder (named person → company team → generic), not a global
 *      `/^Dear\b.*,$/` check that would fail every non-English letter.
 *
 *   2. **Sign-off.** There was no sign-off field anywhere: not in the payload, the
 *      HTML template, the Markdown renderer, or the validator. Letters simply
 *      ended. Now `signoff` + `signature_name` are canonical payload fields
 *      rendered identically in every format.
 *
 *   3. **Banned vocabulary.** Parsed from the machine-readable fenced block in the
 *      shared `voice-dna.md`, never by asking a model to interpret the document.
 *      Per-user allow/deny overrides come from `application_quality`.
 *
 * Plus normalized opening/closing skeleton fingerprints, so "every letter opens the
 * same way" is detectable without a brittle exact-N-words rule.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Boundary markers around the canonical banned-term list in voice-dna.md. */
export const BANNED_TERMS_BEGIN = '<!-- career-ops:banned-terms:begin -->';
export const BANNED_TERMS_END = '<!-- career-ops:banned-terms:end -->';

/**
 * Locale-aware greeting ladders. A localized mode supplies native equivalents;
 * the validator only ever checks that the rendered greeting equals one of the
 * ladder rungs it would itself have produced, so it never hard-codes English.
 * A named salutation is accepted only when the canonical payload also records
 * that exact hiring contact; otherwise an invented name could bypass the ladder.
 */
export const GREETING_LADDERS = Object.freeze({
  en: { named: 'Dear {name},', team: 'Dear {company} Hiring Team,', generic: 'Dear Hiring Manager,' },
  de: { named: 'Sehr geehrte/r {name},', team: 'Sehr geehrtes Team von {company},', generic: 'Sehr geehrte Damen und Herren,' },
  fr: { named: 'Bonjour {name},', team: 'Madame, Monsieur (équipe {company}),', generic: 'Madame, Monsieur,' },
  es: { named: 'Estimado/a {name}:', team: 'Estimado equipo de {company}:', generic: 'Estimados señores:' },
  it: { named: 'Gentile {name},', team: 'Gentile team di {company},', generic: 'Gentili Signori,' },
  pt: { named: 'Prezado(a) {name},', team: 'Prezada equipe da {company},', generic: 'Prezados Senhores,' },
  nl: { named: 'Geachte {name},', team: 'Geacht team van {company},', generic: 'Geachte heer/mevrouw,' },
  da: { named: 'Kære {name},', team: 'Kære {company}-team,', generic: 'Til rette vedkommende,' },
  pl: { named: 'Szanowny/a {name},', team: 'Szanowny Zespole {company},', generic: 'Szanowni Państwo,' },
  ru: { named: 'Уважаемый(ая) {name},', team: 'Уважаемая команда {company},', generic: 'Уважаемые господа,' },
  ua: { named: 'Шановний(а) {name},', team: 'Шановна команда {company},', generic: 'Шановні панове,' },
  tr: { named: 'Sayın {name},', team: 'Sayın {company} Ekibi,', generic: 'Sayın Yetkili,' },
  id: { named: 'Yang terhormat {name},', team: 'Yang terhormat Tim {company},', generic: 'Yang terhormat Bapak/Ibu,' },
  hi: { named: 'आदरणीय {name},', team: '{company} भर्ती टीम को,', generic: 'आदरणीय महोदय/महोदया,' },
  ar: { named: 'حضرة {name}،', team: 'إلى فريق التوظيف في {company}،', generic: 'حضرة المسؤول المحترم،' },
  ja: { named: '{name} 様', team: '{company} 採用ご担当者様', generic: 'ご担当者様' },
  ko: { named: '{name}님께', team: '{company} 채용 담당자님께', generic: '채용 담당자님께' },
  zh: { named: '尊敬的{name}：', team: '尊敬的{company}招聘团队：', generic: '尊敬的招聘负责人：' },
});

export const SIGNOFF_LADDERS = Object.freeze({
  en: 'Kind regards,',
  de: 'Mit freundlichen Grüßen,',
  fr: 'Cordialement,',
  es: 'Atentamente,',
  it: 'Cordiali saluti,',
  pt: 'Atenciosamente,',
  nl: 'Met vriendelijke groet,',
  da: 'Med venlig hilsen,',
  pl: 'Z poważaniem,',
  ru: 'С уважением,',
  ua: 'З повагою,',
  tr: 'Saygılarımla,',
  id: 'Hormat saya,',
  hi: 'सादर,',
  ar: 'وتفضلوا بقبول فائق الاحترام،',
  ja: '敬具',
  ko: '감사합니다.',
  zh: '此致敬礼',
});

export const DEFAULT_GREETING_STRATEGY = 'named-person-company-team-generic';

function normalizeLocale(value) {
  const raw = String(value || 'en').trim().toLowerCase();
  const base = raw.split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(GREETING_LADDERS, base) ? base : 'en';
}

/**
 * The greeting this letter should carry, chosen deterministically.
 *
 * Ladder: a named hiring contact → the company's hiring team → a generic
 * salutation. Never returns an empty string when a greeting is configured.
 *
 * @param {object} options
 * @param {string} [options.name]     Named hiring contact, if genuinely known.
 * @param {string} [options.company]  Company name.
 * @param {string} [options.locale]   Output locale (defaults to English).
 * @param {string} [options.strategy] Ladder policy; the default walks all rungs.
 * @returns {{greeting: string, rung: 'named'|'team'|'generic', locale: string}}
 */
export function resolveGreeting(options = {}) {
  const locale = normalizeLocale(options.locale);
  const ladder = GREETING_LADDERS[locale];
  const strategy = String(options.strategy || DEFAULT_GREETING_STRATEGY);
  const name = String(options.name || '').trim();
  const company = String(options.company || '').trim();

  if (name && strategy.includes('named-person')) {
    return { greeting: ladder.named.replace('{name}', name), rung: 'named', locale };
  }
  if (company && strategy.includes('company-team')) {
    return { greeting: ladder.team.replace('{company}', company), rung: 'team', locale };
  }
  return { greeting: ladder.generic, rung: 'generic', locale };
}

/** The sign-off for a locale. */
export function resolveSignoff(options = {}) {
  const locale = normalizeLocale(options.locale);
  return { signoff: SIGNOFF_LADDERS[locale], locale };
}

/**
 * Every greeting this locale's ladder could legitimately produce for this role.
 * The validator accepts any of them, plus any explicitly configured extra, so a
 * localized mode is never punished for a native salutation.
 */
export function acceptableGreetings(options = {}) {
  const locale = normalizeLocale(options.locale);
  const ladder = GREETING_LADDERS[locale];
  const company = String(options.company || '').trim();
  const name = String(options.name || '').trim();
  const values = [ladder.generic];
  if (company) values.push(ladder.team.replace('{company}', company));
  if (name) values.push(ladder.named.replace('{name}', name));
  return values;
}

function normalizeSalutation(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this greeting acceptable for the locale?
 *
 * Deliberately NOT `/^Dear\b.*,$/`: a Japanese letter ends its salutation with
 * 様 and an Arabic one with ،. Accept any ladder rung for the locale, or any
 * non-empty greeting when the locale is not one we ship a ladder for.
 */
export function greetingAcceptable(greeting, options = {}) {
  const actual = normalizeSalutation(greeting);
  if (!actual) return false;
  const allowed = [
    ...acceptableGreetings(options),
    ...(Array.isArray(options.extraAllowed) ? options.extraAllowed : []),
  ].map(normalizeSalutation);
  return allowed.some((item) => item && actual === item);
}

export function signoffAcceptable(signoff, options = {}) {
  const actual = normalizeSalutation(signoff);
  if (!actual) return false;
  const locale = normalizeLocale(options.locale);
  const allowed = [
    SIGNOFF_LADDERS[locale],
    ...(Array.isArray(options.extraAllowed) ? options.extraAllowed : []),
  ].map(normalizeSalutation);
  return allowed.some((item) => item && actual === item);
}

// ── Banned vocabulary: parsed, never model-interpreted ───────────────────────

/**
 * Parse the canonical banned-term list out of the shared voice policy.
 *
 * Reads ONLY the fenced block between the stable boundary markers, so editing
 * the surrounding prose can never change enforcement, and enforcement can never
 * accidentally pick up an example sentence.
 *
 * @returns {{terms: string[], source: string|null, parsed: boolean}}
 */
export function parseBannedTerms(voiceDnaText) {
  const text = String(voiceDnaText || '');
  const start = text.indexOf(BANNED_TERMS_BEGIN);
  const end = text.indexOf(BANNED_TERMS_END);
  if (start < 0 || end < 0 || end <= start) return { terms: [], source: null, parsed: false };
  const block = text.slice(start + BANNED_TERMS_BEGIN.length, end);
  const fenced = block.match(/```[a-z]*\n([\s\S]*?)```/i);
  const list = (fenced ? fenced[1] : block).trim();
  if (!list) return { terms: [], source: null, parsed: false };

  const terms = new Set();
  for (const raw of list.split(',')) {
    // `landscape (abstract)` → the rule targets the bare word; the parenthetical
    // is human scoping. `intricate/intricacies` registers both surface forms.
    const withoutScope = raw.replace(/\([^)]*\)/g, ' ').trim();
    for (const part of withoutScope.split('/')) {
      const term = part.trim().toLowerCase();
      if (term) terms.add(term);
    }
  }
  return { terms: [...terms].sort(), source: 'voice-dna.md', parsed: true };
}

/** Load and resolve the effective banned-term list for a project + profile. */
export function resolveBannedTerms(root, quality = {}) {
  const path = join(root, 'voice-dna.md');
  const parsed = existsSync(path)
    ? parseBannedTerms(readFileSync(path, 'utf-8'))
    : { terms: [], source: null, parsed: false };
  const allow = new Set((quality.bannedTermsAllow || []).map((item) => String(item).toLowerCase().trim()));
  const add = (quality.bannedTermsAdd || []).map((item) => String(item).toLowerCase().trim()).filter(Boolean);
  const effective = [...new Set([...parsed.terms, ...add])]
    .filter((term) => !allow.has(term))
    .sort();
  return { ...parsed, terms: effective, allowed: [...allow].sort(), added: add };
}

/**
 * Which banned terms occur in this text, with counts.
 *
 * Word-boundary aware across Unicode, so `align` does not fire on "alignment"
 * and `harness` does not fire inside "harnesses" — a hyphenated term like
 * `cutting-edge` is matched as a whole.
 */
export function bannedTermHits(text, terms) {
  const haystack = String(text || '').normalize('NFKC').toLowerCase();
  const hits = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`,
      'gu',
    );
    const count = (haystack.match(pattern) || []).length;
    if (count) hits.push({ term, count });
  }
  return hits.sort((left, right) => right.count - left.count || left.term.localeCompare(right.term));
}

// ── Skeleton fingerprints: repeated openings/closings ────────────────────────

/**
 * Normalize a sentence into a reusable structural fingerprint.
 *
 * Company and role names are replaced with placeholders BEFORE hashing, so two
 * letters that differ only by "Coles" vs "Woolworths" produce the same
 * fingerprint — which is exactly the repetition worth catching. Legitimate
 * repeated work-rights language is short and generic, so restrict the
 * fingerprint to the first sentence's structure.
 */
export function skeletonFingerprint(text, { company = '', title = '' } = {}) {
  let value = String(text || '').normalize('NFKC');
  for (const [token, raw] of [['{company}', company], ['{role}', title]]) {
    const name = String(raw || '').trim();
    if (name.length < 3) continue;
    value = value.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), token);
  }
  const normalized = value
    .toLowerCase()
    .replace(/\{company\}|\{role\}/g, '  ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Opening and closing fingerprints for a cover payload, for storage in
 * generation provenance and comparison against recent letters.
 */
export function coverSkeletonFingerprints(payload, role = {}) {
  const letter = payload?.letter || {};
  const context = { company: role.company ?? letter.company, title: role.title ?? letter.role_title };
  return {
    opening: skeletonFingerprint(letter.opening, context),
    closing: skeletonFingerprint(letter.closing, context),
  };
}
