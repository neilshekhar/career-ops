#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadQueue } from './queue-store.mjs';

export const APPLICATION_ANSWERS_HEADING = '## Application Answers';

// Formatting helpers can render receipt-owned lifecycle states when they are
// reading an existing snapshot, but this CLI may author only the pre-finalizer
// checkpoint (`prefilled`). `application-receipt.mjs` alone promotes receipt-v3
// runs to `filled`; lean-llm-v1 finishes at `prefilled` and never promotes to
// receipt-backed `filled`. The candidate-confirmation path alone promotes to
// `submitted`.
const VALID_STATES = new Set(['prefilled', 'filled', 'submitted']);
const CLI_AUTHORABLE_STATE = 'prefilled';

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function valueText(value) {
  if (Array.isArray(value)) return value.map(inline).filter(Boolean).join(', ');
  return String(value ?? '').trim();
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(state) {
  const normalized = inline(state || 'prefilled').toLowerCase();
  if (!VALID_STATES.has(normalized)) {
    throw new Error(`Application answer state must be one of: ${[...VALID_STATES].join(', ')}`);
  }
  return normalized;
}

function normalizeDate(date) {
  return inline(date || new Date().toISOString().slice(0, 10));
}

function quoteBlock(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '> Not recorded.';
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function metadataLines(entry) {
  const page = inline(pick(entry, ['page', 'page_id', 'page_number', 'checkpoint']));
  const pageIndex = entry?.page_index ?? entry?.pageIndex;
  const controlId = inline(entry?.control_id ?? entry?.controlId);
  const occurrence = entry?.occurrence;
  const provenance = inline(pick(entry, ['provenance', 'source']));
  const resolution = inline(entry?.resolution);
  const taught = entry?.taught;
  const reviewRequired = entry?.review_required === true;
  const reviewNote = inline(pick(entry, ['review_note', 'review']));
  const hasReviewMetadata = entry?.review_required === true ||
    entry?.review_required === false ||
    Object.prototype.hasOwnProperty.call(entry ?? {}, 'review_note') ||
    Object.prototype.hasOwnProperty.call(entry ?? {}, 'review');
  return [
    page ? `- Page: ${page}` : '',
    pageIndex !== undefined && pageIndex !== null && String(pageIndex).trim()
      ? `- Page index: ${pageIndex}`
      : '',
    controlId ? `- Control ID: ${controlId}` : '',
    occurrence !== undefined && occurrence !== null && String(occurrence).trim()
      ? `- Occurrence: ${occurrence}`
      : '',
    provenance ? `- Provenance: ${provenance}` : '',
    resolution ? `- Resolution: ${resolution}` : '',
    (taught === true || taught === false) ? `- Taught: ${taught ? 'yes' : 'no'}` : '',
    (entry?.review_required === true || entry?.review_required === false)
      ? `- Review required: ${reviewRequired ? 'yes' : 'no'}`
      : '',
    hasReviewMetadata ? `- Review note: ${reviewNote || '(none)'}` : '',
  ].filter(Boolean);
}

function qaLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.flatMap((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const answer = pick(entry, valueKeys);
    const metadata = metadataLines(entry);
    return [
      `${index + 1}. **${label}**`,
      '',
      quoteBlock(answer),
      ...(metadata.length ? ['', ...metadata] : []),
      '',
    ];
  }).slice(0, -1);
}

function compactLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.flatMap((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const raw = pick(entry, valueKeys);
    // Preserve intentional blanks from the receipt (middle name, honeypot, etc.).
    // `Not recorded` is only for missing keys — never for an empty-string answer.
    const value = raw == null ? 'Not recorded'
      : (valueText(raw) === '' ? '(blank)' : valueText(raw));
    return [
      `${index + 1}. **${label}:** ${value}`,
      ...metadataLines(entry).map((line) => `   ${line}`),
    ];
  });
}

function fileLines(entries) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.map((entry, index) => {
    const label = inline(pick(entry, ['field', 'name', 'label', 'type'])) || `File ${index + 1}`;
    const file = inline(pick(entry, ['path', 'file', 'filename', 'url'])) || 'Not recorded';
    const version = inline(pick(entry, ['version', 'variant']));
    const expected = inline(entry?.expected);
    const verified = entry?.verified === true ? 'verified' : entry?.verified === false ? 'not verified' : '';
    const details = [version, expected ? `expected ${expected}` : '', verified].filter(Boolean).join('; ');
    return `${index + 1}. **${label}:** ${file}${details ? ` (${details})` : ''}`;
  });
}

export function normalizeApplicationAnswersSnapshot(snapshot = {}) {
  return {
    date: normalizeDate(snapshot.date),
    state: normalizeState(snapshot.state),
    runId: inline(snapshot.runId ?? snapshot.run_id),
    pageCount: snapshot.pageCount ?? snapshot.page_count ?? null,
    leanPageCount: snapshot.leanPageCount ?? snapshot.lean_page_count ?? null,
    executionProtocol: inline(snapshot.executionProtocol ?? snapshot.execution_protocol) || null,
    freeText: list(snapshot.freeText ?? snapshot.freeTextAnswers ?? snapshot.answers),
    selections: list(snapshot.selections ?? snapshot.selectedOptions),
    fieldValues: list(snapshot.fieldValues ?? snapshot.otherFields ?? snapshot.fields),
    files: list(snapshot.files ?? snapshot.uploads ?? snapshot.filesUsed),
  };
}

export function snapshotFromApplicationProgress(progress, options = {}) {
  const lean = progress?.execution_protocol === 'lean-llm-v1'
    || options.execution_protocol === 'lean-llm-v1';
  if (lean) {
    // Lean finishes without a page-receipt ledger; compact review is authored
    // from lean_pages + caller-supplied important/review answers.
    const pages = Array.isArray(progress?.lean_pages) ? progress.lean_pages : [];
    if (!progress || pages.length === 0) {
      throw new Error('Lean application progress with at least one lean page is required');
    }
    const review = progress.lean_review || {};
    const important = list(options.important_answers ?? review.important_answers);
    const reviewRequired = list(options.review_required ?? review.review_required ?? progress.review_required);
    const longFormImportant = important.filter(
      (item) => /textarea|long|essay|cover|why|motivat/i.test(String(item.label ?? item.question ?? '')),
    );
    return {
      date: options.date || new Date().toISOString().slice(0, 10),
      state: 'prefilled',
      runId: progress.run_id,
      pageCount: 0,
      leanPageCount: pages.length,
      executionProtocol: 'lean-llm-v1',
      freeText: longFormImportant,
      selections: [],
      fieldValues: [
        // Long-form answers already render in the free-text section above;
        // listing them here too would emit a duplicate label for one answer.
        ...important.filter((item) => !longFormImportant.includes(item)).map((item) => ({
          question: item.label ?? item.question,
          answer: item.answer,
          provenance: item.source,
        })),
        ...reviewRequired.map((item) => ({
          question: item.label ?? item.question,
          answer: item.answer ?? '',
          review_required: true,
          review_note: item.note ?? item.review_note,
        })),
      ],
      files: list(options.files ?? Object.entries(review.attachments || {}).map(([kind, path]) => ({
        kind, path: typeof path === 'string' ? path : path?.path,
      }))),
    };
  }
  if (!progress || !Array.isArray(progress.pages) || progress.pages.length === 0) {
    throw new Error('Application progress with at least one page receipt is required');
  }
  const freeText = [];
  const selections = [];
  const fieldValues = [];
  const files = [];
  const seenFiles = new Set();
  const labelOccurrences = new Map();

  const pages = [...progress.pages].sort((left, right) => left.page_index - right.page_index);
  for (const page of pages) {
    for (const field of page.fields ?? []) {
      const occurrenceKey = normalizeApplicationAnswerLabel(field.label);
      const occurrence = (labelOccurrences.get(occurrenceKey) ?? 0) + 1;
      labelOccurrences.set(occurrenceKey, occurrence);
      const entry = {
        question: field.label,
        field: field.label,
        answer: field.answer,
        value: field.answer,
        selection: field.answer,
        page: page.page_id,
        page_index: page.page_index,
        control_id: field.control_id,
        occurrence,
        provenance: field.provenance,
        resolution: field.resolution,
        taught: field.taught,
        review_required: field.review_required,
        review_note: field.review_note,
      };
      if (/textarea/i.test(field.type)) freeText.push(entry);
      else if (/select|radio|checkbox/i.test(field.type)) selections.push(entry);
      else fieldValues.push(entry);
    }
    for (const attachment of page.attachments ?? []) {
      const key = `${attachment.kind}:${attachment.displayed}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push({
        field: attachment.kind,
        path: attachment.displayed,
        expected: attachment.expected,
        verified: attachment.verified,
      });
    }
  }

  return {
    date: options.date,
    state: options.state ?? 'prefilled',
    runId: progress.run_id,
    pageCount: pages.length,
    freeText,
    selections,
    fieldValues,
    files,
  };
}

export function formatApplicationAnswersSection(snapshot = {}) {
  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const lean = normalized.executionProtocol === 'lean-llm-v1';
  const lines = [
    APPLICATION_ANSWERS_HEADING,
    '',
    `**Date:** ${normalized.date}`,
    `**State:** ${normalized.state}`,
    ...(lean ? ['**Execution protocol:** lean-llm-v1'] : []),
    ...(normalized.runId ? [`**Run ID:** ${normalized.runId}`] : []),
    ...(normalized.pageCount != null ? [`**Receipt pages:** ${normalized.pageCount}`] : []),
    ...(lean && normalized.leanPageCount != null
      ? [`**Lean pages completed:** ${normalized.leanPageCount}`]
      : []),
    '',
    lean ? '### Important / screening answers' : '### Free-text answers',
    '',
    ...qaLines(normalized.freeText, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Answer',
    }),
    '',
    lean ? '### Selections (if any)' : '### Selections made',
    '',
    ...compactLines(normalized.selections, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['selection', 'selected', 'answer', 'value', 'options'],
      fallback: 'Selection',
    }),
    '',
    lean ? '### Review-required / other answers' : '### Other field values',
    '',
    ...compactLines(normalized.fieldValues, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Field',
    }),
    '',
    '### Files used',
    '',
    ...fileLines(normalized.files),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function upsertApplicationAnswersSection(reportText, snapshot = {}) {
  const report = String(reportText ?? '').replace(/\r\n/g, '\n');
  const section = formatApplicationAnswersSection(snapshot).trimEnd();
  const heading = /^## Application Answers\s*$/m.exec(report);

  if (!heading) {
    return `${report.trimEnd()}\n\n${section}\n`;
  }

  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const nextHeading = /^## .+$/m.exec(report.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : report.length;
  const before = report.slice(0, start).trimEnd();
  const after = report.slice(end).trimStart();

  return [before, section, after].filter(Boolean).join('\n\n') + '\n';
}

/**
 * Locate the one canonical additive Application Answers section. Returning
 * offsets lets receipt-owned state transitions edit that section without
 * accidentally matching similarly named metadata in an evaluation block.
 */
export function locateApplicationAnswersSection(reportText) {
  const source = String(reportText ?? '').replace(/\r\n/g, '\n');
  const headings = [...source.matchAll(/^## Application Answers[ \t]*$/gm)];
  if (headings.length === 0) {
    throw new Error('application_answers_report is missing the ## Application Answers section');
  }
  if (headings.length !== 1) {
    throw new Error('application_answers_report must contain exactly one ## Application Answers section');
  }
  const start = headings[0].index;
  const afterHeading = start + headings[0][0].length;
  const nextHeading = /^##\s+.+$/m.exec(source.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : source.length;
  return { source, start, end, section: source.slice(start, end).trimEnd() };
}

export function normalizeApplicationAnswerLabel(value) {
  return inline(value);
}

export function normalizeApplicationAnswerValue(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (text === '(blank)') return '';
  return text;
}

function uniqueSectionMetadata(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...section.matchAll(new RegExp(
    `^\\*\\*${escaped}:\\*\\*[ \\t]*([^\\n]+?)[ \\t]*$`,
    'gmi',
  ))];
  if (matches.length > 1) throw new Error(`Application Answers ${label} metadata is duplicated`);
  return matches[0]?.[1]?.trim() ?? null;
}

const FIELD_SECTION_NAMES = new Set([
  // receipt-v3 section vocabulary
  'free-text answers',
  'selections made',
  'other field values',
  // lean-llm-v1 compact-review vocabulary (lean-application.mjs writes the same
  // headings and the same entry metadata keys, so one parser reads both records)
  'important / screening answers',
  'selections (if any)',
  'review-required / other answers',
]);

const ENTRY_METADATA_KEYS = new Map([
  ['page', 'page'],
  ['page index', 'page_index'],
  ['control id', 'control_id'],
  ['occurrence', 'occurrence'],
  ['provenance', 'provenance'],
  ['resolution', 'resolution'],
  ['taught', 'taught'],
  ['review required', 'review_required'],
  ['review note', 'review_note'],
]);

function yesNo(value, name) {
  const normalized = inline(value).toLowerCase();
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
  throw new Error(`Application Answers ${name} metadata must be yes or no`);
}

function integerMetadata(value, name, { positive = false } = {}) {
  const normalized = inline(value);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Application Answers ${name} metadata must be an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) {
    throw new Error(`Application Answers ${name} metadata is out of range`);
  }
  return parsed;
}

function parseEntryMetadata(lines, start, sectionName) {
  const raw = {};
  let cursor = start;
  while (cursor < lines.length) {
    if (!lines[cursor].trim()) {
      cursor += 1;
      continue;
    }
    if (/^###\s+/.test(lines[cursor]) || /^\d+\.\s+/.test(lines[cursor])) break;
    const match = /^\s*-\s+([^:]+):[ \t]*(.*)$/.exec(lines[cursor]);
    if (!match) break;
    const canonical = ENTRY_METADATA_KEYS.get(inline(match[1]).toLowerCase());
    if (!canonical) {
      throw new Error(
        `Application Answers contains unexpected ${sectionName} entry metadata: ${inline(match[1])}`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(raw, canonical)) {
      throw new Error(`Application Answers entry metadata is duplicated: ${inline(match[1])}`);
    }
    raw[canonical] = match[2];
    cursor += 1;
  }

  return {
    cursor,
    metadata: {
      page: Object.prototype.hasOwnProperty.call(raw, 'page') ? inline(raw.page) : undefined,
      page_index: Object.prototype.hasOwnProperty.call(raw, 'page_index')
        ? integerMetadata(raw.page_index, 'Page index')
        : undefined,
      control_id: Object.prototype.hasOwnProperty.call(raw, 'control_id')
        ? inline(raw.control_id)
        : undefined,
      occurrence: Object.prototype.hasOwnProperty.call(raw, 'occurrence')
        ? integerMetadata(raw.occurrence, 'Occurrence', { positive: true })
        : undefined,
      provenance: Object.prototype.hasOwnProperty.call(raw, 'provenance')
        ? inline(raw.provenance).toLowerCase()
        : undefined,
      resolution: Object.prototype.hasOwnProperty.call(raw, 'resolution')
        ? inline(raw.resolution).toLowerCase()
        : undefined,
      taught: Object.prototype.hasOwnProperty.call(raw, 'taught')
        ? yesNo(raw.taught, 'Taught')
        : undefined,
      review_required: Object.prototype.hasOwnProperty.call(raw, 'review_required')
        ? yesNo(raw.review_required, 'Review required')
        : undefined,
      review_note: Object.prototype.hasOwnProperty.call(raw, 'review_note')
        ? (inline(raw.review_note) === '(none)' ? null : inline(raw.review_note))
        : undefined,
    },
  };
}

/**
 * Parse the canonical receipt-bound field entries from the exact Application
 * Answers section. Attachments remain a separate report subsection and are not
 * returned as form controls.
 */
export function parseApplicationAnswersSection(reportText) {
  const located = locateApplicationAnswersSection(reportText);
  const lines = located.section.split('\n');
  const entries = [];
  let activeSection = '';

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^###\s+(.+?)[ \t]*$/.exec(lines[index]);
    if (heading) {
      activeSection = inline(heading[1]).toLowerCase();
      continue;
    }
    if (!FIELD_SECTION_NAMES.has(activeSection)) continue;

    const compact = /^\d+\.\s+\*\*(.+):\*\*[ \t]+(.*)$/.exec(lines[index]);
    if (compact) {
      const parsedMetadata = parseEntryMetadata(lines, index + 1, activeSection);
      entries.push({
        label: normalizeApplicationAnswerLabel(compact[1]),
        answer: normalizeApplicationAnswerValue(compact[2]),
        representation: 'compact',
        section: activeSection,
        ...parsedMetadata.metadata,
      });
      index = parsedMetadata.cursor - 1;
      continue;
    }

    const quoted = /^\d+\.\s+\*\*(.+?)\*\*[ \t]*$/.exec(lines[index]);
    if (!quoted) continue;
    const answerLines = [];
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    while (cursor < lines.length) {
      const line = /^>[ \t]?(.*)$/.exec(lines[cursor]);
      if (!line) break;
      answerLines.push(line[1]);
      cursor += 1;
    }
    if (answerLines.length > 0) {
      const parsedMetadata = parseEntryMetadata(lines, cursor, activeSection);
      entries.push({
        label: normalizeApplicationAnswerLabel(quoted[1]),
        answer: normalizeApplicationAnswerValue(answerLines.join('\n')),
        representation: 'quoted',
        section: activeSection,
        ...parsedMetadata.metadata,
      });
      index = parsedMetadata.cursor - 1;
      continue;
    }
    throw new Error(`Application Answers field entry has no answer: ${normalizeApplicationAnswerLabel(quoted[1])}`);
  }

  return {
    ...located,
    state: uniqueSectionMetadata(located.section, 'State'),
    runId: uniqueSectionMetadata(located.section, 'Run ID'),
    pageCount: uniqueSectionMetadata(located.section, 'Receipt pages'),
    entries,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node application-answers.mjs --report <report.md> (--input <answers.json> | --role <queue-role-id>) [--state prefilled] [--date YYYY-MM-DD]',
    '',
    'The input JSON may contain: freeText, selections, fieldValues, files, date, state.',
    '--role builds the snapshot directly from that role\'s durable application_progress pages.',
  ].join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.report || (!args.input && !args.role) || (args.input && args.role)) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  let snapshot;
  if (args.role) {
    const role = loadQueue().roles.find((item) => item.id === args.role);
    if (!role) throw new Error(`Queue role not found: ${args.role}`);
    snapshot = snapshotFromApplicationProgress(role.application_progress, {
      date: args.date,
      state: args.state || 'prefilled',
    });
  } else {
    const inputText = args.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(resolve(args.input), 'utf-8');
    const input = JSON.parse(inputText);
    snapshot = {
      ...input,
      date: args.date || input.date,
      state: args.state || input.state,
    };
  }
  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  if (normalized.state !== CLI_AUTHORABLE_STATE) {
    throw new Error(
      `State: ${normalized.state} cannot be authored by application-answers.mjs; ` +
      'write prefilled, then use the receipt finalizer and candidate-confirmation paths',
    );
  }
  const reportPath = resolve(args.report);
  const updated = upsertApplicationAnswersSection(readFileSync(reportPath, 'utf-8'), normalized);
  writeFileSync(reportPath, updated, 'utf-8');

  console.log(JSON.stringify({ report: reportPath, date: normalized.date, state: normalized.state }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
