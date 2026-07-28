#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { delimiter, join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { discoverPlugins, pluginRoots, pluginStatus } from './plugins/_engine.mjs';
import { resolveExtractorMode } from './browser-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const projectRoot =
  targetIdx !== -1 && argv[targetIdx + 1] ? argv[targetIdx + 1] : __dirname;
const JSON_OUT = argv.includes('--json');
// --strict adds a live ATS-slug probe of portals.yml (network). Opt-in so the
// default `npm run doctor` stays fast and fully offline.
const STRICT = argv.includes('--strict');
// --setup checks only the CORE RUNTIME tier. The scaffolder uses it to verify a
// fresh clone before claiming success, WITHOUT demanding the four user-layer
// files whose absence is exactly what triggers conversational onboarding.
const SETUP_ONLY = argv.includes('--setup');

/**
 * Readiness tiers (Finding 5 #4).
 *
 * `core` is the only tier that can fail a fresh install. Everything else is a
 * capability: absent means "that feature is unavailable", not "setup is broken".
 * A user who never runs a live application should never be blocked by a missing
 * browser controller.
 */
export const READINESS_TIERS = Object.freeze({
  core: 'Core runtime (required)',
  onboarding: 'Onboarding data (agent-guided)',
  evaluation: 'Local evaluation',
  localBrowser: 'Local Chromium (PDF / CLI extraction / liveness fallback)',
  scan: 'Scan / JD extraction',
  liveApply: 'Live-apply browser controller',
  docx: 'DOCX cover letters',
});

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

// Is `cmd` resolvable on PATH? Manual lookup so it works cross-platform without
// spawning which/where, and without any dependency.
function onPath(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, cmd + ext))) return true;
      } catch { /* unreadable PATH entry — keep looking */ }
    }
  }
  return false;
}

/**
 * The declared engine floor, read from the root package.json so the runtime
 * check and the published contract can never disagree.
 */
export function declaredNodeFloor(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const range = String(pkg?.engines?.node || '');
    const match = range.match(/(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  const floor = declaredNodeFloor(projectRoot) ?? 18;
  if (major >= floor) {
    return { pass: true, tier: 'core', label: `Node.js >= ${floor} (v${process.versions.node})` };
  }

  return {
    pass: false,
    tier: 'core',
    label: `Node.js >= ${floor} (found v${process.versions.node})`,
    fix: `Install Node.js ${floor} or later from https://nodejs.org`,
  };
}

/**
 * The SQLite tracker index is an optimization, not the product.
 *
 * `node:sqlite` only exists on newer Node, but the markdown tracker works
 * everywhere. Raising the engine floor to keep the index would break installs on
 * the LTS most of the npm audience runs — and low-friction install is this
 * package's whole value. So: report it as available-or-not, never as a failure.
 */
async function checkSqliteIndex() {
  const origEmit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    await import('node:sqlite');
    return { pass: true, tier: 'evaluation', label: 'Tracker SQLite index available (optional)' };
  } catch {
    return {
      warn: true,
      tier: 'evaluation',
      label: `Tracker SQLite index unavailable on v${process.versions.node} (optional — the markdown tracker works)`,
      fix: [
        'The fast `node tracker.mjs` index needs node:sqlite (Node 22.5+ without a flag).',
        'Everything still works from data/applications.md; only the index is skipped.',
      ],
    };
  } finally {
    process.emitWarning = origEmit;
  }
}

/**
 * DOCX readiness. Pandoc absence is only a real problem when the profile
 * actually requires or prefers DOCX for portal uploads — then PREPARE would fail
 * later, so surface it now.
 */
function checkDocx(root) {
  const available = onPath('pandoc');
  let required = false;
  try {
    const profilePath = join(root, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      const profile = yaml.load(readFileSync(profilePath, 'utf8')) || {};
      const formats = profile?.application_quality?.cover_required_formats;
      required = Array.isArray(formats) && formats.map(String).includes('docx');
    }
  } catch { /* malformed profile is reported by its own check */ }

  if (available) {
    return { pass: true, tier: 'docx', label: 'DOCX cover letters available (pandoc found)' };
  }
  if (required) {
    return {
      pass: false,
      tier: 'docx',
      label: 'DOCX is required by config/profile.yml but pandoc is not installed',
      fix: [
        'application_quality.cover_required_formats includes "docx", so PREPARE will fail.',
        'Install pandoc (https://pandoc.org/installing.html), or remove "docx" from that list.',
      ],
    };
  }
  return {
    warn: true,
    tier: 'docx',
    label: 'DOCX cover letters unavailable (pandoc not installed — optional)',
    fix: [
      'DOCX out-parses PDF on Workday, Greenhouse, Lever, iCIMS and Taleo, and some',
      'AU government / university portals require it. Install pandoc to enable it:',
      'https://pandoc.org/installing.html',
    ],
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, tier: 'core', label: 'Dependencies installed' };
  }
  return {
    pass: false,
    tier: 'core',
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return {
      warn: true,
      tier: 'localBrowser',
      label: 'Local Chromium unavailable (Playwright package is not installed)',
      fix: [
        'Run `npm install`, then `npx playwright install chromium`.',
        'PDF rendering, CLI extraction, and non-ATS liveness fallback are unavailable until then.',
      ],
    };
  }
  // Validate by launching — chromium.executablePath() points at Chrome for Testing
  // (full binary) but chromium.launch() may use the headless-shell binary, which
  // lives at a different path and requires a separate install. Launching directly
  // tests the exact binary the runtime uses and catches stub-installs (directory
  // present but no binary — just ABOUT + LICENSE files).
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return {
      pass: true,
      tier: 'localBrowser',
      label: 'Local Chromium launch succeeded (PDF / CLI extraction / liveness fallback)',
    };
  } catch {
    return {
      warn: true,
      tier: 'localBrowser',
      label: 'Local Chromium launch failed (PDF / CLI extraction / liveness fallback unavailable)',
      fix: 'Run: npx playwright install chromium',
    };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

// Doctor can launch local Chromium, but it cannot invoke tools owned by the
// active agent CLI. Reading a config file is therefore only evidence that a
// Playwright MCP server was REFERENCED, never proof that `browser_navigate` /
// `browser_snapshot` are installed, connected, or callable in this session.
const LIVE_BROWSER_UNVERIFIED = 'Live browser-controller capability not verified by doctor';

function playwrightMcpConfigReferenced(root) {
  const configFiles = [
    '.mcp.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.cursor/mcp.json',
  ];
  for (const rel of configFiles) {
    const file = join(root, ...rel.split('/'));
    if (!existsSync(file)) continue;
    try {
      const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const server of Object.values(servers)) {
          if (JSON.stringify(server ?? '').toLowerCase().includes('playwright')) return true;
        }
      }
    } catch {
      // Malformed config — keep scanning the other locations; never crash doctor on it.
    }
  }
  return false;
}

// Report which scan/JD extractor is active (config/profile.yml → scan.extractor).
// `mcp` (default) uses browser tools owned by the active CLI; doctor cannot
// capability-test those tools. `cli` uses browser-extract.mjs and is ready only
// when the helper exists AND the local Chromium launch above succeeded.
function checkScanExtractor(root, chromiumUsable) {
  const mode = resolveExtractorMode(join(root, 'config', 'profile.yml'));
  if (mode === 'cli') {
    if (!existsSync(join(root, 'browser-extract.mjs'))) {
      return {
        warn: true,
        tier: 'scan',
        label: 'Scan extractor: CLI selected, but browser-extract.mjs is missing',
        fix: [
          'Restore browser-extract.mjs, or set `scan.extractor: mcp` in config/profile.yml.',
          'The MCP fallback is usable only if the active CLI exposes its browser tools.',
        ],
      };
    }
    if (chromiumUsable) {
      return {
        pass: true,
        tier: 'scan',
        label: 'Scan extractor: CLI helper ready (local Chromium launch verified)',
      };
    }
    return {
      warn: true,
      tier: 'scan',
      label: 'Scan extractor: CLI selected, but local Chromium is unavailable',
      fix: [
        'Run `npx playwright install chromium` to enable browser-extract.mjs.',
        'ATS API scanning still works; browser-backed boards and JD extraction need Chromium or active MCP tools.',
      ],
    };
  }
  const configReference = playwrightMcpConfigReferenced(root);
  return {
    warn: true,
    tier: 'scan',
    label: configReference
      ? 'Scan extractor: MCP selected; project config reference found, capability not verified'
      : 'Scan extractor: MCP selected; active CLI browser tools not verified',
    fix: [
      'Doctor cannot invoke MCP tools. Confirm `browser_navigate` and `browser_snapshot`',
      'are available in the active CLI before relying on browser-backed boards or JD extraction.',
      'ATS API scanning remains available without MCP.',
    ],
  };
}

// Per-CLI setup for the browser controller that live apply drives. career-ops
// never writes into a user's CLI config — that is invasive across supported
// CLIs, and the absence of a PROJECT `.mcp.json` does not prove the
// user lacks a GLOBAL one. We only report observable configuration/PATH signals
// and print setup hints; this is explicitly NOT an MCP capability probe.
const BROWSER_CONTROLLER_SETUP = [
  { cmd: 'claude', name: 'Claude Code', hint: 'claude mcp add playwright -- npx -y @playwright/mcp@latest' },
  { cmd: 'cursor', name: 'Cursor', hint: 'add a `playwright` server in Cursor Settings > Tools & MCP (project scope: .cursor/mcp.json)' },
  { cmd: 'codex', name: 'Codex', hint: 'codex mcp add playwright -- npx -y @playwright/mcp@latest' },
  { cmd: 'opencode', name: 'OpenCode', hint: 'add a `playwright` entry to your opencode.json `mcp` block' },
  { cmd: 'gemini', name: 'Gemini CLI', hint: 'add a `playwright` entry to ~/.gemini/settings.json `mcpServers`' },
  { cmd: 'qwen', name: 'Qwen Code', hint: 'add a `playwright` entry to your Qwen settings `mcpServers`' },
  { cmd: 'kimi', name: 'Kimi', hint: 'add a `playwright` entry to your Kimi MCP configuration' },
  { cmd: 'copilot', name: 'GitHub Copilot CLI', hint: 'add a `playwright` entry to your Copilot CLI MCP config' },
  { cmd: 'agy', name: 'Antigravity CLI', hint: 'add a `playwright` entry to your Antigravity MCP config' },
  { cmd: 'grok', name: 'Grok Build CLI', hint: 'add a `playwright` entry to your Grok Build MCP config' },
];

/**
 * Report live-apply browser-controller readiness without overstating it.
 *
 * A project config reference and an installed CLI are setup hints only. Local
 * Chromium is a separate capability and is NOT evidence that the active CLI can
 * drive the shared live-application tab. The apply contract verifies the actual
 * browser tools at execution time.
 */
function checkBrowserController(root) {
  const configReference = playwrightMcpConfigReferenced(root);
  const detected = BROWSER_CONTROLLER_SETUP.filter((entry) => onPath(entry.cmd));
  const setupLines = detected.length
    ? detected.map((entry) => `${entry.name}:  ${entry.hint}`)
    : ['No supported CLI detected on PATH yet. Install one, then re-run `npm run doctor`.'];
  return {
    warn: true,
    tier: 'liveApply',
    label: configReference
      ? `${LIVE_BROWSER_UNVERIFIED} (project MCP config reference found)`
      : `${LIVE_BROWSER_UNVERIFIED} (no project MCP config reference found)`,
    fix: [
      configReference
        ? 'A readable config entry does not prove the server started or its tools are callable.'
        : 'A global MCP configuration may still exist; doctor cannot inspect the active CLI session.',
      'Before live apply, confirm `browser_navigate` and `browser_snapshot` are available.',
      'Setup hint for each detected CLI:',
      ...setupLines,
      'Scanning, JD extraction, and liveness checks keep working without MCP when `scan.extractor: cli` and local Chromium are available.',
    ],
  };
}

// Single source of truth for the four user-layer prerequisites (the list
// AGENTS.md "First Run" documents). BOTH the human checklist (`checkPrereq`)
// and the machine-readable cold-start state (`onboardingState`) derive from
// THIS array, so they cannot drift. Paths use "/" and are split for join().
const USER_LAYER_PREREQS = [
  {
    path: 'cv.md',
    fix: [
      'Create cv.md in the project root with your CV in markdown',
      'See examples/ for reference CVs',
    ],
  },
  {
    path: 'config/profile.yml',
    fix: [
      'Run: cp config/profile.example.yml config/profile.yml',
      'Then edit it with your details',
    ],
  },
  {
    path: 'modes/_profile.md',
    fix: [
      'Run: cp modes/_profile.template.md modes/_profile.md',
      'Then customize your archetypes / targeting narrative',
    ],
  },
  {
    path: 'portals.yml',
    fix: [
      'Run: cp templates/portals.example.yml portals.yml',
      'Then customize with your target companies',
    ],
  },
];

function prereqPresent(root, path) {
  return existsSync(join(root, ...path.split('/')));
}

function checkPrereq({ path, fix }) {
  if (prereqPresent(projectRoot, path)) {
    return { pass: true, tier: 'onboarding', label: `${path} found` };
  }
  return { pass: false, tier: 'onboarding', label: `${path} not found`, fix };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      tier: 'core',
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        tier: 'core',
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      tier: 'core',
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, tier: 'core', label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, tier: 'core', label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, tier: 'core', label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      tier: 'core',
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

// --strict only: probe the ATS slug of every tracked company in portals.yml so
// a typo'd slug (which 404s silently on scans) surfaces here. Skipped gracefully
// when portals.yml is absent. Delegates to verify-portals.mjs so there is one
// slug-probing implementation. Network-bound, hence opt-in.
async function checkPortalSlugs(root) {
  const portalsPath = join(root, 'portals.yml');
  if (!existsSync(portalsPath)) {
    return { pass: true, label: 'ATS slugs: no portals.yml yet (skipped)' };
  }
  try {
    const { verifyPortalsFile } = await import('./verify-portals.mjs');
    const { results } = await verifyPortalsFile(portalsPath);
    const unresolved = results.filter((r) => r.status === 'missing');
    if (unresolved.length === 0) {
      return { pass: true, label: 'All ATS slugs in portals.yml resolve' };
    }
    return {
      pass: false,
      label: `${unresolved.length} ATS slug(s) in portals.yml do not resolve`,
      fix: [
        ...unresolved.map((r) => {
          let line = `${r.name}: ${r.ats || '?'}/${r.slug || '?'} — ${r.reason || 'unresolved'}`;
          if (r.suggested) line += ` → try ${r.suggested.ats}/${r.suggested.slug}`;
          return line;
        }),
        'Probe variants with: node verify-portals.mjs --add "<company>"',
      ],
    };
  } catch (err) {
    return { warn: true, label: `ATS slug check skipped: ${err.message}` };
  }
}

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

function checkPipelineFile() {
  const filePath = join(projectRoot, 'data', 'pipeline.md');
  if (existsSync(filePath)) {
    return { pass: true, tier: 'core', label: 'data/pipeline.md ready' };
  }
  try {
    writeFileSync(filePath, PIPELINE_SKELETON, 'utf-8');
    return { pass: true, tier: 'core', label: 'data/pipeline.md ready (auto-created)' };
  } catch {
    return {
      pass: false,
      tier: 'core',
      label: 'data/pipeline.md could not be created',
      fix: 'Run: mkdir -p data && touch data/pipeline.md',
    };
  }
}

// Discover plugins + their non-secret config block, synchronously. Used by both
// the human check and the --json onboarding state.
function readPluginConfigSync(root) {
  const cfgPath = join(root, 'config', 'plugins.yml');
  if (!existsSync(cfgPath)) return {};
  try { return yaml.load(readFileSync(cfgPath, 'utf8')) || {}; } catch { return {}; }
}

// Plugin layer health: list discovered plugins + whether each enabled one's keys
// are present. WARN-not-FAIL so a half-configured plugin never blocks setup.
function checkPlugins(root) {
  let manifests;
  try { manifests = discoverPlugins(pluginRoots(root)); } catch { return { pass: true, label: 'Plugins: none' }; }
  if (manifests.length === 0) return { pass: true, label: 'Plugins: none installed' };
  const cfg = readPluginConfigSync(root);
  const lines = [];
  const fixes = [];
  for (const m of manifests) {
    const s = pluginStatus(m, cfg);
    lines.push(`${m.id} (${s.enabled ? 'enabled' : s.configured ? `missing ${s.missingEnv.join(', ')}` : 'off'})`);
    if (s.configured && s.missingEnv.length) fixes.push(`${m.id}: add ${s.missingEnv.join(', ')} to .env`);
  }
  const label = `Plugins: ${lines.join(', ')}`;
  return fixes.length ? { warn: true, label, fix: fixes } : { pass: true, label };
}

async function main() {
  console.log('\ncareer-ops doctor');
  console.log('================\n');

  const chromium = await checkPlaywright();
  const chromiumUsable = chromium.pass === true;

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    checkFonts(),
    checkAutoDir('data'),
    checkPipelineFile(),
    checkAutoDir('output'),
    checkAutoDir('reports'),
    ...(SETUP_ONLY ? [] : USER_LAYER_PREREQS.map(checkPrereq)),
    chromium,
    await checkSqliteIndex(),
    checkScanExtractor(projectRoot, chromiumUsable),
    checkBrowserController(projectRoot),
    checkDocx(projectRoot),
    checkPlugins(projectRoot),
  ];

  // Network-bound ATS slug probe — only under --strict.
  if (STRICT && !SETUP_ONLY) {
    checks.push(await checkPortalSlugs(projectRoot));
  }

  let blocking = 0;
  let advisory = 0;
  let warnings = 0;

  const printCheck = (result) => {
    const fixes = Array.isArray(result.fix) ? result.fix : result.fix ? [result.fix] : [];
    if (result.warn) {
      warnings++;
      console.log(`${yellow('⚠')} ${result.label}`);
    } else if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
      return;
    } else {
      // Only the core tier can block. Everything else is a capability gap: the
      // feature is unavailable, but career-ops is not broken.
      if (result.tier === 'core') blocking++;
      else advisory++;
      console.log(`${red('✗')} ${result.label}`);
    }
    for (const hint of fixes) console.log(`  ${dim('→ ' + hint)}`);
  };

  // Group by readiness tier so a user can see at a glance which capabilities
  // they have, instead of one flat list where a missing pandoc looks as fatal as
  // a missing node_modules.
  for (const [tier, heading] of Object.entries(READINESS_TIERS)) {
    const group = checks.filter((result) => (result.tier ?? 'core') === tier);
    if (group.length === 0) continue;
    console.log(dim(`${heading}`));
    for (const result of group) printCheck(result);
    console.log('');
  }
  const untagged = checks.filter((result) => !Object.keys(READINESS_TIERS).includes(result.tier ?? 'core'));
  for (const result of untagged) printCheck(result);

  if (blocking > 0) {
    console.log(`Result: ${blocking} blocking issue${blocking === 1 ? '' : 's'} in the core runtime. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  }
  if (advisory > 0 && !SETUP_ONLY) {
    console.log(`Result: core runtime is fine, but ${advisory} item${advisory === 1 ? '' : 's'} above still need${advisory === 1 ? 's' : ''} attention before the matching feature works.`);
    process.exit(1);
  }
  const warnNote = warnings > 0 ? ` (${warnings} optional capability warning${warnings === 1 ? '' : 's'} — see above)` : '';
  if (SETUP_ONLY) {
    console.log(`Result: core runtime is ready${warnNote}.`);
    process.exit(0);
  }
  console.log(`Result: All checks passed${warnNote}. You're ready to go! Start career-ops from any supported AI coding CLI.`);
  console.log('');
  console.log('Join the community: https://discord.gg/8pRpHETxa4');
  console.log('Read the manifesto: `npm run manifesto` — a new way of job searching is taking shape, and you are now part of it.');
  process.exit(0);
}

// Single source of truth for the cold-start state: the same four user-layer
// prerequisites that AGENTS.md "First Run" lists. `--json` turns the trigger into
// a deterministic mechanism the agent runs (instead of re-deriving it from prose),
// and `--target <dir>` lets the test suite point it at a simulated virgin env.
function onboardingState(root) {
  const autoCopied = [];
  const templates = [
    { target: 'modes/_profile.md', template: 'modes/_profile.template.md' },
    { target: 'modes/_custom.md', template: 'modes/_custom.template.md' },
  ];
  for (const { target, template } of templates) {
    const targetPath = join(root, ...target.split('/'));
    const templatePath = join(root, ...template.split('/'));
    if (!existsSync(targetPath) && existsSync(templatePath)) {
      try {
        copyFileSync(templatePath, targetPath);
        autoCopied.push(target);
      } catch {
        // Gracefully handle read-only filesystems (e.g., CI/CD or containerized environments)
        // by leaving the file uncopied and letting onboardingNeeded/prereq checks handle it.
      }
    }
  }
  const missing = USER_LAYER_PREREQS
    .filter(({ path }) => !prereqPresent(root, path))
    .map(({ path }) => path);
  const configReference = playwrightMcpConfigReferenced(root);
  const warnings = [
    configReference
      ? `${LIVE_BROWSER_UNVERIFIED} (project MCP config reference found)`
      : `${LIVE_BROWSER_UNVERIFIED} (no project MCP config reference found)`,
  ];
  let plugins = [];
  try {
    const cfg = readPluginConfigSync(root);
    plugins = discoverPlugins(pluginRoots(root)).map((m) => {
      const s = pluginStatus(m, cfg);
      return { id: m.id, hooks: m.hooks, enabled: s.enabled, missingEnv: s.missingEnv };
    });
  } catch { plugins = []; }
  return { onboardingNeeded: missing.length > 0, missing, warnings, autoCopied, plugins };
}

// Only run when invoked directly. `READINESS_TIERS` / `declaredNodeFloor` are
// importable, and an import must never launch the checklist or call process.exit
// inside the importing process.
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  if (JSON_OUT) {
    console.log(JSON.stringify(onboardingState(projectRoot)));
    process.exit(0);
  } else {
    main().catch((err) => {
      console.error('doctor.mjs failed:', err.message);
      process.exit(1);
    });
  }
}
