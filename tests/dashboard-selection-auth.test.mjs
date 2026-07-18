#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SelectionConfirmationStore } from '../dashboard-auth.mjs';
import { checkDashboardClient, checkDashboardRuntime } from '../verify-application-contract.mjs';
import { pass, ROOT } from './helpers.mjs';

console.log('\nDashboard candidate selection authorization');

let now = 10_000;
let nonceSerial = 0;
let intentSerial = 0;
const createStore = () => new SelectionConfirmationStore({
  ttlMs: 100,
  now: () => now,
  createNonce: () => `selection-nonce-${++nonceSerial}`,
  createIntentId: () => `intent-${++intentSerial}`,
});

const store = createStore();
const issued = store.issue({
  roleIds: ['role-b', 'role-a', 'role-a'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
});
assert.deepEqual(issued.roleIds, ['role-a', 'role-b']);
assert.equal(store.consume({
  roleIds: ['role-a', 'role-b'],
  action: 'fill',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
  nonce: issued.nonce,
  intentId: issued.intentId,
}).accepted, false);
assert.equal(store.consume({
  roleIds: ['role-a', 'role-b'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
  nonce: issued.nonce,
  intentId: issued.intentId,
}).accepted, false);
pass('a mismatched action consumes the capability and cannot be replayed');

const wrongSet = store.issue({
  roleIds: ['role-a', 'role-b'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
});
assert.equal(store.consume({
  roleIds: ['role-a'],
  action: 'run',
  roleStates: { 'role-a': 'scored' },
  nonce: wrongSet.nonce,
  intentId: wrongSet.intentId,
}).accepted, false);

const wrongIntent = store.issue({
  roleIds: ['role-a'],
  action: 'fill',
  roleStates: { 'role-a': 'prepared' },
});
assert.equal(store.consume({
  roleIds: ['role-a'],
  action: 'fill',
  roleStates: { 'role-a': 'prepared' },
  nonce: wrongIntent.nonce,
  intentId: 'selection-intent:another-run',
}).accepted, false);

const stale = store.issue({
  roleIds: ['role-a'],
  action: 'fill',
  roleStates: { 'role-a': 'prepared' },
});
assert.equal(store.consume({
  roleIds: ['role-a'],
  action: 'fill',
  roleStates: { 'role-a': 'filled' },
  nonce: stale.nonce,
  intentId: stale.intentId,
}).accepted, false);
pass('selection capabilities are exact-role-set, intent, action, and queue-state bound');

const accepted = store.issue({
  roleIds: ['role-b', 'role-a'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
});
const consumed = store.consume({
  roleIds: ['role-a', 'role-b'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
  nonce: accepted.nonce,
  intentId: accepted.intentId,
});
assert.equal(consumed.accepted, true);
assert.equal(store.consume({
  roleIds: ['role-a', 'role-b'],
  action: 'run',
  roleStates: { 'role-a': 'scored', 'role-b': 'prepared' },
  nonce: accepted.nonce,
  intentId: accepted.intentId,
}).accepted, false);

const expired = store.issue({
  roleIds: ['role-a'],
  action: 'stage-prepare',
  roleStates: { 'role-a': 'scored' },
});
now += 101;
assert.equal(store.consume({
  roleIds: ['role-a'],
  action: 'stage-prepare',
  roleStates: { 'role-a': 'scored' },
  nonce: expired.nonce,
  intentId: expired.intentId,
}).accepted, false);
pass('candidate selection capabilities are short-lived and one-use');

const bulkRoleIds = Array.from({ length: 12 }, (_, index) => `bulk-role-${index + 1}`);
const bulkRoleStates = Object.fromEntries(bulkRoleIds.map((id) => [id, 'scored']));
const bulkSelection = store.issue({
  roleIds: bulkRoleIds,
  action: 'stage-prepare',
  roleStates: bulkRoleStates,
});
assert.equal(store.consume({
  roleIds: bulkRoleIds,
  action: 'stage-prepare',
  roleStates: bulkRoleStates,
  nonce: bulkSelection.nonce,
  intentId: bulkSelection.intentId,
}).accepted, true);
pass('PREPARE selection capabilities support role sets larger than the live-fill limit');

const server = readFileSync(join(ROOT, 'dashboard-server.mjs'), 'utf8');
const client = readFileSync(join(ROOT, 'dashboard/web/app.js'), 'utf8');
const html = readFileSync(join(ROOT, 'dashboard/web/index.html'), 'utf8');
assert.deepEqual(checkDashboardRuntime('dashboard-server.mjs', server), []);
assert.deepEqual(checkDashboardClient('dashboard/web/app.js', client), []);
for (const pattern of [
  /function apiSelectionConfirmation\s*\(/,
  /selectionConfirmations\.consume\s*\(/,
  /recordCandidateSelectionConfirmation\s*\(/,
  /action:\s*'run'/,
  /action:\s*'fill'/,
  /action:\s*'stage-prepare'/,
  /function apiBulkPrepare\s*\(/,
  /MAX_BULK_PREPARE_SELECTIONS\s*=\s*500/,
  /['"]dashboard-bulk-prepare['"]/,
  /path === ['"]\/api\/roles\/prepare['"]/,
]) assert.match(server, pattern);
for (const pattern of [
  /function requestCandidateSelection\s*\(/,
  /\/api\/selection-confirmation/,
  /selectionConfirmationBody\(confirmation\)/,
  /'stage-prepare'/,
  /\(issued\)\s*=>\s*doFill\(roleId, issued\)/,
  /function moveVisibleInboxToTodo\s*\(/,
  /postJson\(['"]\/api\/roles\/prepare['"]/,
]) assert.match(client, pattern);
assert.match(html, /id=["']btn-bulk-prepare["']/);
pass('single Fill, live Run, PREPARE drag, and bulk Inbox move share the confirmed selection flow');

assert(
  checkDashboardRuntime(
    'dashboard-server.mjs',
    server.replace(
      "selectionConfirmation = consumeSelectionConfirmation({\n        action: 'run',",
      "selectionConfirmation = { accepted: true };\n      void ({\n        action: 'run',",
    ),
  ).some((item) => item.message.includes('exact-role-set/run-bound')),
  'static guard must reject a bulk run that no longer consumes the candidate selection capability',
);
assert(
  checkDashboardClient(
    'dashboard/web/app.js',
    client.replace("'/api/selection-confirmation'", "'/api/unsafe-selection'"),
  ).some((item) => item.message.includes('role-selection confirmation flow')),
  'static guard must reject a client that bypasses the server-issued selection endpoint',
);
pass('static contract guard rejects server and client selection-confirmation bypasses');
