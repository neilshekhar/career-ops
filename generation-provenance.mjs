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

import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { loadQueue, saveQueue } from './queue-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const PROVENANCE_SCHEMA = 1;
export const RELEASE_FLOW = 'interactive-prepare';
export const BATCH_DRAFT_FLOW = 'batch-draft';
export const DEFAULT_BATCH_ASSET_MODELS = Object.freeze([
  '*',
]);
export const RELEASE_MODEL_POLICIES = Object.freeze(['open', 'allowlist']);

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

  const assets = {};
  for (const [kind, value] of Object.entries(roleAssetPaths(role))) {
    if (!value) continue;
    const path = repoPath(root, value);
    if (!path || !existsSync(path.absolute) || !statSync(path.absolute).isFile()) {
      throw new Error(`${kind} is missing or outside the repository: ${value}`);
    }
    assets[kind] = {
      path: path.relative,
      sha256: sha256File(path.absolute),
      bytes: statSync(path.absolute).size,
    };
  }

  for (const required of ['cv_pdf', 'cv_html', 'cover_md', 'cover_pdf', 'cover_payload']) {
    if (!assets[required]) throw new Error(`Required application asset is missing: ${required}`);
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
  };
}

function loadProfile(root = ROOT) {
  const path = resolve(root, 'config/profile.yml');
  return existsSync(path) ? yaml.load(readFileSync(path, 'utf-8')) || {} : {};
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

  role.generation_provenance = buildGenerationProvenance({ role, cli, model, effort });
  saveQueue(queue);
  console.log(JSON.stringify({
    ok: true,
    role_id: role.id,
    flow: role.generation_provenance.flow,
    generator: role.generation_provenance.generator,
    assets: Object.keys(role.generation_provenance.assets),
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
