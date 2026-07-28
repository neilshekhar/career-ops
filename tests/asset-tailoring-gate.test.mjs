#!/usr/bin/env node
/**
 * tests/asset-tailoring-gate.test.mjs — Finding 3 acceptance tests.
 *
 * Two defences against the reported npm failure (a user uploading their OWN
 * local CV because career-ops generated nothing role-specific):
 *
 *   A. Fail-closed upload evidence at lean finish. A finished run must prove,
 *      per observed upload control, WHICH generated role asset went in — by
 *      content hash. A local source document can never satisfy it.
 *   B. Contextual role tailoring. Identical normalized CV text triggers a
 *      deterministic check against the roles' stored requirements; it fails only
 *      when the roles differ materially and no valid reuse justification exists.
 *
 * Both are zero-token: no validator here may call a model.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, ROOT } from './helpers.mjs';

const IS_CHILD = process.env.CAREER_OPS_TAILORING_CHILD === '1';

async function runIsolated() {
console.log('\nAsset fail-closed and contextual tailoring gates');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-tailoring-'));
const dataDir = join(temp, 'data');
mkdirSync(dataDir, { recursive: true });
for (const dir of ['config', 'modes', 'output', 'jds', 'reports', 'source-docs']) {
  mkdirSync(join(temp, dir), { recursive: true });
}

process.env.NODE_ENV = 'test';
process.env.CAREER_OPS_QUEUE_BACKEND = 'local';
process.env.CAREER_OPS_DATA_DIR = dataDir;
process.env.CAREER_OPS_HANDOVER_PATH = join(temp, 'handover.md');
process.env.CAREER_OPS_TEST_PROJECT_ROOT = temp;

writeFileSync(join(temp, 'handover.md'), '# Handover\n\n## Session Log\n', 'utf8');
writeFileSync(join(temp, 'cv.md'), '# CV\nSQL analysis, forecasting, stakeholder reporting.\n', 'utf8');
writeFileSync(join(temp, 'modes', '_profile.md'), '# Profile\n', 'utf8');
writeFileSync(join(temp, 'modes', '_custom.md'), '# Rules\n', 'utf8');
writeFileSync(join(temp, 'voice-dna.md'), '# Voice\nClear and direct.\n', 'utf8');
writeFileSync(join(temp, 'config', 'profile.yml'), [
  'candidate:',
  '  full_name: Test Candidate',
  'application_quality:',
  '  require_fresh_assets: false',
  '  cover_body_words_min: 1',
  '  cover_body_words_max: 500',
  '  cover_required_formats: [md, pdf]',
  '  require_role_tailored_cv: true',
  '',
].join('\n'), 'utf8');

try {
  const {
    buildPdfLayoutEvidence, persistPdfLayoutEvidence, printablePageBox,
  } = await import('../generation-provenance.mjs');
  const { buildMarkdown } = await import('../generate-cover-markdown.mjs');
  const store = await import('../queue-store.mjs');
  const lean = await import('../lean-application.mjs');
  const tailoring = await import('../cv-tailoring.mjs');
  const { applicationQualityConfig, validateApplicationRole } = await import('../verify-userdata.mjs');
  const { loadApplicationProfile } = await import('../application-source-contract.mjs');

  const PDF = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
  function writePdf(path) {
    writeFileSync(path, PDF);
    const printable = printablePageBox('a4');
    persistPdfLayoutEvidence(path, buildPdfLayoutEvidence({
      pdfPath: path,
      pdfBuffer: PDF,
      format: 'a4',
      pageCount: 1,
      measurement: { top_px: 0, bottom_px: printable.height_px * 0.9, height_px: printable.height_px * 0.9 },
      measuredAt: new Date('2026-07-16T00:00:00.000Z'),
    }));
  }

  const jdText = (
    'The team needs an analyst to deliver reliable SQL reporting, translate stakeholder '
    + 'requirements, validate data quality, document decisions, and communicate findings. '
  ).repeat(6);
  writeFileSync(join(temp, 'jds', 'analyst.md'), jdText, 'utf8');

  /**
   * Build a role with a full asset set. `cvBody` controls the visible CV text so
   * two roles can deliberately share (or not share) identical content.
   */
  function makeRole(id, company, cvBody, coverOpening, requirements, extra = {}) {
    writePdf(join(temp, 'output', `${id}-cv.pdf`));
    writePdf(join(temp, 'output', `${id}-cover.pdf`));
    writeFileSync(join(temp, 'output', `${id}-cv.html`),
      `<html><head><meta name="career-ops-template-id" content="cv-template">`
      + `<meta name="career-ops-template-version" content="1"></head><body>${cvBody}</body></html>`,
      'utf8');
    const payload = {
      candidate: { name: 'Test Candidate' },
      letter: {
        company,
        role_title: 'Analyst',
        locale: 'en',
        opening: coverOpening,
        profile_intro: 'I bring reliable SQL reporting and stakeholder communication.',
        achievements: [],
        problems_section: '',
        closing: 'Thank you for reviewing my application.',
      },
    };
    writeFileSync(join(temp, 'output', `${id}-cover.md`), buildMarkdown(payload), 'utf8');
    writeFileSync(join(temp, 'output', `${id}-cover.payload.json`), JSON.stringify(payload), 'utf8');
    return {
      id,
      company,
      title: 'Analyst',
      url: `https://jobs.example.test/${id}`,
      status: 'prepared',
      score: 4.4,
      flags: [],
      employment_type: 'full-time',
      jd_path: 'jds/analyst.md',
      jd_text: jdText,
      cv_pdf: `output/${id}-cv.pdf`,
      cover_letter_paths: {
        md: `output/${id}-cover.md`,
        pdf: `output/${id}-cover.pdf`,
        payload: `output/${id}-cover.payload.json`,
      },
      application_quality_review: {
        top_requirements: requirements.map((requirement) => ({
          requirement, evidence: 'SQL analysis', source: 'cv.md',
        })),
        company_specific_references: [company, 'Analyst'],
        reviewed_at: '2026-07-28T00:00:00.000Z',
      },
      ...extra,
    };
  }

  // ═══ A. Fail-closed upload evidence at lean finish ═══════════════════════
  const SHARED_CV = 'SQL analysis, forecasting and stakeholder reporting for the analytics team.';
  const roleA = makeRole('up-a', 'Alpha Co', SHARED_CV, 'I am applying to Alpha Co for analytics.',
    ['sql reporting', 'stakeholder communication', 'data quality']);

  const reportRel = 'reports/300-alpha-co-analyst-2026-07-28.md';
  writeFileSync(join(temp, reportRel), '# Alpha Co — Analyst\n\n**URL:** https://jobs.example.test/up-a\n', 'utf8');

  writeFileSync(join(dataDir, 'apply-queue.json'), `${JSON.stringify({
    version: 1,
    settings: {
      application_controller: {
        version: 1, controller: 'active-agent',
        controller_id: 'browser-controller:test', max_active_roles: 4,
      },
    },
    roles: [{
      ...roleA,
      application_progress: {
        run_id: 'run-a',
        execution_protocol: 'lean-llm-v1',
        verification_mode: 'selective',
        receipt_required: false,
        tab: { id: 'tab-1' },
        lean_pages: [{
          page_index: 0,
          url: 'https://jobs.example.test/up-a',
          label: 'page-0',
          completed: true,
          attachments_handled: true,
          warnings: [],
          final_page: true,
          recorded_at: '2026-07-28T00:00:00.000Z',
          // An enabled, REQUIRED CV upload control was really observed here.
          upload_controls: [{
            control_id: 'resume-upload',
            label: 'Resume/CV',
            kind: 'cv',
            required: true,
            multiple: false,
            enabled: true,
            accepts: '.pdf',
          }],
          displayed_filenames: ['up-a-cv.pdf'],
        }],
      },
    }],
  }, null, 2)}\n`, 'utf8');

  const finishBase = {
    final_url: 'https://jobs.example.test/up-a/review',
    final_control: 'Submit application',
    application_answers_report: reportRel,
    important_answers: [],
  };
  const roleCvSha = createHash('sha256')
    .update(readFileSync(join(temp, 'output', 'up-a-cv.pdf'))).digest('hex');
  const roleCoverSha = createHash('sha256')
    .update(readFileSync(join(temp, 'output', 'up-a-cover.pdf'))).digest('hex');

  // A1: no attachment evidence at all, while a required control was observed.
  assert.throws(
    () => lean.finishLean('up-a', { ...finishBase }),
    /required upload control "resume-upload".*has no verified attachment evidence/s,
  );
  pass('lean finish rejects a run with a required upload control and no attachment evidence');

  // A2: the legacy filename-only object carries no proof — still rejected.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: { cv: 'up-a-cv.pdf', cover: 'up-a-cover.pdf' },
    }),
    /required upload control "resume-upload"/,
  );
  pass('a filename-only attachment object is not accepted as upload evidence');

  // A3: a digest must be supplied by the browser controller, rather than being
  // silently filled from whatever bytes happen to be on disk at finish time.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        verified: true,
      }],
    }),
    /asset_sha256 is required/,
  );
  pass('lean finish requires the controller-supplied content SHA-256');

  // A4: the user's OWN local CV, outside output/, is rejected outright.
  const localCv = join(temp, 'source-docs', 'my-own-cv.pdf');
  writePdf(localCv);
  const localCvSha = createHash('sha256').update(readFileSync(localCv)).digest('hex');
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'source-docs/my-own-cv.pdf',
        displayed: 'my-own-cv.pdf',
        asset_sha256: localCvSha,
        verified: true,
      }],
    }),
    /is not one of this role's generated cv_pdf\/cover_letter_paths assets/,
  );
  pass('a local source CV outside output/ can never be an upload asset');

  // A5: right asset, wrong content hash (file changed after upload).
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        asset_sha256: 'f'.repeat(64),
        verified: true,
      }],
    }),
    /content hash does not match the role asset on disk/,
  );
  pass('lean finish rejects an attachment whose content hash does not match the asset');

  // A6: the portal displays a different filename than the asset sent.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'someone-elses-cv.pdf',
        asset_sha256: roleCvSha,
        verified: true,
      }],
    }),
    /displayed filename .* does not match the expected asset/,
  );
  pass('lean finish rejects a displayed filename that is not the asset it sent');

  // A7: an unobserved control id cannot be invented.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'imaginary-control',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        asset_sha256: roleCvSha,
        verified: true,
      }],
    }),
    /never observed on this application/,
  );
  pass('lean finish rejects attachment evidence for a control that was never observed');

  // A8: `verified: false` is not evidence.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        asset_sha256: roleCvSha,
        verified: false,
      }],
    }),
    /is not verified/,
  );
  pass('lean finish rejects unverified attachment evidence');

  // A9: a generated cover PDF cannot satisfy a CV upload control.
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cover',
        expected: 'output/up-a-cover.pdf',
        displayed: 'up-a-cover.pdf',
        asset_sha256: roleCoverSha,
        verified: true,
      }],
    }),
    /attachment kind "cover" is incompatible with "cv" upload control/,
  );
  pass('a cover asset cannot satisfy a CV upload control');

  // A10: the file extension must satisfy the machine-observed accept contract.
  store.mutateQueue((queue) => {
    queue.roles[0].application_progress.lean_pages[0].upload_controls[0].accepts = '.docx';
  });
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        asset_sha256: roleCvSha,
        verified: true,
      }],
    }),
    /is not accepted by upload control/,
  );
  store.mutateQueue((queue) => {
    queue.roles[0].application_progress.lean_pages[0].upload_controls[0].accepts = '.pdf';
  });
  pass('attachment evidence must satisfy the upload control accept contract');

  // A11: a caller-typed displayed filename cannot contradict the browser snapshot.
  store.mutateQueue((queue) => {
    queue.roles[0].application_progress.lean_pages[0].displayed_filenames = ['old-local-cv.pdf'];
  });
  assert.throws(
    () => lean.finishLean('up-a', {
      ...finishBase,
      attachments: [{
        control_id: 'resume-upload',
        kind: 'cv',
        expected: 'output/up-a-cv.pdf',
        displayed: 'up-a-cv.pdf',
        asset_sha256: roleCvSha,
        verified: true,
      }],
    }),
    /was not present in the machine-observed portal filenames/,
  );
  store.mutateQueue((queue) => {
    queue.roles[0].application_progress.lean_pages[0].displayed_filenames = ['up-a-cv.pdf'];
  });
  pass('displayed filename evidence is bound to machine-observed portal filenames when present');

  // Nothing above wrote state: the role is still mid-run, not prefilled.
  assert.equal(store.loadQueue().roles.find((r) => r.id === 'up-a').status, 'prepared');
  pass('every rejected finish left the role unpromoted (no half-finished state)');

  // A12: correct receipt-grade evidence succeeds and records the content hash.
  const expectedSha = roleCvSha;
  const finished = lean.finishLean('up-a', {
    ...finishBase,
    attachments: [{
      control_id: 'resume-upload',
      kind: 'cv',
      expected: 'output/up-a-cv.pdf',
      displayed: 'up-a-cv.pdf',
      asset_sha256: expectedSha,
      verified: true,
    }],
  });
  assert.equal(finished.status, 'prefilled');
  assert.equal(finished.lean_review.attachments.length, 1);
  assert.equal(finished.lean_review.attachments[0].asset_sha256, expectedSha);
  assert.equal(finished.lean_review.attachments[0].expected, 'output/up-a-cv.pdf');
  const written = readFileSync(join(temp, reportRel), 'utf8');
  assert.match(written, /- CV: up-a-cv\.pdf \(sha256 [0-9a-f]{12}…\)/);
  pass('correct receipt-grade upload evidence finishes to prefilled and records the hash');

  // ═══ B. Contextual role tailoring ════════════════════════════════════════
  const profile = loadApplicationProfile(temp);
  const quality = applicationQualityConfig(profile);
  assert.equal(quality.requireRoleTailoredCv, true);

  const SIMILAR_REQS = ['sql reporting', 'stakeholder communication', 'data quality'];
  const DIFFERENT_REQS = ['kubernetes operations', 'incident response', 'terraform modules'];

  // B1: identical CV text + materially SIMILAR roles → allowed.
  const simA = makeRole('sim-a', 'Sim Alpha', SHARED_CV, 'Opening for Sim Alpha analytics work.', SIMILAR_REQS);
  const simB = makeRole('sim-b', 'Sim Beta', SHARED_CV, 'A different opening for Sim Beta entirely.', SIMILAR_REQS);
  let issues = validateApplicationRole(simA, {
    root: temp, profile, quality, requireAssets: true, peers: [simA, simB],
  });
  assert.equal(
    issues.filter((i) => i.code === 'cv-not-role-tailored').length, 0,
    `similar roles should share a CV freely; got ${JSON.stringify(issues.map((i) => i.code))}`,
  );
  pass('acceptance 5: identical CV text for materially similar roles is allowed');

  // Prove it is genuinely the similarity that allowed it, not a dead check.
  const simSignature = tailoring.roleRequirementSignature(simA);
  const similarity = tailoring.requirementSimilarity(
    simSignature, tailoring.roleRequirementSignature(simB), tailoring.tailoringConfig(quality),
  );
  assert.equal(similarity.similar, true);
  assert.ok(similarity.sharedRequirements.length >= 2, 'shared stored requirements are the reason');
  pass('the allow decision is backed by deterministic stored-requirement overlap');

  // B2: identical CV text + materially DIFFERENT roles + no justification → fail.
  const diffA = makeRole('diff-a', 'Diff Alpha', SHARED_CV, 'Opening for Diff Alpha analytics work.', SIMILAR_REQS);
  const diffB = makeRole('diff-b', 'Diff Beta', SHARED_CV, 'A wholly separate opening for Diff Beta.', DIFFERENT_REQS);
  issues = validateApplicationRole(diffA, {
    root: temp, profile, quality, requireAssets: true, peers: [diffA, diffB],
  });
  const untailored = issues.filter((i) => i.code === 'cv-not-role-tailored');
  assert.equal(untailored.length, 1, JSON.stringify(issues.map((i) => i.code)));
  assert.equal(untailored[0].level, 'error');
  assert.equal(untailored[0].peer_role_id, 'diff-b');
  pass('acceptance 6a: identical CV for materially different roles fails without justification');

  // B3: a valid, pair-bound justification must cite visible evidence that
  // collectively covers BOTH stored requirement sets. Validate both directions
  // so the result cannot depend on which role happens to be checked first.
  const CROSS_ROLE_CV = 'SQL analysis, stakeholder reporting, Kubernetes operations and incident response.';
  const justifiedA = makeRole(
    'just-a', 'Just Alpha', CROSS_ROLE_CV, 'Opening for Just Alpha.',
    SIMILAR_REQS,
  );
  const justifiedB = makeRole(
    'just-b', 'Just Beta', CROSS_ROLE_CV, 'Opening for Just Beta.',
    DIFFERENT_REQS,
  );
  const pairJustification = {
    covers_role_ids: ['just-a', 'just-b'],
    rationale: 'The shared CV visibly carries separate evidence for both the analytics and platform requirement sets.',
    shared_evidence: ['SQL analysis', 'Kubernetes operations'],
  };
  justifiedA.cv_reuse_justification = structuredClone(pairJustification);
  justifiedB.cv_reuse_justification = structuredClone(pairJustification);
  issues = validateApplicationRole(justifiedA, {
    root: temp, profile, quality, requireAssets: true, peers: [justifiedA, justifiedB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 0);
  issues = validateApplicationRole(justifiedB, {
    root: temp, profile, quality, requireAssets: true, peers: [justifiedA, justifiedB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 0);
  pass('acceptance 6b: a pair-bound justification with evidence for both roles allows reuse symmetrically');

  // A record found only on the peer is not part of this role's provenance or
  // short-lived quality fingerprint and therefore cannot unlock it.
  const unboundA = { ...justifiedA };
  delete unboundA.cv_reuse_justification;
  issues = validateApplicationRole(unboundA, {
    root: temp, profile, quality, requireAssets: true, peers: [unboundA, justifiedB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 1);
  pass('each role carries its own provenance-bound copy of a pair justification');

  // B4: evidence that appears in the CV but covers only one role is not enough.
  const oneSidedA = {
    ...diffA,
    cv_reuse_justification: {
      covers_role_ids: ['diff-a', 'diff-b'],
      rationale: 'This rationale is long enough but its evidence only supports the analytics requirement set.',
      shared_evidence: ['SQL analysis', 'stakeholder reporting'],
    },
  };
  issues = validateApplicationRole(oneSidedA, {
    root: temp, profile, quality, requireAssets: true, peers: [oneSidedA, diffB],
  });
  const oneSided = issues.filter((i) => i.code === 'cv-not-role-tailored');
  assert.equal(oneSided.length, 1);
  assert.match(oneSided[0].message, /does not cover stored requirements for role diff-b/);
  pass('reuse evidence present in the CV must cover both roles, not only one');

  // B5: a justification citing evidence NOT in the CV is invalid — this is what
  // stops a hand-waved rationale from unlocking anything.
  const bogusA = {
    ...diffA,
    cv_reuse_justification: {
      covers_role_ids: ['diff-a', 'diff-b'],
      rationale: 'These roles are basically the same thing and my CV covers both of them completely.',
      shared_evidence: ['kubernetes cluster administration'],
    },
  };
  issues = validateApplicationRole(bogusA, {
    root: temp, profile, quality, requireAssets: true, peers: [bogusA, diffB],
  });
  const bogus = issues.filter((i) => i.code === 'cv-not-role-tailored');
  assert.equal(bogus.length, 1);
  assert.match(bogus[0].message, /cites evidence absent from the shared CV/);
  pass('a reuse justification citing evidence absent from the CV is rejected');

  // B6: trivial substring evidence cannot unlock the gate.
  const trivialA = {
    ...diffA,
    cv_reuse_justification: {
      covers_role_ids: ['diff-a', 'diff-b'],
      rationale: 'This deliberately long rationale still cannot make a one-letter citation meaningful evidence.',
      shared_evidence: ['a'],
    },
  };
  issues = validateApplicationRole(trivialA, {
    root: temp, profile, quality, requireAssets: true, peers: [trivialA, diffB],
  });
  const trivial = issues.filter((i) => i.code === 'cv-not-role-tailored');
  assert.equal(trivial.length, 1);
  assert.match(trivial[0].message, /evidence must be at least/);
  pass('short substring evidence cannot unlock CV reuse');

  // B7: genuinely tailored CVs never trigger the check at all.
  const tailoredA = makeRole('tail-a', 'Tail Alpha',
    'SQL analysis and forecasting for retail demand planning.', 'Opening for Tail Alpha.', SIMILAR_REQS);
  const tailoredB = makeRole('tail-b', 'Tail Beta',
    'Kubernetes operations, incident response and Terraform modules.', 'Opening for Tail Beta.', DIFFERENT_REQS);
  issues = validateApplicationRole(tailoredA, {
    root: temp, profile, quality, requireAssets: true, peers: [tailoredA, tailoredB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 0);
  assert.equal(issues.filter((i) => i.code === 'cover-not-company-specific').length, 0);
  pass('genuinely role-tailored CVs and covers raise nothing');

  // B8: cover letters are stricter — identical body across companies fails.
  const dupCoverA = makeRole('cov-a', 'Cover Alpha', 'CV text alpha only.', 'One generic opening reused everywhere.', SIMILAR_REQS);
  const dupCoverB = makeRole('cov-b', 'Cover Beta', 'CV text beta only.', 'One generic opening reused everywhere.', SIMILAR_REQS);
  issues = validateApplicationRole(dupCoverA, {
    root: temp, profile, quality, requireAssets: true, peers: [dupCoverA, dupCoverB],
  });
  const dupCover = issues.filter((i) => i.code === 'cover-not-company-specific');
  assert.equal(dupCover.length, 1, JSON.stringify(issues.map((i) => i.code)));
  assert.equal(dupCover[0].level, 'error', 'cover duplication is always an error, never a warning');
  pass('acceptance 8: identical cover bodies across different companies fail');

  // B9: a flag alone is not proof of a duplicate requisition.
  const routeA = { ...dupCoverA, flags: ['duplicate-route'] };
  issues = validateApplicationRole(routeA, {
    root: temp, profile, quality, requireAssets: true, peers: [routeA, dupCoverB],
  });
  assert.equal(issues.filter((i) => i.code === 'cover-not-company-specific').length, 1);
  pass('a duplicate-route flag alone cannot exempt a recycled cross-company cover');

  // B10: a proven same-company requisition reached through two routes is exempt.
  const confirmedRouteA = makeRole(
    'route-a', 'Route Company', 'Route A CV.', 'One route-specific body.', SIMILAR_REQS,
    { requisition_id: 'REQ-42' },
  );
  const confirmedRouteB = makeRole(
    'route-b', 'Route Company', 'Route B CV.', 'One route-specific body.', SIMILAR_REQS,
    { requisition_id: 'REQ-42', url: 'https://alternate.example.test/REQ-42' },
  );
  issues = validateApplicationRole(confirmedRouteA, {
    root: temp, profile, quality, requireAssets: true, peers: [confirmedRouteA, confirmedRouteB],
  });
  assert.equal(issues.filter((i) => i.code === 'cover-not-company-specific').length, 0);
  pass('only a proven same-company requisition is exempt from the duplicate-cover rule');

  // B11: domain and employment type are decisive materiality axes even when
  // generic requirement phrases overlap.
  const domainA = makeRole('domain-a', 'Domain A', SHARED_CV, 'Domain A opening.', SIMILAR_REQS);
  const domainB = makeRole('domain-b', 'Domain B', SHARED_CV, 'Domain B opening.', SIMILAR_REQS);
  domainA.application_quality_review.domain = 'retail analytics';
  domainB.application_quality_review.domain = 'site reliability';
  issues = validateApplicationRole(domainA, {
    root: temp, profile, quality, requireAssets: true, peers: [domainA, domainB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 1);
  assert.match(issues.find((i) => i.code === 'cv-not-role-tailored').message, /domain differs/);

  const contractB = {
    ...domainB,
    application_quality_review: {
      ...domainA.application_quality_review,
      domain: domainA.application_quality_review.domain,
    },
    employment_type: 'contract',
  };
  issues = validateApplicationRole(domainA, {
    root: temp, profile, quality, requireAssets: true, peers: [domainA, contractB],
  });
  assert.equal(issues.filter((i) => i.code === 'cv-not-role-tailored').length, 1);
  assert.match(issues.find((i) => i.code === 'cv-not-role-tailored').message, /employment type differs/);
  pass('domain and employment-type conflicts override generic requirement overlap');

  // B12: warn-not-fail only under an explicit per-user opt-out.
  const lenient = applicationQualityConfig({
    ...profile,
    application_quality: { ...profile.application_quality, require_role_tailored_cv: false },
  });
  issues = validateApplicationRole(diffA, {
    root: temp, profile, quality: lenient, requireAssets: true, peers: [diffA, diffB],
  });
  const lenientFindings = issues.filter((i) => i.code === 'cv-not-role-tailored');
  assert.equal(lenientFindings.length, 1);
  assert.equal(lenientFindings[0].level, 'warning');
  pass('require_role_tailored_cv:false downgrades the CV finding to a warning');

  // B13: no peers means nothing to compare, and that is not a failure.
  issues = validateApplicationRole(diffA, {
    root: temp, profile, quality, requireAssets: true, peers: [],
  });
  assert.equal(issues.filter((i) => i.code.startsWith('cv-not-role')).length, 0);
  pass('a role with no comparable peers raises no tailoring finding');

  // ═══ Zero-token guarantee ════════════════════════════════════════════════
  const tailoringSrc = readFileSync(join(ROOT, 'cv-tailoring.mjs'), 'utf8');
  assert.doesNotMatch(tailoringSrc, /generative-ai|openai|anthropic|fetch\(|http[s]?:\/\/api/i);
  assert.doesNotMatch(tailoringSrc, /\bawait\s+(?:fetch|generate|complete)\b/);
  pass('the tailoring validator makes zero model calls (acceptance 7)');
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
}

if (IS_CHILD) {
  await runIsolated();
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_TAILORING_CHILD: '1', NODE_ENV: 'test' },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.stdout || 'tailoring child failed\n');
    process.exit(child.status || 1);
  }
  process.stdout.write(child.stdout);
  pass('fail-closed upload evidence + contextual CV/cover tailoring gates hold');
}
