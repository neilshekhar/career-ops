/**
 * Shared tracker -> queue status mapping.
 *
 * Tracker statuses are user-facing application states. Queue done statuses are
 * persistence/dedup states used by active_roles/seen_urls.
 */

import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

export const TRACKER_TO_QUEUE_DONE_STATUS = Object.freeze({
  evaluated: 'reviewed',
  applied:   'submitted',
  responded: 'submitted',
  interview: 'submitted',
  offer:     'submitted',
  hired:     'submitted',
  rejected:  'closed',
  discarded: 'reviewed',
  skip:      'skipped',
});

export function normalizeTrackerStatus(status = '') {
  return String(status ?? '')
    .replace(/\*/g, '')
    .trim()
    .toLowerCase();
}

export function queueDoneStatusFromTracker(status = '', options = {}) {
  const normalized = normalizeTrackerStatus(status);
  if (!options.includeEvaluated && normalized === 'evaluated') return null;
  const mapped = TRACKER_TO_QUEUE_DONE_STATUS[normalized] ?? null;
  // An Applied/Responded/Interview/Offer/Hired tracker label is not executable proof
  // that the active live form crossed the receipt + candidate-submit gates.
  // Historical migrations may opt in explicitly; live dashboard reconciliation
  // must never promote an active queue role to submitted from tracker text alone.
  if (mapped === 'submitted' && options.allowSubmittedEvidence !== true) return null;
  return mapped;
}

// -- Done-board rows ----------------------------------------------------------
//
// Post-decision tracker statuses, grouped for the dashboard's Done column:
//   'applied' group — application went out (Applied / Responded / Interview / Offer / Hired)
//   'closed'  group — no longer pursued   (Rejected / Discarded / SKIP)
// Evaluated rows are pre-decision and never appear on the Done board.

const DONE_GROUP_BY_TRACKER_STATUS = Object.freeze({
  applied:   'applied',
  responded: 'applied',
  interview: 'applied',
  offer:     'applied',
  hired:     'applied',
  rejected:  'closed',
  discarded: 'closed',
  skip:      'closed',
});

/**
 * Parse applications.md text into Done-column rows.
 * Pure function — takes the markdown text, returns
 * [{ num, date, company, title, status, group, score }] sorted date desc
 * (ties broken by tracker num desc), capped at options.limit (default 100).
 *
 * Column order is detected from the tracker header; customized Location/Via
 * layouts therefore use the same parser as every canonical tracker writer.
 */
export function parseTrackerDoneRows(text = '', options = {}) {
  const limit = options.limit ?? 100;
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  const colmap = resolveColumns(lines);

  for (const line of lines) {
    const parsed = parseTrackerRow(line, colmap);
    if (!parsed) continue;
    const normalized = normalizeTrackerStatus(parsed.status);
    const group = DONE_GROUP_BY_TRACKER_STATUS[normalized];
    if (!group) continue; // Evaluated / unknown — not a done row

    rows.push({
      num:     parsed.num,
      date:    parsed.date ?? '',
      company: parsed.company ?? '',
      title:   parsed.role ?? '',
      status:  parsed.status.replace(/\*/g, '').trim(),
      group,
      score:   parsed.score ?? '',
    });
  }

  rows.sort((a, b) => (b.date.localeCompare(a.date)) || (b.num - a.num));
  return rows.slice(0, limit);
}
