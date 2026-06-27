#!/usr/bin/env node
/**
 * screener-store.mjs — Deterministic learned-answer store for radio/select screeners.
 *
 * A user-layer flat file (data/screener-answers.json, gitignored) of radio/select
 * answers learned across applications. Unlike the embedding cache (answer-cache.mjs),
 * this store uses EXACT normalized-label matching — no cosine similarity, no fuzzy
 * lookup, no inversion risk. It is the right tool for binary screeners (Yes/No,
 * categorical) whose correct answer is stable and employer-independent.
 *
 * Volatile guard: labels or answers that carry a location, number, date, or money
 * amount are NOT stored — those answers are context-dependent and must be regenerated
 * per-role (e.g. "relocate to Sydney?", "how many years of X?", "salary?").
 *
 * Resolution priority in resolveFields():
 *   L1 (deterministic profile rules, field-rules.mjs)   ← existing, first
 *   L1.5 (this store — learned, exact-label)             ← NEW, after L1 miss
 *   L2 (embedding cache — text/textarea only)            ← existing, text only
 *   L3 (LLM novel)                                       ← existing, fallback
 *
 * Auto-grows via --teach: every novel radio/select answer is written here after
 * the agent finishes filling an application. No user confirmation required.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { extractEntities } from './answer-cache.mjs';
import { normLabel } from './field-rules.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const STORE_PATH = join(ROOT, 'data', 'screener-answers.json');

const EMPTY_STORE = () => ({ version: 1, entries: {} });

// ── Load / Save (atomic) ───────────────────────────────────────────────────────

export function loadStore() {
  if (!existsSync(STORE_PATH)) return EMPTY_STORE();
  try {
    const s = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    if (!s || typeof s.entries !== 'object' || Array.isArray(s.entries)) return EMPTY_STORE();
    return s;
  } catch {
    return EMPTY_STORE();
  }
}

export function saveStore(store) {
  const tmp = join(ROOT, 'data', `.screener-answers-${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmp, STORE_PATH);
}

// ── Volatile guard ─────────────────────────────────────────────────────────────
//
// Returns true if the label or answer carries a context-specific token (number,
// money, date, location). Such answers must not be reused across roles.

function isVolatile(label, answer) {
  const le = extractEntities(label);
  const ae = extractEntities(String(answer));
  // Any volatile token in EITHER label or answer makes the pair context-specific.
  // Label: "how many years of X?" carries no digit but the answer will be one →
  //        we catch that via ae.numbers below.
  // Answer: "Yes" / "No" / "Immediately available" carry no numbers/money/dates/locations
  //        → safe to store. A numeric answer like "3" (years of experience) IS volatile.
  return (
    le.locations.length > 0 || le.numbers.length > 0 ||
    le.dates.length    > 0 || le.money.length    > 0 ||
    ae.locations.length > 0 || ae.numbers.length  > 0 ||
    ae.money.length    > 0 || ae.dates.length     > 0
  );
}

// ── Lookup ─────────────────────────────────────────────────────────────────────

/**
 * Look up an exact-label match in the screener store.
 * @param {object} store  — result of loadStore()
 * @param {string} key    — normLabel(field.label) already computed by caller
 * @returns {object|null} — store entry (answer, options_seen, count, …) or null
 */
export function lookupScreener(store, key) {
  return store?.entries?.[key] ?? null;
}

// ── Learn (upsert) ─────────────────────────────────────────────────────────────

/**
 * Store a novel radio/select answer so future applications can reuse it.
 *
 * @param {object} store     — mutable store from loadStore()
 * @param {object} opts
 * @param {string} opts.label    — exact question label (will be normalized as key)
 * @param {string} opts.answer   — the answer given (e.g. "Yes", "No", "Part-Time")
 * @param {string[]} opts.options — live options from the form (for future revalidation)
 * @param {string} [opts.roleId] — role id for audit trail
 * @returns {{ learned: boolean, reason?: string }}
 */
export function learnScreener(store, { label, answer, options = [], roleId = null }) {
  if (!label || answer == null) return { learned: false, reason: 'missing label or answer' };

  if (isVolatile(label, answer)) {
    return { learned: false, reason: 'volatile (number/money/date/location in label or answer)' };
  }

  const key = normLabel(label);
  const now = new Date().toISOString();

  const existing = store.entries[key];
  if (existing) {
    // Update answer (may have been corrected), extend options_seen, bump count.
    existing.answer = answer;
    existing.options_seen = [...new Set([...existing.options_seen, ...options])];
    existing.count = (existing.count || 1) + 1;
    existing.last_seen = now;
    if (roleId && !existing.roles.includes(roleId)) existing.roles.push(roleId);
    existing.updated_at = now;
  } else {
    store.entries[key] = {
      label,
      answer,
      options_seen: [...new Set(options)],
      count: 1,
      created_at: now,
      last_seen: now,
      updated_at: now,
      roles: roleId ? [roleId] : [],
    };
  }

  return { learned: true };
}
