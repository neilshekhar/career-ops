#!/usr/bin/env node

/**
 * form-fill.mjs — offline application plan compatibility helper.
 *
 * Live form control belongs exclusively to the active interactive agent following
 * modes/apply.md, modes/_custom.md, queue-resolve.mjs, and
 * application-receipt.mjs. This helper never launches a browser, reads portal
 * credentials, mutates the queue, advances a wizard page, uploads a document, or
 * marks an application prefilled/filled. It only prints the prepared role context
 * needed to start the canonical active-agent workflow.
 *
 * Usage:
 *   node form-fill.mjs <role-id>
 *
 * Legacy browser flags such as --headless are rejected fail-closed.
 */

import { pathToFileURL } from 'url';

import { FINAL_APPLICATION_ACTION } from './application-safety.mjs';
import { COVER_RE, KSC_RE } from './field-rules.mjs';
import { loadQueue } from './queue-store.mjs';

export const FORM_FILL_RUNTIME = 'offline-plan-only';
export const FINAL_SUBMIT_DENYLIST = FINAL_APPLICATION_ACTION;
export { COVER_RE, KSC_RE };

const LEGACY_BROWSER_FLAGS = new Set(['--headless', '--headed', '--browser', '--open']);

function compactAssetList(role) {
  const covers = role?.cover_letter_paths && typeof role.cover_letter_paths === 'object'
    ? Object.values(role.cover_letter_paths)
    : [];
  return [role?.cv_pdf, role?.cover_letter_path, ...covers]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

/**
 * Build a secret-free, read-only handoff record for the one canonical browser
 * controller. The record deliberately contains no guessed form answers: the live
 * controller must extract each page and run the resolver/L3/teach/verify loop.
 */
export function buildOfflineApplicationPlan(role) {
  if (!role?.id) throw new Error('queue role is required');
  return {
    version: 1,
    status: 'active-agent-required',
    runtime: FORM_FILL_RUNTIME,
    role_id: role.id,
    company: String(role.company ?? ''),
    title: String(role.title ?? ''),
    url: String(role.url ?? ''),
    queue_status: String(role.status ?? ''),
    browser_owner: 'active-agent',
    queue_mutation: false,
    assets: compactAssetList(role),
    known_draft_labels: Object.keys(role.drafts ?? {}),
    canonical_contract: [
      'modes/apply.md',
      'modes/_custom.md',
      'queue-resolve.mjs',
      'application-receipt.mjs',
    ],
    next_action: `Run career-ops apply for role ${role.id}; open its URL in a new active-agent-controlled tab and complete every page receipt before Next.`,
  };
}

function usage() {
  return [
    'Usage: node form-fill.mjs <role-id>',
    '',
    'This command is an offline application-plan helper only.',
    'Live browser filling must run through the active-agent career-ops apply workflow.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const legacyFlag = argv.find((arg) => LEGACY_BROWSER_FLAGS.has(arg));
  if (legacyFlag) {
    process.stderr.write(
      `form-fill: ${legacyFlag} is retired; no private browser may be launched. ` +
      'Use the active-agent career-ops apply workflow.\n',
    );
    process.exitCode = 2;
    return;
  }

  const roleId = argv.find((arg) => !arg.startsWith('-'));
  if (!roleId) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const role = loadQueue().roles.find((item) => item.id === roleId);
  if (!role) {
    process.stderr.write(`form-fill: queue role not found: ${roleId}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify(buildOfflineApplicationPlan(role), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    process.stderr.write(`form-fill: ${err.message}\n`);
    process.exitCode = 1;
  });
}
