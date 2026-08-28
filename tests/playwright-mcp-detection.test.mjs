// doctor must detect configuration without claiming the active agent can use it.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ndoctor.mjs — honest Playwright MCP detection');

const DOCTOR = join(ROOT, 'doctor.mjs');
const EMPTY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'co-mcp-emptycfg-'));

function runDoctor(target, args = [], env = {}) {
  try {
    const out = execFileSync(NODE, [DOCTOR, '--json', '--target', target, ...args], {
      cwd: target,
      env: { ...process.env, CLAUDE_CONFIG_DIR: EMPTY_CONFIG_DIR, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(out);
  } catch (err) {
    return { _error: err.message, _stderr: String(err.stderr || '') };
  }
}

function check(label, condition, state) {
  if (condition) pass(label);
  else fail(`${label}: ${JSON.stringify(state)}`);
}

try {
  {
    const dir = mkdtempSync(join(tmpdir(), 'co-mcp-none-'));
    try {
      const state = runDoctor(dir);
      check(
        'no config is reported as unverified, never as a proven absence',
        !state._error
          && state.active_cli === 'claude'
          && state.cli_source === 'default'
          && state.playwright_mcp?.claude === false
          && state.warnings?.some((w) => /capability not verified by doctor/i.test(w)
            && /no project MCP config reference found/i.test(w)),
        state,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'co-mcp-claude-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(
        join(dir, '.claude', 'settings.local.json'),
        JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['@playwright/mcp'] } } }),
      );
      const state = runDoctor(dir);
      check(
        'Claude project config is detected without overstating live capability',
        state.playwright_mcp?.claude === true
          && state.warnings?.some((w) => /capability not verified by doctor/i.test(w)
            && /project MCP config reference found/i.test(w)
            && !/no project MCP config/i.test(w)),
        state,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'co-mcp-opencode-'));
    try {
      writeFileSync(join(dir, 'opencode.jsonc'), [
        '{',
        '  // OpenCode accepts JSONC',
        '  "mcp": { "playwright": { "command": ["npx", "@playwright/mcp"], }, },',
        '}',
      ].join('\n'));
      const state = runDoctor(dir, ['--cli', 'opencode']);
      check(
        'OpenCode JSONC is detected from an explicit CLI selection',
        state.active_cli === 'opencode'
          && state.cli_source === 'flag'
          && state.playwright_mcp?.opencode === true
          && state.warnings?.some((w) => /capability not verified by doctor/i.test(w)
            && /project MCP config reference found/i.test(w)),
        state,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'co-mcp-env-'));
    try {
      const state = runDoctor(dir, [], { CAREER_OPS_CLI: 'opencode' });
      check(
        'process environment selects OpenCode without reading an environment file',
        state.active_cli === 'opencode'
          && state.cli_source === 'env'
          && state.playwright_mcp?.opencode === false,
        state,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'co-mcp-invalid-'));
    try {
      const state = runDoctor(dir, ['--cli', 'vim']);
      check(
        'an unknown CLI remains explicit and cannot inherit another CLI configuration',
        state.active_cli === 'unknown'
          && state.cli_source === 'flag'
          && Object.keys(state.playwright_mcp || {}).length === 0
          && state.warnings?.some((w) => /Unknown --cli "vim"/.test(w)),
        state,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
} finally {
  rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true });
}
