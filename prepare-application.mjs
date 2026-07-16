#!/usr/bin/env node

/**
 * RETIRED: this legacy ATS field-summary entrypoint created a second,
 * non-receipted application workflow. It remains as a fail-closed tombstone so
 * system updates overwrite older unsafe copies instead of leaving them callable.
 *
 * Use the dashboard Fill/Run action or career-ops apply. Both route to the one
 * active-agent browser controller governed by modes/apply.md,
 * modes/_custom.md, queue-resolve.mjs, and application-receipt.mjs.
 */

import { pathToFileURL } from 'url';

export const PREPARE_APPLICATION_RETIRED = true;

export function retiredPrepareApplicationMessage() {
  return [
    'prepare-application.mjs is retired and cannot prepare or fill an application.',
    'Use the dashboard Fill/Run action or run career-ops apply so the active agent owns the browser and records every resolver/teach/receipt step.',
  ].join(' ');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stderr.write(`${retiredPrepareApplicationMessage()}\n`);
  process.exitCode = 2;
}
