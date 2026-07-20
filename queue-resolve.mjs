#!/usr/bin/env node
/**
 * queue-resolve.mjs — Layered field resolver for the prepare stage and live apply.
 *
 * The whole point: fill as much as possible with ZERO model tokens, and hand
 * the agent only the few truly novel fields (as compact structured data, never
 * the DOM). Three sub-commands, all operating on data/apply-queue.json:
 *
 *   node queue-resolve.mjs --pre <role-id>
 *     Layer 1 (field-rules, deterministic) + Layer 2 (embed + answer-cache)
 *     resolve every form field they can from role.free_text_fields (captured at
 *     ingest/score time). Resolved answers are written into role.drafts with
 *     provenance. Prints JSON: { resolved:[...], novel:[...] }.
 *     The `novel` list is what the agent must answer in Layer 3.
 *
 *   node queue-resolve.mjs --lookup <role-id> '<page-object|@file>'
 *     Same Layer 1+2 resolution, but over agent-supplied live fields instead of
 *     role.free_text_fields. Use this during the interactive apply step (one call
 *     per wizard page, after the page renders) so the cache is consulted against
 *     the fields actually visible on screen — not the ones captured at ingest time.
 *     Payload: { run_id, tab_id, page_id, page_index, url, snapshot_digest,
 *     observed_at, fields:[...] }, where each field is
 *     { control_id, label, type?, options?, required?, help?, kind? }.
 *     Supports @/path/file.json to avoid shell-quoting large payloads.
 *     Writes hits into role.drafts plus executable pending evidence tied to the
 *     active application receipt, then prints { resolved, novel, evidence_id }.
 *
 *   node queue-resolve.mjs --teach <role-id> '<page-object|@file>'
 *     Stores the agent's Layer-3 answers into role.drafts (provenance: model)
 *     AND teaches the answer-cache (embeds each question, stores answer +
 *     reusable flag + entities) so future paraphrases hit Layer 2 for free.
 *     Payload repeats lookup's run/tab/page/url/snapshot_digest/observed_at context
 *     and evidence_id, with
 *     answers:[{ control_id, label, type?, answer, reusable, entities?, confidence?, options?,
 *       review_required?, review_note? }]. answers:[] is a successful no-op.
 *     Successful execution seals teach evidence that application-receipt --page
 *     must consume; lookup/teach completion cannot be claimed with booleans alone.
 *     The original bare JSON array remains valid only for PREPARE-time teaching
 *     on a prepare-queued/prepared role with no active application run.
 *
 * No network. No generative model. The only embedding calls go to the local
 * embeddinggemma endpoint (embed.mjs). If embeddings are unavailable, Layer 2
 * is skipped and those fields become novel — prepare/lookup still works.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import yaml from 'js-yaml';

import { loadQueue, mutateQueue } from './queue-store.mjs';
import {
  matchProfileRule, normLabel, looksLikeVisaSelect, pickVisaOption,
  chooseOptionDeterministic, matchEeoOption, COVER_RE, KSC_RE,
} from './field-rules.mjs';
import { embedSync, cosine } from './embed.mjs';
import {
  loadCache, mutateCache, lookup, markUsed, teach, DEFAULT_THRESHOLD,
} from './answer-cache.mjs';
import {
  loadStore, mutateScreenerStore, lookupScreener, learnScreener,
} from './screener-store.mjs';
import {
  readSnapshotFile, extractFields, extractUploadControls, extractDisplayedFilenames,
} from './snapshot-extract.mjs';
import { formatPhoneWithoutCountryCode } from './format-au.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESOLVER_EVIDENCE_VERSION = 1;
// Evidence-protocol v3: resolver evidence
// staged from a real snapshot file carries this capture marker. It is the only
// marker the receipt recorder accepts on new runs — hand-authored envelopes
// cannot produce page receipts anymore.
export const SNAPSHOT_FILE_CAPTURE = 'snapshot-file';

// PREPARE-time drafts historically used a normalized label as their key. Live
// pages additionally have a stable control_id, which must participate in the
// key: two controls can legitimately share a label while requiring different
// answers. Keep label-only keys for PREPARE compatibility and use them as a
// fallback only when that label is unambiguous on the current live page.
export function roleDraftKey(field) {
  const label = normLabel(field?.label);
  const controlId = String(field?.control_id ?? '').trim();
  return controlId
    ? `control:${Buffer.from(controlId).toString('base64url')}:${Buffer.from(label).toString('base64url')}`
    : label;
}

function requiredText(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function nonNegativeInteger(value, name) {
  const out = Number(value);
  if (!Number.isInteger(out) || out < 0) throw new Error(`${name} must be a non-negative integer`);
  return out;
}

function requiredDigest(value, name) {
  const out = requiredText(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error(`${name} must be a SHA-256 hex digest`);
  return out;
}

function requiredTimestamp(value, name) {
  const out = requiredText(value, name);
  const parsed = new Date(out);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return parsed.toISOString();
}

function readJsonArg(jsonArg, command) {
  if (!jsonArg) throw new Error(`${command}: JSON payload is required`);
  const raw = jsonArg.startsWith('@') ? readFileSync(jsonArg.slice(1), 'utf-8') : jsonArg;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${command} expects JSON: ${e.message}`);
  }
}

function pageEnvelope(jsonArg, command, itemKey) {
  const payload = readJsonArg(jsonArg, command);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${command}: payload must be an object containing run/page context and ${itemKey}`);
  }
  if (!Array.isArray(payload[itemKey])) throw new Error(`${command}: ${itemKey} must be an array`);
  return {
    run_id: requiredText(payload.run_id, `${command}.run_id`),
    tab_id: requiredText(payload.tab_id, `${command}.tab_id`),
    page_id: requiredText(payload.page_id, `${command}.page_id`),
    page_index: nonNegativeInteger(payload.page_index, `${command}.page_index`),
    url: requiredText(payload.url, `${command}.url`),
    snapshot_digest: requiredDigest(payload.snapshot_digest, `${command}.snapshot_digest`),
    observed_at: requiredTimestamp(payload.observed_at, `${command}.observed_at`),
    evidence_id: payload.evidence_id == null ? null : requiredText(payload.evidence_id, `${command}.evidence_id`),
    items: payload[itemKey],
  };
}

function evidenceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cleanEvidenceFields(fields) {
  const cleaned = fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`--lookup: fields[${index}] must be an object`);
    }
    return {
      control_id: requiredText(field.control_id, `--lookup.fields[${index}].control_id`),
      label: requiredText(field.label, `--lookup.fields[${index}].label`),
      type: String(field.type ?? 'unknown').trim() || 'unknown',
      required: field.required === true,
      options: Array.isArray(field.options) ? field.options.map(String) : [],
      help: field.help == null ? null : String(field.help),
      kind: field.kind == null ? null : String(field.kind),
    };
  });
  const controlIds = cleaned.map((field) => field.control_id);
  if (new Set(controlIds).size !== controlIds.length) {
    throw new Error('--lookup: control_id must be unique within a page');
  }
  return cleaned;
}

function cleanResolvedEvidence(items) {
  return items.map((item, index) => {
    const reviewRequired = item.review_required === true;
    return {
      control_id: requiredText(item.control_id, `resolved[${index}].control_id`),
      label: requiredText(item.label, 'resolved.label'),
      answer: requiredText(item.answer, `resolved answer for ${item.label}`),
      source: requiredText(item.source, `resolved source for ${item.label}`).toLowerCase(),
      review_required: reviewRequired,
      review_note: reviewRequired
        ? requiredText(item.review_note, `resolved review_note for ${item.label}`)
        : (String(item.review_note ?? '').trim() || null),
    };
  });
}

function cleanNovelEvidence(items) {
  return items.map((item, index) => ({
    control_id: requiredText(item.control_id, `novel[${index}].control_id`),
    label: requiredText(item.label, 'novel.label'),
    type: String(item.type ?? 'unknown').trim() || 'unknown',
    required: item.required === true,
  }));
}

function cleanTeachEvidence(items) {
  return items.map((item, index) => {
    const label = String(item.label ?? '');
    const allowBlankAnswer = /\bhoneypot\b/i.test(label)
      || /\b(middle(?:\s+name)?|second name|maiden name|custom pronoun)\b/i.test(label);
    const rawAnswer = String(item.answer ?? '');
    const answer = allowBlankAnswer && !rawAnswer.trim()
      ? ''
      : requiredText(item.answer, `--teach.answers[${index}].answer`);
    return {
      control_id: requiredText(item.control_id, `--teach.answers[${index}].control_id`),
      label: requiredText(item.label, `--teach.answers[${index}].label`),
      type: String(item.type ?? 'textarea').trim() || 'textarea',
      answer,
      reusable: item.reusable === true && item.review_required !== true,
      review_required: item.review_required === true,
      review_note: item.review_required === true
        ? requiredText(item.review_note, `--teach.answers[${index}].review_note`)
        : (String(item.review_note ?? '').trim() || null),
    };
  });
}

function assertActivePageContext(role, context) {
  const progress = role?.application_progress;
  if (!progress || progress.review_ready) {
    throw new Error('an active application-receipt run is required before live resolver commands');
  }
  if (!progress.preflight?.liveness?.method || !progress.preflight?.destination?.method) {
    throw new Error('active application run is missing structured liveness/destination evidence');
  }
  if (progress.run_id !== context.run_id) throw new Error('resolver run_id does not match the active application run');
  if (progress.tab?.id !== context.tab_id) throw new Error('resolver tab_id does not match the active browser tab');
  const pages = Array.isArray(progress.pages) ? progress.pages : [];
  if (context.page_index !== pages.length) {
    throw new Error(`resolver page_index must be the next contiguous page (${pages.length})`);
  }
  if (pages.some((page) => page.page_id === context.page_id)) {
    throw new Error('resolver page_id was already consumed by a page receipt');
  }
  return progress;
}

function loadProfile() {
  const p = process.env.CAREER_OPS_PROFILE || join(ROOT, 'config', 'profile.yml');
  if (!existsSync(p)) throw new Error('config/profile.yml not found');
  return yaml.load(readFileSync(p, 'utf-8'));
}

function isFileField(f) {
  return f.kind === 'resume' || /file/i.test(f.type || '');
}

function isSelectField(f) {
  return /select|radio|checkbox/i.test(f.type || '') || (Array.isArray(f.options) && f.options.length > 0);
}

function threshold(profile) {
  const t = profile?.embedding?.threshold;
  return typeof t === 'number' ? t : DEFAULT_THRESHOLD;
}

// ── Shared resolver core (Layers 1 + 2) ─────────────────────────────────────
//
// Mutates role.drafts. Loads/saves the cache internally unless one is injected.
//
// Resolution order per field:
//   0. file fields            → skipped (CV/cover attach at fill time)
//   1. drafts-first           → reuse an answer already in role.drafts verbatim
//                               (--pre output or a prior --teach model answer); never
//                               regenerate it. Selects validate against live options.
//   2. cover-letter / KSC     → reuse only an exact current-role draft; otherwise
//                               emit novel (never L1/L2/cross-role cache)
//   3. Layer 1 (field-rules)  → deterministic profile matches + select option mapping
//   4. Layer 2 (answer-cache) → semantic reuse for remaining text candidates
//
// @param role     — queue role object (role.drafts pre-initialised by caller)
// @param fields   — array of { control_id?, label, type?, options?, required?, help?, kind? }
// @param profile  — parsed config/profile.yml
// @param embedFn      — injectable for tests (default: embedSync); must accept string[]
//                       and return { embeddings: number[][] }
// @param cache        — injectable answer-cache (default: loadCache()); when provided,
//                       the caller owns persistence (we never saveCache an injected cache).
// @param screenerStore — injectable screener store (default: loadStore()); when provided,
//                       the caller owns persistence (we never saveStore an injected store).
//
// @returns { resolved: [...], novel: [...] }

export function resolveFields(role, fields, profile, { embedFn = embedSync, cache = null, screenerStore = null } = {}) {
  role.drafts = role.drafts || {};

  const labelCounts = new Map();
  for (const field of fields) {
    const label = normLabel(field.label);
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  const resolved = [];
  const novel = [];
  const l2candidates = [];   // text fields with no L1 rule → cache lookup
  const optionChoices = [];  // L1 selects needing an embedding-assisted option pick
  const identity = (field) => field.control_id ? { control_id: field.control_id } : {};
  const novelField = (field, patch = {}) => ({
    ...identity(field),
    label: field.label,
    type: field.type,
    required: !!field.required,
    options: field.options || null,
    help: field.help || null,
    ...patch,
  });

  const setDraft = (f, patch, summary) => {
    role.drafts[roleDraftKey(f)] = {
      field_type: f.type,
      label: f.label,
      ...(f.control_id ? { control_id: f.control_id } : {}),
      ...patch,
    };
    resolved.push({ ...identity(f), label: f.label, answer: patch.answer, ...summary });
  };

  // Layer 1 — deterministic profile rules (+ option mapping for selects)
  for (const f of fields) {
    if (isFileField(f)) continue; // resume/cover-letter file → CV attach at fill

    const lbl = normLabel(f.label);

    // ── Step 0: drafts-first ─────────────────────────────────────────────────
    // If role.drafts already holds an answer for this field (from a prior --pre /
    // --teach run) reuse it verbatim — never re-embed or re-resolve. This prevents
    // model-answered role-specific drafts (reusable:false) from falling through L2
    // (which requires reusable:true) and being incorrectly emitted as novel.
    // Select validation: if the live form has options and the draft answer is no
    // longer in that list (e.g. option wording changed), fall through to re-resolve.
    {
      const exactKey = roleDraftKey(f);
      const existing = role.drafts[exactKey]
        ?? (exactKey !== lbl && labelCounts.get(lbl) === 1 ? role.drafts[lbl] : undefined);
      if (existing && existing.answer != null && existing.answer !== '') {
        const opts = f.options || [];
        const validForSelect = !isSelectField(f) || opts.length === 0 || opts.includes(existing.answer);
        if (validForSelect) {
          resolved.push({
            ...identity(f),
            label: f.label,
            answer: existing.answer,
            source: existing.source || 'deterministic',
            rule:   existing.rule   || undefined,
            score:  existing.score  || undefined,
            firstUse: existing.source === 'cache' ? !!existing.firstUse : false,
            review_required: existing.review_required === true,
            review_note: existing.review_required === true
              ? (String(existing.review_note ?? '').trim() || 'Review this role-local model answer before submission.')
              : null,
          });
          continue;
        }
        // Draft answer not in live options — fall through to re-resolve
      }
    }

    // ── Step 1: cover-letter / KSC → novel unless resumed above ─────────────
    if (COVER_RE.test(f.label) || KSC_RE.test(f.label)) {
      novel.push(novelField(f));
      continue;
    }

    if (isSelectField(f)) {
      const options = f.options || [];
      // Option-less select/radio/checkbox — no option to pick or learn against.
      // Push straight to novel so the live --lookup (or LLM) handles it once the
      // real form supplies options. Avoids a wasted intent-embed round-trip.
      if (options.length === 0) {
        novel.push(novelField(f, { options: [] }));
        continue;
      }
      // Visa/work-rights dropdown → answer from the locked visa policy.
      if (looksLikeVisaSelect(f.label, options)) {
        const pick = pickVisaOption(options, role.visa_answer);
        if (pick) setDraft(f, { answer: pick, widget: 'select', source: 'deterministic', rule: 'visa' },
          { source: 'deterministic', rule: 'visa' });
        else novel.push(novelField(f, { options }));
        continue;
      }
      // EEO/self-identification selects: decline-to-disclose wins whenever it
      // exists; otherwise use an explicit profile value or fall through to L3.
      const eeoPick = matchEeoOption(f.label, options, profile, !!f.required);
      if (eeoPick) {
        setDraft(f, { answer: eeoPick, widget: 'select', source: 'deterministic', rule: 'eeo' },
          { source: 'deterministic', rule: 'eeo' });
        continue;
      }
      const hit = matchProfileRule(f.label, f.type, profile, role);
      if (hit) {
        const det = chooseOptionDeterministic(hit.value, options);
        if (det) {
          setDraft(f, { answer: det, widget: 'select', source: 'deterministic', rule: hit.rule },
            { source: 'deterministic', rule: hit.rule });
        } else {
          optionChoices.push({ field: f, intent: hit.value, rule: hit.rule, options });
        }
      } else {
        // ── L1.5: learned screener store (exact-label, cross-portal) ───────────
        // Consulted only after all deterministic rules miss. Volatile guard (numbers/
        // money/dates/locations) is enforced at learn time, so every stored answer
        // is safe to reuse. Revalidate against live options before accepting.
        // A label-only store cannot distinguish duplicate controls. Escalate
        // those to L3 unless a source-backed deterministic rule resolved them.
        const sStore = screenerStore ?? loadStore();
        const learned = labelCounts.get(lbl) === 1 ? lookupScreener(sStore, lbl) : null;
        const learnedOption = learned ? chooseOptionDeterministic(learned.answer, options) : null;
        if (learnedOption) {
          setDraft(f, { answer: learnedOption, widget: 'select', source: 'learned', rule: 'learned' },
            { source: 'learned', rule: 'learned' });
        } else {
          novel.push(novelField(f, { options }));
        }
      }
      continue;
    }

    // Text / textarea
    const hit = matchProfileRule(f.label, f.type, profile, role);
    if (hit) {
      let answer = hit.value;
      // Split phone row (Oracle HCM / SEEK): when a country-code control is on
      // the same page, fill the national number only — never +61XXXXXXXXX.
      if (hit.rule === 'phone') {
        const hasCountryCode = fields.some((other) =>
          /country\s*code|dial(?:l?ing)?\s*code|calling\s*code/i.test(String(other.label || '')));
        if (hasCountryCode) {
          answer = formatPhoneWithoutCountryCode(hit.value, '+61') || hit.value;
        }
      }
      setDraft(f, { answer, widget: 'text', source: 'deterministic', rule: hit.rule },
        { source: 'deterministic', rule: hit.rule });
    } else if (labelCounts.get(lbl) > 1) {
      // Semantic caches are keyed by label meaning, not control identity. A
      // repeated unresolved label is therefore novel per control.
      novel.push(novelField(f));
    } else {
      l2candidates.push(f);
    }
  }

  // One embedding batch. L2 question lookups occupy the first l2candidates.length
  // slots (so embeddings[i] is candidate i); option-choice groups follow, each
  // recording its base offset.
  const texts = l2candidates.map((f) => f.label);
  optionChoices.forEach((oc) => {
    oc._base = texts.length;
    texts.push(oc.intent, ...oc.options);
  });

  let embeddings = null;
  if (texts.length > 0) {
    try {
      embeddings = embedFn(texts).embeddings;
    } catch (e) {
      process.stderr.write(`⚠️  Layer 2 / option-embed skipped (embedding unavailable): ${e.message}\n`);
    }
  }

  // Resolve embedding-assisted option choices.
  for (const oc of optionChoices) {
    let pick = null;
    if (embeddings) {
      const base = oc._base;
      const intentVec = embeddings[base];
      let best = -Infinity;
      oc.options.forEach((opt, k) => {
        const s = cosine(intentVec, embeddings[base + 1 + k]);
        if (s > best) { best = s; pick = opt; }
      });
    }
    if (pick) {
      setDraft(oc.field, { answer: pick, widget: 'select', source: 'deterministic', rule: oc.rule },
        { source: 'deterministic', rule: oc.rule });
    } else {
      novel.push(novelField(oc.field, { options: oc.options, help: null }));
    }
  }

  // Layer 2 — semantic answer cache for the text candidates (zero model tokens).
  if (l2candidates.length > 0) {
    const ownCache = cache === null;  // true when NOT injected (production path)
    const useCache = ownCache ? loadCache() : cache;
    let cacheTouched = false;
    l2candidates.forEach((f, i) => {
      const emb = embeddings ? embeddings[i] : null;
      const hit = emb ? lookup(useCache, { question: f.label, embedding: emb, threshold: threshold(profile) }) : null;
      if (hit) {
        setDraft(f, {
          answer: hit.entry.answer, widget: isSelectField(f) ? 'select' : 'text',
          source: 'cache', cacheId: hit.entry.id, score: Number(hit.score.toFixed(3)), firstUse: hit.firstUse,
        }, {
          source: 'cache', cacheId: hit.entry.id,
          score: Number(hit.score.toFixed(3)), firstUse: hit.firstUse,
        });
        markUsed(useCache, hit.entry.id);
        cacheTouched = true;
      } else {
        novel.push(novelField(f));
      }
    });
    if (cacheTouched && ownCache) {
      const usedIds = resolved.filter((item) => item.source === 'cache' && item.cacheId)
        .map((item) => item.cacheId);
      mutateCache((freshCache) => {
        for (const id of usedIds) markUsed(freshCache, id);
      });
    }
  }

  return { resolved, novel };
}

function resolveLiveFieldsAndCommit(roleId, fields, profile, context = null) {
  const queue = loadQueue();
  const sourceRole = queue.roles.find((role) => role.id === roleId);
  if (!sourceRole) throw new Error(`role not found: ${roleId}`);
  if (context) {
    assertActivePageContext(sourceRole, context);
    // v3 runs (begin stamps evidence_capture:'file-derived') refuse inline
    // envelopes up front: the only staging path is a real snapshot file via
    // apply-page.mjs lookup. Failing here — not at --page time — keeps the
    // error actionable while the agent is still on the page.
    if (sourceRole.application_progress?.evidence_capture === 'file-derived' &&
        context.capture !== SNAPSHOT_FILE_CAPTURE) {
      throw new Error('this run requires file-derived evidence: use `node apply-page.mjs lookup` with a snapshot file instead of an inline --lookup envelope');
    }
  }
  // Validate and canonicalize live controls before resolution can touch even a
  // cache-use counter. PREPARE-time fields intentionally retain their legacy
  // label-only shape.
  const resolverFields = context ? cleanEvidenceFields(fields) : fields;

  // Resolve outside the queue lock so local embedding work cannot stall other
  // roles. Inject stores so resolveFields never writes a stale whole-file copy.
  const workingRole = structuredClone(sourceRole);
  const cache = loadCache();
  const store = loadStore();
  const { resolved, novel } = resolveFields(workingRole, resolverFields, profile, {
    cache,
    screenerStore: store,
  });

  const cacheIds = resolved.filter((item) => item.source === 'cache' && item.cacheId)
    .map((item) => item.cacheId);
  if (cacheIds.length) {
    mutateCache((freshCache) => {
      for (const id of cacheIds) markUsed(freshCache, id);
    });
  }

  const touchedKeys = new Set(resolved.map((item) => roleDraftKey(item)));
  let resolverEvidence = null;
  mutateQueue((freshQueue) => {
    const freshRole = freshQueue.roles.find((role) => role.id === roleId);
    if (!freshRole) throw new Error(`role disappeared before resolver commit: ${roleId}`);
    const progress = context ? assertActivePageContext(freshRole, context) : null;
    freshRole.drafts = freshRole.drafts || {};
    for (const key of touchedKeys) {
      if (workingRole.drafts?.[key]) freshRole.drafts[key] = workingRole.drafts[key];
    }
    if (context) {
      const evidenceFields = resolverFields;
      const evidenceResolved = cleanResolvedEvidence(resolved);
      const evidenceNovel = cleanNovelEvidence(novel);
      const evidenceId = `resolver-evidence:${context.run_id}:${context.page_index}:${randomUUID()}`;
      const lookupCore = {
        version: RESOLVER_EVIDENCE_VERSION,
        evidence_id: evidenceId,
        run_id: context.run_id,
        tab_id: context.tab_id,
        page_id: context.page_id,
        page_index: context.page_index,
        url: context.url,
        snapshot_digest: context.snapshot_digest,
        observed_at: context.observed_at,
        fields: evidenceFields,
        resolved: evidenceResolved,
        novel: evidenceNovel,
      };
      resolverEvidence = {
        ...lookupCore,
        lookup_fingerprint: evidenceHash(lookupCore),
        lookup_completed_at: new Date().toISOString(),
        teach: null,
        // Capture provenance + machine-extracted manifests live OUTSIDE
        // lookupCore so historical fingerprints keep validating unchanged.
        ...(context.capture ? { capture: context.capture } : {}),
        ...(context.snapshot_path ? { snapshot_path: context.snapshot_path } : {}),
        ...(context.upload_controls ? { upload_controls: structuredClone(context.upload_controls) } : {}),
        ...(context.displayed_filenames ? { displayed_filenames: [...context.displayed_filenames] } : {}),
        ...(context.excluded_controls?.length ? { excluded_controls: [...context.excluded_controls] } : {}),
      };
      progress.pending_resolver_evidence = resolverEvidence;
      progress.updated_at = resolverEvidence.lookup_completed_at;
    }
  });

  return {
    roleId,
    company: sourceRole.company,
    title: sourceRole.title,
    resolved,
    novel,
    ...(resolverEvidence ? {
      evidence_id: resolverEvidence.evidence_id,
      run_id: resolverEvidence.run_id,
      page_id: resolverEvidence.page_id,
      page_index: resolverEvidence.page_index,
      snapshot_digest: resolverEvidence.snapshot_digest,
      observed_at: resolverEvidence.observed_at,
    } : {}),
  };
}

// ── --pre ────────────────────────────────────────────────────────────────────

function preResolve(roleId) {
  const profile = loadProfile();
  const queue = loadQueue();
  const role = queue.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);

  const fields = Array.isArray(role.free_text_fields) ? role.free_text_fields : [];
  return resolveLiveFieldsAndCommit(roleId, fields, profile);
}

// ── --lookup ─────────────────────────────────────────────────────────────────

function liveResolve(roleId, jsonArg) {
  const profile = loadProfile();
  const envelope = pageEnvelope(jsonArg, '--lookup', 'fields');
  return resolveLiveFieldsAndCommit(roleId, envelope.items, profile, envelope);
}

// ── Snapshot-file live resolve (evidence-protocol v3) ────────────────────────

/**
 * Resolve a live wizard page directly from a Playwright MCP snapshot file.
 * The digest, timestamp, field manifest, and upload-control manifest are all
 * derived from the file by `snapshot-extract.mjs` — never typed by an agent —
 * and the staged pending evidence carries `capture: 'snapshot-file'`, which
 * `application-receipt.mjs` requires before it will record a page receipt on
 * a new run. `excludeControls` supports the driver's skip flow (re-staging a
 * page without controls the candidate flow proved non-applicable).
 */
export function liveResolveFromSnapshot(roleId, {
  pageIndex, url, snapshotPath, excludeControls = [],
}) {
  const profile = loadProfile();
  const queue = loadQueue();
  const role = queue.roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);
  const progress = role.application_progress;
  if (!progress || progress.review_ready) {
    throw new Error('an active application-receipt run is required before snapshot lookup');
  }

  const snap = readSnapshotFile(snapshotPath);
  const excluded = new Set(excludeControls.map(String));
  const extracted = extractFields(snap.tree);
  const uploadControls = extractUploadControls(snap.tree);
  const displayedFilenames = extractDisplayedFilenames(snap.tree);
  const fields = extracted
    .filter((field) => !excluded.has(field.control_id))
    .map((field) => ({
      control_id: field.control_id,
      label: field.label,
      type: field.type,
      options: field.options,
      required: field.required,
      help: null,
    }));

  const context = {
    run_id: progress.run_id,
    tab_id: progress.tab?.id,
    page_id: `page-${nonNegativeInteger(pageIndex, 'pageIndex')}-${snap.digest.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    page_index: nonNegativeInteger(pageIndex, 'pageIndex'),
    url: requiredText(url, 'url'),
    snapshot_digest: snap.digest,
    observed_at: snap.observed_at,
    evidence_id: null,
    capture: SNAPSHOT_FILE_CAPTURE,
    snapshot_path: snap.path,
    upload_controls: uploadControls,
    displayed_filenames: displayedFilenames,
    excluded_controls: [...excluded],
  };

  const result = resolveLiveFieldsAndCommit(roleId, fields, profile, context);
  return {
    ...result,
    extraction: {
      snapshot_path: snap.path,
      snapshot_digest: snap.digest,
      observed_at: snap.observed_at,
      fields: extracted,
      upload_controls: uploadControls,
      displayed_filenames: displayedFilenames,
    },
  };
}

// ── --teach ───────────────────────────────────────────────────────────────────

// @param opts.embedFn — injectable for tests (default: embedSync); accepts string[]
// @param opts.queue   — injectable queue (default: loadQueue()); when provided, the
//                       caller owns persistence (we never saveQueue an injected queue).
// @param opts.cache   — injectable answer-cache (default: loadCache()); caller owns persistence.
// @param opts.store   — injectable screener store (default: loadStore()); caller owns persistence.
export function teachAnswers(roleId, jsonArg, {
  embedFn = embedSync,
  queue = null,
  cache = null,
  store = null,
  includeLearningPlan = false,
} = {}) {
  const ownQueue = queue === null;
  const ownCache = cache === null;
  const ownStore = store === null;
  const useQueue = ownQueue ? loadQueue() : queue;
  const role = useQueue.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);
  role.drafts = role.drafts || {};

  // Accept either an inline JSON array or @/path/to/file.json (avoids shell
  // escaping when answers contain quotes).
  let raw = jsonArg;
  if (jsonArg.startsWith('@')) raw = readFileSync(jsonArg.slice(1), 'utf-8');
  let items;
  try {
    items = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--teach expects a JSON array: ${e.message}`);
  }
  if (!Array.isArray(items)) throw new Error('--teach: payload must be a JSON array');
  if (items.length === 0) {
    return {
      roleId,
      taught: [],
      cacheTouched: false,
      noop: true,
      reason: 'no novel fields on page',
      ...(includeLearningPlan ? { learningPlan: { cache: [], screeners: [] } } : {}),
    };
  }

  const allowBlankTeachAnswer = (it) =>
    /\bhoneypot\b/i.test(String(it?.label || ''))
    || /\b(middle(?:\s+name)?|second name|maiden name|custom pronoun)\b/i.test(String(it?.label || ''));
  const invalidIndex = items.findIndex((it) =>
    !it || typeof it !== 'object' || !String(it.label || '').trim() ||
    it.answer == null ||
    (String(it.answer).trim() === '' && !allowBlankTeachAnswer(it)) ||
    typeof it.reusable !== 'boolean'
  );
  if (invalidIndex !== -1) {
    throw new Error(`--teach: item ${invalidIndex} requires non-empty label/answer and boolean reusable`);
  }

  const labelCounts = new Map();
  for (const item of items) {
    const label = normLabel(item.label);
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }
  const duplicateLabels = new Set(
    [...labelCounts.entries()].filter(([, count]) => count > 1).map(([label]) => label),
  );

  // Partition items upfront: select/radio/checkbox → screener store; free-text → embed cache.
  // Embed only the free-text subset so we don't cold-load the embedder on radio-only applies.
  const freeTextItems = items.filter((it) => {
    const isSelectType = it.type && /select|radio|checkbox/i.test(it.type);
    const hasOptions = Array.isArray(it.options) && it.options.length > 0;
    return !isSelectType && !hasOptions && it.reusable && !it.review_required
      && !duplicateLabels.has(normLabel(it.label));
  });
  const reusableScreeners = items.filter((it) => {
    const isSelectType = it.type && /select|radio|checkbox/i.test(it.type);
    const hasOptions = Array.isArray(it.options) && it.options.length > 0;
    return (isSelectType || hasOptions) && it.reusable && !it.review_required
      && !duplicateLabels.has(normLabel(it.label));
  });

  // Build an index: label → embedding position (only free-text items embedded).
  const freeTextLabels = freeTextItems.map((it) => it.label);
  let ftEmbeddings = null;
  if (freeTextLabels.length > 0) {
    try {
      const out = embedFn(freeTextLabels);
      ftEmbeddings = out.embeddings; // parallel to freeTextLabels
    } catch (e) {
      process.stderr.write(`⚠️  cache teach skipped (embedding unavailable): ${e.message}\n`);
    }
  }
  // Map each free-text item's label → its embedding (or null).
  const ftEmbeddingByLabel = new Map(
    freeTextLabels.map((lbl, idx) => [lbl, ftEmbeddings ? ftEmbeddings[idx] : null]),
  );

  const useCache = ownCache ? loadCache() : cache;
  const useStore = ownStore ? loadStore() : store;
  const taught = [];
  let cacheTouched = false;
  items.forEach((it) => {
    const key = roleDraftKey(it);
    const labelKey = normLabel(it.label);
    const reviewRequired = !!it.review_required;
    const duplicateLabel = duplicateLabels.has(labelKey);
    const reusable = !!it.reusable && !reviewRequired && !duplicateLabel;
    role.drafts[key] = {
      answer: it.answer, source: 'model', field_type: it.type || 'textarea',
      label: it.label, ...(it.control_id ? { control_id: it.control_id } : {}),
      reusable, confidence: it.confidence || (reviewRequired ? 'low' : 'medium'),
      review_required: reviewRequired,
      review_note: it.review_note || null,
    };

    role.review_required_fields = Array.isArray(role.review_required_fields)
      ? role.review_required_fields.filter((label) => normLabel(label) !== labelKey)
      : [];
    if (reviewRequired) role.review_required_fields.push(it.label);

    // Radio/select/checkbox items → learned screener store (exact-label, cross-portal).
    // Gate on reusable:true — role-specific answers (why this company, consent checkboxes)
    // must not be persisted cross-portal. Volatile guard is inside learnScreener.
    const isSelectType = it.type && /select|radio|checkbox/i.test(it.type);
    const hasOptions = Array.isArray(it.options) && it.options.length > 0;
    if (isSelectType || hasOptions) {
      if (reusable) {
        const result = learnScreener(useStore, {
          label: it.label, answer: it.answer,
          options: it.options || [], roleId,
        });
        taught.push({ label: it.label, reusable: true, cached: false, learned: result.learned, learnReason: result.reason });
      } else {
        // Role-specific or review-required → drafts only; never cross-contaminate roles.
        taught.push({
          label: it.label, reusable: false, cached: false, learned: false,
          reviewRequired,
          learnReason: reviewRequired ? 'review-required' : duplicateLabel ? 'duplicate-label' : 'reusable:false',
        });
      }
    } else {
      // Only approved reusable free text enters the cross-role embedding cache.
      if (!reusable) {
        taught.push({
          label: it.label, reusable: false, cached: false, reviewRequired,
          learnReason: reviewRequired ? 'review-required' : duplicateLabel ? 'duplicate-label' : 'reusable:false',
        });
        return;
      }
      const emb = ftEmbeddingByLabel.get(it.label) ?? null;
      if (emb) {
        teach(useCache, {
          question: it.label, embedding: emb, answer: it.answer,
          field_type: it.type || 'textarea', reusable: true,
          entities: it.entities || {}, confidence: it.confidence || 'medium',
        });
        cacheTouched = true;
        taught.push({ label: it.label, reusable: true, cached: true });
      } else {
        taught.push({ label: it.label, reusable: true, cached: false });
      }
    }
  });

  if (cacheTouched && ownCache) {
    mutateCache((freshCache) => {
      for (const it of freeTextItems) {
        const emb = ftEmbeddingByLabel.get(it.label) ?? null;
        if (!emb) continue;
        teach(freshCache, {
          question: it.label,
          embedding: emb,
          answer: it.answer,
          field_type: it.type || 'textarea',
          reusable: true,
          entities: it.entities || {},
          confidence: it.confidence || 'medium',
        });
      }
    });
  }
  if (ownStore) {
    if (reusableScreeners.length) {
      mutateScreenerStore((freshStore) => {
        for (const it of reusableScreeners) {
          learnScreener(freshStore, {
            label: it.label,
            answer: it.answer,
            options: it.options || [],
            roleId,
          });
        }
      });
    }
  }
  if (ownQueue) {
    const touched = items.map((it) => ({
      key: roleDraftKey(it),
      labelKey: normLabel(it.label),
      label: it.label,
      reviewRequired: !!it.review_required,
    }));
    mutateQueue((freshQueue) => {
      const freshRole = freshQueue.roles.find((item) => item.id === roleId);
      if (!freshRole) throw new Error(`role disappeared before teach commit: ${roleId}`);
      freshRole.drafts = freshRole.drafts || {};
      freshRole.review_required_fields = Array.isArray(freshRole.review_required_fields)
        ? freshRole.review_required_fields
        : [];
      for (const item of touched) {
        freshRole.drafts[item.key] = role.drafts[item.key];
        freshRole.review_required_fields = freshRole.review_required_fields
          .filter((label) => normLabel(label) !== item.labelKey);
        if (item.reviewRequired) freshRole.review_required_fields.push(item.label);
      }
    });
  }
  const learningPlan = {
    cache: freeTextItems.flatMap((it) => {
      const embedding = ftEmbeddingByLabel.get(it.label) ?? null;
      return embedding ? [{
        question: it.label,
        embedding,
        answer: it.answer,
        field_type: it.type || 'textarea',
        reusable: true,
        entities: it.entities || {},
        confidence: it.confidence || 'medium',
      }] : [];
    }),
    screeners: reusableScreeners.map((it) => ({
      label: it.label,
      answer: it.answer,
      options: it.options || [],
      roleId,
    })),
  };
  return {
    roleId,
    taught,
    cacheTouched,
    ...(includeLearningPlan ? { learningPlan } : {}),
  };
}

function assertPendingEvidence(role, context) {
  const progress = assertActivePageContext(role, context);
  const evidence = progress.pending_resolver_evidence;
  if (!evidence) throw new Error('run --lookup for this page before --teach');
  if (!context.evidence_id) throw new Error('--teach.evidence_id is required from the matching --lookup output');
  for (const key of [
    'evidence_id', 'run_id', 'tab_id', 'page_id', 'page_index', 'url',
    'snapshot_digest', 'observed_at',
  ]) {
    if (evidence[key] !== context[key]) throw new Error(`--teach ${key} does not match the pending lookup evidence`);
  }
  if (evidence.teach) throw new Error('pending lookup evidence was already taught; rerun --lookup after any field change');
  return evidence;
}

function assertNovelAnswers(evidence, items) {
  const expected = (evidence.novel ?? []).map((item) => `${item.control_id}\u0000${normLabel(item.label)}`);
  const actual = items.map((item) => `${item.control_id}\u0000${normLabel(item.label)}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('--teach answers must match the pending lookup novel fields exactly and in order');
  }
}

function copyStagedTeachDrafts(freshRole, stagedRole, items) {
  freshRole.drafts = freshRole.drafts || {};
  freshRole.review_required_fields = Array.isArray(freshRole.review_required_fields)
    ? freshRole.review_required_fields
    : [];
  for (const item of items) {
    const key = roleDraftKey(item);
    const labelKey = normLabel(item.label);
    const draft = stagedRole.drafts?.[key];
    if (!draft) throw new Error(`staged teach draft is missing for control: ${item.control_id ?? item.label}`);
    freshRole.drafts[key] = structuredClone(draft);
    freshRole.review_required_fields = freshRole.review_required_fields
      .filter((label) => normLabel(label) !== labelKey);
    if (item.review_required) freshRole.review_required_fields.push(item.label);
  }
}

function persistCommittedTeachLearning(learningPlan, { cache, store }) {
  const cacheOps = Array.isArray(learningPlan?.cache) ? learningPlan.cache : [];
  const screenerOps = Array.isArray(learningPlan?.screeners) ? learningPlan.screeners : [];
  if (cacheOps.length) {
    const applyCache = (target) => {
      for (const operation of cacheOps) teach(target, operation);
    };
    if (cache !== null) applyCache(cache);
    else mutateCache(applyCache);
  }
  if (screenerOps.length) {
    const applyScreeners = (target) => {
      for (const operation of screenerOps) learnScreener(target, operation);
    };
    if (store !== null) applyScreeners(store);
    else mutateScreenerStore(applyScreeners);
  }
}

/**
 * Complete one live-page teach barrier.
 *
 * Queue drafts and the matching pending-evidence seal are committed together
 * under mutateQueue's lock. Cross-role cache/screener learning happens only
 * after that durable commit succeeds, so stale/replaced evidence cannot leak an
 * answer into another role's reusable stores.
 *
 * The optional dependencies are test seams; production callers use the CLI
 * defaults and never provide them.
 */
export function liveTeach(roleId, jsonArg, {
  embedFn = embedSync,
  cache = null,
  store = null,
  beforeQueueCommit = null,
} = {}) {
  const envelope = pageEnvelope(jsonArg, '--teach', 'answers');
  const cleanItems = cleanTeachEvidence(envelope.items);
  const teachItems = envelope.items.map((item, index) => ({ ...item, ...cleanItems[index] }));
  const before = loadQueue();
  const role = before.roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);
  const evidence = assertPendingEvidence(role, envelope);
  assertNovelAnswers(evidence, cleanItems);

  // Build the exact draft/learning result outside the queue lock, but only in
  // detached in-memory clones. No queue/cache/screener persistence is allowed
  // until the fresh pending evidence is revalidated inside mutateQueue.
  const workingQueue = structuredClone(before);
  const stagedCache = structuredClone(cache ?? loadCache());
  const stagedStore = structuredClone(store ?? loadStore());
  const staged = teachAnswers(roleId, JSON.stringify(teachItems), {
    embedFn,
    queue: workingQueue,
    cache: stagedCache,
    store: stagedStore,
    includeLearningPlan: true,
  });
  const { learningPlan, ...stagedOut } = staged;
  const stagedRole = workingQueue.roles.find((item) => item.id === roleId);
  if (!stagedRole) throw new Error(`role disappeared while staging teach: ${roleId}`);
  if (beforeQueueCommit != null) {
    if (typeof beforeQueueCommit !== 'function') throw new Error('beforeQueueCommit must be a function');
    beforeQueueCommit({ roleId, envelope: structuredClone(envelope) });
  }

  let completedEvidence = null;
  mutateQueue((freshQueue) => {
    const freshRole = freshQueue.roles.find((item) => item.id === roleId);
    if (!freshRole) throw new Error(`role disappeared before teach evidence commit: ${roleId}`);
    const freshEvidence = assertPendingEvidence(freshRole, envelope);
    assertNovelAnswers(freshEvidence, cleanItems);
    copyStagedTeachDrafts(freshRole, stagedRole, teachItems);
    const teachCore = {
      evidence_id: freshEvidence.evidence_id,
      run_id: freshEvidence.run_id,
      tab_id: freshEvidence.tab_id,
      page_id: freshEvidence.page_id,
      page_index: freshEvidence.page_index,
      url: freshEvidence.url,
      snapshot_digest: freshEvidence.snapshot_digest,
      observed_at: freshEvidence.observed_at,
      answers: cleanItems,
    };
    freshEvidence.teach = {
      ...teachCore,
      teach_fingerprint: evidenceHash(teachCore),
      completed_at: new Date().toISOString(),
      noop: cleanItems.length === 0,
    };
    freshRole.application_progress.updated_at = freshEvidence.teach.completed_at;
    completedEvidence = freshEvidence;
  });

  // Apply the already-staged reusable-learning plan against the locked
  // cache/store implementations. No second embedding or queue write occurs.
  // Learning is an optimization; if its separate user-layer store is
  // unavailable, keep the authoritative role-local draft/evidence commit and
  // surface the warning.
  let out = stagedOut;
  const learningWarnings = [];
  try {
    persistCommittedTeachLearning(learningPlan, { cache, store });
  } catch (err) {
    const warning = `role-local teach evidence committed, but reusable learning could not be persisted: ${err.message}`;
    learningWarnings.push(warning);
    process.stderr.write(`⚠️  ${warning}\n`);
    out = {
      ...stagedOut,
      cacheTouched: false,
      taught: stagedOut.taught.map((item) => item.reusable
        ? { ...item, cached: false, learned: false, learnReason: 'learning-persistence-warning' }
        : item),
    };
  }
  return {
    ...out,
    evidence_id: completedEvidence.evidence_id,
    run_id: completedEvidence.run_id,
    page_id: completedEvidence.page_id,
    page_index: completedEvidence.page_index,
    lookup_fingerprint: completedEvidence.lookup_fingerprint,
    teach_fingerprint: completedEvidence.teach.teach_fingerprint,
    ...(learningWarnings.length ? { learning_warnings: learningWarnings } : {}),
  };
}

function teachCommand(roleId, jsonArg) {
  const payload = readJsonArg(jsonArg, '--teach');
  if (!Array.isArray(payload)) return liveTeach(roleId, jsonArg);

  // Prepare-time teaching predates the live receipt and remains an array by
  // design. Once a live application run exists, arrays fail closed: every page
  // must use the run/page/evidence envelope so its teach can be receipted.
  const role = loadQueue().roles.find((item) => item.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);
  if (!new Set(['prepare-queued', 'prepared']).has(role.status)) {
    throw new Error('--teach array payloads are allowed only during PREPARE; live pages require resolver evidence');
  }
  if (role.application_progress && role.application_progress.review_ready !== true) {
    throw new Error('--teach live application pages require the run/page/evidence object');
  }
  return teachAnswers(roleId, jsonArg);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const [, , cmd, roleId, jsonArg] = process.argv;
  if (cmd === '--pre' && roleId) {
    const out = preResolve(roleId);
    // Human summary → stderr; machine JSON → stdout
    process.stderr.write(`\n${out.company} – ${out.title}\n`);
    process.stderr.write(`Layer 1+2 resolved ${out.resolved.length} field(s); ${out.novel.length} novel field(s) for Layer 3.\n`);
    for (const r of out.resolved) {
      process.stderr.write(`  ✓ [${r.source}${r.rule ? ':' + r.rule : ''}${r.score ? ' ' + r.score : ''}] ${r.label}\n`);
    }
    for (const n of out.novel) process.stderr.write(`  • [novel] ${n.label}\n`);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  if (cmd === '--lookup' && roleId && jsonArg) {
    const out = liveResolve(roleId, jsonArg);
    // Human summary → stderr; machine JSON → stdout
    process.stderr.write(`\n${out.company} – ${out.title} (live lookup)\n`);
    process.stderr.write(`Layer 1+2 resolved ${out.resolved.length} field(s); ${out.novel.length} novel field(s) for Layer 3.\n`);
    for (const r of out.resolved) {
      process.stderr.write(`  ✓ [${r.source}${r.rule ? ':' + r.rule : ''}${r.score ? ' ' + r.score : ''}] ${r.label}\n`);
    }
    for (const n of out.novel) process.stderr.write(`  • [novel] ${n.label}\n`);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  if (cmd === '--teach' && roleId && jsonArg) {
    const out = teachCommand(roleId, jsonArg);
    process.stderr.write(out.noop
      ? 'No novel answers on this page; teach barrier completed as a no-op.\n'
      : `Stored ${out.taught.length} model answer(s); cached ${out.taught.filter((t) => t.cached).length}.\n`);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  process.stderr.write(
    'Usage:\n  node queue-resolve.mjs --pre <role-id>\n' +
    "  node queue-resolve.mjs --lookup <role-id> '<page-object|@file>'\n" +
    "  node queue-resolve.mjs --teach <role-id> '<page-object|@file>'\n"
  );
  process.exit(1);
}

// Guard: only run main() when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
