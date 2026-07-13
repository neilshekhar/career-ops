#!/usr/bin/env node

/**
 * Read-only quality gate for active queue data and generated application assets.
 *
 * Usage:
 *   node verify-userdata.mjs
 *   node verify-userdata.mjs --role <queue-role-id>
 *   node verify-userdata.mjs --json
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { ACTIVE_STATUSES, loadQueue } from './queue-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSET_STATUSES = new Set(['prepared', 'prefilled', 'filled']);
const SELECTION_STATUSES = new Set(['prepare-queued', ...ASSET_STATUSES]);
const RETIRED_VISA_PATTERN = /(?:student[- ]visa|visa[- ]window|visa window|large[- ](?:co|company|employer)[^.;]{0,50}visa|visa[^.;]{0,50}(?:cap|window)|(?:cap|capped|caps|capping)[^.;]{0,50}visa)/i;

const DEFAULT_QUALITY = Object.freeze({
  minimumApplyScore: 4,
  requireExplicitLowScoreOverride: true,
  requireFreshAssets: true,
  requireQualityManifest: false,
  cvMaxPages: 2,
  coverMaxPages: 1,
  coverBodyWordsMin: 250,
  coverBodyWordsMax: 500,
  coverAllowBullets: true,
  coverRequiredFormats: ['md', 'pdf'],
  bannedPunctuation: [],
});

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function applicationQualityConfig(profile = {}) {
  const raw = profile.application_quality || {};
  return {
    minimumApplyScore: numberOr(raw.minimum_apply_score, DEFAULT_QUALITY.minimumApplyScore),
    requireExplicitLowScoreOverride: raw.require_explicit_low_score_override ?? DEFAULT_QUALITY.requireExplicitLowScoreOverride,
    requireFreshAssets: raw.require_fresh_assets ?? DEFAULT_QUALITY.requireFreshAssets,
    requireQualityManifest: raw.require_quality_manifest ?? DEFAULT_QUALITY.requireQualityManifest,
    cvMaxPages: numberOr(raw.cv_max_pages, DEFAULT_QUALITY.cvMaxPages),
    coverMaxPages: numberOr(raw.cover_max_pages, DEFAULT_QUALITY.coverMaxPages),
    coverBodyWordsMin: numberOr(raw.cover_body_words_min, DEFAULT_QUALITY.coverBodyWordsMin),
    coverBodyWordsMax: numberOr(raw.cover_body_words_max, DEFAULT_QUALITY.coverBodyWordsMax),
    coverAllowBullets: raw.cover_allow_bullets ?? DEFAULT_QUALITY.coverAllowBullets,
    coverRequiredFormats: Array.isArray(raw.cover_required_formats)
      ? raw.cover_required_formats.map(String)
      : DEFAULT_QUALITY.coverRequiredFormats,
    bannedPunctuation: Array.isArray(raw.banned_punctuation)
      ? raw.banned_punctuation.map(String)
      : DEFAULT_QUALITY.bannedPunctuation,
  };
}

function issue(level, code, message, role = null, path = null) {
  return {
    level,
    code,
    message,
    ...(role ? { role_id: role.id, company: role.company, title: role.title } : {}),
    ...(path ? { path } : {}),
  };
}

function repoPath(root, value) {
  if (!value) return null;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return { absolute, relative: rel.split('\\').join('/') };
}

function coverPaths(role) {
  const paths = { ...(role.cover_letter_paths || {}) };
  if (role.cover_letter_path && !paths.pdf) paths.pdf = role.cover_letter_path;
  return paths;
}

function pdfPageCount(path) {
  const contents = readFileSync(path).toString('latin1');
  return (contents.match(/\/Type\s*\/Page\b/g) || []).length;
}

function visibleHtmlText(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
  return body
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  return (String(text || '').match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || []).length;
}

function normalizeIdentity(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityMatches(actual, expected) {
  const left = normalizeIdentity(actual);
  const right = normalizeIdentity(expected);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size) >= 0.8;
}

function payloadBody(payload) {
  const letter = payload?.letter || {};
  const achievements = Array.isArray(letter.achievements)
    ? letter.achievements.flatMap((item) => [item?.lead, item?.impact])
    : [];
  return [
    letter.opening,
    letter.profile_intro,
    ...achievements,
    letter.problems_section,
    letter.closing,
    letter.language_closing,
  ].filter(Boolean).join(' ');
}

function punctuationHits(text, configured) {
  const checks = {
    'em-dash': /\u2014/g,
    'en-dash': /\u2013/g,
    semicolon: /;/g,
  };
  const hits = [];
  for (const name of configured) {
    const pattern = checks[name];
    if (!pattern) continue;
    const count = (String(text || '').match(pattern) || []).length;
    if (count) hits.push(`${name}=${count}`);
  }
  return hits;
}

export function validateCoverPayload(payload, quality = DEFAULT_QUALITY) {
  const errors = [];
  const body = payloadBody(payload);
  const words = wordCount(body);
  if (words < quality.coverBodyWordsMin || words > quality.coverBodyWordsMax) {
    errors.push(`cover body has ${words} words; required range is ${quality.coverBodyWordsMin}-${quality.coverBodyWordsMax}`);
  }
  if (!quality.coverAllowBullets && Array.isArray(payload?.letter?.achievements) && payload.letter.achievements.length) {
    errors.push('cover payload contains achievement bullets, but bullets are disabled by the profile quality policy');
  }
  const hits = punctuationHits(body, quality.bannedPunctuation);
  if (hits.length) errors.push(`cover body contains banned punctuation: ${hits.join(', ')}`);
  return errors;
}

function latestSourceMtime(root, role) {
  const paths = [
    'cv.md',
    'article-digest.md',
    'config/profile.yml',
    'modes/_profile.md',
    'modes/_custom.md',
    'voice-dna.md',
  ];
  if (role.jd_path) paths.push(role.jd_path);

  let latest = 0;
  let latestPath = null;
  for (const value of paths) {
    const resolved = repoPath(root, value);
    if (!resolved || !existsSync(resolved.absolute)) continue;
    const mtime = statSync(resolved.absolute).mtimeMs;
    if (mtime > latest) {
      latest = mtime;
      latestPath = resolved.relative;
    }
  }

  const scored = Date.parse(role.scored_at || '');
  if (Number.isFinite(scored) && scored > latest) {
    latest = scored;
    latestPath = 'queue role score/JD';
  }
  return { latest, latestPath };
}

function retiredVisaConfig(profile) {
  const location = profile.location || {};
  return {
    cutoff: Date.parse(location.visa_window_cutoff || ''),
    flags: Array.isArray(location.retired_visa_flags) ? location.retired_visa_flags.map(String) : [],
    reasonPattern: location.retired_visa_reason_pattern
      ? new RegExp(location.retired_visa_reason_pattern, 'i')
      : RETIRED_VISA_PATTERN,
  };
}

function expectedVisaAnswer(profile, role) {
  const location = profile.location || {};
  const fullTime = location.visa_form_answer_fulltime;
  const partTime = location.visa_form_answer_parttime;
  if (fullTime && partTime && fullTime === partTime) return fullTime;
  if (role.employment_type === 'part-time') return partTime || null;
  if (role.employment_type === 'full-time') return fullTime || null;
  return null;
}

function isAllowedEvidenceSource(source) {
  const value = String(source || '').replace(/:\d+(?::\d+)?$/, '');
  return [
    'cv.md',
    'article-digest.md',
    'config/profile.yml',
    'modes/_profile.md',
    'interview-prep/story-bank.md',
  ].includes(value) || value.startsWith('writing-samples/') || /^interview-prep\/[^/]+\.md$/.test(value);
}

function validateQualityManifest(role, issues, { root, source, coverBody }) {
  const review = role.application_quality_review;
  if (!review || typeof review !== 'object') {
    issues.push(issue('error', 'quality-review-missing', 'No application_quality_review manifest is stored for this role.', role));
    return;
  }
  const requirements = Array.isArray(review.top_requirements) ? review.top_requirements : [];
  if (requirements.length < 3) {
    issues.push(issue('error', 'quality-review-requirements', 'Quality review must map at least three JD requirements.', role));
  }
  for (const [index, item] of requirements.entries()) {
    const covered = item?.requirement && ((item.evidence && item.source) || item.uncovered === true);
    if (!covered) {
      issues.push(issue('error', 'quality-review-evidence', `Quality review requirement ${index + 1} needs sourced evidence or uncovered: true.`, role));
    } else if (item.uncovered !== true) {
      const evidencePath = repoPath(root, String(item.source).replace(/:\d+(?::\d+)?$/, ''));
      if (!isAllowedEvidenceSource(item.source) || !evidencePath || !existsSync(evidencePath.absolute)) {
        issues.push(issue('error', 'quality-review-source', `Quality review requirement ${index + 1} cites a missing or out-of-scope source: ${JSON.stringify(item.source)}.`, role));
      }
    }
  }
  const references = Array.isArray(review.company_specific_references) ? review.company_specific_references : [];
  if (references.length < 2) {
    issues.push(issue('error', 'quality-review-specificity', 'Quality review must record at least two company-specific references used in the cover letter.', role));
  } else {
    const normalizedBody = normalizeIdentity(coverBody);
    for (const reference of references) {
      if (!normalizedBody.includes(normalizeIdentity(reference))) {
        issues.push(issue('error', 'quality-review-specificity', `Company-specific reference is not present in the cover body: ${JSON.stringify(reference)}.`, role));
      }
    }
  }
  const reviewedAt = Date.parse(review.reviewed_at || '');
  if (!Number.isFinite(reviewedAt) || reviewedAt < source.latest) {
    issues.push(issue('error', 'quality-review-stale', `Quality review must be rerun after ${source.latestPath}.`, role));
  }
}

export function validateApplicationRole(role, options = {}) {
  const root = options.root || ROOT;
  const profile = options.profile || {};
  const quality = options.quality || applicationQualityConfig(profile);
  const now = options.now || new Date();
  const requireAssets = options.requireAssets ?? true;
  const issues = [];

  const expectedVisa = expectedVisaAnswer(profile, role);
  if (role.status !== 'new' && expectedVisa && role.visa_answer !== expectedVisa) {
    issues.push(issue('error', 'visa-answer-stale', `Stored visa answer is ${JSON.stringify(role.visa_answer)}; expected ${JSON.stringify(expectedVisa)}.`, role));
  }

  const retired = retiredVisaConfig(profile);
  if (Number.isFinite(retired.cutoff) && now.getTime() >= retired.cutoff) {
    const matchedFlags = retired.flags.filter((flag) => (role.flags || []).includes(flag));
    const hasRetiredReason = retired.reasonPattern.test(role.reason || '');
    if (matchedFlags.length) {
      issues.push(issue('error', 'retired-visa-flag', `Role still carries retired visa-overlay flag(s): ${matchedFlags.join(', ')}.`, role));
    }
    if (hasRetiredReason) {
      issues.push(issue('error', 'retired-visa-reason', 'Role reason still applies the retired visa-window scoring rule.', role));
    }
    if ((matchedFlags.length || hasRetiredReason) && Number.isFinite(role.score_raw) && Number.isFinite(role.score) && role.score_raw > role.score) {
      issues.push(issue('error', 'retired-visa-score', `Final score ${role.score} remains below raw score ${role.score_raw} after the visa cutoff.`, role));
    }
  }

  if (
    quality.requireExplicitLowScoreOverride &&
    SELECTION_STATUSES.has(role.status) &&
    Number.isFinite(role.score) &&
    role.score < quality.minimumApplyScore &&
    role.user_override?.approved !== true
  ) {
    issues.push(issue('error', 'low-score-override-missing', `Score ${role.score} is below ${quality.minimumApplyScore}; a durable candidate override is required.`, role));
  }

  if (!requireAssets) return issues;

  const cv = repoPath(root, role.cv_pdf);
  if (!cv || !existsSync(cv.absolute)) {
    issues.push(issue('error', 'cv-missing', 'Tailored CV PDF is missing or outside the repository.', role, role.cv_pdf || null));
  }

  const covers = coverPaths(role);
  for (const format of quality.coverRequiredFormats) {
    const path = repoPath(root, covers[format]);
    if (!path || !existsSync(path.absolute)) {
      issues.push(issue('error', 'cover-format-missing', `Tailored cover ${format.toUpperCase()} is missing or outside the repository.`, role, covers[format] || null));
    }
  }

  const coverMd = repoPath(root, covers.md);
  const coverPayload = repoPath(root, covers.payload);
  const cvHtml = cv ? { absolute: cv.absolute.replace(/\.pdf$/i, '.html'), relative: cv.relative.replace(/\.pdf$/i, '.html') } : null;

  if (!cvHtml || cvHtml.absolute === cv?.absolute || !existsSync(cvHtml.absolute)) {
    issues.push(issue('error', 'cv-source-html-missing', 'The tailored CV source HTML must be retained beside the PDF for content QC and regeneration.', role, cvHtml?.relative || null));
  }

  let payload = null;
  let coverBody = '';
  if (!coverPayload || !existsSync(coverPayload.absolute)) {
    issues.push(issue('error', 'cover-payload-missing', 'Canonical cover payload is missing; content identity and body checks cannot run.', role, covers.payload || null));
  } else {
    try {
      payload = JSON.parse(readFileSync(coverPayload.absolute, 'utf-8'));
    } catch (error) {
      issues.push(issue('error', 'cover-payload-invalid', `Canonical cover payload is invalid JSON: ${error.message}`, role, coverPayload.relative));
    }
  }

  if (payload) {
    if (!identityMatches(payload.letter?.company, role.company)) {
      issues.push(issue('error', 'cover-company-mismatch', `Cover company ${JSON.stringify(payload.letter?.company)} does not match queue company ${JSON.stringify(role.company)}.`, role, coverPayload.relative));
    }
    if (!identityMatches(payload.letter?.role_title, role.title)) {
      issues.push(issue('error', 'cover-role-mismatch', `Cover role ${JSON.stringify(payload.letter?.role_title)} does not match queue title ${JSON.stringify(role.title)}.`, role, coverPayload.relative));
    }

    coverBody = payloadBody(payload);
    for (const payloadError of validateCoverPayload(payload, quality)) {
      const code = payloadError.startsWith('cover body has')
        ? 'cover-word-count'
        : payloadError.startsWith('cover payload')
          ? 'cover-bullets'
          : 'cover-punctuation';
      issues.push(issue('error', code, `${payloadError[0].toUpperCase()}${payloadError.slice(1)}.`, role, coverPayload.relative));
    }
  }

  if (coverMd && existsSync(coverMd.absolute) && !quality.coverAllowBullets) {
    const markdown = readFileSync(coverMd.absolute, 'utf-8');
    if (/^\s*[-*+]\s+/m.test(markdown)) {
      issues.push(issue('error', 'cover-markdown-bullets', 'Cover Markdown contains a bullet list, but bullets are disabled by the profile quality policy.', role, coverMd.relative));
    }
  }

  if (cvHtml && existsSync(cvHtml.absolute)) {
    const text = visibleHtmlText(readFileSync(cvHtml.absolute, 'utf-8'));
    const hits = punctuationHits(text, quality.bannedPunctuation);
    if (hits.length) {
      issues.push(issue('error', 'cv-punctuation', `CV body contains banned punctuation: ${hits.join(', ')}.`, role, cvHtml.relative));
    }
  }

  for (const [kind, path, maxPages] of [
    ['CV', cv, quality.cvMaxPages],
    ['cover', repoPath(root, covers.pdf), quality.coverMaxPages],
  ]) {
    if (!path || !existsSync(path.absolute)) continue;
    const pages = pdfPageCount(path.absolute);
    if (!pages) {
      issues.push(issue('error', 'pdf-page-count-unreadable', `${kind} PDF page count could not be read.`, role, path.relative));
    } else if (pages > maxPages) {
      issues.push(issue('error', 'pdf-page-count', `${kind} PDF has ${pages} pages; maximum is ${maxPages}.`, role, path.relative));
    }
  }

  const source = latestSourceMtime(root, role);
  if (quality.requireFreshAssets) {
    const assets = [
      ['CV PDF', cv],
      ['CV HTML', cvHtml && repoPath(root, cvHtml.relative)],
      ...Object.entries(covers).map(([format, value]) => [`cover ${format}`, repoPath(root, value)]),
    ];
    for (const [label, path] of assets) {
      if (!path || !existsSync(path.absolute)) continue;
      if (statSync(path.absolute).mtimeMs < source.latest) {
        issues.push(issue('error', 'asset-stale', `${label} predates ${source.latestPath}; regenerate it before filling.`, role, path.relative));
      }
    }
  }

  if (quality.requireQualityManifest) validateQualityManifest(role, issues, { root, source, coverBody });
  return issues;
}

export function verifyUserData(options = {}) {
  const root = options.root || ROOT;
  let profile = options.profile;
  if (!profile) {
    const profilePath = join(root, 'config', 'profile.yml');
    profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf-8')) || {} : {};
  }
  const queue = options.queue || loadQueue();
  const quality = applicationQualityConfig(profile);
  const roleId = options.roleId || null;
  const now = options.now || new Date();
  const issues = [];

  const roles = roleId
    ? queue.roles.filter((role) => role.id === roleId)
    : queue.roles.filter((role) => ACTIVE_STATUSES.has(role.status));

  if (roleId && roles.length === 0) {
    issues.push(issue('error', 'role-not-found', `Queue role not found: ${roleId}`));
  }

  for (const role of roles) {
    const requireAssets = roleId ? true : ASSET_STATUSES.has(role.status);
    issues.push(...validateApplicationRole(role, { root, profile, quality, now, requireAssets }));
  }

  const errors = issues.filter((item) => item.level === 'error');
  const warnings = issues.filter((item) => item.level === 'warning');
  return {
    ok: errors.length === 0,
    checked_roles: roles.length,
    errors: errors.length,
    warnings: warnings.length,
    issues,
  };
}

function printHuman(result) {
  const state = result.ok ? 'PASS' : 'FAIL';
  console.log(`${state}: checked ${result.checked_roles} role(s), ${result.errors} error(s), ${result.warnings} warning(s)`);
  const limit = 60;
  for (const item of result.issues.slice(0, limit)) {
    const role = item.role_id ? ` [${item.company} - ${item.title}]` : '';
    console.log(`  ${item.level.toUpperCase()} ${item.code}${role}: ${item.message}`);
  }
  if (result.issues.length > limit) {
    console.log(`  ... ${result.issues.length - limit} more issue(s); use --json for the complete list.`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const roleIndex = args.indexOf('--role');
  const roleId = roleIndex >= 0 ? args[roleIndex + 1] : null;
  if (args.includes('--help') || (roleIndex >= 0 && !roleId)) {
    console.log('Usage: node verify-userdata.mjs [--role <queue-role-id>] [--json]');
    process.exit(args.includes('--help') ? 0 : 2);
  }

  try {
    const result = verifyUserData({ roleId });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const result = { ok: false, checked_roles: 0, errors: 1, warnings: 0, issues: [issue('error', 'validator-crash', error.message)] };
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exitCode = 1;
  }
}
