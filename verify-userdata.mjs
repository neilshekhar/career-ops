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
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  applicationFreshnessSourcePaths,
  buildApplicationSourceSnapshot,
  candidateClaimCorpus,
  candidateToolClaimCorpus,
  loadApplicationProfile,
  missingRequiredApplicationSources,
  resolveApplicationAsset,
  resolveCandidateEvidenceSource,
  resolveOptionalApplicationInput,
  resolveRoleJdInput,
} from './application-source-contract.mjs';
import { ACTIVE_STATUSES, loadQueue } from './queue-store.mjs';
import {
  allowedReleaseEfforts,
  allowedReleaseModelEfforts,
  coverMarkdownMatchesPayload,
  describeReleaseEffortPolicy,
  describeReleaseModelPolicy,
  isAllowedReleaseModelEffort,
  isAllowedReleaseGenerator,
  PROVENANCE_SCHEMA,
  releaseModelPolicy,
  roleAssetPaths,
  sha256File,
} from './generation-provenance.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSET_STATUSES = new Set(['prepared', 'prefilled', 'filled']);
const SELECTION_STATUSES = new Set(['prepare-queued', ...ASSET_STATUSES]);
const RETIRED_VISA_PATTERN = /(?:student[- ]visa|visa[- ]window|visa window|large[- ](?:co|company|employer)[^.;]{0,50}visa|visa[^.;]{0,50}(?:cap|window)|(?:cap|capped|caps|capping)[^.;]{0,50}visa)/i;

const DEFAULT_QUALITY = Object.freeze({
  minimumApplyScore: 4,
  requireExplicitLowScoreOverride: true,
  requireFreshAssets: true,
  requireQualityManifest: false,
  requireEvidenceSourceMatch: false,
  requireCandidateClaimTrace: false,
  evidenceMinChars: 8,
  requireGenerationProvenance: false,
  allowedGenerationFlows: ['interactive-prepare'],
  releaseModelPolicy: 'open',
  allowedReleaseModels: {},
  allowedReleaseEfforts: {},
  allowedReleaseModelEfforts: {},
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
  const allowedReleaseModels = raw.allowed_release_models && typeof raw.allowed_release_models === 'object' && !Array.isArray(raw.allowed_release_models)
    ? Object.fromEntries(Object.entries(raw.allowed_release_models).map(([cli, models]) => [
      String(cli).trim().toLowerCase(),
      Array.isArray(models) ? models.map((model) => String(model).trim().toLowerCase()).filter(Boolean) : [],
    ]).filter(([, models]) => models.length))
    : DEFAULT_QUALITY.allowedReleaseModels;
  const releaseEfforts = allowedReleaseEfforts(profile);
  const releaseModelEfforts = allowedReleaseModelEfforts(profile);
  return {
    minimumApplyScore: numberOr(raw.minimum_apply_score, DEFAULT_QUALITY.minimumApplyScore),
    requireExplicitLowScoreOverride: raw.require_explicit_low_score_override ?? DEFAULT_QUALITY.requireExplicitLowScoreOverride,
    requireFreshAssets: raw.require_fresh_assets ?? DEFAULT_QUALITY.requireFreshAssets,
    requireQualityManifest: raw.require_quality_manifest ?? DEFAULT_QUALITY.requireQualityManifest,
    requireEvidenceSourceMatch: raw.require_evidence_source_match ?? DEFAULT_QUALITY.requireEvidenceSourceMatch,
    requireCandidateClaimTrace: raw.require_candidate_claim_trace ?? DEFAULT_QUALITY.requireCandidateClaimTrace,
    evidenceMinChars: numberOr(raw.evidence_min_chars, DEFAULT_QUALITY.evidenceMinChars),
    requireGenerationProvenance: raw.require_generation_provenance ?? DEFAULT_QUALITY.requireGenerationProvenance,
    allowedGenerationFlows: Array.isArray(raw.allowed_generation_flows) && raw.allowed_generation_flows.length
      ? raw.allowed_generation_flows.map(String)
      : DEFAULT_QUALITY.allowedGenerationFlows,
    releaseModelPolicy: releaseModelPolicy(profile),
    allowedReleaseModels,
    allowedReleaseEfforts: releaseEfforts,
    allowedReleaseModelEfforts: releaseModelEfforts,
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

export function wordCount(text) {
  const value = String(text || '').normalize('NFKC');
  if (!value.trim()) return 0;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
    const words = [...segmenter.segment(value)].filter((segment) => segment.isWordLike);
    let count = 0;
    let previous = null;
    for (const word of words) {
      const between = previous
        ? value.slice(previous.index + previous.segment.length, word.index)
        : null;
      // Preserve the previous English behavior where evidence-based and
      // candidate's count as one word. An empty separator (common in Japanese)
      // must not coalesce independently segmented words.
      if (!previous || !between || !/^['’\u2010-]+$/u.test(between)) count++;
      previous = word;
    }
    return count;
  }
  return (value.match(/[\p{L}\p{N}\p{M}]+(?:['’\u2010-][\p{L}\p{N}\p{M}]+)*/gu) || []).length;
}

function normalizeIdentity(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\(\s*주\s*\)|㈜/gu, '주식회사')
    .toLowerCase()
    .replace(/i\u0307/gu, 'i')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function identityMatches(actual, expected) {
  const left = normalizeIdentity(actual);
  const right = normalizeIdentity(expected);
  if (!left || !right) return false;
  if (left === right) return true;

  const tokens = (value) => {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      return [...new Intl.Segmenter('und', { granularity: 'word' }).segment(value)]
        .filter((segment) => segment.isWordLike)
        .map((segment) => segment.segment);
    }
    return value.split(' ').filter(Boolean);
  };
  const leftList = tokens(left);
  const rightList = tokens(right);
  const containsSequence = (haystack, needle) => needle.length > 0 && haystack.some((_token, index) =>
    needle.every((token, offset) => haystack[index + offset] === token));
  const suffixLegalAffixes = [
    'pty ltd', 'private limited', 'limited', 'ltd', 'incorporated', 'inc',
    'llc', 'plc', 'corporation', 'corp', 'gmbh', 'sarl', 'ag', 'bv',
    'प्राइवेट लिमिटेड', 'निजी लिमिटेड', 'लिमिटेड',
  ];
  const prefixLegalAffixes = ['شركة', 'مؤسسة'];
  const compactEitherAffixes = [
    '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
    '주식회사', '유한회사', '유한책임회사', '합자회사', '합명회사', '사단법인', '재단법인',
  ];
  const compactSuffixAffixes = [
    '股份有限公司', '有限责任公司', '有限公司', '集團', '集团',
    'प्राइवेटलिमिटेड', 'निजीलिमिटेड', 'लिमिटेड',
  ];
  const organizationCore = (value) => {
    let spaced = value;
    let removed = false;
    let changed = true;
    while (changed) {
      changed = false;
      for (const affix of prefixLegalAffixes) {
        if (spaced.startsWith(`${affix} `)) {
          spaced = spaced.slice(affix.length).trim();
          changed = removed = true;
        }
      }
      for (const affix of suffixLegalAffixes) {
        if (spaced.endsWith(` ${affix}`)) {
          spaced = spaced.slice(0, -(affix.length + 1)).trim();
          changed = removed = true;
        }
      }
    }
    let compact = spaced.replace(/\s+/g, '');
    changed = true;
    while (changed) {
      changed = false;
      for (const affix of compactEitherAffixes) {
        if (compact.startsWith(affix)) {
          compact = compact.slice(affix.length);
          changed = removed = true;
        }
        if (compact.endsWith(affix)) {
          compact = compact.slice(0, -affix.length);
          changed = removed = true;
        }
      }
      for (const affix of compactSuffixAffixes) {
        if (compact.endsWith(affix)) {
          compact = compact.slice(0, -affix.length);
          changed = removed = true;
        }
      }
    }
    return { core: compact, removed };
  };
  const leftOrganization = organizationCore(left);
  const rightOrganization = organizationCore(right);
  if (leftOrganization.removed || rightOrganization.removed) {
    return [...leftOrganization.core].length >= 2
      && [...rightOrganization.core].length >= 2
      && leftOrganization.core === rightOrganization.core;
  }

  const shorterTokenCount = Math.min(leftList.length, rightList.length);
  if (
    shorterTokenCount >= 2
    && (containsSequence(leftList, rightList) || containsSequence(rightList, leftList))
  ) return true;

  if (!/[A-Za-z0-9]/.test(left + right)) return false;

  const leftTokens = new Set(leftList);
  const rightTokens = new Set(rightList);
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
  let latest = 0;
  let latestPath = null;
  for (const resolved of applicationFreshnessSourcePaths(root, role)) {
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

function normalizeEvidence(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}+#.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsNormalizedPhrase(haystack, needle) {
  if (!needle) return false;
  const escaped = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}+#])${escaped}(?![\\p{L}\\p{N}\\p{M}+#])`, 'u').test(haystack);
}

function sourceContainsEvidence(path, evidence, minimumChars) {
  const needle = normalizeEvidence(evidence);
  if (needle.length < minimumChars) return { ok: false, reason: `evidence is shorter than ${minimumChars} normalized characters` };
  const haystack = normalizeEvidence(readFileSync(path, 'utf-8'));
  return haystack.includes(needle)
    ? { ok: true }
    : { ok: false, reason: 'evidence text does not occur in the cited source' };
}

function canonicalNumber(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s,]/g, '');
}

function numericClaims(text) {
  const pattern = /(?<![\p{L}\p{N}])(?:[$£€]\s*)?\d+(?:[,.]\d+)*(?:\s?(?:%|x|k|m|b|million|billion|hours?|days?|weeks?|years?))?\+?(?![\p{L}\p{N}])/giu;
  return new Set((String(text || '').match(pattern) || []).map(canonicalNumber));
}

const EXPLICIT_TECHNICAL_TERMS = new Set([
  'r', 'dbt', 'pandas', 'numpy', 'scikit learn', 'python', 'docker',
  'kubernetes', 'keras', 'tensorflow', 'pytorch', 'tableau', 'looker',
  'snowflake', 'django', 'airflow', 'terraform', 'databricks', 'polars',
  'duckdb', 'xgboost', 'postgres', 'postgresql', 'azure', 'fastapi',
]);
const KNOWN_TECHNICAL_TERMS = new Set([
  ...EXPLICIT_TECHNICAL_TERMS,
  'bm25', 'redis', 'celery', 'traefik', 'stella', 'temporal', 'react',
  'rust', 'spark', 'spark sql', 'redshift', 'supabase', 'chromadb',
  'langchain', 'github', 'github actions', 'palantir', 'palantir foundry',
  'lookml', 'plotly', 'kepler.gl', 'excel', 'microsoft excel', 'geopandas',
  'kafka', 'flink', 'bigquery', 'node.js', 'mlops',
]);
const STRICT_TOOL_CLAIMS = new Set([
  ...KNOWN_TECHNICAL_TERMS,
  'sql', 'aws', 'gcp', 'api', 'ai', 'ml', 'llm', 'etl', 'elt', 'bi',
  'ci cd', 'c++', 'c#', '.net', 'node.js',
]);

function isStrictToolClaim(claim) {
  return STRICT_TOOL_CLAIMS.has(claim)
    || /^gpt(?:[ .]|\d)/u.test(claim)
    || /^(?:s3|r2)$/u.test(claim);
}

function sourceContainsNamedClaim(sourceNormalized, claim) {
  const aliases = claim === 'postgres'
    ? ['postgres', 'postgresql']
    : claim === 'postgresql'
      ? ['postgresql', 'postgres']
      : [claim];
  return aliases.some((candidate) => containsNormalizedPhrase(sourceNormalized, candidate));
}

function maskExactPhrases(text, phrases) {
  let masked = String(text || '').normalize('NFKC');
  const ordered = [...new Set((phrases || []).map((value) => String(value || '').normalize('NFKC').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const phrase of ordered) {
    const escaped = phrase
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'giu');
    masked = masked.replace(pattern, ' ');
  }
  return masked;
}

export function namedClaims(text) {
  const value = String(text || '').normalize('NFKC');
  const claims = new Set();
  const add = (raw) => {
    const withoutFramingSuffix = String(raw).replace(/-(?:based|driven|powered|enabled|first|ready|grade|scale|level)$/i, '');
    const normalized = normalizeEvidence(withoutFramingSuffix);
    if (normalized) claims.add(normalized);
  };
  // Tokenize once so dotted qualifications/tools (B.Tech, Node.js, U.S.) are
  // evaluated as whole terms. The previous overlapping regexes emitted the
  // prefix "B." before seeing "B.Tech", creating a fail-closed false positive.
  const tokenPattern = /(?:\.(?=\p{Lu}{2,}(?:\b|[+#./-]))|[\p{L}\p{N}])[\p{L}\p{N}\p{M}+#./-]*/gu;
  for (const match of value.matchAll(tokenPattern)) {
    const wholeToken = match[0].replace(/^[/-]+|[./-]+$/g, '');
    const slashParts = wholeToken.split('/');
    const keepComposite = slashParts.length > 1
      && slashParts.every((part) => /^[\p{Lu}\p{N}]+$/u.test(part));
    let partOffset = 0;
    const candidates = keepComposite || slashParts.length === 1
      ? [{ token: wholeToken, index: match.index }]
      : slashParts.map((token) => {
        const candidate = { token, index: match.index + partOffset };
        partOffset += token.length + 1;
        return candidate;
      });

    for (const candidate of candidates) {
      const claimToken = candidate.token.replace(/-(?:based|driven|powered|enabled|first|ready|grade|scale|level)$/i, '');
      const normalizedToken = normalizeEvidence(claimToken);
      if (/^(?:Q[1-4](?:-Q[1-4])?|H[12]|FY\d{2,4})$/i.test(claimToken)) continue;
      if (
        normalizedToken === 'r'
        && /^\s*&\s*D\b/u.test(value.slice(candidate.index + candidate.token.length))
      ) continue;
      if (EXPLICIT_TECHNICAL_TERMS.has(normalizedToken)) {
        add(claimToken);
        continue;
      }
      if (!claimToken || [...claimToken].length < 2) continue;

      const uppercase = claimToken.match(/\p{Lu}/gu)?.length || 0;
      const lowercase = claimToken.match(/\p{Ll}/gu)?.length || 0;
      const dotted = (claimToken.startsWith('.') && uppercase >= 2)
        || (uppercase > 0 && /\p{L}[\p{L}\p{N}]*\.\p{L}/u.test(claimToken));
      const symbolicTool = /[+#]/u.test(claimToken) && /\p{L}/u.test(claimToken);
      const slashAcronym = /\p{Lu}[\p{Lu}\p{N}]*\/\p{Lu}[\p{Lu}\p{N}]*/u.test(claimToken);
      const camelCase = /\p{Ll}[\p{L}\p{N}]*\p{Lu}|\p{Lu}[\p{L}\p{N}]*\p{Ll}[\p{L}\p{N}]*\p{Lu}/u.test(claimToken);
      const acronymLike = uppercase >= 2 && (lowercase === 0 || /^\p{Lu}{2,}\p{Ll}/u.test(claimToken));
      const versionedTool = /^(?:GPT-?\d[\p{L}\p{N}.-]*|S3|R2|EC2)$/u.test(claimToken);
      if (dotted || symbolicTool || slashAcronym || camelCase || acronymLike || versionedTool) {
        add(claimToken);
        continue;
      }

      // A plain TitleCase word is too weak on its own: CV bullets routinely
      // begin with Designed, Built, Machine, and other ordinary words. Only a
      // known technical term gets this fallback; camelCase, acronyms, dotted
      // names, symbols, and versioned tools were already handled above.
      if (
        KNOWN_TECHNICAL_TERMS.has(normalizedToken)
        && /^\p{Lu}[\p{Ll}\p{M}][\p{L}\p{N}\p{M}+#.-]{2,}$/u.test(claimToken)
      ) add(claimToken);
    }
  }
  return claims;
}

function validateCandidateClaims(role, issues, { root, cvText, coverBody }) {
  const source = candidateClaimCorpus(root);
  const toolSource = candidateToolClaimCorpus(root);
  const sourceNumbers = numericClaims(source);
  const sourceNormalized = normalizeEvidence(source);
  const toolSourceNormalized = normalizeEvidence(toolSource);
  const sectionHeadings = [
    'Professional Summary', 'Core Competencies', 'Work Experience',
    'Projects', 'Education', 'Certifications', 'Skills',
  ];
  const validateText = (text, label, trustedPhrases, reviewMetadata = '') => {
    const candidateText = maskExactPhrases(text, trustedPhrases);
    for (const claim of numericClaims(candidateText)) {
      if (!sourceNumbers.has(claim)) {
        issues.push(issue('error', 'claim-number-untraced', `${label} contains number ${JSON.stringify(claim)} that is absent from cv.md, article-digest.md, and candidate-facing config/profile.yml fields.`, role));
      }
    }
    const reviewed = normalizeEvidence(reviewMetadata);
    for (const claim of namedClaims(candidateText)) {
      const sourced = sourceContainsNamedClaim(
        isStrictToolClaim(claim) ? toolSourceNormalized : sourceNormalized,
        claim,
      );
      const metadataAllowed = !isStrictToolClaim(claim)
        && containsNormalizedPhrase(reviewed, claim);
      if (!sourced && !metadataAllowed) {
        issues.push(issue('error', 'claim-term-untraced', `${label} contains named term ${JSON.stringify(claim)} that is absent from the approved candidate sources.`, role));
      }
    }
  };

  // Company/JD references may explain cover-letter proper nouns, but must
  // never whitelist an unsupported CV claim or a known technical tool.
  const trustedRolePhrases = [role.company, role.title, ...sectionHeadings];
  validateText(cvText || '', 'Tailored CV', trustedRolePhrases);
  validateText(coverBody || '', 'Cover letter', trustedRolePhrases, [
    ...(role.application_quality_review?.company_specific_references || []),
  ].filter(Boolean).join(' '));
}

function validateGenerationProvenance(role, issues, { root, quality, source }) {
  const provenance = role.generation_provenance;
  if (!provenance || typeof provenance !== 'object') {
    issues.push(issue('error', 'generation-provenance-missing', 'No generation_provenance record is stored for these application assets.', role));
    return;
  }
  if (provenance.schema !== PROVENANCE_SCHEMA) {
    issues.push(issue('error', 'generation-provenance-schema', `Generation provenance schema must be ${PROVENANCE_SCHEMA}.`, role));
  }
  if (!quality.allowedGenerationFlows.includes(provenance.flow) || provenance.interactive !== true) {
    issues.push(issue('error', 'generation-provenance-flow', `Generation flow ${JSON.stringify(provenance.flow)} is not release-eligible; allowed interactive flows: ${quality.allowedGenerationFlows.join(', ')}.`, role));
  }
  if (!provenance.generator?.cli || !provenance.generator?.model) {
    issues.push(issue('error', 'generation-provenance-generator', 'Generation provenance must record both the CLI and model label.', role));
  } else {
    const cli = String(provenance.generator.cli).trim().toLowerCase();
    const model = String(provenance.generator.model).trim().toLowerCase();
    const policyProfile = {
      application_quality: {
        release_model_policy: quality.releaseModelPolicy,
        allowed_release_models: quality.allowedReleaseModels,
      },
    };
    if (!isAllowedReleaseGenerator(cli, model, policyProfile)) {
      issues.push(issue('error', 'generation-provenance-model', `Generator ${cli}/${model} is not release-eligible; policy: ${describeReleaseModelPolicy(policyProfile)}.`, role));
    }
    const effortProfile = {
      application_quality: {
        allowed_release_efforts: quality.allowedReleaseEfforts,
        allowed_release_model_efforts: quality.allowedReleaseModelEfforts,
      },
    };
    if (!isAllowedReleaseModelEffort(cli, model, provenance.generator.effort, effortProfile)) {
      issues.push(issue('error', 'generation-provenance-effort', `Generator effort ${cli}/${model}/${provenance.generator.effort || 'missing'} is not release-eligible; allowed: ${describeReleaseEffortPolicy(effortProfile)}.`, role));
    }
  }

  const recordedAt = Date.parse(provenance.recorded_at || '');
  if (!Number.isFinite(recordedAt) || recordedAt < source.latest) {
    issues.push(issue('error', 'generation-provenance-stale', `Generation provenance must be recorded after ${source.latestPath}.`, role));
  }

  const recordedAssets = provenance.assets || {};
  for (const [kind, value] of Object.entries(roleAssetPaths(role))) {
    if (!value) continue;
    const current = resolveApplicationAsset(root, value, kind);
    const recorded = recordedAssets[kind];
    if (!current) continue; // missing/out-of-scope errors are emitted elsewhere
    if (!recorded || recorded.path !== current.relative) {
      issues.push(issue('error', 'generation-provenance-path', `${kind} is not bound to its current path in generation provenance.`, role, current.relative));
      continue;
    }
    if (recorded.sha256 !== sha256File(current.absolute)) {
      issues.push(issue('error', 'generation-provenance-hash', `${kind} changed after generation provenance was recorded.`, role, current.relative));
    }
  }

  const recordedSource = provenance.source_snapshot;
  const currentSource = buildApplicationSourceSnapshot(root, role);
  if (!recordedSource || typeof recordedSource !== 'object') {
    issues.push(issue('error', 'generation-provenance-source-missing', 'Generation provenance does not bind the source files, inline JD, quality review, and role context used for these assets.', role));
  } else {
    if (recordedSource.schema !== currentSource.schema) {
      issues.push(issue('error', 'generation-provenance-source-schema', `Generation source snapshot schema must be ${currentSource.schema}.`, role));
    }
    const recordedFiles = recordedSource.files || {};
    const currentFiles = currentSource.files;
    const recordedNames = Object.keys(recordedFiles).sort();
    const currentNames = Object.keys(currentFiles).sort();
    if (JSON.stringify(recordedNames) !== JSON.stringify(currentNames)) {
      issues.push(issue('error', 'generation-provenance-source-set', 'The set of application source files changed after provenance was recorded.', role));
    } else {
      for (const name of currentNames) {
        if (
          recordedFiles[name]?.sha256 !== currentFiles[name].sha256
          || recordedFiles[name]?.bytes !== currentFiles[name].bytes
        ) {
          issues.push(issue('error', 'generation-provenance-source-hash', `Application source changed after provenance was recorded: ${name}.`, role, name));
        }
      }
    }
    if (JSON.stringify(recordedSource.inline_jd ?? null) !== JSON.stringify(currentSource.inline_jd)) {
      issues.push(issue('error', 'generation-provenance-jd', 'Inline JD text changed after provenance was recorded.', role));
    }
    if (JSON.stringify(recordedSource.jd_source ?? null) !== JSON.stringify(currentSource.jd_source)) {
      issues.push(issue('error', 'generation-provenance-jd-source', 'The selected JD source changed after provenance was recorded.', role));
    }
    if (recordedSource.quality_review_sha256 !== currentSource.quality_review_sha256) {
      issues.push(issue('error', 'generation-provenance-quality-review', 'The application quality review changed after provenance was recorded.', role));
    }
    if (JSON.stringify(recordedSource.role_context || {}) !== JSON.stringify(currentSource.role_context)) {
      issues.push(issue('error', 'generation-provenance-role-context', 'Role context changed after provenance was recorded.', role));
    }
  }
}

function validateQualityManifest(role, issues, { root, source, coverBody, quality }) {
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
      const evidencePath = resolveCandidateEvidenceSource(root, item.source);
      if (!evidencePath) {
        issues.push(issue('error', 'quality-review-source', `Quality review requirement ${index + 1} cites a missing or out-of-scope source: ${JSON.stringify(item.source)}.`, role));
      } else if (quality.requireEvidenceSourceMatch) {
        const match = sourceContainsEvidence(evidencePath.absolute, item.evidence, quality.evidenceMinChars);
        if (!match.ok) {
          issues.push(issue('error', 'quality-review-evidence-untraced', `Quality review requirement ${index + 1} cites ${JSON.stringify(item.source)}, but ${match.reason}: ${JSON.stringify(item.evidence)}.`, role));
        }
      }
    }
  }
  if (review.sources_used != null && !Array.isArray(review.sources_used)) {
    issues.push(issue('error', 'quality-review-sources-used', 'Quality review sources_used must be an array of exact repository-relative paths.', role));
  } else {
    for (const sourceUsed of review.sources_used || []) {
      if (!resolveOptionalApplicationInput(root, sourceUsed)) {
        issues.push(issue('error', 'quality-review-sources-used', `Quality review cites a missing or out-of-scope additional input: ${JSON.stringify(sourceUsed)}.`, role));
      }
    }
  }
  const references = Array.isArray(review.company_specific_references) ? review.company_specific_references : [];
  if (references.length < 2) {
    issues.push(issue('error', 'quality-review-specificity', 'Quality review must record at least two company-specific references used in the cover letter.', role));
  } else {
    const normalizedBody = normalizeIdentity(coverBody);
    for (const reference of references) {
      const normalizedReference = normalizeIdentity(reference);
      if (!normalizedReference || !containsNormalizedPhrase(normalizedBody, normalizedReference)) {
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

  for (const missing of missingRequiredApplicationSources(root)) {
    issues.push(issue('error', 'application-source-required', `Required application source is missing, out of scope, or symlinked: ${missing}.`, role, missing));
  }

  if (!resolveRoleJdInput(root, role)) {
    issues.push(issue('error', 'jd-source-missing', 'No substantive inline JD or approved jds/ source is available for this application.', role, role.jd_path || null));
  }

  const cv = resolveApplicationAsset(root, role.cv_pdf, 'cv_pdf');
  if (!cv) {
    issues.push(issue('error', 'cv-missing', 'Tailored CV PDF is missing, out of scope, symlinked, or has the wrong format.', role, role.cv_pdf || null));
  }

  const covers = coverPaths(role);
  for (const format of quality.coverRequiredFormats) {
    const path = resolveApplicationAsset(root, covers[format], `cover_${format}`);
    if (!path) {
      issues.push(issue('error', 'cover-format-missing', `Tailored cover ${format.toUpperCase()} is missing, out of scope, symlinked, or has the wrong format.`, role, covers[format] || null));
    }
  }

  const coverMd = resolveApplicationAsset(root, covers.md, 'cover_md');
  const coverPayload = resolveApplicationAsset(root, covers.payload, 'cover_payload');
  const cvHtml = resolveApplicationAsset(root, roleAssetPaths(role).cv_html, 'cv_html');

  if (!cvHtml) {
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

  if (payload && coverMd) {
    const markdown = readFileSync(coverMd.absolute, 'utf-8');
    if (!coverMarkdownMatchesPayload(payload, markdown)) {
      issues.push(issue('error', 'cover-markdown-divergent', 'Cover Markdown diverges from the canonical cover payload; re-render all cover formats.', role, coverMd.relative));
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
    ['cover', resolveApplicationAsset(root, covers.pdf, 'cover_pdf'), quality.coverMaxPages],
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
      ['CV HTML', cvHtml],
      ...Object.entries(covers).map(([format, value]) => [`cover ${format}`, resolveApplicationAsset(root, value, `cover_${format}`)]),
    ];
    for (const [label, path] of assets) {
      if (!path || !existsSync(path.absolute)) continue;
      if (statSync(path.absolute).mtimeMs < source.latest) {
        issues.push(issue('error', 'asset-stale', `${label} predates ${source.latestPath}; regenerate it before filling.`, role, path.relative));
      }
    }
  }

  if (quality.requireQualityManifest) validateQualityManifest(role, issues, { root, source, coverBody, quality });
  if (quality.requireCandidateClaimTrace) validateCandidateClaims(role, issues, { root, cvText: cvHtml && existsSync(cvHtml.absolute) ? visibleHtmlText(readFileSync(cvHtml.absolute, 'utf-8')) : '', coverBody });
  if (quality.requireGenerationProvenance) validateGenerationProvenance(role, issues, { root, quality, source });
  return issues;
}

export function verifyUserData(options = {}) {
  const root = options.root || ROOT;
  let profile = options.profile;
  if (!profile) {
    profile = loadApplicationProfile(root);
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
