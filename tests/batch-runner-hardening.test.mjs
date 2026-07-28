#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { pass, ROOT, getBash, toBashPath } from './helpers.mjs';

console.log('\nBatch runner hardening');

const runner = join(ROOT, 'batch', 'batch-runner.sh');
const source = readFileSync(runner, 'utf8');
// This suite drives batch-runner.sh through a real interpreter. Resolve it with
// the shared helper rather than hardcoding /bin/bash: on Windows that path does
// not exist (spawnSync then reports status null, not an exit code), while Git
// Bash does — getBash() finds it and toBashPath() converts D:\... to the /d/...
// form that interpreter can open. Both are identity operations off Windows.
const bash = getBash();

// Git Bash rewrites arguments on their way to native Windows binaries, and
// render_prompt_template shells out to `node`. Path conversion is REQUIRED there
// — node.exe cannot open a /d/... form — so it is left on, and the fixtures below
// are written in whatever form each platform passes through unchanged.
const bashEnv = process.env;

// A POSIX-looking JD path would be converted before the script saw it. Both
// forms exercise what this assertion is actually about: the ampersand surviving
// substitution.
const jdFixture = process.platform === 'win32' ? 'C:/tmp/jd&one' : '/tmp/jd&one';

// Git Bash also strips brace groups while rebuilding argv for a native binary,
// and that happens on the bash -> node.exe hop INSIDE render_prompt_template —
// downstream of anything this test controls, and not governed by
// MSYS2_ARG_CONV_EXCL (which only excludes path conversion). A literal {{DATE}}
// therefore cannot reach the renderer on Windows at all. Keep the
// placeholder-in-URL case on POSIX, where the substitution guard it probes is
// the real risk, and exercise the query/ampersand/backslash handling on Windows.
const specialUrl = process.platform === 'win32'
  ? 'https://example.test/jobs?a=1&next=DATE%5Ctail'
  : 'https://example.test/jobs?a=1&next={{DATE}}%5Ctail';

assert.equal(spawnSync(bash, ['-n', toBashPath(runner)]).status, 0);
assert.doesNotMatch(source, /--dangerously-skip-permissions/);
assert.match(source, /--permission-mode dontAsk/);
assert.match(source, /--safe-mode/);
assert.match(source, /permission_read_rule/);
assert.doesNotMatch(source, /node "\$PROJECT_DIR\/verify-pipeline\.mjs" \|\|/);
pass('worker permissions are scoped and final verification is fail-closed');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-batch-hardening-'));
try {
  const template = join(temp, 'template.md');
  const rendered = join(temp, 'rendered.md');
  writeFileSync(
    template,
    'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\nDATE={{DATE}}\nID={{ID}}\n',
  );
  const renderScript = [
    'runner="$1"; template="$2"; output="$3"; url="$4"; shift 4; set --',
    'source "$runner"',
    `render_prompt_template "$template" "$output" "$url" "${jdFixture}" "007" "2026-07-16" "42"`,
  ].join('\n');
  const renderResult = spawnSync(
    bash,
    ['-c', renderScript, 'batch-test', toBashPath(runner), toBashPath(template),
      toBashPath(rendered), specialUrl],
    { cwd: ROOT, encoding: 'utf8', env: bashEnv },
  );
  assert.equal(renderResult.status, 0, renderResult.stderr);
  assert.equal(
    readFileSync(rendered, 'utf8'),
    `URL=${specialUrl}\nJD=${jdFixture}\nREPORT=007\nDATE=2026-07-16\nID=42\n`,
  );
  pass('prompt rendering preserves ampersands, backslashes, and placeholder-like URL text');

  const project = join(temp, 'project');
  const reports = join(project, 'reports');
  const tracker = join(project, 'batch', 'tracker-additions');
  const output = join(project, 'output');
  mkdirSync(join(project, 'config'), { recursive: true });
  mkdirSync(reports, { recursive: true });
  mkdirSync(tracker, { recursive: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(project, 'config', 'profile.yml'), 'auto_pdf_score_threshold: 4.0\n');

  const id = '42';
  const reportNum = '007';
  const date = '2026-07-16';
  const url = 'https://example.test/jobs?a=1&b=2';
  const reportName = `${reportNum}-acme-${date}.md`;
  const reportPath = join(reports, reportName);
  const trackerPath = join(tracker, `${id}.tsv`);
  const machineSummary = [
    'company: "Acme"',
    'role: "Data Analyst"',
    'score: 4.2',
    'legitimacy_tier: "High Confidence"',
    'archetype: "Analytics"',
    'final_decision: "Apply"',
    'hard_stops: []',
    'soft_gaps: []',
    'top_strengths: ["SQL"]',
    'risk_level: "Low"',
    'confidence: "High"',
    'next_action: "Review"',
    'via: null',
    'company_confidential: false',
    'advertised_comp: null',
  ].join('\n');
  const report = (pdfMetadata) => [
    '# Evaluación: Acme — Data Analyst',
    '',
    '**Score:** 4.2/5',
    `**URL:** ${url}`,
    `**PDF:** ${pdfMetadata}`,
    `**Batch ID:** ${id}`,
    '',
    '## Machine Summary',
    '',
    '```yaml',
    machineSummary,
    '```',
    '',
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].flatMap((section) => [
      `## ${section}) Section`,
      'Complete.',
      '',
    ]),
  ].join('\n');
  const trackerLine = (pdfEmoji) => [
    '1', date, 'Acme', 'Data Analyst', 'Evaluated', '4.2/5', pdfEmoji,
    `[${reportNum}](reports/${reportName})`, 'Complete evaluation',
  ].join('\t') + '\n';

  const verifyScript = [
    'runner="$1"; project="$2"; skip_pdf="$3"; shift 3; set --',
    'source "$runner"',
    'PROJECT_DIR="$project"',
    'REPORTS_DIR="$project/reports"',
    'TRACKER_DIR="$project/batch/tracker-additions"',
    `verify_worker_artifacts "${id}" "${url}" "${reportNum}" "${date}" "$skip_pdf"`,
  ].join('\n');
  const verify = (skipPdf) => spawnSync(
    bash,
    ['-c', verifyScript, 'batch-test', toBashPath(runner), toBashPath(project), String(skipPdf)],
    { cwd: ROOT, encoding: 'utf8', env: bashEnv },
  );

  writeFileSync(reportPath, report('not generated — run /career-ops pdf acme to create on demand'));
  writeFileSync(trackerPath, trackerLine('❌'));
  let result = verify(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '4.2');

  result = verify(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be ✅ when score 4\.2 meets threshold 4/);
  pass('exit-zero worker artifacts cannot pass draft mode without a required PDF');

  const pdfRelative = `output/cv-candidate-acme-${date}.pdf`;
  const pdfPath = join(project, pdfRelative);
  writeFileSync(pdfPath, '%PDF-1.7\nfixture\n');
  writeFileSync(pdfPath.replace(/\.pdf$/, '.html'), '<!doctype html><title>CV</title>\n');
  writeFileSync(reportPath, report(pdfRelative));
  writeFileSync(trackerPath, trackerLine('✅'));
  result = verify(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '4.2');

  writeFileSync(pdfPath, 'not-a-pdf\n');
  result = verify(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not have a PDF header/);
  pass('report, tracker, Machine Summary, PDF, and source HTML are verified before completion');

  const interruptProject = join(temp, 'interrupt-project');
  const batchDir = join(interruptProject, 'batch');
  const fakeBin = join(interruptProject, 'bin');
  const tempDir = join(interruptProject, 'tmp');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(join(interruptProject, 'reports'), { recursive: true });
  mkdirSync(join(interruptProject, 'data'), { recursive: true });
  writeFileSync(join(batchDir, 'batch-runner.sh'), source);
  chmodSync(join(batchDir, 'batch-runner.sh'), 0o755);
  writeFileSync(
    join(batchDir, 'batch-prompt.md'),
    'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\nDATE={{DATE}}\nID={{ID}}\n',
  );
  writeFileSync(
    join(batchDir, 'batch-input.tsv'),
    'id\turl\tsource\tnotes\n42\thttps://example.test/slow\tfixture\t-\n',
  );
  const fakeClaude = join(fakeBin, 'claude');
  writeFileSync(fakeClaude, [
    '#!/usr/bin/env bash',
    'trap "exit 143" HUP INT TERM',
    'while true; do sleep 0.1; done',
  ].join('\n') + '\n');
  chmodSync(fakeClaude, 0o755);

  const child = spawn(bash, [toBashPath(join(batchDir, 'batch-runner.sh'))], {
    cwd: interruptProject,
    // delimiter, not ':' — Windows separates PATH entries with ';'.
    env: { ...bashEnv, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, TMPDIR: tempDir },
    stdio: 'ignore',
  });
  const workerTempFiles = () => readdirSync(tempDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [entry.name];
    return readdirSync(join(tempDir, entry.name)).map((name) => `${entry.name}/${name}`);
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && workerTempFiles().length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(workerTempFiles().length, 2, 'worker temp files were not created in time');
  child.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('interrupted runner did not exit')), 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.code, 143);
  assert.deepEqual(readdirSync(tempDir), []);
  pass('TERM reaches managed workers and removes both temporary JD and prompt files');
} finally {
  // The suite kills a bash process tree; on Windows the OS can still hold
  // handles under this directory for a moment afterwards, which surfaces as
  // EPERM. maxRetries/retryDelay is what those options exist for — without them
  // a passing test still fails the job during cleanup.
  rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
