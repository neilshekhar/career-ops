#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass } from './helpers.mjs';

console.log('\nQueue persistence hardening');

const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-queue-hardening-'));
const queuePath = join(dataDir, 'apply-queue.json');
const oldData = process.env.CAREER_OPS_DATA_DIR;
const oldBackend = process.env.CAREER_OPS_QUEUE_BACKEND;
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';

const legacyRoles = [
  {
    id: 'legacy:filled',
    company: 'Legacy Co',
    title: 'Legacy Filled',
    url: 'https://example.test/filled',
    status: 'filled',
  },
  {
    id: 'legacy:submitted',
    company: 'Legacy Co',
    title: 'Legacy Submitted',
    url: 'https://example.test/submitted',
    status: 'submitted',
  },
];
writeFileSync(queuePath, JSON.stringify({
  version: 1,
  settings: {},
  roles: legacyRoles,
}, null, 2) + '\n');

try {
  const store = await import(`../queue-store.mjs?queue-hardening=${Date.now()}`);

  const merged = store.mergeCloudAndLocal([
    {
      id: 'role:1',
      company: 'Acme',
      title: 'Analyst',
      url: 'https://jobs.example.test/1',
      ats: 'custom',
      status: 'prepared',
    },
  ], {
    version: 1,
    settings: {
      score_threshold: 4,
      auto_fill_all: true,
      application_controller: {
        version: 1,
        controller: 'active-agent',
        controller_id: 'browser-controller:test',
        max_active_roles: 4,
      },
      custom_setting: 'preserved',
    },
    roles: {},
  });
  assert.equal(
    merged.settings.application_controller.controller_id,
    'browser-controller:test',
  );
  assert.equal(merged.settings.custom_setting, 'preserved');
  assert.equal(merged.settings.score_threshold, 4);
  assert.equal(merged.settings.auto_fill_all, true);
  pass('Supabase merge preserves the full sidecar settings ledger and controller lease');

  assert.doesNotThrow(() => store.mutateQueue((queue) => {
    queue.settings.legacy_touch = true;
  }));
  const afterLegacy = JSON.parse(readFileSync(queuePath, 'utf8'));
  assert.equal(afterLegacy.settings.legacy_touch, true);
  assert.equal(afterLegacy.roles[0].application_progress, undefined);
  assert.equal(afterLegacy.roles[1].application_request, undefined);
  pass('genuine legacy protected rows remain saveable for unrelated queue mutations');

  const invalidModern = {
    version: 1,
    settings: {},
    roles: [{
      id: 'modern:filled',
      company: 'Modern Co',
      title: 'Modern Filled',
      url: 'https://example.test/modern',
      status: 'filled',
      application_progress: {},
      application_request: {},
    }],
  };
  writeFileSync(queuePath, JSON.stringify(invalidModern, null, 2) + '\n');
  assert.throws(
    () => store.mutateQueue((queue) => {
      queue.settings.unrelated = true;
    }),
    /status filled requires a finalized review-ready application receipt/,
  );
  pass('unchanged modern filled rows are revalidated on every locked save');

  const erased = store.loadQueue();
  delete erased.roles[0].application_progress;
  delete erased.roles[0].application_request;
  assert.throws(
    () => store.saveQueue(erased),
    /refusing to erase modern application receipt evidence/,
  );
  pass('direct saves cannot erase modern receipt fields while retaining a protected status');

  const split = store.splitRoleForPersistence({
    id: 'role:transaction',
    company: 'Acme',
    title: 'Analyst',
    url: 'https://example.test/transaction',
    status: 'prepared',
    application_finalization_transaction: { state: 'pending' },
  });
  assert.equal(split.cloud.application_finalization_transaction, undefined);
  assert.deepEqual(
    split.local.application_finalization_transaction,
    { state: 'pending' },
  );
  pass('application finalization transactions remain local-only');

  // A live owner remains authoritative regardless of lock-directory age.
  rmSync(store.QUEUE_LOCK_PATH, { recursive: true, force: true });
  mkdirSync(store.QUEUE_LOCK_PATH, { recursive: true });
  writeFileSync(join(store.QUEUE_LOCK_PATH, 'owner.json'), JSON.stringify({
    pid: process.pid,
    token: 'live-owner',
    started_at: '2000-01-01T00:00:00.000Z',
  }));
  assert.throws(
    () => store.mutateQueue(() => {}, { timeoutMs: 80 }),
    /Timed out waiting for apply queue lock/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(store.QUEUE_LOCK_PATH, 'owner.json'), 'utf8')).token,
    'live-owner',
  );
  pass('queue lock recovery never steals an old lock from a live owner PID');

  // A dead owner is recoverable.
  rmSync(store.QUEUE_LOCK_PATH, { recursive: true, force: true });
  mkdirSync(store.QUEUE_LOCK_PATH, { recursive: true });
  writeFileSync(join(store.QUEUE_LOCK_PATH, 'owner.json'), JSON.stringify({
    pid: 2147483647,
    token: 'dead-owner',
    started_at: new Date().toISOString(),
  }));
  writeFileSync(queuePath, JSON.stringify({
    version: 1,
    settings: {},
    roles: legacyRoles,
  }, null, 2) + '\n');
  assert.doesNotThrow(() => store.mutateQueue((queue) => {
    queue.settings.dead_owner_recovered = true;
  }, { timeoutMs: 500 }));
  assert.equal(existsSync(store.QUEUE_LOCK_PATH), false);
  pass('queue lock recovery removes a dead PID owner and completes the mutation');

  // Final release is token-checked: losing ownership during the callback must
  // never delete a replacement lock created by another process.
  assert.doesNotThrow(() => store.mutateQueue((queue) => {
    rmSync(store.QUEUE_LOCK_PATH, { recursive: true, force: true });
    mkdirSync(store.QUEUE_LOCK_PATH, { recursive: true });
    writeFileSync(join(store.QUEUE_LOCK_PATH, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'replacement-owner',
      started_at: new Date().toISOString(),
    }));
    queue.settings.token_checked_release = true;
  }));
  assert.equal(
    JSON.parse(readFileSync(join(store.QUEUE_LOCK_PATH, 'owner.json'), 'utf8')).token,
    'replacement-owner',
  );
  pass('queue lock release cannot delete a newer replacement owner');
} finally {
  if (oldData == null) delete process.env.CAREER_OPS_DATA_DIR;
  else process.env.CAREER_OPS_DATA_DIR = oldData;
  if (oldBackend == null) delete process.env.CAREER_OPS_QUEUE_BACKEND;
  else process.env.CAREER_OPS_QUEUE_BACKEND = oldBackend;
  rmSync(dataDir, { recursive: true, force: true });
}
