#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';

console.log('\nDashboard bulk PREPARE integration');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForDashboard(child, origin) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`dashboard did not start: ${output.trim()}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(origin)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`dashboard exited early (${code}): ${output.trim()}`));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-bulk-prepare-'));
const roleIds = Array.from({ length: 7 }, (_, index) => `bulk-${index + 1}`);
writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
  version: 1,
  settings: { score_threshold: 4 },
  roles: roleIds.map((id, index) => ({
    id,
    company: `Company ${index + 1}`,
    title: `Data Role ${index + 1}`,
    url: `https://example.test/jobs/${id}`,
    status: 'scored',
    score: 4.2,
    eligibility: 'ok',
    confidence: 'high',
    flags: [],
  })),
}, null, 2));

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dashboard-server.mjs', '--port', String(port)], {
  cwd: ROOT,
  env: {
    ...process.env,
    CAREER_OPS_DATA_DIR: dataDir,
    CAREER_OPS_QUEUE_BACKEND: 'local',
    DOTENV_CONFIG_PATH: join(dataDir, 'no-env-file'),
    DOTENV_CONFIG_QUIET: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForDashboard(child, origin);
  const initial = await fetch(`${origin}/api/queue`).then((response) => response.json());
  assert.equal(initial.roles.length, roleIds.length);
  const headers = {
    'Content-Type': 'application/json',
    'X-Career-Ops-CSRF': initial.csrf_token,
    Origin: origin,
  };

  const oversizedRun = await fetch(`${origin}/api/selection-confirmation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: roleIds.slice(0, 5),
      action: 'run',
      confirmation: 'I selected these roles for preparation or filling',
    }),
  });
  assert.equal(oversizedRun.status, 400, 'live Run must remain capped at four roles');

  const confirmationResponse = await fetch(`${origin}/api/selection-confirmation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: roleIds,
      action: 'stage-prepare',
      confirmation: 'I selected these roles for preparation or filling',
    }),
  });
  assert.equal(confirmationResponse.status, 200);
  const confirmation = await confirmationResponse.json();

  const moveResponse = await fetch(`${origin}/api/roles/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: roleIds,
      selection_confirmation_nonce: confirmation.selection_confirmation_nonce,
      selection_intent_id: confirmation.selection_intent_id,
    }),
  });
  assert.equal(moveResponse.status, 200);
  const move = await moveResponse.json();
  assert.equal(move.moved, roleIds.length);

  const persisted = JSON.parse(readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'));
  for (const role of persisted.roles) {
    assert.equal(role.status, 'prepare-queued');
    assert.equal(role.candidate_selection_confirmation?.source, 'dashboard-bulk-prepare');
    assert.equal(role.candidate_selection_confirmation?.role_ids.length, roleIds.length);
    assert.equal(role.application_request, undefined);
  }
  pass('confirmed bulk Inbox selection moves every role to To Do without creating live application work');
  pass('bulk PREPARE is independent of the four-role browser-controller cap');

  // The same >4 selection becomes valid only after the candidate enables
  // One-shot for every role. Run records all seven durably; it does not create
  // seven live browser requests.
  persisted.settings.auto_fill_all = true;
  writeFileSync(
    join(dataDir, 'apply-queue.json'),
    `${JSON.stringify(persisted, null, 2)}\n`,
    'utf8',
  );
  const oneShotConfirmationResponse = await fetch(`${origin}/api/selection-confirmation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: roleIds,
      action: 'run',
      confirmation: 'I selected these roles for preparation or filling',
    }),
  });
  assert.equal(oneShotConfirmationResponse.status, 200);
  const oneShotConfirmation = await oneShotConfirmationResponse.json();
  const oneShotRunResponse = await fetch(`${origin}/api/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: roleIds,
      selection_confirmation_nonce: oneShotConfirmation.selection_confirmation_nonce,
      selection_intent_id: oneShotConfirmation.selection_intent_id,
    }),
  });
  assert.equal(oneShotRunResponse.status, 200);
  const oneShotRun = await oneShotRunResponse.json();
  assert.equal(oneShotRun.oneShotRequested, roleIds.length);
  assert.equal(oneShotRun.prepareQueued, roleIds.length);
  assert.equal(oneShotRun.agentPath, 0);

  const afterOneShotRun = JSON.parse(
    readFileSync(join(dataDir, 'apply-queue.json'), 'utf8'),
  );
  assert.equal(
    afterOneShotRun.roles.filter((role) => role.one_shot_request?.state === 'prepare-requested').length,
    roleIds.length,
  );
  assert.equal(
    afterOneShotRun.roles.filter((role) => role.application_request).length,
    0,
  );
  pass('an actual seven-role One-shot Run records seven resumable chains for four-slot draining');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else child.once('exit', resolve);
  });
  rmSync(dataDir, { recursive: true, force: true });
}
