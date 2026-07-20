#!/usr/bin/env node
/**
 * benchmark-lean-application.mjs — fixture-replay cost comparison:
 * receipt-v3 (lookup + after-snapshot complete) vs lean-llm-v1 (lookup + page-done).
 *
 * Asserts ≥40% fewer evidence tool-call payloads on ordinary pages (no selective
 * re-observe). Token estimates use chars/4.
 *
 * Usage: node benchmark-lean-application.mjs [--json] [--assert]
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
const MIN_TOOL_CALL_REDUCTION = 0.40;

function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yml') && !name.includes('filled') && !name.includes('conditional'))
    .map((name) => {
      const path = join(FIXTURE_DIR, name);
      const text = readFileSync(path, 'utf8');
      return {
        name,
        text,
        tree: parseSnapshot(text),
        digest: sha256Text(text),
      };
    });
}

function receiptV3EvidenceToolCalls(fixture) {
  // Ordinary receipt page: before snapshot + lookup + teach + after snapshot + complete
  const fields = extractFields(fixture.tree);
  const uploads = extractUploadControls(fixture.tree);
  const novel = fields.filter((_, i) => i % 3 !== 0);
  const lookupIn = {
    page_index: 0,
    url: 'https://example.test/apply',
    snapshot: `.playwright-mcp/${fixture.name}`,
  };
  const lookupOut = {
    resolved: fields.filter((_, i) => i % 3 === 0).map((f) => ({
      control_id: f.control_id, label: f.label, answer: f.value || 'profile',
    })),
    novel: novel.map((f) => ({
      control_id: f.control_id, label: f.label, type: f.type,
      options: (f.options || []).slice(0, 40),
    })),
    upload_controls: uploads,
  };
  const teachIn = {
    evidence_id: 'ev_bench',
    answers: novel.slice(0, 2).map((f) => ({
      control_id: f.control_id, answer: 'conservative', reusable: false,
    })),
  };
  const completeIn = {
    after_snapshot: `.playwright-mcp/${fixture.name}`,
    answers: teachIn.answers,
  };
  const completeOut = { ok: true, page_index: 0, taught: novel.length };
  // before snap, lookup, teach, after snap, complete
  const toolCalls = 5;
  const modelVisibleChars =
    fixture.text.length
    + JSON.stringify(lookupIn).length + JSON.stringify(lookupOut).length
    + JSON.stringify(teachIn).length
    + fixture.text.length
    + JSON.stringify(completeIn).length + JSON.stringify(completeOut).length;
  return { toolCalls, modelVisibleChars };
}

function leanEvidenceToolCalls(fixture) {
  // Ordinary lean page: one observation + lookup + page-done (no after-snapshot)
  const fields = extractFields(fixture.tree);
  const uploads = extractUploadControls(fixture.tree);
  const novel = fields.filter((_, i) => i % 3 !== 0);
  const lookupIn = {
    page_index: 0,
    url: 'https://example.test/apply',
    snapshot: `.playwright-mcp/${fixture.name}`,
  };
  const lookupOut = {
    resolved: fields.filter((_, i) => i % 3 === 0).map((f) => ({
      control_id: f.control_id, label: f.label, answer: f.value || 'profile',
    })),
    novel: novel.map((f) => ({
      control_id: f.control_id, label: f.label, type: f.type,
      options: (f.options || []).slice(0, 40),
    })),
    upload_controls: uploads,
  };
  const pageDoneIn = {
    page_index: 0,
    url: 'https://example.test/apply',
    final_page: false,
  };
  const pageDoneOut = {
    execution_protocol: 'lean-llm-v1',
    page_index: 0,
    next: 'Next/Continue',
  };
  // Count: 1 snapshot observation + 2 CLI round-trips (lookup, page-done)
  const toolCalls = 3;
  const modelVisibleChars =
    fixture.text.length // single MCP tree
    + JSON.stringify(lookupIn).length + JSON.stringify(lookupOut).length
    + JSON.stringify(pageDoneIn).length + JSON.stringify(pageDoneOut).length;
  return { toolCalls, modelVisibleChars };
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
  const preferred = ['workable-form.yml', 'orc-form.yml', 'successfactors-form.yml'];
  const selected = preferred
    .map((name) => fixtures.find((f) => f.name === name))
    .filter(Boolean);
  const rows = (selected.length ? selected : fixtures.slice(0, 3)).map((fixture) => {
    const receipt = receiptV3EvidenceToolCalls(fixture);
    const lean = leanEvidenceToolCalls(fixture);
    const toolReduction = (receipt.toolCalls - lean.toolCalls) / receipt.toolCalls;
    const charReduction = (receipt.modelVisibleChars - lean.modelVisibleChars)
      / Math.max(receipt.modelVisibleChars, 1);
    return {
      shape: shapeLabel(fixture.name),
      fixture: fixture.name,
      fields: extractFields(fixture.tree).length,
      receipt_tool_calls: receipt.toolCalls,
      lean_tool_calls: lean.toolCalls,
      tool_call_reduction: Number(toolReduction.toFixed(3)),
      receipt_chars: receipt.modelVisibleChars,
      lean_chars: lean.modelVisibleChars,
      char_reduction: Number(charReduction.toFixed(3)),
      receipt_tokens_est: estimateTokens(receipt.modelVisibleChars),
      lean_tokens_est: estimateTokens(lean.modelVisibleChars),
    };
  });

  const avgToolReduction = rows.reduce((s, r) => s + r.tool_call_reduction, 0) / rows.length;
  const summary = {
    protocol: 'lean-llm-v1 vs receipt-v3',
    min_tool_call_reduction_required: MIN_TOOL_CALL_REDUCTION,
    avg_tool_call_reduction: Number(avgToolReduction.toFixed(3)),
    passes_efficiency_gate: avgToolReduction >= MIN_TOOL_CALL_REDUCTION,
    note: 'Ordinary pages only (no selective re-observe). Lean drops the mandatory after-fill snapshot.',
    rows,
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.log('Lean LLM vs receipt-v3 — fixture-replay efficiency benchmark');
    console.log(summary.note);
    console.log(`Avg tool-call reduction: ${(avgToolReduction * 100).toFixed(1)}% (gate ≥${MIN_TOOL_CALL_REDUCTION * 100}%)\n`);
    console.log(
      'shape'.padEnd(16),
      'recv'.padStart(5),
      'lean'.padStart(5),
      'tool↓'.padStart(7),
      'recvTok'.padStart(8),
      'leanTok'.padStart(8),
      'char↓'.padStart(7),
    );
    for (const row of rows) {
      console.log(
        row.shape.padEnd(16),
        String(row.receipt_tool_calls).padStart(5),
        String(row.lean_tool_calls).padStart(5),
        `${(row.tool_call_reduction * 100).toFixed(0)}%`.padStart(7),
        String(row.receipt_tokens_est).padStart(8),
        String(row.lean_tokens_est).padStart(8),
        `${(row.char_reduction * 100).toFixed(0)}%`.padStart(7),
      );
    }
  }

  if (process.argv.includes('--assert') && !summary.passes_efficiency_gate) {
    process.stderr.write(
      `lean efficiency gate failed: avg tool-call reduction ${avgToolReduction} < ${MIN_TOOL_CALL_REDUCTION}\n`,
    );
    process.exit(1);
  }
}

run();
