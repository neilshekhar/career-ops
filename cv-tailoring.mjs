#!/usr/bin/env node
/**
 * cv-tailoring.mjs — Contextual role-tailoring checks. Zero model tokens.
 *
 * WHY THIS EXISTS
 * ---------------
 * `generation_provenance` already binds each asset's path, content SHA-256, PDF
 * layout, source snapshot, and role context, so a *wrong-file* CV (pointing at
 * last week's PDF) is caught. What it cannot catch is a CV that was freshly
 * generated and correctly stamped but whose visible text is byte-identical to the
 * one sent to a materially different role. That is a tailoring failure, not a
 * provenance failure, and it is the shape of the reported npm complaint: assets
 * that were not actually written for the role.
 *
 * THE RULE (deliberately contextual, not an unconditional ban)
 * -----------------------------------------------------------
 * Two CVs with identical normalized visible text **trigger a check**, they do not
 * fail by themselves. Closely related roles may legitimately share one CV; a
 * Senior Data Scientist and a Site Reliability Engineer may not. So:
 *
 *   1. Hash the normalized visible CV text (metadata excluded).
 *   2. Hashes differ            → nothing to check.
 *   3. Hashes match             → compare the roles' ALREADY-STORED evidence.
 *   4. Materially similar       → allow, and record the overlap as the reason.
 *   5. Materially different     → require a source-supported `cv_reuse_justification`
 *                                 written during the existing PREPARE turn.
 *   6. Different + no valid justification → fail.
 *
 * Cover letters are stricter: an identical normalized cover body across different
 * companies fails unless the roles are a confirmed duplicate route for the same
 * requisition.
 *
 * Everything here is deterministic string/set work. No validator ever calls a
 * model — that is asserted by a test.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';

import { resolveApplicationAsset } from './application-source-contract.mjs';

/**
 * Content-identity cache, keyed by absolute path + size + mtime.
 *
 * `verifyUserData` validates every role against every comparable peer, so a
 * naive implementation re-reads and re-hashes the same CV once per pair — O(n²)
 * file reads over the whole queue. The key includes size and mtime so a
 * regenerated asset is never served from a stale entry.
 */
const identityCache = new Map();

function cachedIdentity(absolute, compute) {
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return null;
  }
  const key = `${absolute}:${stats.size}:${stats.mtimeMs}`;
  if (identityCache.has(key)) return identityCache.get(key);
  const value = compute();
  // Bounded so a long-lived process (the dashboard) cannot grow without limit.
  if (identityCache.size > 2000) identityCache.clear();
  identityCache.set(key, value);
  return value;
}

/** Statuses whose assets are real enough to compare against. */
export const TAILORING_COMPARABLE_STATUSES = new Set([
  'prepared', 'prefilled', 'filled', 'submitted',
]);

export const DEFAULT_TAILORING = Object.freeze({
  requireRoleTailoredCv: true,
  requirementOverlapMin: 0.6,
  minSharedRequirements: 2,
  justificationMinChars: 40,
  justificationEvidenceMinChars: 6,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Visible text of an HTML document: no tags, no style/script, no comments,
 * entities decoded, whitespace collapsed.
 *
 * Canonical implementation — `verify-userdata.mjs` imports this one so the
 * punctuation gate and the tailoring gate can never disagree about what "the
 * visible text" is.
 */
export function visibleHtmlText(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
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

/**
 * Normalize for content identity: case-folded, punctuation-stripped, collapsed.
 * Two documents with the same normalized text say the same thing to a reader,
 * even if one differs by a template tweak or a stray comma.
 */
export function normalizeContentText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 of a CV's normalized visible text, or null if unreadable. */
export function cvVisibleTextHash(root, role) {
  const cvPdf = typeof role?.cv_pdf === 'string' ? role.cv_pdf : '';
  if (!/\.pdf$/i.test(cvPdf)) return null;
  const htmlPath = resolveApplicationAsset(root, cvPdf.replace(/\.pdf$/i, '.html'), 'cv_html');
  if (!htmlPath || !existsSync(htmlPath.absolute)) return null;
  return cachedIdentity(htmlPath.absolute, () => {
    const normalized = normalizeContentText(visibleHtmlText(readFileSync(htmlPath.absolute, 'utf-8')));
    if (!normalized) return null;
    return { hash: sha256(normalized), chars: normalized.length, path: htmlPath.relative };
  });
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

/** SHA-256 of a cover letter's normalized body, or null if unreadable. */
export function coverBodyHash(root, role) {
  const covers = { ...(role?.cover_letter_paths || {}) };
  const payloadPath = resolveApplicationAsset(root, covers.payload, 'cover_payload');
  if (!payloadPath || !existsSync(payloadPath.absolute)) return null;
  return cachedIdentity(payloadPath.absolute, () => {
    let payload;
    try {
      payload = JSON.parse(readFileSync(payloadPath.absolute, 'utf-8'));
    } catch {
      return null;
    }
    const normalized = normalizeContentText(payloadBody(payload));
    if (!normalized) return null;
    return { hash: sha256(normalized), chars: normalized.length, path: payloadPath.relative };
  });
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'a', 'an', 'of', 'to', 'in', 'on', 'or', 'is',
  'are', 'be', 'as', 'at', 'by', 'from', 'that', 'this', 'will', 'you', 'your',
  'we', 'our', 'have', 'has', 'able', 'using', 'use', 'work', 'role', 'team',
]);

function contentTokens(text) {
  return new Set(
    normalizeContentText(text)
      .split(' ')
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function storedRequirementTokens(role) {
  const review = role?.application_quality_review;
  const requirements = Array.isArray(review?.top_requirements)
    ? review.top_requirements.map((item) => item?.requirement)
    : [];
  return contentTokens([
    ...requirements,
    ...(Array.isArray(role?.ksc_criteria) ? role.ksc_criteria : []),
    role?.requirements_snippet,
  ].filter(Boolean).join(' '));
}

/**
 * The role's stored requirement evidence — read only, never recomputed.
 *
 * Reuses `application_quality_review.top_requirements` (already written during
 * PREPARE), `ksc_criteria`, and `requirements_snippet`. Optional `archetype` /
 * `seniority` / `domain` fields are honoured when a review records them.
 */
export function roleRequirementSignature(role) {
  const review = role?.application_quality_review;
  const requirements = Array.isArray(review?.top_requirements) ? review.top_requirements : [];
  const requirementTexts = requirements
    .map((item) => String(item?.requirement || '').trim())
    .filter(Boolean);
  const ksc = Array.isArray(role?.ksc_criteria) ? role.ksc_criteria.map(String) : [];
  const corpus = [
    ...requirementTexts,
    ...ksc,
    String(role?.requirements_snippet || ''),
    String(role?.title || ''),
  ].join(' ');
  return {
    requirements: requirementTexts.map((text) => normalizeContentText(text)).filter(Boolean),
    tokens: contentTokens(corpus),
    archetype: normalizeContentText(review?.archetype || ''),
    seniority: normalizeContentText(review?.seniority || ''),
    domain: normalizeContentText(review?.domain || ''),
    employmentType: normalizeContentText(role?.employment_type || ''),
    title: normalizeContentText(role?.title || ''),
  };
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Are two roles' requirements materially similar? Deterministic, explainable.
 *
 * @returns {{similar: boolean, overlap: number, sharedRequirements: string[], reasons: string[]}}
 */
export function requirementSimilarity(left, right, tailoring = DEFAULT_TAILORING) {
  const sharedRequirements = left.requirements.filter((item) => right.requirements.includes(item));
  const overlap = jaccard(left.tokens, right.tokens);
  const reasons = [];

  // An explicitly recorded archetype/seniority mismatch is decisive: it is the
  // strongest signal a review can give that these are different jobs.
  const archetypeConflict = Boolean(left.archetype && right.archetype
    && left.archetype !== right.archetype);
  const seniorityConflict = Boolean(left.seniority && right.seniority
    && left.seniority !== right.seniority);
  const domainConflict = Boolean(left.domain && right.domain && left.domain !== right.domain);
  const employmentTypeConflict = Boolean(
    left.employmentType && right.employmentType
    && left.employmentType !== right.employmentType,
  );
  if (archetypeConflict) reasons.push(`archetype differs (${left.archetype} vs ${right.archetype})`);
  if (seniorityConflict) reasons.push(`seniority differs (${left.seniority} vs ${right.seniority})`);
  if (domainConflict) reasons.push(`domain differs (${left.domain} vs ${right.domain})`);
  if (employmentTypeConflict) {
    reasons.push(`employment type differs (${left.employmentType} vs ${right.employmentType})`);
  }

  if (archetypeConflict || seniorityConflict || domainConflict || employmentTypeConflict) {
    return { similar: false, overlap, sharedRequirements, reasons };
  }

  const enoughShared = sharedRequirements.length >= tailoring.minSharedRequirements;
  const enoughOverlap = overlap >= tailoring.requirementOverlapMin;
  if (enoughShared || enoughOverlap) {
    return {
      similar: true,
      overlap,
      sharedRequirements,
      reasons: [
        ...(enoughShared ? [`${sharedRequirements.length} shared stored requirement(s)`] : []),
        ...(enoughOverlap ? [`requirement token overlap ${overlap.toFixed(2)} >= ${tailoring.requirementOverlapMin}`] : []),
      ],
    };
  }
  return {
    similar: false,
    overlap,
    sharedRequirements,
    reasons: [
      ...reasons,
      `requirement token overlap ${overlap.toFixed(2)} < ${tailoring.requirementOverlapMin}`,
      `${sharedRequirements.length} shared stored requirement(s) < ${tailoring.minSharedRequirements}`,
    ],
  };
}

/**
 * Is the role's stored `cv_reuse_justification` valid for reusing this CV
 * against `peerRoleId`?
 *
 * Valid means: it names the peer role, it is substantive, and every piece of
 * evidence it cites actually occurs in the shared visible CV text. That last
 * clause is what stops a hand-waved justification from unlocking anything.
 */
export function cvReuseJustificationErrors(role, peer, cvText, tailoring = DEFAULT_TAILORING) {
  const peerRoleId = String(peer?.id || '');
  const record = role?.cv_reuse_justification;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [`no cv_reuse_justification is stored for reusing this CV alongside ${peerRoleId}`];
  }
  const errors = [];
  const covered = Array.isArray(record.covers_role_ids) ? record.covers_role_ids.map(String) : [];
  for (const requiredRoleId of [String(role.id || ''), peerRoleId]) {
    if (!requiredRoleId || !covered.includes(requiredRoleId)) {
      errors.push(`cv_reuse_justification does not cover role ${requiredRoleId || '(missing id)'}`);
    }
  }
  const rationale = String(record.rationale || '').trim();
  if (rationale.length < tailoring.justificationMinChars) {
    errors.push(`cv_reuse_justification rationale must be at least ${tailoring.justificationMinChars} characters`);
  }
  const evidence = Array.isArray(record.shared_evidence) ? record.shared_evidence : [];
  if (evidence.length === 0) {
    errors.push('cv_reuse_justification must cite shared_evidence present in the CV');
  }
  const haystack = normalizeContentText(cvText);
  const evidenceTokens = new Set();
  for (const item of evidence) {
    const needle = normalizeContentText(item);
    if (!needle) {
      errors.push('cv_reuse_justification shared_evidence contains an empty entry');
      continue;
    }
    if (needle.length < tailoring.justificationEvidenceMinChars) {
      errors.push(
        `cv_reuse_justification evidence must be at least `
        + `${tailoring.justificationEvidenceMinChars} meaningful characters: ${JSON.stringify(String(item))}`,
      );
      continue;
    }
    const tokens = contentTokens(needle);
    if (tokens.size === 0) {
      errors.push(`cv_reuse_justification evidence is not meaningful: ${JSON.stringify(String(item))}`);
      continue;
    }
    for (const token of tokens) evidenceTokens.add(token);
    if (!(` ${haystack} `.includes(` ${needle} `))) {
      errors.push(`cv_reuse_justification cites evidence absent from the shared CV: ${JSON.stringify(String(item))}`);
    }
  }
  if (evidenceTokens.size > 0) {
    for (const [candidate, requirementTokens] of [
      [String(role.id || ''), storedRequirementTokens(role)],
      [peerRoleId, storedRequirementTokens(peer)],
    ]) {
      const matching = [...evidenceTokens].filter((token) => requirementTokens.has(token));
      const minimum = requirementTokens.size > 0 ? 1 : 0;
      if (minimum === 0 || matching.length < minimum) {
        errors.push(
          `cv_reuse_justification evidence does not cover stored requirements for role ${candidate}`
          + (minimum > 0 ? ` (matched ${matching.length}/${minimum} required evidence tokens)` : ''),
        );
      }
    }
  }
  return errors;
}

/** Roles that could legitimately share a cover body: same requisition, two routes. */
function isDuplicateRoute(role, peer) {
  const roleReq = String(role?.requisition_id || '').trim();
  const peerReq = String(peer?.requisition_id || '').trim();
  if (!roleReq || roleReq !== peerReq) return false;
  const roleCompany = normalizeContentText(role?.company || '');
  const peerCompany = normalizeContentText(peer?.company || '');
  return Boolean(roleCompany && roleCompany === peerCompany);
}

export function tailoringConfig(quality = {}) {
  return {
    requireRoleTailoredCv: quality.requireRoleTailoredCv ?? DEFAULT_TAILORING.requireRoleTailoredCv,
    requirementOverlapMin: Number.isFinite(quality.tailoringRequirementOverlapMin)
      ? quality.tailoringRequirementOverlapMin
      : DEFAULT_TAILORING.requirementOverlapMin,
    minSharedRequirements: Number.isFinite(quality.tailoringMinSharedRequirements)
      ? quality.tailoringMinSharedRequirements
      : DEFAULT_TAILORING.minSharedRequirements,
    justificationMinChars: Number.isFinite(quality.tailoringJustificationMinChars)
      ? quality.tailoringJustificationMinChars
      : DEFAULT_TAILORING.justificationMinChars,
    justificationEvidenceMinChars: DEFAULT_TAILORING.justificationEvidenceMinChars,
  };
}

/**
 * The contextual tailoring gate for one role against its comparable peers.
 *
 * @param {object} role     The role being validated.
 * @param {object[]} peers  Other queue roles with real assets.
 * @param {object} options  { root, quality }
 * @returns {{level: 'error'|'warning', code: string, message: string, peer_role_id: string, path?: string}[]}
 */
export function validateRoleTailoring(role, peers = [], options = {}) {
  const root = options.root;
  const tailoring = tailoringConfig(options.quality || {});
  const findings = [];

  const comparable = peers.filter((peer) =>
    peer && peer.id !== role.id && TAILORING_COMPARABLE_STATUSES.has(peer.status));
  if (comparable.length === 0) return findings;

  const cv = cvVisibleTextHash(root, role);
  const cover = coverBodyHash(root, role);
  const signature = roleRequirementSignature(role);
  // Read the shared CV text once, only if we actually need to check evidence.
  let cvText = null;
  const readCvText = () => {
    if (cvText != null) return cvText;
    const htmlPath = cv ? resolveApplicationAsset(root, cv.path, 'cv_html') : null;
    cvText = htmlPath && existsSync(htmlPath.absolute)
      ? visibleHtmlText(readFileSync(htmlPath.absolute, 'utf-8'))
      : '';
    return cvText;
  };

  for (const peer of comparable) {
    // ── Identical CV ────────────────────────────────────────────────────────
    if (cv) {
      const peerCv = cvVisibleTextHash(root, peer);
      if (peerCv && peerCv.hash === cv.hash) {
        const similarity = requirementSimilarity(signature, roleRequirementSignature(peer), tailoring);
        if (similarity.similar) {
          // Step 4: allowed, with the overlap as the deterministic reason.
          findings.push({
            level: 'info',
            code: 'cv-reuse-allowed',
            message: `CV text is shared with ${peer.id} and allowed: ${similarity.reasons.join('; ')}.`,
            peer_role_id: peer.id,
            path: cv.path,
          });
        } else {
          // Both roles carry the same pair-bound record. This role's generation
          // provenance and quality evidence hash only this role's fields, so a
          // record found solely on the peer must not unlock the current role.
          const justificationErrors = cvReuseJustificationErrors(
            role, peer, readCvText(), tailoring,
          );
          if (justificationErrors.length) {
            findings.push({
              level: tailoring.requireRoleTailoredCv ? 'error' : 'warning',
              code: 'cv-not-role-tailored',
              message: `CV visible text is identical to ${peer.company ?? peer.id} – ${peer.title ?? ''} `
                + `but the roles differ materially (${similarity.reasons.join('; ')}). `
                + `${justificationErrors.join('; ')}.`,
              peer_role_id: peer.id,
              path: cv.path,
            });
          } else {
            findings.push({
              level: 'info',
              code: 'cv-reuse-justified',
              message: `CV text is shared with ${peer.id} under a source-supported cv_reuse_justification.`,
              peer_role_id: peer.id,
              path: cv.path,
            });
          }
        }
      }
    }

    // ── Identical cover body: stricter, no similarity escape hatch ──────────
    if (cover) {
      const peerCover = coverBodyHash(root, peer);
      if (peerCover && peerCover.hash === cover.hash && !isDuplicateRoute(role, peer)) {
        findings.push({
          level: 'error',
          code: 'cover-not-company-specific',
          message: `Cover body is identical to ${peer.company ?? peer.id} – ${peer.title ?? ''}. `
            + 'A cover letter must be written for this company; only the same company and '
            + 'same non-empty requisition_id qualify as a duplicate route.',
          peer_role_id: peer.id,
          path: cover.path,
        });
      }
    }
  }
  return findings;
}
