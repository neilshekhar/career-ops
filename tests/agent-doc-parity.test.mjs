#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

const agents = read('AGENTS.md');
const claude = read('CLAUDE.md');

const sharedBehaviorAnchors = [
  'Source-of-Truth Boundary (CRITICAL)',
  'Authorship claims are non-negotiable',
  'modes/_custom.template.md',
  'verify-userdata.mjs',
  'Secrets & Credentials -- CRITICAL',
  'Ethical Use -- CRITICAL',
  'API first, zero tokens',
  'NEVER decide liveness from a bare WebSearch/WebFetch snippet',
  'Form Fill',
  'test-cron-rls-negative.mjs',
  'test-cron-evict.mjs',
  'Every upstream pull MUST pass the full validation gate',
  'Headless / Batch Mode',
  'Session Handover',
  'Cross-Agent QC',
  '`interview-redflag`',
  '`reply-watch`',
  '`agent-inbox`',
];

for (const anchor of sharedBehaviorAnchors) {
  assert(agents.includes(anchor), `AGENTS.md missing shared behavior: ${anchor}`);
  assert(claude.includes(anchor), `CLAUDE.md missing shared behavior: ${anchor}`);
}

assert(claude.includes('@AGENTS.md'), 'CLAUDE.md must retain the canonical AGENTS.md import');
assert(claude.includes('## Stack and Conventions'), 'CLAUDE.md must retain its full authored instruction body');
assert(claude.includes('## Cross-Agent QC'), 'CLAUDE.md must retain authored cross-agent QC instructions');
assert(!claude.includes('AI-powered job search automation built on Claude Code'), 'CLAUDE.md contains the stale Claude-only architecture claim');
for (const [name, doc] of [['AGENTS.md', agents], ['CLAUDE.md', claude]]) {
  assert(!doc.includes('ALWAYS use Playwright'), `${name} regressed to the pre-#574 Playwright-always liveness rule; keep the API-first ladder (check-liveness.mjs first)`);
}

for (const wrapper of ['CODEX.md', 'OPENCODE.md', 'KIMI.md']) {
  const instructions = read(wrapper).replace(/<!--[\s\S]*?-->/g, '').trim();
  assert.match(instructions, /^@(?:\.\/)?AGENTS\.md$/, `${wrapper} must remain a thin canonical wrapper`);
}

const gemini = read('GEMINI.md');
assert(!/^@(?:\.\/)?AGENTS\.md/m.test(gemini), 'GEMINI.md must remain a no-op to avoid duplicate Antigravity context');

const router = read('.agents/skills/career-ops/SKILL.md');
const argumentHint = router.match(/^argument-hint:\s*"([^"]+)"/m)?.[1] ?? '';
const standaloneModes = router.match(/### Standalone modes[\s\S]*?Applies to:\s*([^\n]+)/)?.[1] ?? '';
for (const mode of ['interview-redflag', 'reply-watch', 'agent-inbox']) {
  assert(router.includes(`| \`${mode}\` | \`${mode}\` |`), `shared router missing ${mode}`);
  assert(argumentHint.includes(mode), `shared router argument hint missing ${mode}`);
  assert(router.includes(`/career-ops ${mode}`), `shared discovery menu missing ${mode}`);
  assert(standaloneModes.includes(`\`${mode}\``), `shared context loader missing ${mode}`);
}

console.log('agent documentation parity tests passed');
