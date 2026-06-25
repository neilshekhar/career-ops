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
