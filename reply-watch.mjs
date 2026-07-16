#!/usr/bin/env node

/**
 * reply-watch.mjs — Classify employer replies and generate a review digest (RFC #1585).
 *
 * Reads candidate replies from a JSON file, matches them against the application tracker,
 * classifies the reply types (e.g. Interview, Rejected, Noise), and prints a concise
 * review digest. Prompts the user to approve recommended tracker status updates,
 * then delegates each confirmed transition to the canonical set-status.mjs writer.
 *
 * Usage:
 *   node reply-watch.mjs [path/to/candidates.json] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matchCandidates, classifyReply } from './reply-matcher.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANDIDATES_PATH = path.join(__dirname, 'data', 'reply-candidates.json');
const APPS_FILE = resolveTrackerPath(__dirname);
const FOLLOWUPS_FILE = path.join(__dirname, 'data', 'follow-ups.md');
const SET_STATUS_FILE = path.join(__dirname, 'set-status.mjs');

// Helper to ask a question in the CLI
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

// Generate custom signal description based on keywords
function getSignalDesc(text, signal) {
  const parts = [];
  if (text.includes('简历通过')) {
    parts.push('resume passed');
  }
  if (text.includes('微信小程序') || text.includes('WeChat mini-program') || text.includes('AI微信小程序')) {
    parts.push('AI WeChat mini-program interview');
  }
  if (parts.length > 0) {
    return parts.join(' + ');
  }
  return signal || 'none';
}

// Create a default set of mock candidates if the file doesn't exist
function ensureCandidatesFile(filePath) {
  if (fs.existsSync(filePath)) return;

  const mockCandidates = [
    {
      message_id: 'msg1',
      from: 'recruiter@wingyun.com',
      subject: '恭喜简历通过，杭州赢云贸易有限公司邀您面试',
      body_snippet: '您的首轮面试是AI微信小程序面试。面试形式：AI微信小程序面试，面试时长：约15~30分钟',
      signal: 'interview_invite'
    },
    {
      message_id: 'msg2',
      from: 'hr@examplelabs.com',
      subject: 'Update on your application for Full-stack Engineer',
      body_snippet: '很遗憾地通知您，您的简历与我们当前岗位的需求暂不匹配，不合适我司的要求，未能进入下一轮。',
      signal: 'rejection'
    },
    {
      message_id: 'msg3',
      from: 'alerts@zhaopin.com',
      subject: 'Zhaopin job alert',
      body_snippet: '我们为您推荐了以下职位：邀请投递测试工程师岗位，现在沟通，抢面试先机！近期热招职位，立即投递！',
      signal: null
    },
    {
      message_id: 'msg4',
      from: 'hr@somecompany.com',
      subject: '补充信息',
      body_snippet: '邀请您在面试/入职之前更新或补充最新的应聘信息。',
      signal: null
    }
  ];

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(mockCandidates, null, 2), 'utf-8');
  console.log(`Created default mock candidates file at ${filePath}`);
}

// Load applications tracker rows
function loadTrackerApps() {
  if (!fs.existsSync(APPS_FILE)) {
    return [];
  }
  const content = fs.readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const apps = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) {
      apps.push(row);
    }
  }
  return apps;
}

// Load followups history
function loadFollowups() {
  if (!fs.existsSync(FOLLOWUPS_FILE)) {
    return [];
  }
  const content = fs.readFileSync(FOLLOWUPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const followups = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (isNaN(num) || isNaN(appNum)) continue;
    followups.push({
      num,
      appNum,
      date: parts[3],
      company: parts[4],
      role: parts[5],
      channel: parts[6],
      contact: parts[7],
      notes: parts[8] || ''
    });
  }
  return followups;
}

function safeEvidence(value, fallback = 'none') {
  const cleaned = String(value ?? '')
    .replace(/[\r\n|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/**
 * Build a concise, idempotent audit note for a confirmed external reply.
 * set-status.mjs adds the separate [external-status] provenance marker.
 */
export function replyEvidenceNote(candidate, classification) {
  const messageId = safeEvidence(candidate?.message_id, 'unknown-message')
    .replace(/[\[\];]/g, '_')
    .slice(0, 120);
  const type = safeEvidence(classification?.type, 'Unknown');
  const evidence = Array.isArray(classification?.evidence) && classification.evidence.length > 0
    ? classification.evidence.map((item) => safeEvidence(item)).join(', ')
    : safeEvidence(candidate?.signal, 'classification-only');
  return `[reply-watch:${messageId}] type=${type}; evidence=${evidence}`;
}

/**
 * Apply one user-confirmed lifecycle transition through the only canonical
 * tracker writer. Numeric row selection is an exact # match; argv is passed
 * without a shell, so reply text cannot become executable input.
 */
export function applyConfirmedTrackerStatus({ appNum, newStatus, note }, options = {}) {
  if (!Number.isInteger(appNum) || appNum <= 0) {
    throw new Error(`Invalid exact tracker row number: ${appNum}`);
  }
  if (!String(newStatus ?? '').trim()) {
    throw new Error('Confirmed reply transition is missing a canonical status');
  }
  if (!String(note ?? '').trim()) {
    throw new Error('Confirmed reply transition is missing reply evidence');
  }
  const runner = options.runner ?? spawnSync;
  const result = runner(process.execPath, [
    SET_STATUS_FILE,
    String(appNum),
    newStatus,
    '--external',
    '--note',
    note,
    '--json',
  ], {
    cwd: __dirname,
    env: process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`set-status.mjs rejected #${appNum} → ${newStatus}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`set-status.mjs returned invalid JSON for #${appNum}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const unknownFlags = argv.filter((arg) => arg.startsWith('--') && arg !== '--dry-run');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (unknownFlags.length > 0 || positional.length > 1) {
    throw new Error('Usage: node reply-watch.mjs [path/to/candidates.json] [--dry-run]');
  }
  const candidatesPath = positional[0] || DEFAULT_CANDIDATES_PATH;
  ensureCandidatesFile(candidatesPath);

  if (!fs.existsSync(candidatesPath)) {
    console.error(`Error: candidates file not found at ${candidatesPath}`);
    process.exit(1);
  }

  let candidates;
  try {
    candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
  } catch (e) {
    console.error(`Error parsing candidates JSON: ${e.message}`);
    process.exit(1);
  }

  const apps = loadTrackerApps();
  const followups = loadFollowups();

  const matched = matchCandidates(candidates, apps, followups);

  console.log(`\nToday: ${candidates.length} application updates need review\n`);

  const recommendations = [];

  matched.forEach((match, index) => {
    const cand = candidates.find(c => c.message_id === match.message_id);
    const classification = classifyReply(cand);

    let headerStr = '';
    if (match.application_num !== null) {
      const app = apps.find(a => a.num === match.application_num);
      headerStr = `${app.company} — ${app.role}`;
    } else {
      headerStr = cand.subject || match.company_hint || cand.from || 'Unknown';
    }

    console.log(`${index + 1}. ${headerStr}`);
    console.log(`   Type: ${classification.type}`);

    // Print Signal for Interview classification when meaningful
    const signalDesc = getSignalDesc(cand.subject + ' ' + cand.body_snippet, cand.signal);
    if (classification.type === 'Interview' && signalDesc && signalDesc !== 'none') {
      console.log(`   Signal: ${signalDesc}`);
    }

    if (classification.evidence && classification.evidence.length > 0) {
      console.log(`   Evidence: ${classification.evidence.join('; ')}`);
    }

    console.log(`   Suggested tracker update: ${classification.suggestedTrackerUpdate}`);
    console.log('');

    if (match.application_num !== null && classification.suggestedTrackerUpdate !== 'none' && classification.suggestedTrackerUpdate !== 'Needs Review') {
      const app = apps.find(a => a.num === match.application_num);
      if (app && app.status !== classification.suggestedTrackerUpdate) {
        recommendations.push({
          num: app.num,
          company: app.company,
          role: app.role,
          oldStatus: app.status,
          newStatus: classification.suggestedTrackerUpdate,
          note: replyEvidenceNote(cand, classification),
        });
      }
    }
  });

  if (recommendations.length > 0) {
    console.log('Suggested status updates to apply:');
    recommendations.forEach(r => {
      console.log(`  #${r.num} ${r.company} (${r.role}): ${r.oldStatus} → ${r.newStatus}`);
    });
    console.log('');

    if (dryRun) {
      console.log('Dry run — recommendations only; tracker unchanged.');
      return;
    }

    const answer = await askQuestion('Apply recommended status updates through set-status.mjs? (y/N): ');
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      for (const r of recommendations) {
        const result = applyConfirmedTrackerStatus({
          appNum: r.num,
          newStatus: r.newStatus,
          note: r.note,
        });
        console.log(`${result.changed ? 'Updated' : 'Already current'} #${r.num} to ${r.newStatus}`);
      }
      console.log('\n✅ All confirmed updates applied by the canonical locked tracker writer');

      // Sync tracker DB if tracker.mjs exists
      try {
        const sync = spawnSync(process.execPath, [path.join(__dirname, 'tracker.mjs'), 'sync'], {
          cwd: __dirname,
          env: process.env,
          stdio: 'ignore',
        });
        if (sync.error || sync.status !== 0) throw sync.error ?? new Error(`exit ${sync.status}`);
        console.log('Synced database index (applications.db).');
      } catch (e) {
        // ignore
      }
    } else {
      console.log('Updates skipped.');
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message || err);
    process.exitCode = 1;
  });
}
