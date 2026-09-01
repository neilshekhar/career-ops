#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applicationQualityConfig,
  createApplicationQualityEvidence,
  identityMatches,
  namedClaims,
  validateApplicationRole,
  validateApplicationQualityEvidence,
  verifyUserData,
  wordCount,
} from '../verify-userdata.mjs';
import {
  buildApplicationSourceSnapshot,
  candidateClaimCorpus,
  candidateToolClaimCorpus,
  loadApplicationProfile,
  missingRequiredApplicationSources,
  resolveApplicationAsset,
  resolveCandidateEvidenceSource,
  resolveJdSource,
  resolveOptionalApplicationInput,
  resolveRoleJdInput,
} from '../application-source-contract.mjs';
import { recordCandidateSelectionOverride } from '../queue-store.mjs';
import { buildMarkdown } from '../generate-cover-markdown.mjs';
import {
  buildPdfLayoutEvidence,
  buildGenerationProvenance,
  BATCH_DRAFT_FLOW,
  isAllowedBatchAssetModel,
  isAllowedReleaseEffort,
  isAllowedReleaseGenerator,
  isAllowedReleaseModelEffort,
  persistPdfLayoutEvidence,
  printablePageBox,
  releaseModelPolicy,
} from '../generation-provenance.mjs';

const root = mkdtempSync(join(tmpdir(), 'career-ops-userdata-'));
const PDF_FIXTURE = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');

function writePdfFixture(path, utilization = 0.90) {
  writeFileSync(path, PDF_FIXTURE);
  const printable = printablePageBox('a4');
  persistPdfLayoutEvidence(path, buildPdfLayoutEvidence({
    pdfPath: path,
    pdfBuffer: PDF_FIXTURE,
    format: 'a4',
    pageCount: 1,
    measurement: {
      top_px: 0,
      bottom_px: printable.height_px * utilization,
      height_px: printable.height_px * utilization,
    },
    measuredAt: new Date('2099-01-01T00:00:00.000Z'),
  }));
}

try {
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  mkdirSync(join(root, 'interview-prep'), { recursive: true });
  mkdirSync(join(root, 'writing-samples'), { recursive: true });
  mkdirSync(join(root, 'jds'), { recursive: true });
  mkdirSync(join(root, 'outside-jds'), { recursive: true });

  writeFileSync(join(root, 'cv.md'), '# CV\nSQL evidence\nReporting evidence\nPython delivery improved reporting by 40%.\nB.Tech with Node.js, U.S. clients, C++, C#, CI/CD, .NET, and GPT-4.\n');
  writeFileSync(join(root, 'article-digest.md'), [
    '# Proof points',
    'Stakeholder evidence',
    '**Airflow boundary** — Airflow must not be claimed.',
    'Chose Django over FastAPI. No new BM25 layer.',
    'Built Docker while deliberately excluding Redis, Celery, and Traefik.',
    'Stella failed during evaluation.',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'config', 'profile.yml'), [
    'candidate:',
    '  full_name: Test Candidate',
    'target_roles:',
    '  primary: [Kubernetes Engineer]',
    'application_quality:',
    '  cover_body_words_min: 350',
    'embedding:',
    '  model: gpt-5.6-terra',
    '  threshold: 0.85',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'modes', '_profile.md'), '# Profile\n');
  writeFileSync(join(root, 'modes', '_custom.md'), '# Rules\n');
  writeFileSync(join(root, 'voice-dna.md'), [
    '# Voice',
    '<!-- career-ops:banned-terms:begin -->',
    '```text',
    'forbidden-placeholder',
    '```',
    '<!-- career-ops:banned-terms:end -->',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'interview-prep', 'story-bank.md'), '# Stories\nStakeholder evidence from a verified story\n');
  writeFileSync(join(root, 'interview-prep', 'retracted-claims.md'), '# Retracted\nNever use Kubernetes evidence\n');
  writeFileSync(join(root, 'writing-samples', 'sample.md'), '# Style only\nKubernetes appears only as prose style.\n');
  writeFileSync(join(root, 'writing-samples', 'README.md'), '# Instructions, not a style input\n');
  symlinkSync(join(root, 'cv.md'), join(root, 'interview-prep', 'linked.md'));
  const fileJd = 'Responsibilities include reliable SQL reporting, stakeholder analysis, testing, documentation, and production support. Requirements include professional analytics experience, communication skills, careful data modelling, and cross-functional delivery. '.repeat(2);
  writeFileSync(join(root, 'jds', 'acme.md'), fileJd);
  writeFileSync(join(root, 'outside-jds', 'outside.md'), fileJd);
  writeFileSync(join(root, 'jds', 'api-key.md'), 'known-safe test fixture');
  symlinkSync(join(root, 'outside-jds'), join(root, 'jds', 'linked'));
  symlinkSync(join(root, 'cv.md'), join(root, 'output', 'linked.pdf'));

  assert.equal(wordCount('evidence-based '.repeat(350)), 350);
  assert.equal(wordCount('دليل '.repeat(350)), 350);
  assert.equal(wordCount('प्रमाण '.repeat(350)), 350);
  assert.equal(wordCount('分析。'.repeat(350)), 350);
  assert(wordCount('データ分析と品質改善を担当します。'.repeat(50)) >= 250);
  assert(wordCount('データ分析と品質改善を担当します。'.repeat(50)) <= 500);
  assert.equal(identityMatches('شركة أكمي للبيانات', 'أكمي للبيانات'), true);
  assert.equal(identityMatches('شركة أكمي', 'شركة بيتا'), false);
  assert.equal(identityMatches('एक्मे प्राइवेट लिमिटेड', 'एक्मे'), true);
  assert.equal(identityMatches('株式会社アクメ', 'アクメ'), true);
  assert.equal(identityMatches('株式会社アクメ', '株式会社ベータ'), false);
  assert.equal(identityMatches('株式会社アクメ', '株式会社アクメラ'), false);
  assert.equal(identityMatches('카카오주식회사', '카카오'), true);
  assert.equal(identityMatches('카카오', '카카오뱅크'), false);
  assert.equal(identityMatches('شركة بيت', 'شركة بيتا'), false);
  assert.equal(identityMatches('Дата', 'БазаДата'), false);
  assert.equal(identityMatches('محلل بيانات أول', 'محلل بيانات'), true);
  assert.equal(identityMatches('シニア データ アナリスト', 'データ アナリスト'), true);
  assert.equal(identityMatches('Engineer', 'Software Engineer'), false);
  assert.equal(identityMatches('㈜카카오', '카카오'), true);
  assert.equal(identityMatches('İRESS', 'iress'), true);
  assert.equal(identityMatches('Limited Brands', 'Brands'), false);
  assert.equal(identityMatches('AG Insurance', 'Insurance'), false);
  assert.equal(identityMatches('Acme Pty Ltd', 'Acme'), true);
  assert.equal(identityMatches('ＡＣＭＥ', 'Acme'), true);
  assert.equal(identityMatches('Data', 'Database'), false);

  const technicalClaims = namedClaims('B.Tech Node.js U.S. C++ C# CI/CD .NET GPT-4');
  assert.deepEqual([...technicalClaims], ['b.tech', 'node.js', 'u.s', 'c++', 'c#', 'ci cd', '.net', 'gpt 4']);
  assert.equal(technicalClaims.has('b.'), false);
  assert.deepEqual(
    [...namedClaims('SQL-based AWS-powered LLM-driven GPT-4-enabled .NET-based evidence-based')],
    ['sql', 'aws', 'llm', 'gpt 4', '.net'],
  );
  assert.deepEqual(
    [...namedClaims('I used Python/Docker, Python/SQL, Docker/Kubernetes, Node.js/React, and CI/CD.')],
    ['python', 'docker', 'sql', 'kubernetes', 'node.js', 'react', 'ci cd'],
  );
  assert.deepEqual(
    [...namedClaims('Kubernetes delivered value. dbt, pandas, scikit-learn, GPT-4o, S3, and R followed.')],
    ['kubernetes', 'dbt', 'pandas', 'scikit learn', 'gpt 4o', 's3', 'r'],
  );
  assert.deepEqual([...namedClaims('e.g. i.e. example.com data.csv 3.14 Q3 H1 FY2025 Q1-Q4 R&D')], []);
  assert.deepEqual([...namedClaims('Used R language for modelling.')], ['r']);
  assert.deepEqual([...namedClaims('Designed a model. Machine learning followed.')], []);
  assert.deepEqual([...namedClaims('React powered the UI. Rust handled the service.')], ['react', 'ui', 'rust']);
  const claimCorpus = candidateClaimCorpus(root);
  const toolClaimCorpus = candidateToolClaimCorpus(root);
  assert.equal(claimCorpus.includes('gpt-5.6-terra'), false);
  assert.equal(claimCorpus.includes('350'), false);
  assert.equal(toolClaimCorpus.toLowerCase().includes('airflow'), false);
  assert.equal(toolClaimCorpus.toLowerCase().includes('fastapi'), false);
  assert.equal(toolClaimCorpus.toLowerCase().includes('bm25'), false);
  assert.equal(toolClaimCorpus.toLowerCase().includes('redis'), false);
  assert.equal(toolClaimCorpus.toLowerCase().includes('kubernetes'), false);
  assert.equal(resolveCandidateEvidenceSource(root, 'interview-prep/retracted-claims.md'), null);
  assert.equal(resolveCandidateEvidenceSource(root, 'interview-prep/linked.md'), null);
  assert.equal(resolveCandidateEvidenceSource(root, 'writing-samples/../cv.md'), null);
  assert.equal(resolveOptionalApplicationInput(root, 'writing-samples/README.md'), null);
  assert.equal(resolveJdSource(root, 'config/profile.yml'), null);
  assert.equal(resolveJdSource(root, 'jds/api-key.md'), null);
  assert.equal(resolveJdSource(root, 'jds/linked/outside.md'), null);
  assert.equal(resolveApplicationAsset(root, 'config/profile.yml', 'cover_payload'), null);
  assert.equal(resolveApplicationAsset(root, 'output/linked.pdf', 'cv_pdf'), null);
  const badRoot = join(root, 'bad-root');
  mkdirSync(join(badRoot, 'config'), { recursive: true });
  mkdirSync(join(badRoot, 'modes'), { recursive: true });
  writeFileSync(join(badRoot, 'cv.md'), '# CV\n');
  writeFileSync(join(badRoot, 'modes', '_profile.md'), '# Profile\n');
  symlinkSync(join(root, 'config', 'profile.yml'), join(badRoot, 'config', 'profile.yml'));
  assert.throws(() => loadApplicationProfile(badRoot), /symlinked/);
  assert.deepEqual(missingRequiredApplicationSources(badRoot), ['config/profile.yml']);

  const body = ['Acme product', 'Acme reporting domain', ...Array.from({ length: 356 }, (_value, index) => `evidence${index}`)].join(' ');
  const payload = {
    candidate: { name: 'Test Candidate' },
    letter: {
      company: 'Acme Data',
      role_title: 'Data Analyst',
      opening: body,
      profile_intro: '',
      achievements: [],
      problems_section: '',
      closing: '',
    },
  };

  const cvHtmlFixture = '<html><head><meta name="career-ops-template-id" content="cv-template">'
    + '<meta name="career-ops-template-version" content="1"></head>'
    + '<body><h1>Test Candidate</h1><p>SQL evidence. B.Tech with Node.js, U.S. clients, '
    + 'C++, C#, CI/CD, .NET, and GPT-4.</p></body></html>';
  writeFileSync(join(root, 'output', 'acme-cv.html'), cvHtmlFixture);
  writePdfFixture(join(root, 'output', 'acme-cv.pdf'));
  writeFileSync(join(root, 'output', 'acme-cover.md'), buildMarkdown(payload));
  writePdfFixture(join(root, 'output', 'acme-cover.pdf'));
  writeFileSync(join(root, 'output', 'acme-cover.docx'), 'docx fixture');
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(payload));

  const profile = {
    location: {
      visa_window_cutoff: '2026-01-01',
      retired_visa_flags: ['example-visa-cap'],
      visa_form_answer_fulltime: 'Example unrestricted work visa',
      visa_form_answer_parttime: 'Example unrestricted work visa',
    },
    application_quality: {
      minimum_apply_score: 4,
      require_explicit_low_score_override: true,
      require_fresh_assets: true,
      require_quality_manifest: true,
      require_evidence_source_match: true,
      require_candidate_claim_trace: true,
      evidence_min_chars: 8,
      require_generation_provenance: true,
      allowed_generation_flows: ['interactive-prepare'],
      release_model_policy: 'allowlist',
      allowed_release_models: {
        claude: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'],
        codex: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra'],
      },
      allowed_release_efforts: {
        claude: ['high', 'xhigh', 'max'],
        codex: ['high', 'xhigh', 'max'],
      },
      allowed_release_model_efforts: {
        claude: {
          'claude-opus-4-8': ['medium', 'high', 'xhigh', 'max'],
          'claude-fable-5': ['medium', 'high', 'xhigh', 'max'],
        },
        codex: {
          'gpt-5.6': ['medium', 'high', 'xhigh', 'max'],
          'gpt-5.6-sol': ['medium', 'high', 'xhigh', 'max'],
        },
      },
      cv_max_pages: 1,
      cover_max_pages: 1,
      cover_body_words_min: 350,
      cover_body_words_max: 420,
      cover_allow_bullets: false,
      cover_required_formats: ['md', 'pdf', 'docx'],
      banned_punctuation: ['em-dash', 'en-dash', 'semicolon'],
    },
  };

  const role = {
    id: 'role-1',
    company: 'Acme Data',
    title: 'Data Analyst',
    status: 'prepared',
    score: 4.3,
    score_raw: 4.3,
    flags: [],
    employment_type: 'full-time',
    visa_answer: 'Example unrestricted work visa',
    jd_text: 'Acme Data needs an analyst who can translate stakeholder requirements into reliable SQL reporting and communicate evidence clearly. '.repeat(3),
    jd_path: 'jds/acme.md',
    reason: 'Strong SQL and stakeholder fit.',
    cv_pdf: 'output/acme-cv.pdf',
    cover_letter_paths: {
      md: 'output/acme-cover.md',
      pdf: 'output/acme-cover.pdf',
      docx: 'output/acme-cover.docx',
      payload: 'output/acme-cover.payload.json',
    },
    application_quality_review: {
      reviewed_at: '2099-01-01T00:00:00.000Z',
      top_requirements: [
        { requirement: 'SQL', evidence: 'SQL evidence', source: 'cv.md' },
        { requirement: 'Reporting', evidence: 'Reporting evidence', source: 'cv.md' },
        { requirement: 'Stakeholders', evidence: 'Stakeholder evidence from a verified story', source: 'interview-prep/story-bank.md' },
      ],
      company_specific_references: ['Acme product', 'Acme reporting domain'],
      sources_used: ['writing-samples/sample.md'],
    },
  };

  role.generation_provenance = buildGenerationProvenance({
    role,
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    root,
    now: new Date('2099-01-01T00:00:00.000Z'),
  });

  const quality = applicationQualityConfig(profile);
  assert.equal(isAllowedBatchAssetModel('claude-opus-4-8', {
    application_quality: { allowed_batch_asset_models: ['claude-opus-4-8'] },
  }), true);
  assert.equal(isAllowedBatchAssetModel('claude-sonnet-5', {
    application_quality: { allowed_batch_asset_models: ['claude-opus-4-8'] },
  }), false);
  assert.equal(isAllowedBatchAssetModel('future-provider-model', {}), true);
  assert.equal(isAllowedBatchAssetModel('future-provider-model', {
    application_quality: { allowed_batch_asset_models: [] },
  }), false);
  assert.equal(releaseModelPolicy({}), 'open');
  assert.equal(isAllowedReleaseGenerator('future-cli', 'future-model', {}), true);
  assert.equal(isAllowedReleaseGenerator('future-cli', 'future-model', {
    application_quality: {
      release_model_policy: 'allowlist',
      allowed_release_models: {},
    },
  }), false);
  assert.equal(isAllowedReleaseGenerator('future-cli', 'future-model', {
    application_quality: { release_model_policy: 'typo' },
  }), false);
  assert.equal(isAllowedReleaseGenerator('future-cli', 'future-model', {
    application_quality: {
      release_model_policy: 'allowlist',
      allowed_release_models: { '*': ['*'] },
    },
  }), true);
  assert.equal(isAllowedReleaseGenerator('codex', 'gpt-5.6-sol', profile), true);
  assert.equal(isAllowedReleaseGenerator('codex', 'gpt-5.6-terra', profile), true);
  assert.equal(isAllowedReleaseGenerator('codex', 'gpt-5.6-luna', profile), false);
  assert.equal(isAllowedReleaseGenerator('claude', 'claude-sonnet-5', profile), true);
  assert.equal(isAllowedReleaseEffort('codex', 'high', profile), true);
  assert.equal(isAllowedReleaseEffort('codex', 'medium', profile), false);
  assert.equal(isAllowedReleaseModelEffort('codex', 'gpt-5.6-sol', 'medium', profile), true);
  assert.equal(isAllowedReleaseModelEffort('codex', 'gpt-5.6', 'medium', profile), true);
  assert.equal(isAllowedReleaseModelEffort('codex', 'gpt-5.6-terra', 'medium', profile), false);
  assert.equal(isAllowedReleaseModelEffort('codex', 'gpt-5.6-terra', 'high', profile), true);
  assert.equal(isAllowedReleaseModelEffort('claude', 'claude-opus-4-8', 'medium', profile), true);
  assert.equal(isAllowedReleaseModelEffort('claude', 'claude-fable-5', 'medium', profile), true);
  assert.equal(isAllowedReleaseModelEffort('claude', 'claude-sonnet-5', 'medium', profile), false);
  assert.equal(isAllowedReleaseModelEffort('claude', 'claude-sonnet-5', 'high', profile), true);
  const initialIssues = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') });
  assert.equal(initialIssues.length, 0, JSON.stringify(initialIssues, null, 2));

  // Production profile coverage for the portal-hosted-resume path. The
  // lightweight feature test intentionally disables provenance and therefore
  // cannot prove that the real release gate accepts a cover-only asset set.
  const portalSettings = { portal_default_cv: true };
  const portalRole = structuredClone(role);
  portalRole.id = 'role-portal-resume';
  portalRole.url = 'https://www.seek.com.au/job/12345';
  portalRole.application_host = 'seek.com.au';
  portalRole.cv_source = 'portal-default';
  delete portalRole.cv_pdf;
  delete portalRole.generation_provenance;
  portalRole.generation_provenance = buildGenerationProvenance({
    role: portalRole,
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    root,
    settings: portalSettings,
    now: new Date('2099-01-01T00:00:00.000Z'),
  });
  assert.equal(portalRole.generation_provenance.cv_source, 'portal-default');
  assert.equal(Object.hasOwn(portalRole.generation_provenance.assets, 'cv_pdf'), false);
  assert.equal(Object.hasOwn(portalRole.generation_provenance.assets, 'cv_html'), false);
  const portalIssues = validateApplicationRole(portalRole, {
    root,
    profile,
    quality,
    settings: portalSettings,
    now: new Date('2026-07-13T00:00:00Z'),
  });
  assert.deepEqual(
    portalIssues.filter((item) => item.level === 'error'),
    [],
    JSON.stringify(portalIssues, null, 2),
  );
  assert(portalIssues.some((item) => item.code === 'cv-portal-default'));
  assert.throws(
    () => buildGenerationProvenance({
      role: portalRole,
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      root,
      settings: { portal_default_cv: false },
    }),
    /Required application asset is missing: cv_pdf/,
  );
  const portalToggleOffCodes = validateApplicationRole(portalRole, {
    root,
    profile,
    quality,
    settings: { portal_default_cv: false },
    now: new Date('2026-07-13T00:00:00Z'),
  }).map((item) => item.code);
  assert(portalToggleOffCodes.includes('cv-missing'));
  assert(portalToggleOffCodes.includes('cv-source-html-missing'));
  const unboundPortalSource = structuredClone(portalRole);
  delete unboundPortalSource.generation_provenance.cv_source;
  const unboundPortalCodes = validateApplicationRole(unboundPortalSource, {
    root,
    profile,
    quality,
    settings: portalSettings,
    now: new Date('2026-07-13T00:00:00Z'),
  }).map((item) => item.code);
  assert(unboundPortalCodes.includes('generation-provenance-cv-source'));

  writePdfFixture(join(root, 'output', 'acme-cv.pdf'), 0.3);
  const sparseCvCodes = validateApplicationRole(role, {
    root, profile, quality, now: new Date('2026-07-13T00:00:00Z'),
  }).map((item) => item.code);
  assert(sparseCvCodes.includes('pdf-one-page-underfilled'));
  writePdfFixture(join(root, 'output', 'acme-cv.pdf'), 0.90);
  const qualityEvidence = createApplicationQualityEvidence(role, {
    root, profile, quality, now: new Date('2026-07-13T00:00:00Z'),
  });
  assert.equal(validateApplicationQualityEvidence(role, qualityEvidence, {
    root, profile, maxAgeMs: Number.POSITIVE_INFINITY,
  }).fingerprint, qualityEvidence.fingerprint);
  const originalCvPdf = readFileSync(join(root, 'output', 'acme-cv.pdf'));
  writeFileSync(join(root, 'output', 'acme-cv.pdf'), Buffer.concat([originalCvPdf, Buffer.from('\ntampered')]));
  assert.throws(() => validateApplicationQualityEvidence(role, qualityEvidence, {
    root, profile, maxAgeMs: Number.POSITIVE_INFINITY,
  }), /layout evidence does not match|no longer matches/);
  writeFileSync(join(root, 'output', 'acme-cv.pdf'), originalCvPdf);

  writeFileSync(join(root, 'output', 'acme-cover.md'), `${buildMarkdown(payload)}\nFabricated divergent paragraph.\n`);
  const divergentMarkdownCodes = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(divergentMarkdownCodes.includes('cover-markdown-divergent'));
  assert.throws(
    () => buildGenerationProvenance({ role, cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium', root }),
    /diverges from the canonical cover payload/,
  );
  writeFileSync(join(root, 'output', 'acme-cover.md'), buildMarkdown(payload));

  const inlinePreferredSnapshot = buildApplicationSourceSnapshot(root, role);
  assert.deepEqual(inlinePreferredSnapshot.jd_source, { kind: 'inline' });
  assert.equal(Object.hasOwn(inlinePreferredSnapshot.files, 'jds/acme.md'), false);
  writeFileSync(join(root, 'jds', 'acme.md'), `${fileJd} Unused path changed.`);
  assert.deepEqual(buildApplicationSourceSnapshot(root, role), inlinePreferredSnapshot);
  writeFileSync(join(root, 'jds', 'acme.md'), fileJd);

  const fileBackedRole = structuredClone(role);
  fileBackedRole.jd_text = 'Title only';
  const fileBackedInput = resolveRoleJdInput(root, fileBackedRole);
  const fileBackedSnapshot = buildApplicationSourceSnapshot(root, fileBackedRole);
  assert.equal(fileBackedInput.kind, 'file');
  assert.deepEqual(fileBackedSnapshot.jd_source, { kind: 'file', path: 'jds/acme.md' });
  assert.equal(Object.hasOwn(fileBackedSnapshot.files, 'jds/acme.md'), true);

  const missingJd = structuredClone(role);
  missingJd.jd_text = 'Title only';
  missingJd.jd_path = null;
  const missingJdCodes = validateApplicationRole(missingJd, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(missingJdCodes.includes('jd-source-missing'));
  assert.throws(() => buildGenerationProvenance({ role: missingJd, cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium', root }), /substantive inline JD/);

  const outOfScopeAsset = structuredClone(role);
  outOfScopeAsset.cv_pdf = 'config/profile.yml';
  assert.throws(() => buildGenerationProvenance({ role: outOfScopeAsset, cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium', root }), /out of scope/);

  const operationalFlagChange = structuredClone(role);
  operationalFlagChange.flags.push('auto-fill');
  const operationalFlagCodes = validateApplicationRole(operationalFlagChange, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert.equal(operationalFlagCodes.includes('generation-provenance-role-context'), false);

  const staleSourceSchema = structuredClone(role);
  staleSourceSchema.generation_provenance.source_snapshot.schema = 0;
  const staleSourceSchemaCodes = validateApplicationRole(staleSourceSchema, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(staleSourceSchemaCodes.includes('generation-provenance-source-schema'));

  const changedInlineJd = structuredClone(role);
  changedInlineJd.jd_text += ' A newly added responsibility.';
  const changedInlineJdCodes = validateApplicationRole(changedInlineJd, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(changedInlineJdCodes.includes('generation-provenance-jd'));

  const changedReview = structuredClone(role);
  changedReview.application_quality_review.uncovered_requirements = ['A newly recorded gap'];
  const changedReviewCodes = validateApplicationRole(changedReview, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(changedReviewCodes.includes('generation-provenance-quality-review'));

  const lateReuseJustification = structuredClone(role);
  lateReuseJustification.cv_reuse_justification = {
    covers_role_ids: ['role-1', 'role-2'],
    rationale: 'A justification added after provenance must never become release-eligible without a new stamp.',
    shared_evidence: ['SQL evidence'],
  };
  const lateReuseCodes = validateApplicationRole(lateReuseJustification, {
    root, profile, quality, now: new Date('2026-07-13T00:00:00Z'),
  }).map((item) => item.code);
  assert(lateReuseCodes.includes('generation-provenance-cv-reuse-justification'));
  assert.throws(() => validateApplicationQualityEvidence(lateReuseJustification, qualityEvidence, {
    root, profile, maxAgeMs: Number.POSITIVE_INFINITY,
  }), /no longer matches/);

  const unsupportedTemplate = cvHtmlFixture.replace(
    'content="cv-template"',
    'content="hand-built-template"',
  );
  writeFileSync(join(root, 'output', 'acme-cv.html'), unsupportedTemplate);
  const unsupportedTemplateCodes = validateApplicationRole(role, {
    root, profile, quality, now: new Date('2026-07-13T00:00:00Z'),
  }).map((item) => item.code);
  assert(unsupportedTemplateCodes.includes('cv-template-unsupported'));
  assert(unsupportedTemplateCodes.includes('generation-provenance-template-unsupported'));
  assert.throws(
    () => buildGenerationProvenance({
      role, cli: 'codex', model: 'gpt-5.6-sol', effort: 'medium', root,
    }),
    /template identity is missing or unsupported/,
  );
  writeFileSync(join(root, 'output', 'acme-cv.html'), cvHtmlFixture);

  const invalidUsedSource = structuredClone(role);
  invalidUsedSource.application_quality_review.sources_used = ['writing-samples/../cv.md'];
  const invalidUsedSourceCodes = validateApplicationRole(invalidUsedSource, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(invalidUsedSourceCodes.includes('quality-review-sources-used'));

  const malformedRequirements = structuredClone(role);
  malformedRequirements.application_quality_review.top_requirements = 'not-an-array';
  const malformedRequirementCodes = validateApplicationRole(malformedRequirements, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(malformedRequirementCodes.includes('quality-review-requirements'));

  const changedContext = structuredClone(role);
  changedContext.location = 'Melbourne, VIC';
  const changedContextCodes = validateApplicationRole(changedContext, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(changedContextCodes.includes('generation-provenance-role-context'));

  writeFileSync(join(root, 'interview-prep', 'story-bank.md'), '# Stories\nStakeholder evidence was changed after generation\n');
  const changedStoryCodes = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(changedStoryCodes.includes('generation-provenance-source-hash'));
  writeFileSync(join(root, 'interview-prep', 'story-bank.md'), '# Stories\nStakeholder evidence from a verified story\n');

  const snapshotBeforeUnrelatedPrep = buildApplicationSourceSnapshot(root, role);
  writeFileSync(join(root, 'interview-prep', 'unrelated-company-role.md'), '# Unrelated prep\n');
  assert.deepEqual(buildApplicationSourceSnapshot(root, role), snapshotBeforeUnrelatedPrep);

  const fabricatedEvidence = structuredClone(role);
  fabricatedEvidence.application_quality_review.top_requirements[0].evidence = 'Fabricated SQL leadership proof';
  const fabricatedEvidenceCodes = validateApplicationRole(fabricatedEvidence, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(fabricatedEvidenceCodes.includes('quality-review-evidence-untraced'));

  const missingProvenance = structuredClone(role);
  delete missingProvenance.generation_provenance;
  const missingProvenanceCodes = validateApplicationRole(missingProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(missingProvenanceCodes.includes('generation-provenance-missing'));

  const weakModelProvenance = structuredClone(role);
  weakModelProvenance.generation_provenance.generator.model = 'gpt-5.6-luna';
  const weakModelProvenanceCodes = validateApplicationRole(weakModelProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(weakModelProvenanceCodes.includes('generation-provenance-model'));

  const weakEffortProvenance = structuredClone(role);
  weakEffortProvenance.generation_provenance.generator.effort = 'low';
  const weakEffortProvenanceCodes = validateApplicationRole(weakEffortProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(weakEffortProvenanceCodes.includes('generation-provenance-effort'));

  const terraMediumProvenance = structuredClone(role);
  terraMediumProvenance.generation_provenance.generator.model = 'gpt-5.6-terra';
  const terraMediumProvenanceCodes = validateApplicationRole(terraMediumProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(terraMediumProvenanceCodes.includes('generation-provenance-effort'));

  const missingEffortProvenance = structuredClone(role);
  delete missingEffortProvenance.generation_provenance.generator.effort;
  const missingEffortProvenanceCodes = validateApplicationRole(missingEffortProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(missingEffortProvenanceCodes.includes('generation-provenance-effort'));

  const batchProvenance = structuredClone(role);
  batchProvenance.generation_provenance.flow = BATCH_DRAFT_FLOW;
  batchProvenance.generation_provenance.interactive = false;
  const batchProvenanceCodes = validateApplicationRole(batchProvenance, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(batchProvenanceCodes.includes('generation-provenance-flow'));

  const retired = {
    ...role,
    flags: ['example-visa-cap'],
    score: 3.4,
    score_raw: 4.1,
    reason: 'Strong analyst fit, but capped by the retired student-visa window rule.',
  };
  const retiredCodes = validateApplicationRole(retired, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(retiredCodes.includes('retired-visa-flag'));
  assert(retiredCodes.includes('retired-visa-reason'));
  assert(retiredCodes.includes('retired-visa-score'));
  assert(retiredCodes.includes('low-score-override-missing'));

  const selectedLowScore = { score: 3.8 };
  assert.equal(recordCandidateSelectionOverride(selectedLowScore, 4, 'test-dashboard'), true);
  assert.equal(selectedLowScore.user_override.approved, true);
  assert.equal(selectedLowScore.user_override.source, 'test-dashboard');
  assert.equal(recordCandidateSelectionOverride(selectedLowScore, 4, 'test-dashboard'), false);

  const weakCoverPayload = structuredClone(payload);
  weakCoverPayload.letter.opening = 'Too short';
  weakCoverPayload.letter.achievements = [{ lead: 'A bullet', impact: 'An impact' }];
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(weakCoverPayload));
  writeFileSync(join(root, 'output', 'acme-cover.md'), '- A bullet\n');
  const weakCoverCodes = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(weakCoverCodes.includes('cover-word-count'));
  assert(weakCoverCodes.includes('cover-bullets'));
  assert(weakCoverCodes.includes('cover-markdown-bullets'));

  const fabricatedNumberPayload = structuredClone(payload);
  fabricatedNumberPayload.letter.opening = `${body} Delivered an unsupported 99% result.`;
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(fabricatedNumberPayload));
  const fabricatedNumberCodes = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .map((item) => item.code);
  assert(fabricatedNumberCodes.includes('claim-number-untraced'));

  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>SQL evidence using TensorFlow, Kubernetes, Airflow, FastAPI, BM25, Redis, Celery, Traefik, C++, and .NET</p></body></html>');
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(payload));
  const fabricatedTermIssues = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced');
  assert(fabricatedTermIssues.some((item) => item.message.includes('"tensorflow"')));
  assert(fabricatedTermIssues.some((item) => item.message.includes('"kubernetes"')));
  for (const term of ['airflow', 'fastapi', 'bm25', 'redis', 'celery', 'traefik']) {
    assert(fabricatedTermIssues.some((item) => item.message.includes(JSON.stringify(term))), `${term} was incorrectly whitelisted by negative digest context`);
  }

  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>GPT-5.6-Terra produced 350 unsupported outcomes.</p></body></html>');
  const operationalSettingIssues = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') });
  assert(operationalSettingIssues.some((item) => item.code === 'claim-number-untraced' && item.message.includes('"350"')));
  assert(operationalSettingIssues.some((item) => item.code === 'claim-term-untraced' && item.message.includes('"gpt 5.6 terra"')));

  const toolNamedCompany = structuredClone(role);
  toolNamedCompany.company = 'Databricks';
  const toolNamedCompanyPayload = structuredClone(payload);
  toolNamedCompanyPayload.letter.company = 'Databricks';
  toolNamedCompanyPayload.letter.opening = `${body} Databricks`;
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(toolNamedCompanyPayload));
  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>Databricks Data Analyst</p></body></html>');
  const toolCompanyClaimIssues = validateApplicationRole(toolNamedCompany, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced' && item.message.includes('"databricks"'));
  assert.equal(toolCompanyClaimIssues.length, 0);

  const fullWidthCompany = structuredClone(role);
  fullWidthCompany.company = 'ACME';
  const fullWidthCompanyPayload = structuredClone(payload);
  fullWidthCompanyPayload.letter.company = 'ＡＣＭＥ';
  fullWidthCompanyPayload.letter.opening = `${body} ＡＣＭＥ`;
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(fullWidthCompanyPayload));
  const fullWidthCompanyIssues = validateApplicationRole(fullWidthCompany, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced' && item.message.includes('"acme"'));
  assert.equal(fullWidthCompanyIssues.length, 0);

  const toolInTitle = structuredClone(role);
  toolInTitle.title = 'Kubernetes Engineer';
  const toolInTitlePayload = structuredClone(payload);
  toolInTitlePayload.letter.role_title = 'Kubernetes Engineer';
  toolInTitlePayload.letter.opening = `${body} I used Kubernetes in production.`;
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(toolInTitlePayload));
  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>I used Kubernetes in production.</p></body></html>');
  const titleWhitelistIssues = validateApplicationRole(toolInTitle, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced' && item.message.includes('"kubernetes"'));
  assert(titleWhitelistIssues.some((item) => item.message.startsWith('Tailored CV')));
  assert(titleWhitelistIssues.some((item) => item.message.startsWith('Cover letter')));

  const manifestWhitelistAttempt = structuredClone(role);
  manifestWhitelistAttempt.application_quality_review.company_specific_references = ['Kubernetes', 'Acme reporting domain'];
  const manifestWhitelistPayload = structuredClone(payload);
  manifestWhitelistPayload.letter.opening = `${body} Kubernetes`;
  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(manifestWhitelistPayload));
  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>SQL evidence using Kubernetes</p></body></html>');
  const whitelistIssues = validateApplicationRole(manifestWhitelistAttempt, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced' && item.message.includes('"kubernetes"'));
  assert(whitelistIssues.some((item) => item.message.startsWith('Tailored CV')));
  assert(whitelistIssues.some((item) => item.message.startsWith('Cover letter')));

  writeFileSync(join(root, 'cv.md'), '# CV\nSQL evidence\nReporting evidence\nPython delivery improved reporting by 40%.\nB.Tech with Node.js, U.S. clients, C#, CI/CD, and GPT-4.\n');
  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>SQL evidence using C++ and .NET</p></body></html>');
  const unsupportedSymbolIssues = validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') })
    .filter((item) => item.code === 'claim-term-untraced');
  assert(unsupportedSymbolIssues.some((item) => item.message.includes('"c++"')));
  assert(unsupportedSymbolIssues.some((item) => item.message.includes('".net"')));

  writeFileSync(join(root, 'cv.md'), '# CV\nSQL evidence\nReporting evidence\nPython delivery improved reporting by 40%.\nB.Tech with Node.js, U.S. clients, C++, C#, CI/CD, .NET, and GPT-4.\n');
  writeFileSync(join(root, 'output', 'acme-cv.html'), cvHtmlFixture);

  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(payload));
  writeFileSync(join(root, 'output', 'acme-cover.md'), buildMarkdown(payload));
  // Recreate the unchanged binary fixtures after the deliberate source-mtime
  // mutation above. The hash-bound provenance stays valid, while the separate
  // conservative mtime gate correctly sees freshly rendered assets.
  writePdfFixture(join(root, 'output', 'acme-cv.pdf'));
  writePdfFixture(join(root, 'output', 'acme-cover.pdf'));
  writeFileSync(join(root, 'output', 'acme-cover.docx'), 'docx fixture');
  const result = verifyUserData({
    root,
    profile,
    queue: { roles: [role] },
    roleId: role.id,
    now: new Date('2026-07-13T00:00:00Z'),
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.checked_roles, 1);

  console.log('verify-userdata tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
