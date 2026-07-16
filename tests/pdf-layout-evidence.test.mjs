#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pass } from './helpers.mjs';
import {
  buildPdfLayoutEvidence,
  MIN_ONE_PAGE_UTILIZATION,
  persistPdfLayoutEvidence,
  printablePageBox,
  validatePdfLayoutEvidence,
} from '../generation-provenance.mjs';

console.log('\nPDF printable-height utilisation evidence');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-pdf-layout-'));
const pdfPath = join(temp, 'synthetic.pdf');
const pdf = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
const printable = printablePageBox('a4');

try {
  writeFileSync(pdfPath, pdf);
  const sparse = buildPdfLayoutEvidence({
    pdfPath,
    pdfBuffer: pdf,
    format: 'a4',
    pageCount: 1,
    measurement: {
      top_px: 0,
      bottom_px: printable.height_px * 0.3,
      height_px: printable.height_px * 0.3,
    },
    measuredAt: new Date('2026-07-16T00:00:00.000Z'),
  });
  persistPdfLayoutEvidence(pdfPath, sparse);
  assert.throws(
    () => validatePdfLayoutEvidence(pdfPath),
    (error) => error.code === 'PDF_LAYOUT_UNDERFILLED' && /30\.0%/.test(error.message),
  );
  pass('synthetic sparse one-page PDF fails the 75% printable-height gate');

  const wellFilled = buildPdfLayoutEvidence({
    pdfPath,
    pdfBuffer: pdf,
    format: 'a4',
    pageCount: 1,
    measurement: {
      top_px: 0,
      bottom_px: printable.height_px * 0.82,
      height_px: printable.height_px * 0.82,
    },
    measuredAt: new Date('2026-07-16T00:01:00.000Z'),
  });
  persistPdfLayoutEvidence(pdfPath, wellFilled);
  const validated = validatePdfLayoutEvidence(pdfPath);
  assert.equal(validated.evidence.printable_height_utilization, 0.82);
  assert(validated.evidence.printable_height_utilization >= MIN_ONE_PAGE_UTILIZATION);
  pass('synthetic 82%-filled one-page PDF passes with durable hash-bound evidence');

  writeFileSync(pdfPath, Buffer.concat([pdf, Buffer.from('\ntampered')]));
  assert.throws(
    () => validatePdfLayoutEvidence(pdfPath),
    (error) => error.code === 'PDF_LAYOUT_EVIDENCE_INVALID' && /current PDF bytes/.test(error.message),
  );
  pass('layout evidence cannot be reused after the PDF bytes change');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
