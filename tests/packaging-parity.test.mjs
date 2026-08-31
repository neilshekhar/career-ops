#!/usr/bin/env node
/**
 * tests/packaging-parity.test.mjs — Finding 5 acceptance tests.
 *
 *  1. The shared voice-dna.md ships as an upstream-updatable system file
 *  3. A newly created article-digest.md is ignored by Git
 *  4. Failed dependency installation causes a nonzero scaffold exit
 *  5. Successful scaffolding runs doctor before printing ready
 *  6. The declared Node floor matches tracker behavior
 *  7. Doctor distinguishes the readiness tiers
 *  8. A fresh profile exposes every supported quality key
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { pass, ROOT } from './helpers.mjs';

console.log('\nPackaging and install parity');

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scaffolderPkg = JSON.parse(readFileSync(join(ROOT, 'scaffolder', 'package.json'), 'utf8'));
const scaffolderSrc = readFileSync(join(ROOT, 'scaffolder', 'bin', 'cli.mjs'), 'utf8');
const doctorSrc = readFileSync(join(ROOT, 'doctor.mjs'), 'utf8');
const trackerSrc = readFileSync(join(ROOT, 'tracker.mjs'), 'utf8');
const interviewMode = readFileSync(join(ROOT, 'modes', 'interview.md'), 'utf8');

// ── 2. The postinstall fallback is genuinely different ─────────────────────
const postinstall = String(rootPkg.scripts?.postinstall || '');
assert.ok(!/(.+?)\s*\|\|\s*\1/.test(postinstall.trim()),
  `postinstall still retries the identical command: ${postinstall}`);
assert.equal(postinstall, 'node install-browser.mjs');
pass('postinstall no longer retries the identical command on both sides of ||');

const installer = readFileSync(join(ROOT, 'install-browser.mjs'), 'utf8');
const withDeps = installer.indexOf("'--with-deps'");
const withoutDeps = installer.indexOf("args: ['playwright', 'install', 'chromium'],");
assert.ok(withDeps > 0 && withoutDeps > withDeps,
  'the fallback must drop --with-deps, which is the step that needs root on Linux');
// Chromium is optional (PDF + browser liveness only), so a failure must not
// break `npm install` for users who only scan and evaluate.
assert.match(installer, /process\.exit\(0\)/);
assert.doesNotMatch(installer, /process\.exit\(1\)/);
assert.match(installer, /npx playwright install chromium/);
pass('the Chromium installer has a real fallback, stays non-fatal, and prints recovery steps');

// ── 4 + 5. Scaffolder fails closed and verifies before claiming success ────
assert.match(scaffolderSrc, /npm install failed in \$\{display\}/,
  'a failed npm install must call die(), not warn and continue');
const warnIdx = scaffolderSrc.indexOf('you can re-run it manually later with "npm install"');
assert.equal(warnIdx, -1, 'the old warn-and-continue path must be gone');

const dieIdx = scaffolderSrc.indexOf('npm install failed in ${display}');
const doctorIdx = scaffolderSrc.indexOf("['doctor.mjs', '--setup']".replace(/'/g, '"'))
  >= 0 ? scaffolderSrc.indexOf('doctor.mjs') : scaffolderSrc.indexOf('doctor.mjs');
const readyIdx = scaffolderSrc.indexOf('career-ops is ready in');
assert.ok(dieIdx > 0 && doctorIdx > dieIdx && readyIdx > doctorIdx,
  'order must be: install (fail closed) -> doctor -> "ready"');
pass('acceptance 4+5: install failure exits nonzero, and doctor runs before "ready" is printed');

assert.match(scaffolderSrc, /doctor\.mjs["'],\s*["']--setup/,
  'the scaffolder must use --setup so onboarding files are not demanded on a fresh clone');
pass('the scaffolder verifies the core tier only, so onboarding is still agent-guided');

// ── 6. The Node floor is declared and consistent ───────────────────────────
assert.ok(rootPkg.engines?.node, 'the ROOT package.json must declare an engines.node floor');
assert.equal(rootPkg.engines.node, scaffolderPkg.engines.node,
  'the root and scaffolder engine floors must agree');
pass(`acceptance 6: both packages declare the same Node floor (${rootPkg.engines.node})`);

// tracker.mjs must NOT terminate when node:sqlite is missing: the index is an
// optimization and data/applications.md is the source of truth.
const loaderStart = trackerSrc.indexOf('async function loadSqlite()');
const loaderEnd = trackerSrc.indexOf('function openDb(');
const loaderBody = trackerSrc.slice(loaderStart, loaderEnd);
assert.ok(loaderStart > 0 && loaderEnd > loaderStart);
assert.doesNotMatch(loaderBody, /process\.exit/,
  'loadSqlite must degrade to null, never process.exit — the markdown tracker still works');
assert.match(loaderBody, /return null;/);
// Every command must route through the null-tolerant opener.
assert.doesNotMatch(
  trackerSrc.slice(loaderEnd),
  /const DatabaseSync = await loadSqlite\(\);/,
  'no command may call loadSqlite() directly any more; use openIndexOrNull()',
);
const openerCalls = (trackerSrc.match(/await openIndexOrNull\(\)/g) || []).length;
assert.ok(openerCalls >= 5, `expected every command to use the null-tolerant opener, saw ${openerCalls}`);
pass('the SQLite index is genuinely optional: no command exits when node:sqlite is absent');

// And prove the markdown fallback really produces the right rows, by stubbing
// node:sqlite away with a loader hook and running the real CLI.
const temp = mkdtempSync(join(tmpdir(), 'career-ops-pkg-'));
try {
  const mdPath = join(temp, 'applications.md');
  writeFileSync(mdPath, [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-07-01 | Alpha Co | Data Scientist | 4.5/5 | Applied | ✅ | — | first |',
    '| 2 | 2026-07-15 | Beta Ltd | Data Analyst | 4.1/5 | Evaluated | ❌ | — | second |',
    '| 3 | 2026-07-20 | Alpha Co | ML Engineer | 3.9/5 | Rejected | ❌ | — | third |',
    '',
  ].join('\n'), 'utf8');

  // A loader hook that makes `node:sqlite` unresolvable, simulating Node 18.
  const hookPath = join(temp, 'no-sqlite-hook.mjs');
  writeFileSync(hookPath, `
export async function resolve(specifier, context, next) {
  if (specifier === 'node:sqlite') {
    throw Object.assign(new Error('stubbed: node:sqlite unavailable'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
  }
  return next(specifier, context);
}
`, 'utf8');

  const runTracker = (args) => spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register(pathToFileURL(${JSON.stringify(hookPath)}).href,pathToFileURL("./"));`,
      join(ROOT, 'tracker.mjs'), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_TRACKER: mdPath, CAREER_OPS_TRACKER_DB: join(temp, 'index.db') },
      encoding: 'utf8',
    },
  );

  const queried = runTracker(['query', '--company', 'Alpha', '--json']);
  assert.equal(queried.status, 0,
    `query must succeed without node:sqlite.\nstdout: ${queried.stdout}\nstderr: ${queried.stderr}`);
  assert.match(queried.stderr, /node:sqlite is unavailable/,
    'the fallback must say why it read the markdown directly');
  const rows = JSON.parse(queried.stdout);
  assert.equal(rows.length, 2, `expected both Alpha Co rows, got ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((row) => row.id), [3, 1], 'fallback must sort by id DESC like the SQL path');
  assert.equal(rows[1].company, 'Alpha Co');
  pass('without node:sqlite, `tracker query` reads the markdown and returns correctly filtered rows');

  const filtered = runTracker(['query', '--status', 'Applied', '--json']);
  assert.equal(filtered.status, 0);
  const appliedRows = JSON.parse(filtered.stdout);
  assert.deepEqual(appliedRows.map((row) => row.id), [1]);
  pass('the markdown fallback honours --status with canonical normalization');

  const since = runTracker(['query', '--since', '2026-07-15', '--json']);
  assert.equal(since.status, 0);
  assert.deepEqual(JSON.parse(since.stdout).map((row) => row.id), [3, 2]);
  pass('the markdown fallback honours --since inclusively, matching the SQL semantics');

  const limited = runTracker(['query', '--limit', '1', '--json']);
  assert.equal(limited.status, 0);
  assert.equal(JSON.parse(limited.stdout).length, 1);
  pass('the markdown fallback honours --limit');

  const synced = runTracker(['sync']);
  assert.equal(synced.status, 0, `sync must not fail without node:sqlite: ${synced.stderr}`);
  assert.match(synced.stderr, /index not written/);
  pass('`tracker sync` reports the skipped index and exits 0 instead of dying');

  const exported = runTracker(['export']);
  assert.equal(exported.status, 0, `export must not fail without node:sqlite: ${exported.stderr}`);
  assert.match(exported.stdout, /\| 1 \| 2026-07-01 \| Alpha Co \|/);
  pass('`tracker export` regenerates the canonical table from the markdown');

  const hist = runTracker(['history', '--id', '1']);
  assert.equal(hist.status, 0);
  assert.match(hist.stdout, /#1 Alpha Co — Data Scientist/);
  assert.match(hist.stdout, /current state only/);
  pass('`tracker history` reports the current state truthfully rather than faking a timeline');

  const deleted = runTracker(['delete', '--num', '2']);
  assert.equal(deleted.status, 0,
    `delete must still succeed without node:sqlite: ${deleted.stderr}`);
  assert.match(deleted.stderr, /Removed application 2 \(1 row\) from .*applications\.md\./);
  assert.doesNotMatch(deleted.stderr, /and reindexed/,
    'delete must not claim it rebuilt an index when node:sqlite was unavailable');
  assert.doesNotMatch(readFileSync(mdPath, 'utf8'), /^\| 2 \|/m,
    'the markdown row itself must still be removed');
  pass('`tracker delete` removes the row without falsely claiming it reindexed');

  // Sanity: the hook really did remove node:sqlite, so the above proves the
  // fallback and not just a working index.
  const probe = spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register(pathToFileURL(${JSON.stringify(hookPath)}).href,pathToFileURL("./"));`,
      '-e', "import('node:sqlite').then(()=>console.log('AVAILABLE'),()=>console.log('BLOCKED'))"],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.match(probe.stdout, /BLOCKED/, 'the loader hook must actually block node:sqlite');
  pass('the test genuinely ran with node:sqlite unavailable');
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// ── 7. Doctor readiness tiers ──────────────────────────────────────────────
const { READINESS_TIERS, declaredNodeFloor } = await import('../doctor.mjs');
for (const tier of ['core', 'evaluation', 'localBrowser', 'scan', 'liveApply', 'docx']) {
  assert.ok(READINESS_TIERS[tier], `doctor must declare the ${tier} readiness tier`);
}
pass('acceptance 7: doctor separates local Chromium, scan, live-apply, and DOCX readiness');

assert.equal(declaredNodeFloor(ROOT), 18,
  'the runtime Node check must read the declared floor from package.json, not hardcode it');
pass('the Node check derives its floor from package.json so they cannot drift');

// A config reference is only a setup signal. Doctor cannot invoke agent-owned
// MCP tools, so it must not claim that it capability-probed the controller.
assert.match(doctorSrc, /function checkBrowserController/);
assert.match(doctorSrc, /BROWSER_CONTROLLER_SETUP/);
assert.match(doctorSrc, /function playwrightMcpConfigReferenced/);
assert.match(doctorSrc, /explicitly NOT an MCP capability probe/);
assert.match(doctorSrc, /Live browser-controller capability not verified by doctor/);
assert.doesNotMatch(doctorSrc, /Live-apply browser controller: MCP server configured/);
assert.doesNotMatch(doctorSrc, /writeFileSync\([^)]*mcp\.json/i,
  'doctor must never write into a user CLI/MCP config');
assert.doesNotMatch(doctorSrc, /mcpServers["']\s*\]\s*=/, 'doctor must never mutate an MCP config');
pass('acceptance: doctor labels MCP state as unverified and never auto-registers it');

// Browser-backed scan/liveness is available without MCP only through the
// explicitly selected CLI extractor and a Chromium launch that actually worked.
assert.match(
  doctorSrc,
  /without MCP when `scan\.extractor: cli` and local Chromium are available/,
);
assert.match(doctorSrc, /ATS API scanning remains available without MCP/);
pass('doctor states the exact no-MCP boundary for ATS APIs and CLI browser extraction');

// Every supported CLI gets a setup hint.
for (const cmd of ['claude', 'cursor', 'codex', 'opencode', 'gemini', 'qwen', 'kimi', 'copilot', 'agy', 'grok']) {
  assert.ok(
    new RegExp(`cmd: '${cmd}'`).test(doctorSrc),
    `doctor is missing a browser-controller setup hint for ${cmd}`,
  );
}
pass('all ten supported CLIs have a browser-controller setup hint');

// DOCX: warning normally, hard failure only when the profile requires it.
assert.match(doctorSrc, /function checkDocx/);
assert.match(doctorSrc, /DOCX is required by config\/profile\.yml but pandoc is not installed/);
pass('DOCX is a warning unless the profile actually requires it, then a clear failure');

// `--setup` must not demand the onboarding files.
assert.match(doctorSrc, /SETUP_ONLY \? \[\] : USER_LAYER_PREREQS\.map\(checkPrereq\)/);
pass('doctor --setup skips the onboarding prerequisites the scaffolder deliberately leaves absent');

// ── 1 + 3. Shared voice policy, personal digest ────────────────────────────
const trackedVoice = execFileSync('git', ['ls-files', 'voice-dna.md'], { cwd: ROOT, encoding: 'utf8' }).trim();
assert.equal(trackedVoice, 'voice-dna.md', 'voice-dna.md must ship as the shared writing baseline');
assert.equal(existsSync(join(ROOT, 'voice-dna.template.md')), false,
  'a second voice-dna.template.md would create a conflicting ownership model');
assert.doesNotMatch(doctorSrc, /target: 'voice-dna\.md', template: 'voice-dna\.template\.md'/,
  'doctor must not copy a private voice file over the shared baseline');
const dataContract = readFileSync(join(ROOT, 'DATA_CONTRACT.md'), 'utf8');
assert.doesNotMatch(dataContract, /`voice-dna\.md` \| Your private voice\/style rules/);
assert.match(dataContract, /`voice-dna\.md` \| \*\*Opinionated shared writing default\*\*/);
const updaterSrc = readFileSync(join(ROOT, 'update-system.mjs'), 'utf8');
const systemManifest = (updaterSrc.match(/const SYSTEM_PATHS = \[([\s\S]*?)\];/) || [, ''])[1];
const userManifest = (updaterSrc.match(/const USER_PATHS = \[([\s\S]*?)\];/) || [, ''])[1];
assert.match(systemManifest, /'voice-dna\.md'/);
assert.doesNotMatch(systemManifest, /'voice-dna\.template\.md'/);
assert.doesNotMatch(userManifest, /'voice-dna\.md'/);
assert.doesNotMatch(updaterSrc, /filter\(\(path\) => path !== 'voice-dna\.md'\)/);
pass('acceptance 1: shared voice DNA is tracked and updateable without a conflicting private template');

const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
assert.doesNotMatch(gitignore, /^voice-dna\.md$/m,
  'the tracked shared voice baseline must not be classified as ignored user data');
assert.match(gitignore, /^article-digest\.md$/m,
  'article-digest.md must be in the TRACKED .gitignore, not just .git/info/exclude');
pass('acceptance 3: article-digest.md is ignored by the tracked .gitignore a fresh clone inherits');

// ── 10–13. Optional article-digest onboarding is explicit and safe ─────────
for (const choice of ['Import:', 'Build:', 'Skip:']) {
  assert.ok(interviewMode.includes(choice), `interview mode must offer the ${choice.slice(0, -1)} branch`);
}
assert.match(interviewMode, /onboarding\.article_digest_onboarding/);
assert.match(interviewMode, /already `provided` or\s*`skipped`, \*\*do not offer this choice again\*\*/);
assert.match(interviewMode, /article_digest_onboarding: provided # or skipped/);
pass('acceptance 10–11: interview onboarding offers import/build/skip once and persists provided/skipped');

assert.match(interviewMode, /Skip:[\s\S]{0,180}create no digest and spend no generation turn/);
assert.match(interviewMode, /Skipping never\s*blocks onboarding, evaluation, PREPARE, or applying/);
assert.match(interviewMode, /\*\*Optionally update `article-digest\.md`\*\*/);
pass('skip is token-free and non-blocking; article-digest.md is an optional interview output');

for (const rule of [
  /confirming every metric,\s*project, and authorship claim/,
  /Never\s*infer authorship from tool use/,
  /Never add\s*sample or placeholder claims/,
]) {
  assert.match(interviewMode, rule);
}
pass('acceptance 12–13: digest creation is source-confirmed and forbids inferred authorship/placeholders');

// ── 8. Every supported quality key is exposed in the example profile ───────
const exampleProfile = yaml.load(readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf8')) || {};
const exampleQuality = exampleProfile.application_quality || {};
for (const key of [
  'cv_max_pages', 'cover_max_pages', 'cover_body_words_min', 'cover_body_words_max',
  'cover_allow_bullets', 'cover_required_formats', 'banned_punctuation',
  'banned_terms_allow', 'banned_terms_add', 'require_banned_term_check',
  'require_role_tailored_cv',
]) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(exampleQuality, key),
    `config/profile.example.yml must expose application_quality.${key}`,
  );
}
pass('acceptance 8: the example profile exposes every supported quality key');

// The shared greeting/sign-off default must be ON for a fresh install — that is
// the whole point of the "shared product default" decision.
assert.ok(exampleProfile.cover, 'the example profile must expose a cover: block');
assert.equal(exampleProfile.cover.greeting_required, true);
assert.equal(exampleProfile.cover.signoff_required, true);
pass('greeting and sign-off are shared product defaults, enabled for every new install');

assert.equal(exampleQuality.require_role_tailored_cv, true,
  'a fresh install must fail closed when materially different roles reuse a CV without valid evidence');
assert.equal(exampleQuality.require_banned_term_check, true,
  'a fresh install must deterministically enforce the shared banned-term policy');
pass('fresh installs fail closed on unexplained CV reuse and configured banned vocabulary');

// Work-rights answers are factual personal data: never pre-filled with a guess.
const location = exampleProfile.location || {};
for (const key of ['visa_form_answer_fulltime', 'visa_form_answer_parttime']) {
  assert.ok(
    !location[key],
    `config/profile.example.yml must not ship a guessed work-rights answer (${key})`,
  );
}
pass('work-rights answers are left for onboarding, never pre-filled with a generic value');

// ---------------------------------------------------------------------------
// Playwright's engine floor must degrade a tier, never kill the process.
//
// Playwright >= 1.62 hard-exits at import time when Node is below its own
// engines.node floor. A hard exit inside a dependency cannot be caught, so
// checkPlaywright()'s try/catch is not enough — doctor has to refuse the import
// outright rather than attempt it. This is
// what the Node 18 minimum-version CI leg exercises for real; here we simulate a
// below-floor runtime by pointing --target at a root whose installed Playwright
// claims an unreachable floor, so the check fires on any Node version.
const floorTemp = mkdtempSync(join(tmpdir(), 'career-ops-pw-floor-'));
try {
  mkdirSync(join(floorTemp, 'node_modules', 'playwright'), { recursive: true });
  writeFileSync(
    join(floorTemp, 'node_modules', 'playwright', 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.62.0', engines: { node: '>=999' } }),
  );

  // --json emits only the onboarding contract, so assert against the readiness
  // report doctor prints by default — that is where the tier labels live.
  const probe = spawnSync(process.execPath, [join(ROOT, 'doctor.mjs'), '--target', floorTemp], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  // The run must survive: a hard exit from the dependency would truncate the
  // report, which is precisely the CI failure this guard prevents.
  assert.ok(probe.stdout.trim(), `doctor produced no output: ${probe.stderr}`);
  assert.match(
    probe.stdout,
    /Local Chromium unavailable \(Playwright needs Node >= 999/,
    'doctor must report the unmet Playwright engine floor as a degraded local-browser tier',
  );
  assert.doesNotMatch(
    probe.stderr,
    /Please update your version of Node\.js/,
    'doctor must not reach Playwright\'s own import-time version bail-out',
  );
  pass('an unmet Playwright engine floor degrades the local-browser tier instead of killing doctor');
} finally {
  rmSync(floorTemp, { recursive: true, force: true });
}
