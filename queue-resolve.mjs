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
 *   node queue-resolve.mjs --lookup <role-id> '<json-array|@file>'
 *     Same Layer 1+2 resolution, but over agent-supplied live fields instead of
 *     role.free_text_fields. Use this during the interactive apply step (one call
 *     per wizard page, after the page renders) so the cache is consulted against
 *     the fields actually visible on screen — not the ones captured at ingest time.
 *     Same JSON field shape: { label, type?, options?, required?, help?, kind? }.
 *     Supports @/path/file.json to avoid shell-quoting large payloads.
 *     Writes hits into role.drafts, prints JSON: { resolved:[...], novel:[...] }.
 *
 *   node queue-resolve.mjs --teach <role-id> '<json-array|@file>'
 *     Stores the agent's Layer-3 answers into role.drafts (provenance: model)
 *     AND teaches the answer-cache (embeds each question, stores answer +
 *     reusable flag + entities) so future paraphrases hit Layer 2 for free.
 *     JSON array items: { label, type?, answer, reusable, entities?, confidence? }
 *
 * No network. No generative model. The only embedding calls go to the local
 * embeddinggemma endpoint (embed.mjs). If embeddings are unavailable, Layer 2
 * is skipped and those fields become novel — prepare/lookup still works.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { loadQueue, saveQueue } from './queue-store.mjs';
import {
  matchProfileRule, normLabel, looksLikeVisaSelect, pickVisaOption,
  chooseOptionDeterministic, COVER_RE, KSC_RE,
} from './field-rules.mjs';
import { embedSync, cosine } from './embed.mjs';
import {
  loadCache, saveCache, lookup, markUsed, teach, DEFAULT_THRESHOLD,
} from './answer-cache.mjs';
import { loadStore, saveStore, lookupScreener, learnScreener } from './screener-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

function loadProfile() {
  const p = join(ROOT, 'config', 'profile.yml');
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
//   2. cover-letter / KSC     → always role-specific → emit novel (no L1/L2/cache)
//   3. Layer 1 (field-rules)  → deterministic profile matches + select option mapping
//   4. Layer 2 (answer-cache) → semantic reuse for remaining text candidates
//
// @param role     — queue role object (role.drafts pre-initialised by caller)
// @param fields   — array of { label, type?, options?, required?, help?, kind? }
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

  const resolved = [];
  const novel = [];
  const l2candidates = [];   // text fields with no L1 rule → cache lookup
  const optionChoices = [];  // L1 selects needing an embedding-assisted option pick

  const setDraft = (f, patch, summary) => {
    role.drafts[normLabel(f.label)] = { field_type: f.type, label: f.label, ...patch };
    resolved.push({ label: f.label, answer: patch.answer, ...summary });
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
      const existing = role.drafts[lbl];
      if (existing && existing.answer != null && existing.answer !== '') {
        const opts = f.options || [];
        const validForSelect = !isSelectField(f) || opts.length === 0 || opts.includes(existing.answer);
        if (validForSelect) {
          resolved.push({
            label: f.label,
            answer: existing.answer,
            source: existing.source || 'deterministic',
            rule:   existing.rule   || undefined,
            score:  existing.score  || undefined,
            firstUse: existing.source === 'cache' ? !!existing.firstUse : false,
          });
          continue;
        }
        // Draft answer not in live options — fall through to re-resolve
      }
    }

    // ── Step 1: cover-letter / KSC → always novel (never L1/L2/cache) ────────
    if (COVER_RE.test(f.label) || KSC_RE.test(f.label)) {
      novel.push({ label: f.label, type: f.type, required: !!f.required, options: f.options || null, help: f.help || null });
      continue;
    }

    if (isSelectField(f)) {
      const options = f.options || [];
      // Option-less select/radio/checkbox — no option to pick or learn against.
      // Push straight to novel so the live --lookup (or LLM) handles it once the
      // real form supplies options. Avoids a wasted intent-embed round-trip.
      if (options.length === 0) {
        novel.push({ label: f.label, type: f.type, required: !!f.required, options: [], help: f.help || null });
        continue;
      }
      // Visa/work-rights dropdown → answer from the locked visa policy.
      if (looksLikeVisaSelect(f.label, options)) {
        const pick = pickVisaOption(options, role.visa_answer);
        if (pick) setDraft(f, { answer: pick, widget: 'select', source: 'deterministic', rule: 'visa' },
          { source: 'deterministic', rule: 'visa' });
        else novel.push({ label: f.label, type: f.type, required: !!f.required, options, help: f.help || null });
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
        const sStore = screenerStore ?? loadStore();
        const learned = lookupScreener(sStore, lbl);
        const learnedOption = learned ? chooseOptionDeterministic(learned.answer, options) : null;
        if (learnedOption) {
          setDraft(f, { answer: learnedOption, widget: 'select', source: 'learned', rule: 'learned' },
            { source: 'learned', rule: 'learned' });
        } else {
          novel.push({ label: f.label, type: f.type, required: !!f.required, options, help: f.help || null });
        }
      }
      continue;
    }

    // Text / textarea
    const hit = matchProfileRule(f.label, f.type, profile, role);
    if (hit) {
      setDraft(f, { answer: hit.value, widget: 'text', source: 'deterministic', rule: hit.rule },
        { source: 'deterministic', rule: hit.rule });
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
      novel.push({ label: oc.field.label, type: oc.field.type, required: !!oc.field.required, options: oc.options, help: null });
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
        }, { source: 'cache', score: Number(hit.score.toFixed(3)), firstUse: hit.firstUse });
        markUsed(useCache, hit.entry.id);
        cacheTouched = true;
      } else {
        novel.push({ label: f.label, type: f.type, required: !!f.required, options: f.options || null, help: f.help || null });
      }
    });
    if (cacheTouched && ownCache) saveCache(useCache);
  }

  return { resolved, novel };
}

// ── --pre ────────────────────────────────────────────────────────────────────

function preResolve(roleId) {
  const profile = loadProfile();
  const queue = loadQueue();
  const role = queue.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);

  const fields = Array.isArray(role.free_text_fields) ? role.free_text_fields : [];
  const { resolved, novel } = resolveFields(role, fields, profile);

  saveQueue(queue);
  return { roleId, company: role.company, title: role.title, resolved, novel };
}

// ── --lookup ─────────────────────────────────────────────────────────────────

function liveResolve(roleId, jsonArg) {
  const profile = loadProfile();
  const queue = loadQueue();
  const role = queue.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`role not found: ${roleId}`);

  // Accept either an inline JSON array or @/path/to/file.json (avoids shell
  // escaping when field labels contain quotes or special characters).
  let raw = jsonArg;
  if (jsonArg.startsWith('@')) raw = readFileSync(jsonArg.slice(1), 'utf-8');
  let fields;
  try {
    fields = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--lookup expects a JSON array of field objects: ${e.message}`);
  }
  if (!Array.isArray(fields)) throw new Error('--lookup: payload must be a JSON array');

  const { resolved, novel } = resolveFields(role, fields, profile);

  saveQueue(queue);
  return { roleId, company: role.company, title: role.title, resolved, novel };
}

// ── --teach ───────────────────────────────────────────────────────────────────

// @param opts.embedFn — injectable for tests (default: embedSync); accepts string[]
// @param opts.queue   — injectable queue (default: loadQueue()); when provided, the
//                       caller owns persistence (we never saveQueue an injected queue).
// @param opts.cache   — injectable answer-cache (default: loadCache()); caller owns persistence.
// @param opts.store   — injectable screener store (default: loadStore()); caller owns persistence.
export function teachAnswers(roleId, jsonArg, { embedFn = embedSync, queue = null, cache = null, store = null } = {}) {
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
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('--teach: empty or non-array payload');
  }

  // Partition items upfront: select/radio/checkbox → screener store; free-text → embed cache.
  // Embed only the free-text subset so we don't cold-load the embedder on radio-only applies.
  const freeTextItems = items.filter((it) => {
    if (!it.label || it.answer == null) return false;
    const isSelectType = it.type && /select|radio|checkbox/i.test(it.type);
    const hasOptions = Array.isArray(it.options) && it.options.length > 0;
    return !isSelectType && !hasOptions;
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
    if (!it.label || it.answer == null) return;
    const key = normLabel(it.label);
    role.drafts[key] = {
      answer: it.answer, source: 'model', field_type: it.type || 'textarea',
      label: it.label, reusable: !!it.reusable, confidence: it.confidence || 'medium',
    };

    // Radio/select/checkbox items → learned screener store (exact-label, cross-portal).
    // Gate on reusable:true — role-specific answers (why this company, consent checkboxes)
    // must not be persisted cross-portal. Volatile guard is inside learnScreener.
    const isSelectType = it.type && /select|radio|checkbox/i.test(it.type);
    const hasOptions = Array.isArray(it.options) && it.options.length > 0;
    if (isSelectType || hasOptions) {
      if (it.reusable) {
        const result = learnScreener(useStore, {
          label: it.label, answer: it.answer,
          options: it.options || [], roleId,
        });
        taught.push({ label: it.label, reusable: true, cached: false, learned: result.learned, learnReason: result.reason });
      } else {
        // reusable:false → drafts only (already written above); do not cross-contaminate roles.
        taught.push({ label: it.label, reusable: false, cached: false, learned: false, learnReason: 'reusable:false' });
      }
    } else {
      // Free-text → embedding cache (unchanged path).
      const emb = ftEmbeddingByLabel.get(it.label) ?? null;
      if (emb) {
        teach(useCache, {
          question: it.label, embedding: emb, answer: it.answer,
          field_type: it.type || 'textarea', reusable: !!it.reusable,
          entities: it.entities || {}, confidence: it.confidence || 'medium',
        });
        cacheTouched = true;
        taught.push({ label: it.label, reusable: !!it.reusable, cached: true });
      } else {
        taught.push({ label: it.label, reusable: !!it.reusable, cached: false });
      }
    }
  });

  if (cacheTouched && ownCache) saveCache(useCache);
  if (ownStore) saveStore(useStore);
  if (ownQueue) saveQueue(useQueue);
  return { roleId, taught, cacheTouched };
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
    const out = teachAnswers(roleId, jsonArg);
    process.stderr.write(`Stored ${out.taught.length} model answer(s); cached ${out.taught.filter((t) => t.cached).length}.\n`);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  process.stderr.write(
    'Usage:\n  node queue-resolve.mjs --pre <role-id>\n' +
    "  node queue-resolve.mjs --lookup <role-id> '<json-array|@file>'\n" +
    "  node queue-resolve.mjs --teach <role-id> '<json-array|@file>'\n"
  );
  process.exit(1);
}

// Guard: only run main() when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
