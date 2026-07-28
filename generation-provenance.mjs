#!/usr/bin/env node

/**
 * generation-provenance.mjs — fail-closed provenance for application assets.
 *
 * A model or agent may generate files, but those files are not release-eligible
 * until this helper records the interactive generation flow, CLI/model label,
 * exact repository paths, and SHA-256 hashes on the queue role. The independent
 * verify-userdata.mjs gate checks this record immediately before any form fill.
 *
 * Usage:
 *   node generation-provenance.mjs stamp --role <id> --cli <cli> --model <model> [--effort <effort>]
 *   node generation-provenance.mjs check-batch-model --model <model>
 */

import { createHash, randomUUID } from 'crypto';
import {
  existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import {
  assertRequiredApplicationSources,
  buildApplicationSourceSnapshot,
  loadApplicationProfile,
  resolveApplicationAsset,
  resolveRoleJdInput,
} from './application-source-contract.mjs';
import { buildMarkdown } from './generate-cover-markdown.mjs';
import { coverSkeletonFingerprints } from './cover-quality.mjs';
import { loadQueue, mutateQueue } from './queue-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const PROVENANCE_SCHEMA = 3;
export const RELEASE_FLOW = 'interactive-prepare';
export const BATCH_DRAFT_FLOW = 'batch-draft';
export const PDF_LAYOUT_EVIDENCE_SCHEMA = 1;
export const MIN_ONE_PAGE_UTILIZATION = 0.85;
export const DEFAULT_BATCH_ASSET_MODELS = Object.freeze([
  '*',
]);
export const RELEASE_MODEL_POLICIES = Object.freeze(['open', 'allowlist']);

const PRINTABLE_PAGE_BOXES = Object.freeze({
  a4: Object.freeze({ width_px: 698, height_px: 1026 }),
  letter: Object.freeze({ width_px: 720, height_px: 960 }),
});

function finiteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function layoutEvidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function printablePageBox(format = 'a4') {
  const normalized = String(format || 'a4').trim().toLowerCase();
  const box = PRINTABLE_PAGE_BOXES[normalized];
  if (!box) throw new Error(`Unsupported PDF layout format: ${format}`);
  return { format: normalized, ...box };
}

export function pdfLayoutEvidencePath(pdfPath) {
  return `${resolve(pdfPath)}.layout.json`;
}

export function buildPdfLayoutEvidence({
  pdfPath,
  pdfBuffer = null,
  format = 'a4',
  pageCount,
  measurement,
  measuredAt = new Date(),
}) {
  const absolutePdf = resolve(pdfPath);
  const contents = pdfBuffer ?? readFileSync(absolutePdf);
  const printable = printablePageBox(format);
  const pages = Number(pageCount);
  if (!Number.isInteger(pages) || pages < 1) throw new Error('PDF layout pageCount must be a positive integer');
  const top = finiteNumber(measurement?.top_px ?? measurement?.topPx ?? 0, 'PDF content top');
  const bottom = finiteNumber(measurement?.bottom_px ?? measurement?.bottomPx, 'PDF content bottom');
  const height = finiteNumber(measurement?.height_px ?? measurement?.heightPx, 'PDF content height');
  if (top < 0 || bottom < top || height < 0) throw new Error('PDF layout content bounds are invalid');
  const utilization = rounded(height / printable.height_px);
  const timestamp = measuredAt instanceof Date ? measuredAt : new Date(measuredAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error('PDF layout measuredAt timestamp is invalid');
  return {
    schema: PDF_LAYOUT_EVIDENCE_SCHEMA,
    generator: 'generate-pdf.mjs',
    measured_at: timestamp.toISOString(),
    pdf_filename: absolutePdf.split(/[\\/]/).pop(),
    pdf_sha256: createHash('sha256').update(contents).digest('hex'),
    pdf_bytes: contents.length,
    format: printable.format,
    page_count: pages,
    printable: {
      width_px: printable.width_px,
      height_px: printable.height_px,
      margin_in: 0.5,
      css_dpi: 96,
    },
    content: {
      top_px: rounded(top, 2),
      bottom_px: rounded(bottom, 2),
      height_px: rounded(height, 2),
    },
    printable_height_utilization: utilization,
  };
}

export function persistPdfLayoutEvidence(pdfPath, evidence) {
  const target = pdfLayoutEvidencePath(pdfPath);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return target;
}

export function validatePdfLayoutEvidence(pdfPath, options = {}) {
  const absolutePdf = resolve(pdfPath);
  const evidencePath = pdfLayoutEvidencePath(absolutePdf);
  if (!existsSync(evidencePath)) {
    throw layoutEvidenceError(
      'PDF_LAYOUT_EVIDENCE_MISSING',
      `PDF layout evidence is missing: ${evidencePath}`,
    );
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw layoutEvidenceError(
      'PDF_LAYOUT_EVIDENCE_INVALID',
      `PDF layout evidence is invalid JSON: ${error.message}`,
    );
  }
  if (evidence?.schema !== PDF_LAYOUT_EVIDENCE_SCHEMA || evidence?.generator !== 'generate-pdf.mjs') {
    throw layoutEvidenceError(
      'PDF_LAYOUT_EVIDENCE_INVALID',
      `PDF layout evidence schema/generator must be ${PDF_LAYOUT_EVIDENCE_SCHEMA}/generate-pdf.mjs`,
    );
  }
  if (!existsSync(absolutePdf)) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', `PDF layout evidence target is missing: ${absolutePdf}`);
  }
  const contents = readFileSync(absolutePdf);
  const digest = createHash('sha256').update(contents).digest('hex');
  if (evidence.pdf_sha256 !== digest || evidence.pdf_bytes !== contents.length) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence does not match the current PDF bytes');
  }
  if (evidence.pdf_filename !== absolutePdf.split(/[\\/]/).pop()) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence filename does not match its PDF');
  }
  const measuredAt = Date.parse(evidence.measured_at || '');
  if (!Number.isFinite(measuredAt)) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence timestamp is invalid');
  }
  const printable = printablePageBox(evidence.format);
  if (
    Number(evidence.printable?.width_px) !== printable.width_px
    || Number(evidence.printable?.height_px) !== printable.height_px
    || Number(evidence.printable?.margin_in) !== 0.5
    || Number(evidence.printable?.css_dpi) !== 96
  ) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence printable box is invalid');
  }
  const pages = Number(evidence.page_count);
  if (!Number.isInteger(pages) || pages < 1) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence page count is invalid');
  }
  if (options.expectedPageCount != null && pages !== Number(options.expectedPageCount)) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence page count differs from the PDF');
  }
  const top = Number(evidence.content?.top_px);
  const bottom = Number(evidence.content?.bottom_px);
  const height = Number(evidence.content?.height_px);
  const utilization = Number(evidence.printable_height_utilization);
  if (
    !Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(height)
    || top < 0 || bottom < top || height < 0 || !Number.isFinite(utilization)
    || Math.abs((bottom - top) - height) > 0.05
    || Math.abs(utilization - rounded(height / printable.height_px)) > 0.0001
  ) {
    throw layoutEvidenceError('PDF_LAYOUT_EVIDENCE_INVALID', 'PDF layout evidence content measurement is invalid');
  }
  const minimum = Number(options.minOnePageUtilization ?? MIN_ONE_PAGE_UTILIZATION);
  if (pages === 1 && utilization < minimum) {
    throw layoutEvidenceError(
      'PDF_LAYOUT_UNDERFILLED',
      `One-page printable content utilization is ${(utilization * 100).toFixed(1)}%; minimum is ${(minimum * 100).toFixed(0)}%`,
    );
  }
  return { evidencePath, evidence };
}

export function pdfLayoutProvenanceRecord(pdfPath, { root = ROOT, expectedPageCount = null } = {}) {
  const { evidencePath, evidence } = validatePdfLayoutEvidence(pdfPath, { expectedPageCount });
  const canonicalRoot = realpathSync(resolve(root));
  const canonicalEvidencePath = realpathSync(evidencePath);
  const rel = relative(canonicalRoot, canonicalEvidencePath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('PDF layout evidence must remain inside the career-ops project');
  }
  return {
    path: rel.split(sep).join('/'),
    sha256: sha256File(evidencePath),
    schema: evidence.schema,
    page_count: evidence.page_count,
    printable_height_utilization: evidence.printable_height_utilization,
  };
}

function coverPaths(role) {
  const paths = { ...(role.cover_letter_paths || {}) };
  if (role.cover_letter_path && !paths.pdf) paths.pdf = role.cover_letter_path;
  return paths;
}

export function roleAssetPaths(role) {
  const covers = coverPaths(role);
  const cvHtml = typeof role.cv_pdf === 'string' && /\.pdf$/i.test(role.cv_pdf)
    ? role.cv_pdf.replace(/\.pdf$/i, '.html')
    : null;
  return {
    cv_pdf: role.cv_pdf || null,
    cv_html: cvHtml,
    cover_md: covers.md || null,
    cover_pdf: covers.pdf || null,
    cover_docx: covers.docx || null,
    cover_payload: covers.payload || null,
  };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function pdfPageCount(path) {
  const contents = readFileSync(path).toString('latin1');
  return (contents.match(/\/Type\s*\/Page\b/g) || []).length;
}

function normalizedMarkdown(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trimEnd();
}

export function coverMarkdownMatchesPayload(payload, markdown) {
  try {
    return normalizedMarkdown(markdown) === normalizedMarkdown(buildMarkdown(payload));
  } catch {
    return false;
  }
}

export function buildGenerationProvenance({
  role,
  cli,
  model,
  effort = null,
  flow = RELEASE_FLOW,
  root = ROOT,
  now = new Date(),
}) {
  if (!role?.id) throw new Error('A queue role with an id is required.');
  if (!String(cli || '').trim()) throw new Error('Generator CLI is required.');
  if (!String(model || '').trim()) throw new Error('Generator model is required.');
  if (![RELEASE_FLOW, BATCH_DRAFT_FLOW].includes(flow)) {
    throw new Error(`Unsupported generation flow: ${flow}`);
  }
  assertRequiredApplicationSources(root);
  if (!resolveRoleJdInput(root, role)) {
    throw new Error('A substantive inline JD or approved jds/ source is required before generation provenance can be recorded.');
  }

  const assets = {};
  for (const [kind, value] of Object.entries(roleAssetPaths(role))) {
    if (!value) continue;
    const path = resolveApplicationAsset(root, value, kind);
    if (!path) {
      throw new Error(`${kind} is missing, out of scope, symlinked, or has the wrong format: ${value}`);
    }
    assets[kind] = {
      path: path.relative,
      sha256: sha256File(path.absolute),
      bytes: statSync(path.absolute).size,
      ...(/_pdf$/.test(kind) ? {
        layout: pdfLayoutProvenanceRecord(path.absolute, {
          root,
          expectedPageCount: pdfPageCount(path.absolute),
        }),
      } : {}),
    };
  }

  for (const required of ['cv_pdf', 'cv_html', 'cover_md', 'cover_pdf', 'cover_payload']) {
    if (!assets[required]) throw new Error(`Required application asset is missing: ${required}`);
  }
  let coverPayload;
  try {
    coverPayload = JSON.parse(readFileSync(resolveApplicationAsset(root, roleAssetPaths(role).cover_payload, 'cover_payload').absolute, 'utf-8'));
  } catch (error) {
    throw new Error(`Canonical cover payload is invalid JSON: ${error.message}`);
  }
  const coverMarkdown = readFileSync(resolveApplicationAsset(root, roleAssetPaths(role).cover_md, 'cover_md').absolute, 'utf-8');
  if (!coverMarkdownMatchesPayload(coverPayload, coverMarkdown)) {
    throw new Error('Cover Markdown diverges from the canonical cover payload; re-render all cover formats before stamping provenance.');
  }
  const templates = detectAssetTemplates(root, role);
  if (!isSupportedCvTemplateIdentity(templates.cv)) {
    throw new Error(
      `CV template identity is missing or unsupported: `
      + `${templates.cv?.template_id || 'unrecorded'}@${templates.cv?.template_version || 'missing'}`,
    );
  }

  return {
    schema: PROVENANCE_SCHEMA,
    flow,
    interactive: flow === RELEASE_FLOW,
    recorded_at: now.toISOString(),
    generator: {
      cli: String(cli).trim().toLowerCase(),
      model: String(model).trim(),
      ...(String(effort || '').trim() ? { effort: String(effort).trim().toLowerCase() } : {}),
    },
    assets,
    // Which supported renderer produced the CV. Recording the identity beats
    // requiring one exact CSS shape: standard, conservative, and localized
    // templates all stay valid, while a hand-built unrecorded template is
    // detectable. Detected from the rendered HTML, not asserted by the caller.
    templates,
    // Normalized opening/closing structure, with company and role names
    // replaced by placeholders BEFORE hashing. Two letters that differ only by
    // the employer name collide, which is how repeated skeletons are caught.
    cover_skeleton: coverSkeletonFingerprints(coverPayload, role),
    source_snapshot: buildApplicationSourceSnapshot(root, role),
  };
}

/**
 * Supported CV template identities, newest first. Each entry names a marker that
 * the rendered HTML carries when that template produced it.
 */
export const SUPPORTED_CV_TEMPLATES = Object.freeze([
  { id: 'cv-template', version: 1, marker: /career-ops-template-id["']?\s*[:=]\s*["']?cv-template/i },
  { id: 'cv-template-html', version: 1, marker: /<!--\s*career-ops:cv-template\s*-->/i },
]);

export function isSupportedCvTemplateIdentity(identity) {
  if (!identity || typeof identity !== 'object') return false;
  return SUPPORTED_CV_TEMPLATES.some((entry) =>
    String(identity.template_id || '') === entry.id
    && String(identity.template_version || '') === String(entry.version));
}

/**
 * Detect which supported template rendered each asset.
 *
 * An explicit `<meta name="career-ops-template-id">` stamp wins. Otherwise the
 * renderer is reported as `unrecorded`, which a profile may choose to reject.
 */
export function detectAssetTemplates(root, role) {
  const out = {};
  const htmlPath = resolveApplicationAsset(root, roleAssetPaths(role).cv_html, 'cv_html');
  if (!htmlPath) return out;
  const html = readFileSync(htmlPath.absolute, 'utf-8');
  const stamped = html.match(/<meta\s+name=["']career-ops-template-id["']\s+content=["']([^"']+)["']/i);
  const version = html.match(/<meta\s+name=["']career-ops-template-version["']\s+content=["']([^"']+)["']/i);
  if (stamped) {
    out.cv = { template_id: stamped[1], template_version: version ? version[1] : null, source: 'stamped' };
    return out;
  }
  const matched = SUPPORTED_CV_TEMPLATES.find((entry) => entry.marker.test(html));
  out.cv = matched
    ? { template_id: matched.id, template_version: String(matched.version), source: 'detected' }
    : { template_id: 'unrecorded', template_version: null, source: 'none' };
  return out;
}

function loadProfile(root = ROOT) {
  return loadApplicationProfile(root);
}

export function allowedBatchAssetModels(profile = {}) {
  const configured = profile.application_quality?.allowed_batch_asset_models;
  return Array.isArray(configured)
    ? configured.map((value) => String(value).trim()).filter(Boolean)
    : [...DEFAULT_BATCH_ASSET_MODELS];
}

export function isAllowedBatchAssetModel(model, profile = {}) {
  const candidate = String(model || '').trim().toLowerCase();
  if (!candidate) return false;
  return allowedBatchAssetModels(profile).some((allowed) => {
    const normalized = allowed.toLowerCase();
    return normalized === '*' || normalized === candidate;
  });
}

export function allowedReleaseModels(profile = {}) {
  const configured = profile.application_quality?.allowed_release_models;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).map(([cli, models]) => [
    String(cli).trim().toLowerCase(),
    Array.isArray(models) ? models.map((model) => String(model).trim().toLowerCase()).filter(Boolean) : [],
  ]).filter(([, models]) => models.length));
}

export function releaseModelPolicy(profile = {}) {
  const configured = String(profile.application_quality?.release_model_policy || '').trim().toLowerCase();
  if (configured) return RELEASE_MODEL_POLICIES.includes(configured) ? configured : 'invalid';
  return Object.keys(allowedReleaseModels(profile)).length ? 'allowlist' : 'open';
}

export function isAllowedReleaseGenerator(cli, model, profile = {}) {
  const policy = releaseModelPolicy(profile);
  if (policy === 'open') return Boolean(String(cli || '').trim() && String(model || '').trim());
  if (policy !== 'allowlist') return false;
  const configured = allowedReleaseModels(profile);
  const candidateCli = String(cli || '').trim().toLowerCase();
  const candidateModel = String(model || '').trim().toLowerCase();
  const candidates = [...(configured[candidateCli] || []), ...(configured['*'] || [])];
  return Boolean(candidateCli && candidateModel && candidates.some((allowed) => allowed === '*' || allowed === candidateModel));
}

export function describeReleaseModelPolicy(profile = {}) {
  const policy = releaseModelPolicy(profile);
  if (policy === 'open') return 'open policy (any explicitly identified CLI/model)';
  if (policy === 'invalid') return 'invalid release_model_policy (expected open or allowlist)';
  const allowed = Object.entries(allowedReleaseModels(profile))
    .flatMap(([cli, models]) => models.map((model) => `${cli}/${model}`));
  return allowed.length ? allowed.join(', ') : 'empty allowlist (no generator is eligible)';
}

export function allowedReleaseEfforts(profile = {}) {
  const configured = profile.application_quality?.allowed_release_efforts;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).map(([cli, efforts]) => [
    String(cli).trim().toLowerCase(),
    Array.isArray(efforts) ? efforts.map((effort) => String(effort).trim().toLowerCase()).filter(Boolean) : [],
  ]).filter(([, efforts]) => efforts.length));
}

export function allowedReleaseModelEfforts(profile = {}) {
  const configured = profile.application_quality?.allowed_release_model_efforts;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  return Object.fromEntries(Object.entries(configured).map(([cli, models]) => {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return [String(cli).trim().toLowerCase(), {}];
    return [
      String(cli).trim().toLowerCase(),
      Object.fromEntries(Object.entries(models).map(([model, efforts]) => [
        String(model).trim().toLowerCase(),
        Array.isArray(efforts) ? efforts.map((effort) => String(effort).trim().toLowerCase()).filter(Boolean) : [],
      ]).filter(([model, efforts]) => model && efforts.length)),
    ];
  }).filter(([cli, models]) => cli && Object.keys(models).length));
}

export function isAllowedReleaseEffort(cli, effort, profile = {}) {
  const configured = allowedReleaseEfforts(profile);
  if (!Object.keys(configured).length) return true;
  const candidateCli = String(cli || '').trim().toLowerCase();
  const candidateEffort = String(effort || '').trim().toLowerCase();
  const candidates = [...(configured[candidateCli] || []), ...(configured['*'] || [])];
  return Boolean(candidateCli && candidateEffort && candidates.some((allowed) => allowed === '*' || allowed === candidateEffort));
}

export function isAllowedReleaseModelEffort(cli, model, effort, profile = {}) {
  const configured = allowedReleaseModelEfforts(profile);
  const candidateCli = String(cli || '').trim().toLowerCase();
  const candidateModel = String(model || '').trim().toLowerCase();
  const candidateEffort = String(effort || '').trim().toLowerCase();
  const overrides = [
    configured[candidateCli]?.[candidateModel],
    configured[candidateCli]?.['*'],
    configured['*']?.[candidateModel],
    configured['*']?.['*'],
  ].filter(Array.isArray);
  if (!overrides.length) return isAllowedReleaseEffort(candidateCli, candidateEffort, profile);
  return Boolean(candidateCli && candidateModel && candidateEffort
    && overrides.flat().some((allowed) => allowed === '*' || allowed === candidateEffort));
}

export function describeReleaseEffortPolicy(profile = {}) {
  const configured = allowedReleaseEfforts(profile);
  const defaults = Object.entries(configured)
    .flatMap(([cli, efforts]) => efforts.map((effort) => `${cli}/${effort}`))
    .join(', ');
  const overrides = Object.entries(allowedReleaseModelEfforts(profile))
    .flatMap(([cli, models]) => Object.entries(models)
      .flatMap(([model, efforts]) => efforts.map((effort) => `${cli}/${model}/${effort}`)))
    .join(', ');
  if (!defaults && !overrides) return 'no effort restriction';
  return [defaults && `CLI defaults: ${defaults}`, overrides && `model exceptions: ${overrides}`]
    .filter(Boolean)
    .join('; ');
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  console.log(`Usage:
  node generation-provenance.mjs stamp --role <id> --cli <cli> --model <model> [--effort <effort>]
  node generation-provenance.mjs check-batch-model --model <model>`);
}

function stamp(args) {
  const roleId = valueAfter(args, '--role');
  const cli = valueAfter(args, '--cli');
  const model = valueAfter(args, '--model');
  const effort = valueAfter(args, '--effort');
  if (!roleId || !cli || !model) {
    usage();
    process.exitCode = 2;
    return;
  }

  const queue = loadQueue();
  const role = queue.roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`Queue role not found: ${roleId}`);
  if (role.status !== 'prepare-queued') {
    throw new Error(`Role must be prepare-queued before provenance is stamped; current status is ${role.status}.`);
  }

  const profile = loadProfile();
  if (!isAllowedReleaseGenerator(cli, model, profile)) {
    throw new Error(`Generator ${String(cli).toLowerCase()}/${String(model).toLowerCase()} is not release-eligible. Policy: ${describeReleaseModelPolicy(profile)}`);
  }
  if (!isAllowedReleaseModelEffort(cli, model, effort, profile)) {
    throw new Error(`Generator effort ${String(cli).toLowerCase()}/${String(model).toLowerCase()}/${String(effort || 'missing').toLowerCase()} is not release-eligible. Allowed: ${describeReleaseEffortPolicy(profile)}`);
  }

  const expectedAssets = roleAssetPaths(role);
  const provenance = buildGenerationProvenance({ role, cli, model, effort });
  mutateQueue((freshQueue) => {
    const freshRole = freshQueue.roles.find((item) => item.id === roleId);
    if (!freshRole) throw new Error(`Queue role disappeared before provenance commit: ${roleId}`);
    if (freshRole.status !== 'prepare-queued') {
      throw new Error(`Role changed before provenance commit; current status is ${freshRole.status}.`);
    }
    if (JSON.stringify(roleAssetPaths(freshRole)) !== JSON.stringify(expectedAssets)) {
      throw new Error('Role asset paths changed while provenance was being built; regenerate and stamp the current assets.');
    }
    freshRole.generation_provenance = provenance;
  });
  console.log(JSON.stringify({
    ok: true,
    role_id: role.id,
    flow: provenance.flow,
    generator: provenance.generator,
    assets: Object.keys(provenance.assets),
  }, null, 2));
}

function checkBatchModel(args) {
  const model = valueAfter(args, '--model');
  const profile = loadProfile();
  if (!isAllowedBatchAssetModel(model, profile)) {
    const configured = allowedBatchAssetModels(profile);
    const allowed = configured.includes('*') ? 'any explicit model ID' : configured.join(', ') || 'none';
    console.error(`Batch asset generation blocked for model ${JSON.stringify(model || null)}. Allowed: ${allowed}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Batch draft asset model accepted: ${model}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0];
  if (args.includes('--help') || !command) {
    usage();
    process.exitCode = args.includes('--help') ? 0 : 2;
  } else {
    try {
      if (command === 'stamp') stamp(args.slice(1));
      else if (command === 'check-batch-model') checkBatchModel(args.slice(1));
      else {
        usage();
        process.exitCode = 2;
      }
    } catch (error) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
