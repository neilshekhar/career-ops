/**
 * Shared tracker -> queue status mapping.
 *
 * Tracker statuses are user-facing application states. Queue done statuses are
 * persistence/dedup states used by active_roles/seen_urls.
 */

export const TRACKER_TO_QUEUE_DONE_STATUS = Object.freeze({
  evaluated: 'reviewed',
  applied:   'submitted',
  responded: 'submitted',
  interview: 'submitted',
  offer:     'submitted',
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
  return TRACKER_TO_QUEUE_DONE_STATUS[normalized] ?? null;
}

// -- Done-board rows ----------------------------------------------------------
//
// Post-decision tracker statuses, grouped for the dashboard's Done column:
//   'applied' group — application went out (Applied / Responded / Interview / Offer)
//   'closed'  group — no longer pursued   (Rejected / Discarded / SKIP)
// Evaluated rows are pre-decision and never appear on the Done board.

const DONE_GROUP_BY_TRACKER_STATUS = Object.freeze({
  applied:   'applied',
  responded: 'applied',
  interview: 'applied',
  offer:     'applied',
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
 * Tracker column order: | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
 */
export function parseTrackerDoneRows(text = '', options = {}) {
  const limit = options.limit ?? 100;
  const rows = [];

  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue;

    const normalized = normalizeTrackerStatus(cells[5]);
    const group = DONE_GROUP_BY_TRACKER_STATUS[normalized];
    if (!group) continue; // Evaluated / unknown — not a done row

    rows.push({
      num:     parseInt(cells[0], 10),
      date:    cells[1] ?? '',
      company: cells[2] ?? '',
      title:   cells[3] ?? '',
      status:  cells[5].replace(/\*/g, '').trim(),
      group,
      score:   cells[4] ?? '',
    });
  }

  rows.sort((a, b) => (b.date.localeCompare(a.date)) || (b.num - a.num));
  return rows.slice(0, limit);
}
