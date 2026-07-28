#!/usr/bin/env node

/**
 * updater-migration-tests.mjs — source-level safety checks for update-system.
 *
 * Protects cross-version migrations where an older installed updater must fetch
 * newly introduced system paths without touching user data.
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LEGACY_VOICE_DNA_MIGRATION_MARKER,
  preserveLegacyVoiceDna,
  voiceDnaOwnershipFromUpdaterSource,
} from './update-system.mjs';

let passed = 0;
let failed = 0;

function pass(message) {
  console.log(`PASS ${message}`);
  passed++;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  failed++;
}

let source = '';
try {
  source = readFileSync('update-system.mjs', 'utf-8');
  pass('update-system.mjs is readable');
} catch (error) {
  fail(`update-system.mjs is readable: ${error.message}`);
  process.exit(1);
}

function extractArray(name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    fail(`${name} array exists`);
    return [];
  }
  pass(`${name} array exists`);
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

const systemPaths = extractArray('SYSTEM_PATHS');
const userPaths = extractArray('USER_PATHS');
const bootstrapPaths = extractArray('BOOTSTRAP_PATHS');

const requiredSystemPaths = [
  'modes/email.md',
  'modes/followup.md',
  'modes/interview.md',
  'modes/interview-prep.md',
  'modes/patterns.md',
  'modes/update.md',
  'modes/ar/',
  'modes/hi/',
  'modes/tr/',
  'modes/ua/',
  'batch/README.md',
  'examples/',
  'config/profile.example.yml',
  '.env.example',
  '.claude-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  'tracker-columns-tests.mjs',
  'updater-migration-tests.mjs',
  'README.ar.md',
  'README.de.md',
  'README.hi.md',
  'README.ja.md',
  'README.ua.md',
  'CHANGELOG.md',
  'generate-cover-markdown.mjs',
  'generate-cover-formats.mjs',
  'cover-format-policy.mjs',
  'voice-dna.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
];

const requiredBootstrapPaths = [
  '.agents/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  'providers/',
  'liveness-browser.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'updater-migration-tests.mjs',
  'tracker-columns-tests.mjs',
];

for (const path of requiredSystemPaths) {
  if (systemPaths.includes(path)) pass(`SYSTEM_PATHS covers ${path}`);
  else fail(`SYSTEM_PATHS missing ${path}`);
}

for (const path of requiredBootstrapPaths) {
  if (bootstrapPaths.includes(path)) pass(`BOOTSTRAP_PATHS covers ${path}`);
  else fail(`BOOTSTRAP_PATHS missing ${path}`);
}

const twoPassManifestChecks = [
  {
    name: 'apply has a re-exec guard',
    pattern: /CAREER_OPS_UPDATE_REEXEC/,
  },
  {
    name: 'apply resolves the re-exec checkout closure from FETCH_HEAD (#1245)',
    pattern: /resolveReexecCheckout\('FETCH_HEAD',\s*'update-system\.mjs'\)/,
  },
  {
    name: 'apply checks out the resolved re-exec files from FETCH_HEAD (#1245)',
    pattern: /git\('checkout',\s*'FETCH_HEAD',\s*'--',\s*\.\.\.reexecFiles\)/,
  },
  {
    name: 're-exec fallback still covers the skill-entrypoints import (#1245)',
    pattern: /REEXEC_FALLBACK_FILES\s*=\s*\[[^\]]*'scaffolder\/bin\/skill-entrypoints\.mjs'/,
  },
  {
    name: 'apply re-execs through the current Node binary',
    pattern: /execFileSync\(process\.execPath,\s*\[\s*'update-system\.mjs',\s*'apply'\s*\]/,
  },
  {
    name: 'apply carries the original backup branch across re-exec',
    pattern: /CAREER_OPS_UPDATE_BACKUP_BRANCH/,
  },
  {
    name: 'apply reads the target updater manifest from FETCH_HEAD',
    pattern: /git\('show',\s*'FETCH_HEAD:update-system\.mjs'\)/,
  },
  {
    name: 'apply extracts SYSTEM_PATHS from the target updater',
    pattern: /extractArrayFromSource\([^,]+,\s*'SYSTEM_PATHS'\)/,
  },
  {
    name: 'apply merges local and target system manifests',
    pattern: /mergePathLists\(SYSTEM_PATHS,\s*remoteSystemPaths[\s\S]*?\)/,
  },
  {
    name: 'apply checks out the merged manifest instead of only the local manifest',
    pattern: /for\s*\(const path of updatePaths\)/,
  },
  {
    name: 'revertPaths uses git checkout HEAD (not just --) to reset index+worktree (#915)',
    pattern: /git\('checkout',\s*'HEAD',\s*'--'/,
  },
  {
    name: 'apply commit is scoped to update paths, not bare commit (#915)',
    pattern: /git\('commit',\s*'-m',[^)]+'--',\s*\.\.\.pathsToStage\)/,
  },
  {
    name: 'rollback commit is scoped to rollback paths, not bare commit (#915)',
    pattern: /git\('commit',\s*'-m',[^)]+'--',\s*\.\.\.rollbackPaths\)/,
  },
  {
    name: 'apply captures uncommitted work via git stash create before branching (#915)',
    pattern: /git\('stash',\s*'create'\)/,
  },
];

for (const check of twoPassManifestChecks) {
  if (check.pattern.test(source)) pass(check.name);
  else fail(check.name);
}

// voice-dna.md moved from the legacy user layer to the shared system layer.
// Prove the transition preserves customized bytes before the normal checkout,
// is one-time, and recognizes old/new updater manifests deterministically.
const legacyUpdater = `
const SYSTEM_PATHS = ['doctor.mjs'];
const USER_PATHS = ['cv.md', 'voice-dna.md'];
`;
const sharedUpdater = `
const SYSTEM_PATHS = ['doctor.mjs', 'voice-dna.md'];
const USER_PATHS = ['cv.md'];
`;
if (
  voiceDnaOwnershipFromUpdaterSource(legacyUpdater) === 'user'
  && voiceDnaOwnershipFromUpdaterSource(sharedUpdater) === 'system'
) {
  pass('voice-dna ownership migration distinguishes legacy user and new system manifests');
} else {
  fail('voice-dna ownership migration could not distinguish old/new updater manifests');
}

const voiceTmp = mkdtempSync(join(tmpdir(), 'career-ops-voice-migration-'));
try {
  mkdirSync(join(voiceTmp, 'writing-samples'), { recursive: true });
  const customVoice = '# My custom voice\nKeep this exact sentence.\n';
  writeFileSync(join(voiceTmp, 'voice-dna.md'), customVoice, 'utf8');
  const first = preserveLegacyVoiceDna(
    voiceTmp,
    '# New shared default\n',
    { log: () => {} },
  );
  const backupPath = first.backup ? join(voiceTmp, ...first.backup.split('/')) : '';
  if (
    first.status === 'preserved'
    && backupPath
    && readFileSync(backupPath, 'utf8') === customVoice
    && readFileSync(join(voiceTmp, 'voice-dna.md'), 'utf8') === customVoice
    && existsSync(join(voiceTmp, ...LEGACY_VOICE_DNA_MIGRATION_MARKER.split('/')))
  ) {
    pass('legacy customized voice-dna bytes are backed up before the shared default checkout');
  } else {
    fail('legacy customized voice-dna was not preserved exactly');
  }

  writeFileSync(join(voiceTmp, 'voice-dna.md'), '# Later local edit\n', 'utf8');
  const second = preserveLegacyVoiceDna(
    voiceTmp,
    '# Another shared default\n',
    { log: () => {} },
  );
  if (
    second.status === 'already-migrated'
    && readFileSync(backupPath, 'utf8') === customVoice
  ) {
    pass('voice-dna ownership preservation is one-time and never overwrites its backup');
  } else {
    fail('voice-dna migration repeated or overwrote the original backup');
  }
} finally {
  rmSync(voiceTmp, { recursive: true, force: true });
}

const migrationIdx = source.indexOf('preserveLegacyVoiceDna(ROOT, incomingVoiceDna)');
const checkoutIdx = source.indexOf("git('checkout', 'FETCH_HEAD', '--', path)");
if (migrationIdx > 0 && checkoutIdx > migrationIdx) {
  pass('apply preserves legacy voice-dna before checking out system files');
} else {
  fail('apply does not preserve legacy voice-dna before the system checkout');
}

for (const userPath of ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'portals.yml', 'data/', 'reports/']) {
  if (userPaths.includes(userPath)) pass(`USER_PATHS protects ${userPath}`);
  else fail(`USER_PATHS missing ${userPath}`);
}

const allowedSystemUserOverlap = new Set([
  'writing-samples/README.md',
  // System-owned scaffold inside the user-layer interview-prep/ dir (#1242):
  // the updater ships these two, but never the real session files alongside them.
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
]);
let hasSystemUserCollision = false;
for (const systemPath of systemPaths) {
  const overlapsUserPath = userPaths.some((userPath) => {
    if (allowedSystemUserOverlap.has(systemPath)) return false;
    return systemPath === userPath || systemPath.startsWith(userPath);
  });
  if (overlapsUserPath) {
    hasSystemUserCollision = true;
    fail(`SYSTEM_PATHS must not update user path ${systemPath}`);
  }
}
if (!hasSystemUserCollision) {
  pass('SYSTEM_PATHS does not collide with USER_PATHS');
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
