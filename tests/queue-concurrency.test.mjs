#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { pass } from './helpers.mjs';

console.log('\nConcurrent application stores');

const dataDir = mkdtempSync(join(tmpdir(), 'career-ops-stores-'));
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'apply-queue.json'), JSON.stringify({
  version: 1,
  settings: { counter: 0 },
  roles: [],
}, null, 2) + '\n');

const queueUrl = new URL('../queue-store.mjs', import.meta.url).href;
const cacheUrl = new URL('../answer-cache.mjs', import.meta.url).href;
const screenerUrl = new URL('../screener-store.mjs', import.meta.url).href;
const workerCode = `
  import { mutateQueue } from ${JSON.stringify(queueUrl)};
  import { mutateCache } from ${JSON.stringify(cacheUrl)};
  import { mutateScreenerStore } from ${JSON.stringify(screenerUrl)};
  const worker = process.argv[1];
  for (let i = 0; i < 25; i++) {
    mutateQueue((queue) => { queue.settings.counter = (queue.settings.counter || 0) + 1; });
    mutateCache((cache) => { cache.entries.push({ id: worker + '-' + i }); });
    mutateScreenerStore((store) => { store.entries[worker + '-' + i] = { answer: 'Yes' }; });
  }
`;

function runWorker(id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, id], {
      env: {
        ...process.env,
        CAREER_OPS_DATA_DIR: dataDir,
        CAREER_OPS_QUEUE_BACKEND: 'local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker ${id} failed: ${stderr}`)));
  });
}

const oldData = process.env.CAREER_OPS_DATA_DIR;
const oldBackend = process.env.CAREER_OPS_QUEUE_BACKEND;
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';

try {
  await Promise.all(['a', 'b', 'c', 'd'].map(runWorker));

  const queue = await import(`${queueUrl}?test=${Date.now()}`);
  const cache = await import(`${cacheUrl}?test=${Date.now()}`);
  const screener = await import(`${screenerUrl}?test=${Date.now()}`);
  assert.equal(queue.loadQueue().settings.counter, 100);
  assert.equal(cache.loadCache().entries.length, 100);
  assert.equal(Object.keys(screener.loadStore().entries).length, 100);
  pass('four workers preserve every queue, cache, and screener mutation');

  writeFileSync(join(dataDir, 'apply-queue.json'), '{ broken queue');
  assert.throws(() => queue.loadQueue(), /Invalid JSON/);
  pass('existing malformed queue data fails closed instead of appearing empty');

  writeFileSync(join(dataDir, 'answer-cache.json'), '{ broken cache');
  writeFileSync(join(dataDir, 'screener-answers.json'), '{ broken screener');
  assert.throws(() => cache.loadCache(), /refusing silent reset/);
  assert.throws(() => screener.loadStore(), /refusing silent reset/);
  pass('learned-answer stores fail closed instead of losing prior answers');
} finally {
  if (oldData == null) delete process.env.CAREER_OPS_DATA_DIR;
  else process.env.CAREER_OPS_DATA_DIR = oldData;
  if (oldBackend == null) delete process.env.CAREER_OPS_QUEUE_BACKEND;
  else process.env.CAREER_OPS_QUEUE_BACKEND = oldBackend;
  // Four workers just contended on lock files in this directory. On a loaded
  // machine a lock can be released between rmSync's directory walk and its
  // unlink, which surfaces as ENOTEMPTY even with force:true. Retry rather than
  // failing the suite on a teardown race that proves nothing about the code.
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

