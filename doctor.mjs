#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { delimiter, join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { discoverPlugins, pluginRoots, pluginStatus } from './plugins/_engine.mjs';
import { resolveExtractorMode } from './browser-extract.mjs';
import { parseConfigByExtension } from './jsonc-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { geminiNodeFloor } from './lib/gemini-node-floor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

// CLIs the doctor recognises.
const VALID_CLIS = ['claude', 'codex', 'opencode', 'antigravity', 'grok', 'qwen', 'kimi', 'copilot', 'gemini'];

// --help ran the full diagnostic and printed the report at exit 0 (#2856), so
// a mistyped flag was indistinguishable from a clean run — and --targe
// silently diagnosed THIS checkout instead of the one asked for. Handled via
// lib/cli-flags.mjs's validateFlags() (#2775), which rejects unrecognized
// flags before --help so `--help --bogus` still errors.
const KNOWN_FLAGS = ['--target', '--json', '--strict', '--setup', '--cli', '--help', '-h'];

// Both take their value as the next argv token.
const VALUE_FLAGS = ['--target', '--cli'];

const USAGE = `Usage:
  node doctor.mjs                    # run the setup diagnostic
  node doctor.mjs --json             # machine-readable onboarding state
  node doctor.mjs --strict           # also probe portals.yml ATS slugs (network)
  node doctor.mjs --setup            # check only the core runtime for a fresh install
  node doctor.mjs --target <path>    # diagnose another career-ops checkout
  node doctor.mjs --cli <name>       # check a specific CLI's integration
  node doctor.mjs --help             # show this message

CLIs: ${VALID_CLIS.join(', ')}`;

// requireOperand: without it, `--target --json` reads --json as the target
// path (argv[targetIdx + 1] below has no adjacency check of its own), and the
// doctor silently diagnoses a directory literally named "--json" at exit 0
// (#3087) — this is the onboarding entrypoint, so that's a user told to
// create files that already exist. Nothing more specific to say than the
// shared message.
if (isMain) {
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
}

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

const cliIdx = argv.indexOf('--cli');
const cliFlag = cliIdx !== -1 ? argv[cliIdx + 1] : null;

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

// El check mas frecuente de la comunidad, medido: 8 personas en 4 semanas
// preguntando por cuota y coste, y la causa mas repetida es esta. Aviso, nunca
// fallo: tener una clave puesta es una eleccion legitima, lo que no es legitimo
// es que el usuario no sepa que la esta usando en vez del plan que ya paga.
function checkBillingSource() {
  const key = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  // Enabled means SET TO A TRUTHY VALUE, not merely present. These switches are
  // documented as `=1`, so `CLAUDE_CODE_USE_BEDROCK=0` is how someone turns one
  // off — and mere presence would then report "requests bill to your cloud
  // account" at exactly the user who just said they don't. A billing check that
  // misreads an explicit opt-out causes the confusion it exists to remove.
  // Matches the repo's own env-flag convention (=== '1' in merge-tracker.mjs
  // and update-system.mjs), while also accepting `true` since these are
  // third-party switches users copy from assorted docs.
  const cloud = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .filter((v) => /^(1|true|yes|on)$/i.test(String(process.env[v] ?? '').trim()));

  if (cloud.length) {
    return {
      warn: true,
      label: `${cloud[0]} is set, so requests bill to your cloud account, not to a Claude subscription.`,
      fix: [
        'Intentional? Nothing to do.',
        `Not intentional: unset ${cloud[0]} and restart your terminal.`,
      ],
    };
  }

  const which = key ? 'ANTHROPIC_API_KEY' : (authToken ? 'ANTHROPIC_AUTH_TOKEN' : null);
  if (!which) {
    return { pass: true, label: 'Billing source: no API key in the environment (a Claude subscription will be used if you are logged in)' };
  }

  return {
    warn: true,
    label: `${which} is set, so it takes precedence over any Claude subscription: this session bills per token even if you pay for Pro or Max.`,
    fix: [
      'Intentional (you meant to use API credits)? Nothing to do.',
      `Not intentional: remove the export of ${which} from ~/.zshrc, ~/.bashrc, ~/.profile or a project .env, restart your terminal, and run /login.`,
      'Batch runs are the exception: `claude -p` workers do not use the interactive login, so they need `claude setup-token` exported as CLAUDE_CODE_OAUTH_TOKEN.',
      'Details: docs/RUNNING_ON_A_BUDGET.md section 2b.',
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

// Older updater versions could leave cascading tracked .bak files behind.
// Later updates cannot safely decide to untrack user files, so diagnose them.
function checkTrackedBakFiles(root) {
  let raw;
  try {
    raw = execFileSync('git', ['ls-files', '-z', '--', '*.bak*'], {
      cwd: root, encoding: 'utf-8', timeout: 5000,
    });
  } catch {
    return { pass: true, label: 'Tracked .bak files: skipped (not a git checkout)' };
  }
  const paths = raw.split('\0').filter(Boolean);
  if (paths.length === 0) {
    return { pass: true, label: 'No tracked .bak backup files' };
  }
  const preview = paths.slice(0, 8);
  const rest = paths.length - preview.length;
  return {
    warn: true,
    label: `${paths.length} tracked .bak backup file${paths.length === 1 ? '' : 's'} found — an old update-system.mjs bug committed these, and no update untracks them on its own`,
    fix: [
      ...preview,
      ...(rest > 0 ? [`...and ${rest} more`] : []),
      "git ls-files '*.bak*'            # find them",
      'git rm --cached <each path>      # untrack, leaving the file on disk',
      'git commit -m "chore: untrack .bak backups"',
    ],
  };
}

/**
 * Playwright's own engine floor, read from the installed package so this and the
 * dependency can never disagree. Same idiom as declaredNodeFloor() above.
 */
export function playwrightNodeFloor(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'playwright', 'package.json'), 'utf8'));
    const match = String(pkg?.engines?.node || '').match(/(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function checkPlaywright() {
  // Playwright >= 1.62 calls process.exit(1) at import time when Node is below its
  // engine floor. process.exit cannot be caught, so a bare try/catch here would take
  // the whole doctor run down instead of reporting a degraded tier — which is exactly
  // what the Node 18 minimum-version CI leg exists to prevent. Check the floor first.
  const floor = playwrightNodeFloor(projectRoot);
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (floor !== null && Number.isFinite(major) && major < floor) {
    return {
      warn: true,
      tier: 'localBrowser',
      label: `Local Chromium unavailable (Playwright needs Node >= ${floor}, found v${process.versions.node})`,
      fix: [
        `Install Node.js ${floor} or later from https://nodejs.org to enable Playwright.`,
        'PDF rendering, CLI extraction, and non-ATS liveness fallback are unavailable until then.',
      ],
    };
  }

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

// Per-CLI MCP config registry. `plugins: true` marks a CLI whose MCP servers
// can also arrive from an installed plugin outside the project root.
const MCP_CONFIGS = [
  { cli: 'claude', files: ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'], plugins: true },
  { cli: 'opencode', files: ['opencode.json', 'opencode.jsonc'] },
];

function isPlaywrightServer(server) {
  if (!server || typeof server !== 'object') return false;
  return JSON.stringify(server).toLowerCase().includes('@playwright/mcp');
}

function hasPlaywrightIn(cfg, { bare = false } = {}) {
  if (!cfg || typeof cfg !== 'object') return false;
  const buckets = [cfg.mcpServers, cfg.mcp, ...(bare ? [cfg] : [])]
    .filter((bucket) => bucket && typeof bucket === 'object');
  return buckets.some((servers) => Object.values(servers).some(isPlaywrightServer));
}

function readConfigIfPresent(file) {
  if (!existsSync(file)) return null;
  try {
    return parseConfigByExtension(file, readFileSync(file, 'utf8')) ?? null;
  } catch {
    return null;
  }
}

function playwrightMcpConfigReferenced(root) {
  const configFiles = [
    '.mcp.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.cursor/mcp.json',
    'opencode.json',
    'opencode.jsonc',
  ];
  for (const rel of configFiles) {
    const file = join(root, ...rel.split('/'));
    if (hasPlaywrightIn(readConfigIfPresent(file))) return true;
  }
  return false;
}

// Claude Code's user config dir. CLAUDE_CONFIG_DIR is the documented override;
// the tests point it at a tmpdir so this never reads the real machine.
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// A Claude Code plugin declares its MCP servers in its own .mcp.json, which
// lives under the user's config dir - never in the project root. The
// project-root scan below therefore reports "not detected" on a machine where
// Playwright MCP is installed and working, which reads as though the MANDATORY
// offer-liveness verification in AGENTS.md cannot be met (#2752).
//
// Only ENABLED plugins count: an installed-but-disabled plugin still ships its
// manifest on disk, but registers no server. Enumeration is driven by the two
// manifests rather than by walking plugins/cache, so a large cache costs
// nothing and disabled plugins are never read.
function isPlaywrightMcpFromPlugin() {
  const configDir = claudeConfigDir();

  const enabled = readConfigIfPresent(join(configDir, 'settings.json'))?.enabledPlugins;
  if (!enabled || typeof enabled !== 'object') return false;

  const installed = readConfigIfPresent(join(configDir, 'plugins', 'installed_plugins.json'))?.plugins;
  if (!installed || typeof installed !== 'object') return false;

  return Object.entries(enabled).some(([key, on]) => {
    if (on !== true) return false;
    const entries = Array.isArray(installed[key]) ? installed[key] : [];
    return entries.some(({ installPath } = {}) => {
      if (typeof installPath !== 'string' || !installPath) return false;
      return hasPlaywrightIn(readConfigIfPresent(join(installPath, '.mcp.json')), { bare: true });
    });
  });
}

function isPlaywrightMcpConfigured(root, activeCli) {
  const entry = MCP_CONFIGS.find((c) => c.cli === activeCli);
  if (!entry) return false; // known CLI but no MCP file mapping; caller warns
  const inProject = entry.files.some((rel) => {
    const file = join(root, ...rel.split('/'));
    return hasPlaywrightIn(readConfigIfPresent(file));
  });
  if (inProject) return true;
  // Gated behind the project scan, so an already-configured project pays no
  // extra I/O and non-plugin CLIs never touch the user config dir.
  return entry.plugins === true && isPlaywrightMcpFromPlugin();
}

// CLI resolution is intentionally limited to explicit process inputs:
// --cli flag > $CAREER_OPS_CLI > default ('claude'). Doctor never opens a
// credential-bearing environment file merely to infer the active CLI.
function resolveActiveCli() {
  if (cliFlag !== undefined && cliFlag !== null) {
    if (!VALID_CLIS.includes(cliFlag)) {
      return { cli: 'unknown', source: 'flag', warning: `Unknown --cli "${cliFlag}". Valid: ${VALID_CLIS.join(', ')}.` };
    }
    return { cli: cliFlag, source: 'flag' };
  }
  if (process.env.CAREER_OPS_CLI) {
    if (!VALID_CLIS.includes(process.env.CAREER_OPS_CLI)) {
      return { cli: 'unknown', source: 'env', warning: `CAREER_OPS_CLI="${process.env.CAREER_OPS_CLI}" is not a recognized CLI. Valid: ${VALID_CLIS.join(', ')}.` };
    }
    return { cli: process.env.CAREER_OPS_CLI, source: 'env' };
  }
  return { cli: 'claude', source: 'default' };
}

function checkPlaywrightMcp(root, activeCli) {
  // Unknown CLI (typo / not in VALID_CLIS).
  if (activeCli === 'unknown') return null;

  // Known CLI without an MCP file mapping.
  const entry = MCP_CONFIGS.find((c) => c.cli === activeCli);
  if (!entry) {
    return {
      warn: true,
      label: `Playwright MCP check skipped for CLI: ${activeCli}`,
      fix: [
        `doctor doesn't scan MCP configs for "${activeCli}". Verify your Playwright MCP setup manually for that CLI.`,
        `CLIs with scanning today: ${MCP_CONFIGS.map((c) => c.cli).join(', ')}.`,
      ],
    };
  }
  if (isPlaywrightMcpConfigured(root, activeCli)) {
    return { pass: true, label: `Playwright MCP server configured (${activeCli})` };
  }
  // Active CLI is known (flag/env/.env) but its MCP isn't configured.
  return {
    warn: true,
    label: `Playwright MCP tools not detected (active CLI: ${activeCli})`,
    fix: [
      entry.plugins
        ? `No project-level MCP config, and no enabled plugin providing one, was detected for ${activeCli}.`
        : `No project-level MCP config was detected for ${activeCli}.`,
      activeCli === 'opencode'
        ? 'Add the Playwright MCP server to opencode.json (see opencode.example.json) or pass --cli <name> if you actually run a different CLI.'
        : `Add the Playwright MCP server to your ${activeCli} config, or install a plugin that provides it (e.g. /plugin install playwright@claude-plugins-official).`,
    ],
  };
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

  const { cli: activeCli, warning: cliWarning } = resolveActiveCli();
  const chromium = await checkPlaywright();
  const chromiumUsable = chromium.pass === true;

  const checks = [
    ...(cliWarning ? [{ warn: true, label: cliWarning }] : []),
    checkNodeVersion(),
    // Devuelve null salvo que el CLI activo sea Gemini: el filter(Boolean) de
    // abajo lo descarta, así que ningún otro usuario ve un check que no le toca.
    geminiNodeFloor(activeCli, process.versions.node),
    checkBillingSource(),
    checkDependencies(),
    checkTrackedBakFiles(projectRoot),
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
  ].filter(Boolean);

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

  const { cli: activeCli, source: cliSource, warning: cliWarning } = resolveActiveCli();
  const mcpCheck = checkPlaywrightMcp(root, activeCli);
  const configReference = playwrightMcpConfigReferenced(root);
  const bakCheck = checkTrackedBakFiles(root);
  const warnings = [
    ...(cliWarning ? [cliWarning] : []),
    [
      LIVE_BROWSER_UNVERIFIED,
      configReference
        ? '(project MCP config reference found)'
        : '(no project MCP config reference found)',
    ].join(' '),
    ...(bakCheck.warn ? [`${bakCheck.label}\n→ ${[].concat(bakCheck.fix || []).join('\n  ')}`] : []),
  ];
  const playwrightMcp = activeCli !== 'unknown' && MCP_CONFIGS.find((c) => c.cli === activeCli)
    ? { [activeCli]: mcpCheck?.pass === true }
    : {};
  let plugins = [];
  try {
    const cfg = readPluginConfigSync(root);
    plugins = discoverPlugins(pluginRoots(root)).map((m) => {
      const s = pluginStatus(m, cfg);
      return { id: m.id, hooks: m.hooks, enabled: s.enabled, missingEnv: s.missingEnv };
    });
  } catch { plugins = []; }
  return {
    onboardingNeeded: missing.length > 0,
    missing,
    warnings,
    autoCopied,
    plugins,
    playwright_mcp: playwrightMcp,
    active_cli: activeCli,
    cli_source: cliSource,
  };
}

// Only run when invoked directly. `READINESS_TIERS` / `declaredNodeFloor` are
// importable, and an import must never launch the checklist or call process.exit
// inside the importing process.
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
