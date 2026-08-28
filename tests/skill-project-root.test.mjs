import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fail, pass, ROOT } from './helpers.mjs';

console.log('\nSkill project-root resolution (#3332)');

const entrypoints = [
  '.agents',
  '.antigravitycli',
  '.claude',
  '.cursor',
  '.grok',
  '.kimi',
  '.opencode',
  '.qwen',
].map(dir => join(dir, 'skills', 'career-ops', 'SKILL.md'));

function findProjectRoot(skillPath) {
  let current = dirname(skillPath);
  while (true) {
    if (existsSync(join(current, 'AGENTS.md')) && existsSync(join(current, 'modes'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const failures = [];
for (const relativePath of entrypoints) {
  const skillPath = join(ROOT, relativePath);
  readFileSync(skillPath, 'utf8');
  const resolvedRoot = findProjectRoot(skillPath);

  if (resolve(resolvedRoot || '') !== resolve(ROOT)) {
    failures.push(`${relativePath}: resolved ${resolvedRoot || '(none)'}`);
  }
}

if (failures.length === 0) {
  pass('all CLI skill entrypoints resolve physically inside the checkout root');
} else {
  fail(failures.join(' | '));
}
