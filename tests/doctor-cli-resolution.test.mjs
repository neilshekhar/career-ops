// tests/doctor-cli-resolution.test.mjs — CLI resolution precedence coverage
// in `doctor.mjs`. CLI resolution feeds MCP detection (covered in
// tests/playwright-mcp-detection.test.mjs); this file owns the precedence
// paths themselves. See plan/opencode-json-ignore.md for context.
// Each scenario uses a fresh --target dir so no MCP config / .env / env
// leaks across cases.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\ndoctor.mjs — CLI resolution');

const DOCTOR = join(ROOT, 'doctor.mjs');

function runDoctor(cwd, args, env) {
  try {
    const out = execFileSync(NODE, [DOCTOR, '--json', '--target', cwd, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(out);
  } catch (e) {
    return { _error: e.message, _stderr: e.stderr ? String(e.stderr) : '' };
  }
}

function expectOk(state, msg) {
  if (state._error) { fail(`${msg}: doctor crashed: ${state._error}`); return false; }
  return true;
}

try {
  // 1. --cli flag beats process.env.CAREER_OPS_CLI. Pin precedence at the
  //    flag/env boundary so a future reorder of resolveActiveCli fails loudly.
  {
    const dir = mkdtempSync(join(tmpdir(), 'co-resolve-1-'));
    try {
      const state = runDoctor(dir, ['--cli', 'opencode'], { CAREER_OPS_CLI: 'claude' });
      if (expectOk(state, '#1 flag beats env')
          && state.active_cli === 'opencode'
          && state.cli_source === 'flag') {
        pass('--cli flag beats CAREER_OPS_CLI env (active_cli=opencode, cli_source=flag)');
      } else {
        fail(`#1 unexpected state: ${JSON.stringify(state)}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // 2. process.env.CAREER_OPS_CLI selects the CLI when no flag is present.
  {
    const dir = mkdtempSync(join(tmpdir(), 'co-resolve-2-'));
    try {
      const state = runDoctor(dir, [], { CAREER_OPS_CLI: 'opencode' });
      if (expectOk(state, '#2 env selection')
          && state.active_cli === 'opencode'
          && state.cli_source === 'env') {
        pass('process.env CAREER_OPS_CLI selects opencode when no --cli flag is present');
      } else {
        fail(`#2 unexpected state: ${JSON.stringify(state)}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const doctorSource = readFileSync(DOCTOR, 'utf8');
  if (!/dotenv\.config\s*\(/.test(doctorSource)
      && !/readFileSync\s*\([^)]*['"]\.env['"]/.test(doctorSource)) {
    pass('CLI resolution does not inspect credential-bearing environment files');
  } else {
    fail('CLI resolution must use explicit process inputs without opening environment files');
  }

} catch (e) {
  fail(`doctor-cli-resolution tests crashed: ${e.message}`);
}
