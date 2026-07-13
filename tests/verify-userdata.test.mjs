#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applicationQualityConfig, validateApplicationRole, verifyUserData } from '../verify-userdata.mjs';
import { recordCandidateSelectionOverride } from '../queue-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'career-ops-userdata-'));

try {
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });

  writeFileSync(join(root, 'cv.md'), '# CV\nVerified evidence\n');
  writeFileSync(join(root, 'article-digest.md'), '# Proof points\n');
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate: {}\n');
  writeFileSync(join(root, 'modes', '_profile.md'), '# Profile\n');
  writeFileSync(join(root, 'modes', '_custom.md'), '# Rules\n');
  writeFileSync(join(root, 'voice-dna.md'), '# Voice\n');

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

  writeFileSync(join(root, 'output', 'acme-cv.html'), '<html><body><h1>Test Candidate</h1><p>SQL evidence</p></body></html>');
  writeFileSync(join(root, 'output', 'acme-cv.pdf'), '%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
  writeFileSync(join(root, 'output', 'acme-cover.md'), body + '\n');
  writeFileSync(join(root, 'output', 'acme-cover.pdf'), '%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF');
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
        { requirement: 'Stakeholders', evidence: 'Stakeholder evidence', source: 'article-digest.md' },
      ],
      company_specific_references: ['Acme product', 'Acme reporting domain'],
    },
  };

  const quality = applicationQualityConfig(profile);
  assert.equal(validateApplicationRole(role, { root, profile, quality, now: new Date('2026-07-13T00:00:00Z') }).length, 0);

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

  writeFileSync(join(root, 'output', 'acme-cover.payload.json'), JSON.stringify(payload));
  writeFileSync(join(root, 'output', 'acme-cover.md'), body + '\n');
  const result = verifyUserData({
    root,
    profile,
    queue: { roles: [role] },
    roleId: role.id,
    now: new Date('2026-07-13T00:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked_roles, 1);

  console.log('verify-userdata tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
