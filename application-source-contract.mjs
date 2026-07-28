#!/usr/bin/env node

/**
 * Canonical source resolver for candidate-facing application content.
 *
 * Keep this module aligned with the Source-of-Truth Boundary in AGENTS.md and
 * the user's stricter quality policy in modes/_custom.md. Candidate numbers and
 * tool-name claims trace only to the three explicitly approved claim sources.
 * Other in-scope text files may be cited as requirement evidence; when they
 * are cited, they join the freshness/provenance snapshot for that role.
 */

import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { extname, isAbsolute, relative, resolve } from 'path';
import yaml from 'js-yaml';

import { assessJdContent } from './queue-sweep.mjs';

const CLAIM_TRACE_SOURCES = Object.freeze([
  'cv.md',
  'article-digest.md',
  'config/profile.yml',
]);

const REQUIRED_APPLICATION_SOURCES = Object.freeze([
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
]);

const BASELINE_ASSET_SOURCES = Object.freeze([
  ...CLAIM_TRACE_SOURCES,
  'modes/_profile.md',
  'modes/_custom.md',
  'voice-dna.md',
]);

const DIRECT_EVIDENCE_SOURCES = Object.freeze([
  ...CLAIM_TRACE_SOURCES,
  'modes/_profile.md',
  'interview-prep/story-bank.md',
]);

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.csv', '.tsv']);
const PROFILE_CLAIM_NAMESPACES = Object.freeze([
  'candidate',
  'target_roles',
  'narrative',
  'compensation',
  'location',
  'application_answers',
  'eeo',
  'salary',
  'references',
  'education',
  'experience',
  'skills',
  'projects',
  'certifications',
  'preferences',
  'deal_breakers',
  'work_rights',
  'contact',
  'portfolio',
]);
const POSITIVE_TOOL_PROFILE_NAMESPACES = Object.freeze([
  'candidate',
  'narrative',
  'application_answers',
  'education',
  'experience',
  'skills',
  'projects',
  'certifications',
  'portfolio',
]);
const SENSITIVE_PATH_PART = /(?:^|[._-])(?:env|secrets?|tokens?|passwords?|passwds?|credentials?|api[._-]?keys?|private[._-]?keys?|signing[._-]?keys?|service[._-]?roles?)(?:[._-]|$)/i;
const SENSITIVE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|jks)$/i;
const APPLICATION_ASSET_SUFFIX = Object.freeze({
  cv_pdf: '.pdf',
  cv_html: '.html',
  cover_md: '.md',
  cover_pdf: '.pdf',
  cover_docx: '.docx',
  cover_payload: '.payload.json',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function unsafeRelativePath(value) {
  const normalized = String(value || '').split('\\').join('/');
  return normalized.split('/').some((part) => part.startsWith('.') || SENSITIVE_PATH_PART.test(part))
    || SENSITIVE_EXTENSION.test(normalized);
}

function repoEntry(root, value, expectedType) {
  if (!value) return null;
  const lexicalRoot = resolve(root);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value);
  const rel = relative(lexicalRoot, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const normalizedRel = rel.split('\\').join('/');
  if (unsafeRelativePath(normalizedRel)) return null;
  if (!existsSync(absolute)) return null;
  let stats, realRoot, realAbsolute;
  try {
    stats = lstatSync(absolute);
    realRoot = realpathSync(lexicalRoot);
    realAbsolute = realpathSync(absolute);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) return null;
  if (expectedType === 'file' && !stats.isFile()) return null;
  if (expectedType === 'directory' && !stats.isDirectory()) return null;

  const realRel = relative(realRoot, realAbsolute);
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null;
  // Reject a symlink in any parent component, even when it resolves back into
  // the repository. The lexical source path must name the real entry directly.
  if (resolve(realRoot, rel) !== realAbsolute) return null;
  return { absolute: realAbsolute, relative: realRel.split('\\').join('/') };
}

export function repoFile(root, value) {
  return repoEntry(root, value, 'file');
}

function repoDirectory(root, value) {
  return repoEntry(root, value, 'directory');
}

function textFile(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function writingSamplePaths(root) {
  const directory = repoDirectory(root, 'writing-samples');
  if (!directory) return [];

  const found = [];
  const visit = (absoluteDirectory, relativeDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = resolve(absoluteDirectory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!unsafeRelativePath(relativePath)) visit(absolute, relativePath);
      } else if (
        entry.isFile()
        && entry.name.toLowerCase() !== 'readme.md'
        && textFile(entry.name)
      ) {
        const path = repoFile(root, relativePath);
        if (path) found.push(path);
      }
    }
  };
  visit(directory.absolute, 'writing-samples');
  return found;
}

function interviewPrepFactPaths(root) {
  const directory = repoDirectory(root, 'interview-prep');
  if (!directory) return [];
  return readdirSync(directory.absolute, { withFileTypes: true })
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return entry.isFile()
        && name.endsWith('.md')
        && name !== 'readme.md'
        && !name.includes('retracted')
        && !name.includes('redflag')
        && !name.includes('red-flag');
    })
    .map((entry) => repoFile(root, `interview-prep/${entry.name}`))
    .filter(Boolean);
}

function uniqueSorted(paths) {
  return [...new Map(paths.map((path) => [path.relative, path])).values()]
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

/** Sources allowed by the user's strict number/tool-name trace policy. */
export function candidateClaimSourcePaths(root) {
  return uniqueSorted(CLAIM_TRACE_SOURCES.map((value) => repoFile(root, value)).filter(Boolean));
}

export function missingRequiredApplicationSources(root) {
  return REQUIRED_APPLICATION_SOURCES.filter((value) => {
    const path = repoFile(root, value);
    return !path || path.relative !== value;
  });
}

export function assertRequiredApplicationSources(root) {
  const missing = missingRequiredApplicationSources(root);
  if (missing.length) {
    throw new Error(`Required application source files are missing, out of scope, or symlinked: ${missing.join(', ')}`);
  }
}

export function loadApplicationProfile(root) {
  const path = repoFile(root, 'config/profile.yml');
  if (!path || path.relative !== 'config/profile.yml') {
    throw new Error('Required config/profile.yml is missing, out of scope, or symlinked.');
  }
  let profile;
  try {
    profile = yaml.load(readFileSync(path.absolute, 'utf-8'));
  } catch (error) {
    throw new Error(`config/profile.yml is invalid YAML: ${error.message}`);
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('config/profile.yml must contain a YAML mapping.');
  }
  return profile;
}

/** In-scope text files that a quality-review requirement may cite exactly. */
export function candidateEvidenceSourcePaths(root) {
  const direct = DIRECT_EVIDENCE_SOURCES.map((value) => repoFile(root, value)).filter(Boolean);
  return uniqueSorted([...direct, ...interviewPrepFactPaths(root)]);
}

/** Optional role-specific factual or style inputs, included only when cited. */
export function optionalApplicationInputPaths(root) {
  const voice = repoFile(root, 'voice-dna.md');
  return uniqueSorted([
    ...candidateEvidenceSourcePaths(root),
    ...writingSamplePaths(root),
    ...(voice ? [voice] : []),
  ]);
}

function profileCorpusForNamespaces(root, namespaces) {
  const profile = loadApplicationProfile(root);
  const candidateFacing = Object.fromEntries(namespaces
    .filter((key) => Object.prototype.hasOwnProperty.call(profile, key))
    .map((key) => [key, profile[key]]));
  return canonicalJson(candidateFacing);
}

function candidateFacingProfileCorpus(root) {
  return profileCorpusForNamespaces(root, PROFILE_CLAIM_NAMESPACES);
}

function positiveToolProfileCorpus(root) {
  return profileCorpusForNamespaces(root, POSITIVE_TOOL_PROFILE_NAMESPACES);
}

/** All inputs whose edits require application assets to be reviewed again. */
export function applicationFreshnessSourcePaths(root, role = {}) {
  const baseline = BASELINE_ASSET_SOURCES.map((value) => repoFile(root, value)).filter(Boolean);
  const jdInput = resolveRoleJdInput(root, role);
  const requirements = Array.isArray(role.application_quality_review?.top_requirements)
    ? role.application_quality_review.top_requirements
    : [];
  const usedSources = Array.isArray(role.application_quality_review?.sources_used)
    ? role.application_quality_review.sources_used
    : [];
  const citedEvidence = requirements
    .map((item) => resolveCandidateEvidenceSource(root, item?.source))
    .filter(Boolean);
  const explicitlyUsed = usedSources
    .map((source) => resolveOptionalApplicationInput(root, source))
    .filter(Boolean);
  return uniqueSorted([
    ...baseline,
    ...citedEvidence,
    ...explicitlyUsed,
    ...(jdInput?.kind === 'file' ? [jdInput.path] : []),
  ]);
}

export function candidateClaimCorpus(root) {
  return candidateClaimSourcePaths(root)
    .map((path) => {
      const contents = readFileSync(path.absolute, 'utf-8');
      if (path.relative !== 'config/profile.yml') return contents;
      return candidateFacingProfileCorpus(root);
    })
    .join('\n');
}

/**
 * Positive tool inventory for candidate-facing reuse.
 *
 * article-digest.md deliberately records rejected tools, failed experiments,
 * superseded wording, and honesty boundaries. Mere occurrence there cannot
 * prove hands-on skill. A tool must also be promoted into the canonical CV or
 * candidate-facing profile before generated application text may claim it.
 */
export function candidateToolClaimCorpus(root) {
  const cv = repoFile(root, 'cv.md');
  return [
    ...(cv ? [readFileSync(cv.absolute, 'utf-8')] : []),
    positiveToolProfileCorpus(root),
  ].join('\n');
}

/** Resolve a saved JD only from the dedicated, non-secret user directory. */
export function resolveJdSource(root, value) {
  const path = repoFile(root, value);
  if (!path || !path.relative.startsWith('jds/')) return null;
  return ['.md', '.txt'].includes(extname(path.relative).toLowerCase()) ? path : null;
}

/** Select the actual substantive JD branch used by generation. */
export function resolveRoleJdInput(root, role = {}) {
  const inline = typeof role.jd_text === 'string' ? role.jd_text : '';
  if (assessJdContent(inline).substantive) {
    return { kind: 'inline', text: inline };
  }
  const path = resolveJdSource(root, role.jd_path);
  if (!path) return null;
  const text = readFileSync(path.absolute, 'utf-8');
  return assessJdContent(text).substantive ? { kind: 'file', path, text } : null;
}

/** Resolve generated assets only from output/ with their expected format. */
export function resolveApplicationAsset(root, value, kind) {
  const suffix = APPLICATION_ASSET_SUFFIX[kind];
  if (!suffix) return null;
  const path = repoFile(root, value);
  if (!path || !path.relative.startsWith('output/')) return null;
  return path.relative.toLowerCase().endsWith(suffix) ? path : null;
}

export function resolveCandidateEvidenceSource(root, source) {
  const value = String(source || '').replace(/:\d+(?::\d+)?$/, '').split('\\').join('/');
  if (!value) return null;
  const allowed = new Set(candidateEvidenceSourcePaths(root).map((path) => path.relative));
  if (!allowed.has(value)) return null;
  return repoFile(root, value);
}

export function resolveOptionalApplicationInput(root, source) {
  const value = String(source || '').replace(/:\d+(?::\d+)?$/, '').split('\\').join('/');
  if (!value) return null;
  const allowed = new Set(optionalApplicationInputPaths(root).map((path) => path.relative));
  if (!allowed.has(value)) return null;
  return repoFile(root, value);
}

/**
 * Hash every input that could affect generated application assets. This makes
 * provenance independent of filesystem timestamp preservation and catches
 * inline-JD edits that have no file mtime.
 */
export function buildApplicationSourceSnapshot(root, role = {}) {
  const jdInput = resolveRoleJdInput(root, role);
  const files = {};
  for (const path of applicationFreshnessSourcePaths(root, role)) {
    const bytes = readFileSync(path.absolute);
    files[path.relative] = {
      sha256: sha256(bytes),
      bytes: statSync(path.absolute).size,
    };
  }

  const qualityReview = role.application_quality_review && typeof role.application_quality_review === 'object'
    ? role.application_quality_review
    : null;
  const cvReuseJustification = role.cv_reuse_justification
    && typeof role.cv_reuse_justification === 'object'
    && !Array.isArray(role.cv_reuse_justification)
    ? role.cv_reuse_justification
    : null;
  return {
    schema: 2,
    files,
    jd_source: jdInput?.kind === 'file'
      ? { kind: 'file', path: jdInput.path.relative }
      : jdInput?.kind === 'inline'
        ? { kind: 'inline' }
        : null,
    inline_jd: jdInput?.kind === 'inline'
      ? { sha256: sha256(Buffer.from(jdInput.text, 'utf-8')), bytes: Buffer.byteLength(jdInput.text, 'utf-8') }
      : null,
    quality_review_sha256: qualityReview ? sha256(canonicalJson(qualityReview)) : null,
    cv_reuse_justification_sha256: cvReuseJustification
      ? sha256(canonicalJson(cvReuseJustification))
      : null,
    role_context: {
      company: String(role.company || ''),
      title: String(role.title || ''),
      location: String(role.location || ''),
      url: String(role.url || ''),
      jd_source: jdInput?.kind === 'file' ? jdInput.path.relative : jdInput?.kind || '',
      scored_at: String(role.scored_at || ''),
      employment_type: String(role.employment_type || ''),
      visa_answer: String(role.visa_answer || ''),
    },
  };
}
