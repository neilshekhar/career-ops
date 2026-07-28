#!/usr/bin/env node
/**
 * application-request.mjs — Shared durable active-agent request core.
 *
 * One implementation of the browser-controller lease, the four-active-role
 * concurrency cap, and `application_request` creation. Both dispatchers use it:
 *
 *   - `dashboard-server.mjs` — the candidate clicked Fill/Run on a role whose
 *     assets already passed the gate.
 *   - `one-shot-request.mjs` — the active agent is draining the candidate's
 *     original One-shot Run intent after PREPARE produced fresh assets.
 *
 * Keeping the cap in ONE module makes the invariant structural instead of a
 * cross-file assertion that two copies happen to agree.
 *
 * This module never touches a browser, never changes role status, and never
 * mints candidate authorization. It only records that work is queued for the
 * single active-agent browser controller.
 */

import { randomUUID } from 'crypto';

import { APPLICATION_RECEIPT_REQUEST_CONTRACT } from './application-receipt-integrity.mjs';

export const ACTIVE_AGENT_APPLY_CONTRACT = APPLICATION_RECEIPT_REQUEST_CONTRACT;

/**
 * Maximum queued/in-progress application requests for the single browser
 * controller. This bounds blast radius and keeps the candidate's end-of-session
 * review tractable; it is a hard invariant, not a tunable. `application-receipt.mjs`
 * independently re-asserts the same number on every receipt begin.
 */
export const MAX_ACTIVE_APPLICATION_REQUESTS = 4;

export const ACTIVE_APPLICATION_REQUEST_STATES = new Set(['queued', 'in-progress']);

function httpError(message, code) {
  const err = new Error(message);
  err.httpCode = code;
  return err;
}

/**
 * Resolve (or mint) the queue's single browser-controller lease and prove every
 * active request belongs to it.
 */
export function applicationControllerLease(queue) {
  queue.settings = queue.settings ?? {};
  const current = queue.settings.application_controller;
  const existingControllerIds = [...new Set((queue.roles ?? [])
    .filter((item) => ACTIVE_APPLICATION_REQUEST_STATES.has(item?.application_request?.state))
    .map((item) => item.application_request?.controller_id)
    .filter(Boolean))];
  if (existingControllerIds.length > 1) {
    throw httpError('multiple browser-controller IDs already exist; preserve tabs and resolve the conflict before queueing more work', 409);
  }
  const now = new Date().toISOString();
  const lease = current?.version === 1 && current.controller === 'active-agent' && current.controller_id
    ? current
    : {
        version: 1,
        controller: 'active-agent',
        controller_id: existingControllerIds[0] ?? `browser-controller:${randomUUID()}`,
        max_active_roles: MAX_ACTIVE_APPLICATION_REQUESTS,
        created_at: now,
        updated_at: now,
      };
  if (existingControllerIds.length === 1 && existingControllerIds[0] !== lease.controller_id) {
    throw httpError('active application requests do not match the persisted browser-controller lease', 409);
  }
  for (const item of queue.roles ?? []) {
    if (!ACTIVE_APPLICATION_REQUEST_STATES.has(item?.application_request?.state)) continue;
    if (item.application_request.controller !== 'active-agent') {
      throw httpError('an active application request is owned by a non-canonical controller', 409);
    }
    item.application_request.controller_id = item.application_request.controller_id ?? lease.controller_id;
    if (item.application_request.controller_id !== lease.controller_id) {
      throw httpError('multiple browser-controller leases are active in the same queue', 409);
    }
  }
  lease.max_active_roles = MAX_ACTIVE_APPLICATION_REQUESTS;
  lease.updated_at = now;
  queue.settings.application_controller = lease;
  return lease;
}

export function activeApplicationRequests(queue) {
  return (queue.roles ?? []).filter(
    (item) => ACTIVE_APPLICATION_REQUEST_STATES.has(item?.application_request?.state),
  );
}

/** Remaining concurrency slots for the browser controller. Never negative. */
export function availableApplicationRequestSlots(queue) {
  return Math.max(0, MAX_ACTIVE_APPLICATION_REQUESTS - activeApplicationRequests(queue).length);
}

/**
 * Persist a work request without touching a browser or changing application
 * status. The interactive agent consumes this record and owns the exact tab for
 * the whole extract/resolve/L3/teach/verify/receipt run.
 *
 * Idempotent per role: an existing active request for the same controller is
 * preserved and returned with `reused: true` instead of being overwritten.
 */
export function createActiveAgentRequest(queue, role, runId, source = 'dashboard') {
  const lease = applicationControllerLease(queue);
  const existing = role.application_request;
  if (existing && ACTIVE_APPLICATION_REQUEST_STATES.has(existing.state)) {
    if (existing.controller !== 'active-agent') {
      throw httpError('role already has an active request owned by a different controller', 409);
    }
    // One migration path for requests written before controller IDs became
    // executable. Preserve their run/tab instead of overwriting live work.
    existing.controller_id = existing.controller_id ?? lease.controller_id;
    if (existing.controller_id !== lease.controller_id) {
      throw httpError('role already belongs to another browser-controller lease', 409);
    }
    existing.updated_at = new Date().toISOString();
    return { request: structuredClone(existing), reused: true };
  }
  if (existing?.state === 'review-ready') {
    throw httpError('role already has a review-ready application request; validate or repair its receipt instead of overwriting it', 409);
  }
  if (activeApplicationRequests(queue).length >= MAX_ACTIVE_APPLICATION_REQUESTS) {
    throw httpError(`browser-controller already has ${MAX_ACTIVE_APPLICATION_REQUESTS} active roles; finish or park one before queueing another`, 409);
  }
  const requestedAt = new Date().toISOString();
  role.application_request = {
    version: 1,
    request_id: `${runId}:${role.id}`,
    run_id: runId,
    role_id: role.id,
    source,
    state: 'queued',
    controller: 'active-agent',
    controller_id: lease.controller_id,
    requested_at: requestedAt,
    url: role.url,
    contract: [...ACTIVE_AGENT_APPLY_CONTRACT],
  };
  lease.updated_at = requestedAt;
  return { request: structuredClone(role.application_request), reused: false };
}
