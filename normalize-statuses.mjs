#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per states.yml:
 *   Evaluada, Aplicado, Respondido, Entrevista, Oferta, Rechazado, Descartado, NO APLICAR
 *
 * Also strips markdown bold (**) and dates from the status field, moving
 * DUPLICADO info to the notes column. Real writes run under the canonical
 * tracker lock, use an atomic replacement, and append migration provenance.
 *
 * Run: node career-ops/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, copyFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import {
  rebuildRow,
  resolveTrackerPath,
  trackerLockDirFor,
  acquireTrackerLock,
  writeFileAtomic,
  cell,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = resolveTrackerPath(CAREER_OPS);
const DRY_RUN = process.argv.includes('--dry-run');
const PROGRESSION_STATES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);

// Canonical status mapping
export function normalizeStatus(raw) {
  // Strip markdown bold
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  // DUPLICADO variants → Discarded
  if (/^duplicado/i.test(s) || /^dup\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }

  // CERRADA / Cancelada / Descartada → Discarded
  if (/^cerrada$/i.test(s)) return { status: 'Discarded' };
  if (/^cancelada/i.test(s)) return { status: 'Discarded' };
  if (/^descartada$/i.test(s)) return { status: 'Discarded' };
  if (/^descartado$/i.test(s)) return { status: 'Discarded' };

  // Rechazada / Rechazado → Rejected
  if (/^rechazada?$/i.test(s)) return { status: 'Rejected' };
  if (/^rechazado\s+\d{4}/i.test(s)) return { status: 'Rejected' };

  // Aplicado with date → Applied (strip date)
  if (/^aplicado\s+\d{4}/i.test(s)) return { status: 'Applied' };

  // CONDICIONAL / HOLD / EVALUAR / Verificar → Evaluated
  if (/^(condicional|hold|evaluar|verificar)$/i.test(s)) return { status: 'Evaluated' };

  // MONITOR → SKIP
  if (/^monitor$/i.test(s)) return { status: 'SKIP' };

  // GEO BLOCKER → SKIP
  if (/geo.?blocker/i.test(s)) return { status: 'SKIP' };

  // Repost #NNN → Discarded
  if (/^repost/i.test(s)) return { status: 'Discarded', moveToNotes: raw.trim() };

  // "—" (em dash, no status) → Discarded
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  // Already canonical (English, per states.yml) — just fix casing/bold
  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  // Spanish aliases → English canonicals
  if (['evaluada'].includes(lower)) return { status: 'Evaluated' };
  if (['aplicado', 'enviada', 'aplicada', 'applied', 'sent'].includes(lower)) return { status: 'Applied' };
  if (['respondido'].includes(lower)) return { status: 'Responded' };
  if (['entrevista'].includes(lower)) return { status: 'Interview' };
  if (['oferta'].includes(lower)) return { status: 'Offer' };
  if (['contratado', 'contratada', 'hired', 'accepted', 'accept'].includes(lower)) return { status: 'Hired' };
  if (['cerrada', 'descartada'].includes(lower)) return { status: 'Discarded' };
  if (['no aplicar', 'no_aplicar', 'skip'].includes(lower)) return { status: 'SKIP' };

  // Unknown — flag it
  return { status: null, unknown: true };
}

function hasDelimitedNote(existing, entry) {
  return existing === entry
    || existing.startsWith(`${entry}; `)
    || existing.endsWith(`; ${entry}`)
    || existing.includes(`; ${entry}; `);
}

function appendNote(parts, notesIndex, entry) {
  if (notesIndex == null) {
    throw new Error('Tracker has no Notes column; refusing a status migration without audit provenance');
  }
  while (parts.length <= notesIndex) parts.push('');
  const existing = parts[notesIndex] && !['—', '-'].includes(parts[notesIndex])
    ? parts[notesIndex]
    : '';
  if (!hasDelimitedNote(existing, entry)) {
    parts[notesIndex] = existing ? `${existing}; ${entry}` : entry;
  }
}

function migrationMarker(oldStatus, newStatus) {
  const old = cell(oldStatus)
    .replace(/[\[\]*]/g, '')
    .slice(0, 80) || '(blank)';
  return `[status-normalized:${old}->${newStatus}]`;
}

async function main() {
  if (!existsSync(APPS_FILE)) {
    console.log('No applications.md found. Nothing to normalize.');
    return;
  }

  let lock = null;
  try {
    if (!DRY_RUN) {
      lock = await acquireTrackerLock(trackerLockDirFor(APPS_FILE), {
        timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
        retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
        staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
        tracker: APPS_FILE,
      });
    }

    const content = readFileSync(APPS_FILE, 'utf-8');
    const lines = content.split('\n');
    const colmap = resolveColumns(lines);
    let changes = 0;
    const unknowns = [];

    for (let i = 0; i < lines.length; i++) {
      const row = parseTrackerRow(lines[i], colmap);
      if (!row) continue;

      const parts = lines[i].split('|').map(s => s.trim());
      const rawStatus = parts[colmap.status] ?? '';
      const result = normalizeStatus(rawStatus);

      if (result.unknown) {
        unknowns.push({ num: row.num, rawStatus, line: i + 1 });
        continue;
      }
      if (result.status === rawStatus) continue;

      const oldStatus = rawStatus;
      parts[colmap.status] = result.status;

      if (result.moveToNotes) {
        appendNote(parts, colmap.notes, cell(result.moveToNotes));
      }
      appendNote(parts, colmap.notes, migrationMarker(oldStatus, result.status));
      const existingNotes = colmap.notes == null ? '' : (parts[colmap.notes] ?? '');
      if (PROGRESSION_STATES.has(result.status) && !/\[application-receipt:[^\]]+\]/.test(existingNotes)) {
        // Normalization is an import/migration of historical tracker state,
        // not proof of a canonical live-application receipt.
        appendNote(parts, colmap.notes, '[external-status]');
      }

      if (colmap.score != null && parts[colmap.score]) {
        parts[colmap.score] = parts[colmap.score].replace(/\*\*/g, '');
      }

      lines[i] = rebuildRow(parts);
      changes++;
      console.log(`#${row.num}: "${oldStatus}" → "${result.status}"`);
    }

    if (unknowns.length > 0) {
      console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
      for (const item of unknowns) {
        console.log(`  #${item.num} (line ${item.line}): "${item.rawStatus}"`);
      }
    }

    console.log(`\n📊 ${changes} statuses normalized`);

    if (!DRY_RUN && changes > 0) {
      copyFileSync(APPS_FILE, `${APPS_FILE}.bak`);
      writeFileAtomic(APPS_FILE, lines.join('\n'));
      console.log('✅ Written atomically under the tracker lock (backup: applications.md.bak)');
    } else if (DRY_RUN) {
      console.log('(dry-run — no changes written)');
    } else {
      console.log('✅ No changes needed');
    }
  } finally {
    lock?.release();
  }
}

main().catch((error) => {
  console.error(`❌ Status normalization failed: ${error.message}`);
  process.exitCode = 1;
});
