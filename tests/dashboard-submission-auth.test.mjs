#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  SubmissionConfirmationStore,
  validateDashboardMutationRequest,
} from '../dashboard-auth.mjs';
import { pass } from './helpers.mjs';

console.log('\nDashboard submission authorization');

const expectedOrigin = 'http://127.0.0.1:7777';
const csrfToken = 'test-csrf-token';
assert.deepEqual(validateDashboardMutationRequest({
  origin: expectedOrigin,
  'content-type': 'application/json',
  'x-career-ops-csrf': csrfToken,
}, { expectedOrigin, csrfToken }), { allowed: true });
pass('same-origin JSON mutation with the dashboard CSRF token is accepted');

assert.equal(validateDashboardMutationRequest({
  origin: 'https://malicious.example',
  'content-type': 'text/plain',
}, { expectedOrigin, csrfToken }).allowed, false);
assert.equal(validateDashboardMutationRequest({
  origin: expectedOrigin,
  'content-type': 'application/json',
}, { expectedOrigin, csrfToken }).allowed, false);
pass('cross-origin simple POSTs and missing-token mutations fail closed');

let now = 1_000;
let serial = 0;
const store = new SubmissionConfirmationStore({
  ttlMs: 100,
  now: () => now,
  createNonce: () => `nonce-${++serial}`,
});
const nonce = store.issue('role-1');
assert.equal(store.consume('role-2', nonce).accepted, false);
assert.equal(store.consume('role-1', nonce).accepted, false);
const accepted = store.issue('role-1');
assert.equal(store.consume('role-1', accepted).accepted, true);
assert.equal(store.consume('role-1', accepted).accepted, false);
const expired = store.issue('role-1');
now += 101;
assert.equal(store.consume('role-1', expired).accepted, false);
pass('submission confirmations are role-bound, short-lived, and one-use');
