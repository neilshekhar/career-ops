import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USER_MODE_FILES = new Set([
  'modes/_profile.md',
  'modes/_custom.md',
  'modes/_brief.md',
]);

const UPSTREAM_ONLY_MODES = [
  'modes/_brief.template.md',
  'modes/_writing.md',
  'modes/calibrate.md',
  'modes/intake.md',
  'modes/outcome.md',
  'modes/pdf/hm-audit.md',
  'modes/triage.md',
];

const LOCKED_FILES = [
  '.agents/skills/career-ops/SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'GEMINI.md',
  'KIMI.md',
  'OPENCODE.md',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'config/profile.example.yml',
  'templates/README.md',
  'templates/cover-letter-template.html',
  'templates/cv-template.dense.html',
  'templates/cv-template.html',
  'templates/cv-template.tex',
  'templates/cv-template.zh-minimal.html',
  'templates/portals.example.yml',
  'templates/resume-template.html',
  'templates/states.yml',
];

const PRE_UPSTREAM_TRACKER_ALIASES = {
  '#': 'num',
  num: 'num',
  date: 'date',
  company: 'company',
  empresa: 'company',
  via: 'via',
  role: 'role',
  puesto: 'role',
  location: 'location',
  score: 'score',
  status: 'status',
  pdf: 'pdf',
  report: 'report',
  notes: 'notes',
};

function systemModeFiles(dir = join(ROOT, 'modes')) {
  const paths = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const rel = relative(ROOT, absolute).replaceAll('\\', '/');
    if (USER_MODE_FILES.has(rel)) continue;
    if (entry.isDirectory()) paths.push(...systemModeFiles(absolute));
    else if (entry.isFile() || entry.isSymbolicLink()) paths.push(rel);
  }
  return paths;
}

function workflowDigest() {
  const paths = [...LOCKED_FILES, ...systemModeFiles()].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(ROOT, path)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), paths };
}

test('fork workflow remains byte-identical to the pre-upstream process', () => {
  for (const path of UPSTREAM_ONLY_MODES) {
    assert.equal(existsSync(join(ROOT, path)), false, `${path} must remain absent`);
  }

  const { digest, paths } = workflowDigest();
  assert.ok(paths.every((path) => !USER_MODE_FILES.has(path)), 'workflow lock must never read user mode files');
  assert.equal(
    digest,
    'b433826e49815f0999eaf66756bb71015feba53008ea7cac82d69a8bc209d53b',
    'A workflow/router/default-template file changed. Review it as a fork workflow change, not an ordinary upstream update.',
  );
});

test('tracker header compatibility preserves the fork baseline plus URL dedup', () => {
  const aliases = JSON.parse(readFileSync(join(ROOT, 'tracker-aliases.json'), 'utf-8'));
  for (const [header, canonical] of Object.entries(PRE_UPSTREAM_TRACKER_ALIASES)) {
    assert.equal(aliases[header], canonical, `baseline tracker alias changed: ${header}`);
  }
  assert.equal(aliases.url, 'url', 'retained URL dedup engine needs its additive header alias');
  assert.deepEqual(
    Object.keys(aliases).sort(),
    [...Object.keys(PRE_UPSTREAM_TRACKER_ALIASES), 'url'].sort(),
    'tracker aliases must not import upstream workflow columns implicitly',
  );
});

test('headless OpenAI tailoring uses the retained shared voice policy', () => {
  const source = readFileSync(join(ROOT, 'openai-tailor.mjs'), 'utf8');
  assert.doesNotMatch(source, /modes\/_writing\.md|_writing\.md/);
  assert.match(source, /join\(ROOT, 'voice-dna\.md'\)/);
  assert.match(source, /VOICE DNA \(voice-dna\.md\)/);
});
