#!/usr/bin/env node
/**
 * tests/upstream-merge-gate.test.mjs — Finding 2.
 *
 * The engine zero-diff gate is the fork's single hard protection for the
 * apply/queue engine during an upstream merge. It was written as
 * `git diff main..HEAD` while the documented timing is "resolved and staged, not
 * yet committed" — and at that moment HEAD still points at the pre-merge `main`,
 * so the command compares main to itself and is empty regardless of what the
 * index holds. A gate that cannot fail is worse than no gate: it reads as proof.
 *
 * These tests pin the corrected commands and the ignore-path gate so a future
 * edit cannot quietly restore the no-op.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';

console.log('\nUpstream merge gate');

const checklist = readFileSync(join(ROOT, 'UPSTREAM_MERGE_CHECKLIST.md'), 'utf8');

const protectedBlock = checklist.match(/PROTECTED_ENGINE_PATHS=\(\s*([\s\S]*?)\n\)/);
assert.ok(protectedBlock, 'checklist must define the canonical PROTECTED_ENGINE_PATHS array');
const ENGINE_PATHS = protectedBlock[1]
  .split(/\r?\n/)
  .map((line) => line.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);

const REQUIRED_ENGINE_PATHS = [
  'application-answers.mjs',
  'application-receipt-integrity.mjs',
  'application-receipt.mjs',
  'application-request.mjs',
  'application-safety.mjs',
  'application-source-contract.mjs',
  'answer-cache.mjs',
  'apply-page.mjs',
  'cover-quality.mjs',
  'credentials-store.mjs',
  'cv-tailoring.mjs',
  'dashboard-auth.mjs',
  'dashboard-launch.mjs',
  'dashboard-server.mjs',
  'dashboard/web/app.js',
  'field-rules.mjs',
  'form-fill.mjs',
  'generate-docx.mjs',
  'generation-provenance.mjs',
  'lean-application.mjs',
  'login-core.mjs',
  'mint-cron-jwt.mjs',
  'one-shot-request.mjs',
  'prepare-application.mjs',
  'queue-ingest.mjs',
  'queue-resolve.mjs',
  'queue-store.mjs',
  'queue-sweep.mjs',
  'run-partition.mjs',
  'screener-store.mjs',
  'set-status.mjs',
  'snapshot-extract.mjs',
  'supabase-client.mjs',
  'tracker-status-map.mjs',
  'verify-application-contract.mjs',
  'verify-userdata.mjs',
];

// The two-dot form against the pre-merge HEAD is the no-op. It must not appear
// as an engine-diff command anywhere in the checklist.
const twoDotEngineDiff = /git diff\s+main\.\.HEAD\s+--[\s\S]{0,240}?queue-store\.mjs/;
assert.doesNotMatch(
  checklist,
  twoDotEngineDiff,
  'checklist still uses the no-op `git diff main..HEAD --` for the engine gate',
);
pass('engine gate no longer uses the no-op two-dot diff against the pre-merge HEAD');

assert.match(
  checklist,
  /git diff --cached --exit-code main -- "\$\{PROTECTED_ENGINE_PATHS\[@\]\}"/,
  'checklist must use an executable `git diff --cached --exit-code main` gate',
);
pass('engine gate fails automatically on a staged protected-engine change');

for (const command of [
  'git diff --exit-code -- "${PROTECTED_ENGINE_PATHS[@]}"',
  'git diff --cached --check',
  'git diff --check',
  'git status --short',
]) {
  assert.ok(checklist.includes(command), `checklist must run: ${command}`);
}
pass('engine gate independently fails on unstaged changes and checks malformed diffs');

// Every current live runtime path must still be in the canonical protected set.
for (const path of REQUIRED_ENGINE_PATHS) {
  assert.ok(
    ENGINE_PATHS.includes(path),
    `current live engine path missing from PROTECTED_ENGINE_PATHS: ${path}`,
  );
}
assert.equal(new Set(ENGINE_PATHS).size, ENGINE_PATHS.length, 'protected engine paths must be unique');
pass('the protected set covers the current queue, controller, asset-gate, and verification runtime');

// The ignore gate must name every secret/browser path the findings call out,
// including article-digest.md (previously only in .git/info/exclude).
for (const path of [
  'career_ops_signing_key_private.json',
  '.browser-profiles/',
  '.playwright-mcp/',
  'data/portal-credentials.json',
  'article-digest.md',
]) {
  assert.ok(
    new RegExp(`git check-ignore[\\s\\S]{0,400}?${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(checklist),
    `check-ignore gate must cover ${path}`,
  );
}
pass('check-ignore gate covers every secret, browser-profile, and personal-data path');

// Dependency-aware topic guidance replaces the "collision-free files first" shortcut.
assert.match(checklist, /not safe merely because the fork never touched that path/i);
assert.match(checklist, /is \*\*not\*\* a\s*\nconflict count|not\*\* a conflict count/i);
pass('checklist states that path-level non-collision is not dependency safety');

// ── The commands actually behave as documented ─────────────────────────────
// Prove empirically, in a throwaway repo, that the two-dot form is blind to a
// staged engine change and the --cached form catches it.
const temp = mkdtempSync(join(tmpdir(), 'career-ops-merge-gate-'));
try {
  const git = (...args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'gate@test.invalid');
  git('config', 'user.name', 'Gate Test');
  writeFileSync(join(temp, 'queue-store.mjs'), 'export const original = 1;\n');
  writeFileSync(join(temp, 'lean-application.mjs'), 'export const original = 1;\n');
  writeFileSync(join(temp, 'application-request.mjs'), 'export const original = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');

  // Simulate a resolved-but-uncommitted merge with one staged engine change
  // and a separate, well-formed unstaged engine change.
  writeFileSync(join(temp, 'queue-store.mjs'), 'export const upstreamRewrote = 1;\n');
  git('add', 'queue-store.mjs');
  writeFileSync(join(temp, 'lean-application.mjs'), 'export const unstagedRewrite = 1;\n');

  const twoDot = git('diff', 'main..HEAD', '--', 'queue-store.mjs');
  assert.equal(
    twoDot,
    '',
    'sanity check failed: two-dot diff should be empty pre-commit',
  );
  const stagedGate = spawnSync(
    'git',
    ['diff', '--cached', '--exit-code', 'main', '--', ...ENGINE_PATHS],
    { cwd: temp, encoding: 'utf8' },
  );
  assert.equal(stagedGate.status, 1, 'staged protected-engine rewrite must fail the gate');
  assert.match(stagedGate.stdout, /upstreamRewrote/);

  const unstagedGate = spawnSync(
    'git',
    ['diff', '--exit-code', '--', ...ENGINE_PATHS],
    { cwd: temp, encoding: 'utf8' },
  );
  assert.equal(unstagedGate.status, 1, 'unstaged protected-engine rewrite must fail the gate');
  assert.match(unstagedGate.stdout, /unstagedRewrite/);
  pass('empirically: staged and unstaged protected-engine rewrites both return a failing status');

  // Regression for the original eight-path list: application-request.mjs was
  // introduced by One-shot and used to be omitted entirely.
  git('restore', '--staged', 'queue-store.mjs');
  git('restore', 'queue-store.mjs', 'lean-application.mjs');
  writeFileSync(join(temp, 'application-request.mjs'), 'export const omittedBefore = 1;\n');
  git('add', 'application-request.mjs');
  const expandedGate = spawnSync(
    'git',
    ['diff', '--cached', '--exit-code', 'main', '--', ...ENGINE_PATHS],
    { cwd: temp, encoding: 'utf8' },
  );
  assert.equal(expandedGate.status, 1, 'new controller modules must be protected too');
  assert.match(expandedGate.stdout, /omittedBefore/);
  pass('expanded gate catches a controller-file rewrite omitted by the old eight-path list');
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// ── The paths the gate protects are genuinely ignored right now ────────────
for (const path of [
  'career_ops_signing_key_private.json',
  '.browser-profiles/',
  '.playwright-mcp/',
  'data/portal-credentials.json',
  'article-digest.md',
]) {
  let ignored = true;
  try {
    // --no-index so the tracked .gitignore is what answers, not the index.
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT });
  } catch {
    ignored = false;
  }
  assert.ok(ignored, `${path} is not ignored by the tracked .gitignore`);
}
pass('every gated path is ignored by the tracked .gitignore (not just .git/info/exclude)');
