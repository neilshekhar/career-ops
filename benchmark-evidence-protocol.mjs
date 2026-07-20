#!/usr/bin/env node
/**
 * benchmark-evidence-protocol.mjs — fixture-replay cost comparison for
 * Evidence Protocol v3.1 fixture-replay cost comparison.
 *
 * Replays sanitized accessibility snapshot fixtures through snapshot-extract
 * and measures payload sizes for three agent-facing shapes:
 *   1. direct        — agent would re-serialize the full snapshot into context
 *   2. pre-v3        — hand-authored lookup + teach + page receipt envelopes
 *   3. v3            — apply-page compact stdout (paths only + resolved/novel)
 *
 * Token estimates use chars/4 (honest approximation — not a billed tokenizer).
 * Playwright MCP behavior note: `browser_snapshot` returns the accessibility
 * tree to the model AND writes the same YAML to `.playwright-mcp/page-*.yml`.
 * v3 still incurs the MCP return into model context once per snapshot; the
 * win is eliminating the second/third/fourth re-serialization of digests,
 * manifests, and receipt bodies that pre-v3 required.
 *
 * Usage: node benchmark-evidence-protocol.mjs [--json]
 */

import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  extractFields, extractUploadControls, parseSnapshot, sha256Text,
} from './snapshot-extract.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(ROOT, 'tests/fixtures/snapshots');
const CHARS_PER_TOKEN = 4;

function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => {
      const path = join(FIXTURE_DIR, name);
      const bytes = readFileSync(path);
      const text = bytes.toString('utf8');
      return {
        name,
        path,
        bytes,
        text,
        tree: parseSnapshot(text),
        digest: sha256Text(text),
      };
    });
}

function preV3EnvelopeChars(fixture) {
  const fields = extractFields(fixture.tree);
  const uploads = extractUploadControls(fixture.tree);
  const lookup = {
    page_index: 0,
    url: 'https://example.test/apply',
    snapshot_digest: fixture.digest,
    observed_at: new Date(0).toISOString(),
    fields,
    upload_controls: uploads,
  };
  const teach = {
    evidence_id: 'ev_bench',
    answers: fields.slice(0, Math.min(3, fields.length)).map((f) => ({
      control_id: f.control_id,
      answer: f.value || 'sample',
      reusable: false,
    })),
  };
  const page = {
    resolver_evidence_id: 'ev_bench',
    page_index: 0,
    url: 'https://example.test/apply',
    upload_controls: uploads,
    browser_observation: {
      before: { snapshot_digest: fixture.digest, field_manifest: fields.map((f) => f.control_id) },
      rescan: { snapshot_digest: fixture.digest, field_manifest: fields.map((f) => f.control_id) },
      after: {
        snapshot_digest: fixture.digest,
        field_manifest: fields.map((f) => f.control_id),
        populated_manifest: fields.map((f) => ({
          control_id: f.control_id,
          answer_digest: fixture.digest.slice(0, 16),
        })),
      },
    },
    fields: fields.map((f) => ({
      control_id: f.control_id,
      label: f.label,
      type: f.type,
      answer: f.value || '',
      resolution: 'novel',
      provenance: 'model',
      taught: true,
    })),
  };
  return JSON.stringify(lookup).length + JSON.stringify(teach).length + JSON.stringify(page).length;
}

function v3DriverChars(fixture) {
  const fields = extractFields(fixture.tree);
  const uploads = extractUploadControls(fixture.tree);
  const resolved = fields.filter((_, i) => i % 3 === 0).map((f) => ({
    control_id: f.control_id,
    label: f.label,
    answer: f.value || 'profile',
    provenance: 'deterministic',
  }));
  const novel = fields.filter((_, i) => i % 3 !== 0).map((f) => ({
    control_id: f.control_id,
    label: f.label,
    type: f.type,
    options: (f.options || []).slice(0, 40),
    required: f.required,
  }));
  const lookupOut = {
    ok: true,
    evidence_id: 'ev_bench',
    resolved,
    novel,
    upload_controls: uploads.map((u) => ({
      control_id: u.control_id,
      kind: u.kind,
      label: u.label,
      required: u.required,
    })),
  };
  const lookupIn = {
    page_index: 0,
    url: 'https://example.test/apply',
    snapshot: `.playwright-mcp/${fixture.name}`,
  };
  const completeIn = {
    after_snapshot: `.playwright-mcp/${fixture.name}`,
    answers: novel.slice(0, 2).map((f) => ({
      control_id: f.control_id,
      answer: 'conservative',
      reusable: false,
    })),
  };
  const completeOut = {
    ok: true,
    page_index: 0,
    taught: novel.length,
    verification_warnings: 0,
  };
  return (
    JSON.stringify(lookupIn).length +
    JSON.stringify(lookupOut).length +
    JSON.stringify(completeIn).length +
    JSON.stringify(completeOut).length
  );
}

function shapeLabel(name) {
  if (name.includes('workable')) return 'workable';
  if (name.includes('orc')) return 'oracle-orc';
  if (name.includes('successfactors')) return 'successfactors';
  if (name.includes('humanforce')) return 'humanforce';
  if (name.includes('careersvic')) return 'careersvic';
  return name.replace(/\.yml$/, '');
}

function run() {
  const fixtures = loadFixtures();
  // Prefer one representative per portal family for the §15 table.
  const preferred = [
    'workable-form.yml',
    'orc-form.yml',
    'successfactors-form.yml',
  ];
  const selected = preferred
    .map((name) => fixtures.find((f) => f.name === name))
    .filter(Boolean);
  const rows = (selected.length ? selected : fixtures.slice(0, 3)).map((fixture) => {
    const directChars = fixture.text.length;
    const preV3Chars = preV3EnvelopeChars(fixture);
    const v3Chars = v3DriverChars(fixture);
    return {
      shape: shapeLabel(fixture.name),
      fixture: fixture.name,
      fields: extractFields(fixture.tree).length,
      direct_chars: directChars,
      pre_v3_chars: preV3Chars,
      v3_chars: v3Chars,
      direct_tokens_est: estimateTokens(directChars),
      pre_v3_tokens_est: estimateTokens(preV3Chars),
      v3_tokens_est: estimateTokens(v3Chars),
      v3_vs_pre_v3_ratio: Number((v3Chars / Math.max(preV3Chars, 1)).toFixed(3)),
      note: 'token estimates = chars/4; MCP still returns full tree once per snapshot',
    };
  });

  const summary = {
    protocol: 'evidence-protocol-v3.1',
    mcp_behavior:
      'Playwright MCP browser_snapshot returns the a11y tree to the model and writes the same YAML under .playwright-mcp/. v3 eliminates hand-authored re-serialization of digests/manifests/receipts; it does not eliminate the initial MCP tree return.',
    token_estimate: 'chars/4 (approximate, not a billed tokenizer)',
    rows,
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  console.log('Evidence Protocol v3.1 — fixture-replay benchmark');
  console.log(summary.mcp_behavior);
  console.log(`Token estimate method: ${summary.token_estimate}\n`);
  console.log(
    'shape'.padEnd(16),
    'fields'.padStart(6),
    'direct'.padStart(8),
    'pre-v3'.padStart(8),
    'v3'.padStart(8),
    'v3/pre'.padStart(8),
  );
  for (const row of rows) {
    console.log(
      row.shape.padEnd(16),
      String(row.fields).padStart(6),
      String(row.direct_tokens_est).padStart(8),
      String(row.pre_v3_tokens_est).padStart(8),
      String(row.v3_tokens_est).padStart(8),
      String(row.v3_vs_pre_v3_ratio).padStart(8),
    );
  }
}

run();
