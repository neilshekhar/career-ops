import { randomUUID, timingSafeEqual } from 'node:crypto';

export const DASHBOARD_JSON_BODY_LIMIT = 64 * 1024;

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateDashboardMutationRequest(headers = {}, {
  expectedOrigin,
  csrfToken,
} = {}) {
  const origin = String(headers.origin ?? '').trim();
  if (origin && origin !== expectedOrigin) {
    return { allowed: false, status: 403, reason: 'cross-origin dashboard mutation is forbidden' };
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(headers['content-type'] ?? ''))) {
    return { allowed: false, status: 415, reason: 'dashboard mutations require application/json' };
  }
  if (!safeEqual(headers['x-career-ops-csrf'], csrfToken)) {
    return { allowed: false, status: 403, reason: 'dashboard CSRF token is missing or invalid' };
  }
  return { allowed: true };
}

export class SubmissionConfirmationStore {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now(), createNonce = randomUUID } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.createNonce = createNonce;
    this.entries = new Map();
  }

  issue(roleId) {
    const id = String(roleId ?? '').trim();
    if (!id) throw new Error('role id is required for submission confirmation');
    const nonce = this.createNonce();
    this.entries.set(nonce, { roleId: id, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  consume(roleId, nonce) {
    const value = String(nonce ?? '').trim();
    const entry = this.entries.get(value);
    if (!entry) return { accepted: false, reason: 'submission confirmation nonce is missing or invalid' };
    this.entries.delete(value);
    if (entry.expiresAt < this.now()) {
      return { accepted: false, reason: 'submission confirmation nonce expired' };
    }
    if (entry.roleId !== String(roleId ?? '').trim()) {
      return { accepted: false, reason: 'submission confirmation nonce belongs to a different role' };
    }
    return { accepted: true };
  }
}

function canonicalRoleIds(roleIds) {
  if (!Array.isArray(roleIds)) return [];
  return [...new Set(roleIds.map((id) => String(id ?? '').trim()).filter(Boolean))].sort();
}

function canonicalRoleStates(roleIds, roleStates = {}) {
  return Object.fromEntries(roleIds.map((id) => [id, String(roleStates?.[id] ?? '').trim()]));
}

function sameJson(left, right) {
  return safeEqual(JSON.stringify(left), JSON.stringify(right));
}

/**
 * In-memory capability store for candidate-approved dashboard selection.
 *
 * A capability is bound to one exact action, an exact canonical role set, the
 * roles' current queue states, and a separately generated intent ID. It is
 * short-lived and deleted on every consume attempt, including a mismatched
 * attempt, so it cannot be replayed or retargeted by another local caller.
 */
export class SelectionConfirmationStore {
  constructor({
    ttlMs = 5 * 60 * 1000,
    now = () => Date.now(),
    createNonce = randomUUID,
    createIntentId = randomUUID,
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.createNonce = createNonce;
    this.createIntentId = createIntentId;
    this.entries = new Map();
  }

  issue({ roleIds, action, roleStates = {} } = {}) {
    const ids = canonicalRoleIds(roleIds);
    const normalizedAction = String(action ?? '').trim();
    if (ids.length === 0) throw new Error('at least one role id is required for selection confirmation');
    if (!normalizedAction) throw new Error('selection action is required');

    const issuedAt = this.now();
    const nonce = this.createNonce();
    const intentId = `selection-intent:${this.createIntentId()}`;
    const entry = {
      action: normalizedAction,
      roleIds: ids,
      roleStates: canonicalRoleStates(ids, roleStates),
      intentId,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    };
    this.entries.set(nonce, entry);
    return {
      nonce,
      intentId,
      roleIds: [...entry.roleIds],
      roleStates: { ...entry.roleStates },
      expiresAt: entry.expiresAt,
    };
  }

  consume({ roleIds, action, roleStates = {}, nonce, intentId } = {}) {
    const value = String(nonce ?? '').trim();
    const entry = this.entries.get(value);
    if (!entry) return { accepted: false, reason: 'selection confirmation nonce is missing or invalid' };
    this.entries.delete(value);

    if (entry.expiresAt < this.now()) {
      return { accepted: false, reason: 'selection confirmation nonce expired' };
    }
    if (!safeEqual(entry.intentId, String(intentId ?? '').trim())) {
      return { accepted: false, reason: 'selection confirmation intent is missing or invalid' };
    }
    if (!safeEqual(entry.action, String(action ?? '').trim())) {
      return { accepted: false, reason: 'selection confirmation belongs to a different action' };
    }

    const ids = canonicalRoleIds(roleIds);
    if (!sameJson(entry.roleIds, ids)) {
      return { accepted: false, reason: 'selection confirmation belongs to a different role set' };
    }
    const states = canonicalRoleStates(ids, roleStates);
    if (!sameJson(entry.roleStates, states)) {
      return { accepted: false, reason: 'selection confirmation is stale because a role state changed' };
    }

    const consumedAt = this.now();
    return {
      accepted: true,
      intentId: entry.intentId,
      action: entry.action,
      roleIds: [...entry.roleIds],
      roleStates: { ...entry.roleStates },
      issuedAt: entry.issuedAt,
      consumedAt,
    };
  }
}
