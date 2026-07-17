#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { pass, ROOT } from './helpers.mjs';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const assertBefore = (text, first, second, message) => {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert(firstIndex >= 0, `${message}: missing "${first}"`);
  assert(secondIndex >= 0, `${message}: missing "${second}"`);
  assert(firstIndex < secondIndex, `${message}: "${first}" must precede "${second}"`);
};

console.log('\nWorkflow documentation consistency');

const batchMode = read('modes/batch.md');
assert.match(batchMode, /Full A-G `.md` report/);
assert.match(batchMode, /By default it\s+does not generate PDFs/i);
assert.match(batchMode, /`--draft-pdf` is an explicit, model-gated exception/i);
assert.match(batchMode, /score meets the\s+configured `auto_pdf_score_threshold`/i);
assert.match(read('batch/README.md'), /Each worker produces an A-G report/);
pass('batch mode is A-G evaluation-only unless draft PDFs are explicitly enabled');

const batchPrompt = read('batch/batch-prompt.md');
assert.match(batchPrompt, /Default obligatorio:[\s\S]{0,240}evaluation-only/i);
assert.match(batchPrompt, /Activation gate \(first\):[\s\S]{0,300}explicitly says `PDF BORRADOR`/i);
assert.match(batchPrompt, /Score gate \(second\):[\s\S]{0,220}`auto_pdf_score_threshold`/i);
assert.doesNotMatch(batchPrompt, /^# .* \+ PDF \+ Tracker Line$/m);
pass('batch worker cannot infer PDF authorization from score alone');

const runner = read('batch/batch-runner.sh');
assert.doesNotMatch(runner, /evaluación A-F/i);
assert.match(runner, /evaluación A-G \+ report \.md \+ tracker line/);
assert.match(runner, /evaluación A-G \+ report \.md \+ PDF BORRADOR \+ tracker line/);
assert.match(runner, /report \+ Evaluated tracker row remain/);
assert.doesNotMatch(runner, /Skip PDF\/tracker for offers scoring below/);
pass('batch runtime prompts use the complete A-G terminology');

const pipeline = read('modes/pipeline.md');
assert.match(pipeline, /Evaluation A-G → Report `\.md` →\s+Evaluated tracker row/);
assert.match(pipeline, /evaluation-only by default/i);
assert.match(pipeline, /threshold never enables PDF generation by\s+itself/i);
assert.match(pipeline, /batch-runner\.sh --draft-pdf/);
assert.doesNotMatch(pipeline, /Evaluation A-F/);
assertBefore(
  pipeline,
  'Public ATS API / deterministic scanner record first',
  '**Playwright:**',
  'pipeline JD extraction order',
);
pass('pipeline defaults to evaluation and gates optional drafts on explicit enablement plus threshold');

const autoPipeline = read('modes/auto-pipeline.md');
assert.match(autoPipeline, /Verdict-First Evaluation/);
assert.match(autoPipeline, /stop at the\s+candidate-selection boundary/i);
assert.match(autoPipeline, /Do not generate a tailored CV, cover letter, form-answer draft/i);
assertBefore(
  autoPipeline,
  'Public ATS API or deterministic source first',
  '**Playwright:**',
  'auto-pipeline JD extraction order',
);
assert.doesNotMatch(autoPipeline, /Full Automatic Pipeline/);
assert.doesNotMatch(autoPipeline, /## Step 3 — Generate PDF/);
assert.doesNotMatch(autoPipeline, /Draft Application Answers/);
pass('auto-pipeline is API-first and stops after the evaluation verdict');

const oferta = read('modes/oferta.md');
assert.match(oferta, /## Application-work boundary/);
assert.match(oferta, /Evaluation ends with the A-G report/);
assert.match(oferta, /\*\*PDF:\*\* not generated — evaluation-only/);
assert.doesNotMatch(oferta, /## H\) Draft Application Answers/);
assert.doesNotMatch(oferta, /## Cover Letter Draft/);
assert.doesNotMatch(oferta, /\*\*PDF:\*\* \{path or pending\}/);
pass('oferta persists evaluation only and cannot imply automatic application assets');

const cover = read('modes/cover.md');
assert.match(cover, /Load its JD,\s+company, role, keywords, A-G evaluation context/i);
assert.match(cover, /legacy `## Cover Letter Draft` exists[\s\S]{0,180}revalidated against the approved sources/i);
assert.doesNotMatch(cover, /Extract the `## Cover Letter Draft` section as a starting point/);
assert.match(read('modes/pdf.md'), /legacy `## Cover Letter Draft` exists, treat it only as optional starting text/i);
pass('cover and PDF modes treat report drafts as optional legacy wording, not generated prerequisites');

const applyMode = read('modes/apply.md');
assert.match(
  applyMode,
  /run a full `oferta` evaluation and persist\s+its report first[\s\S]{0,220}queue PREPARE phase to generate fresh tailored\s+CV and cover assets/i,
);
assert.match(applyMode, /PREPARE remains the asset-creation\s+authority/i);
assert.doesNotMatch(applyMode, /`oferta` evaluation first \(report \+\s+tailored CV/i);
for (const file of [
  'modes/_shared.md',
  'modes/apply.md',
  'modes/_custom.md',
  'queue-resolve.mjs',
  'application-receipt.mjs',
]) {
  assert.match(applyMode, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(applyMode, /This protocol applies to every portal/i);
assert.match(applyMode, /\*\*For every portal and ATS\*\*/i);
assert.match(applyMode, /Reports provide JD, company, role, scoring, and\s+application-history context; they are never independent evidence for a candidate fact/i);
assert.match(applyMode, /revalidate it against the current rendered form and the approved\s+candidate sources/i);
assert.match(applyMode, /upload_controls` array \(including `\[\]` when none exist\)/i);
assert.match(applyMode, /\{control_id,kind,expected,displayed,asset_sha256,verified:true\}/i);
assert.match(applyMode, /requires a verified CV in every enabled `cv` control/i);
assert.match(applyMode, /verified cover letter in every enabled `cover` or `supporting` control/i);
assert.doesNotMatch(applyMode, /use it as a base and refine/i);
assert.doesNotMatch(applyMode, /existing A-H report blocks/i);
pass('deep-eval keeps oferta evaluation separate from PREPARE asset creation');

const followup = read('modes/followup.md');
assert.match(followup, /A report is not evidence for a candidate fact/i);
assert.match(followup, /article-digest\.md/);
assert.match(followup, /Revalidate any wording copied from an older report or follow-up/i);
assert.doesNotMatch(followup, /cv\.md\/report proof points/i);
assert.doesNotMatch(followup, /report's Block B match/i);
assert.doesNotMatch(followup, /Barbeiro\.app|15 years of PHP/i);
pass('follow-up drafts use reports for role context and approved files for candidate facts');

const dashboard = read('dashboard/web/index.html');
assert.match(dashboard, /One-shot for explicitly selected roles/);
assert.doesNotMatch(dashboard, /One-shot for ALL roles/);
pass('one-shot tooltip is scoped to explicit role selection');

const dashboardApp = read('dashboard/web/app.js');
assert.match(dashboardApp, /agent uses a conservative answer and flags it for final review/i);
assert.match(dashboardApp, /agent answers truthfully and flags the rejection risk/i);
assert.match(dashboardApp, /CV and cover letter not yet generated/i);
assert.match(dashboardApp, /generate and validate the tailored CV \+ cover letter/i);
pass('dashboard copy assigns complete preparation and provisional fills to the agent');

const autofillOverview = read('docs/APPLY_AUTOFILL.md');
assert.match(
  autofillOverview,
  /upload_controls:\[\{control_id,label,kind,required,multiple,enabled,accepts\}\]/,
);
assert.match(autofillOverview, /control_id[\s\S]{0,180}(?:asset_sha256|SHA-256)/i);
assert.match(autofillOverview, /every enabled `cv` control[\s\S]{0,180}verified CV/i);
assert.match(
  autofillOverview,
  /every enabled `cover` or `supporting` control[\s\S]{0,180}verified(?: tailored)? cover letter/i,
);
pass('autofill overview mirrors the executable upload-control and content-hash gate');

const applyButton = read('web/src/components/apply-button.tsx');
assert.match(applyButton, /const hasUrl =/);
assert.match(applyButton, /href="http:\/\/127\.0\.0\.1:7777"/);
assert.match(applyButton, /dashboard-first selection → PREPARE/);
assert.doesNotMatch(applyButton, /pdfReady|useJobs/);
pass('web Apply CTA opens the dashboard from a valid URL without a PDF-readiness gate');

const webRun = read('web/src/app/api/run/route.ts');
assert.match(webRun, /artifacts \(A–G report \+ tracker row\)/);
assert.match(webRun, /complete A–G evaluation and Machine Summary/);
assert.match(webRun, /An A–G score is meaningless without a CV/);
assert.doesNotMatch(webRun, /A[–-]F (?:report|score)/);
assert.match(webRun, /headless, the asset is a non-release draft/i);
assert.match(webRun, /node find\.mjs \$\{input\}/);
assert.match(webRun, /retain the source beside the PDF as [^\n]*output\/cv-/);
assert.match(webRun, /must never mark a queue role prepared or bypass interactive PREPARE/i);
assert.doesNotMatch(webRun, /\/tmp\//);
pass('web evaluation comments and prompt consistently describe A-G');

const patterns = read('modes/patterns.md');
assert.match(patterns, /top-level\s+`auto_pdf_score_threshold` key in `config\/profile\.yml`/i);
assert.match(patterns, /only after a run explicitly enables non-release draft PDFs/i);
assert.match(patterns, /never selects roles or\s+enables PDF generation by itself/i);

const profileExample = read('config/profile.example.yml');
assert.match(profileExample, /evaluation-only unless\s+# the candidate explicitly enables non-release draft PDFs/i);
assert.match(profileExample, /only the second-stage score filter after that\s+# explicit draft-PDF activation/i);
assert.match(profileExample, /Set it to 0 to draft every evaluated offer in an explicitly activated\s+# draft-PDF run/i);

const patternAnalyzer = read('analyze-patterns.mjs');
assert.match(patternAnalyzer, /For explicitly enabled --draft-pdf runs only/);
assert.match(patternAnalyzer, /auto_pdf_score_threshold/);
assert.match(patternAnalyzer, /never enables PDF generation/);
assert.doesNotMatch(patternAnalyzer, /Set minimum score threshold at .* before generating PDFs/);
pass('the PDF score threshold filters only explicitly enabled draft-PDF runs');

const localizedPipelineFiles = [
  'modes/ar/pipeline.md',
  'modes/da/pipeline.md',
  'modes/de/pipeline.md',
  'modes/es/pipeline.md',
  'modes/fr/pipeline.md',
  'modes/hi/pipeline.md',
  'modes/id/pipeline.md',
  'modes/it/pipeline.md',
  'modes/ja/pipeline.md',
  'modes/ko/pipeline.md',
  'modes/pl/pipeline.md',
  'modes/pt/pipeline.md',
  'modes/ru/pipeline.md',
  'modes/tr/pipeline.md',
  'modes/ua/pipeline.md',
  'modes/zh/pipeline.md',
];
for (const file of localizedPipelineFiles) {
  const text = read(file);
  assert.match(text, /API-first bulk and per-role\s+liveness checks/i, file);
  assert.match(text, /explicitly activated\s+draft-PDF score filter/i, file);
  assert.match(text, /single-pass\/no-recursive-fanout worker limit/i, file);
  assert.doesNotMatch(text, /one-browser-controller rule/i, file);
}
pass('localized pipeline wrappers preserve API-first, opt-in-draft, bounded-worker behavior');

const localizedApplyFiles = [
  'modes/ar/takdeem.md',
  'modes/da/apply.md',
  'modes/de/bewerben.md',
  'modes/es/aplicar.md',
  'modes/fr/postuler.md',
  'modes/hi/aavedan.md',
  'modes/id/melamar.md',
  'modes/it/candidarsi.md',
  'modes/ja/oubo.md',
  'modes/ko/jiwon.md',
  'modes/pl/aplikuj.md',
  'modes/pt/aplicar.md',
  'modes/ru/apply.md',
  'modes/tr/basvuru.md',
  'modes/ua/apply.md',
  'modes/zh/apply.md',
];
for (const file of localizedApplyFiles) {
  const text = read(file);
  assert.match(text, /1\. `modes\/_shared\.md`/, file);
  assert.match(text, /2\. `modes\/apply\.md`/, file);
  assert.match(text, /3\. `modes\/_custom\.md`/, file);
  assert.match(text, /4\. `queue-resolve\.mjs`/, file);
  assert.match(text, /5\. `application-receipt\.mjs`/, file);
  assert.match(text, /five authoritative files above/i, file);
}
pass('localized apply wrappers point to the same five-file live contract');

assert.match(read('README.fr.md'), /Évalue les offres.*A-G/i);
assert.match(read('README.fr.md'), /API ATS\/données déterministes d'abord/i);
assert.match(read('docs/FREE_TIER.md'), /Offer evaluation \(A-G\)/);

const budget = read('docs/RUNNING_ON_A_BUDGET.md');
assert.match(budget, /default scanner uses local parsers and public ATS APIs/i);
assert.match(budget, /does\s+not launch Playwright or use an LLM/i);
assert.match(budget, /Generate report-only draft answers; never fills a live form/i);
assert.match(budget, /requires an already-tailored input HTML plus\s+an output path/i);
assert.doesNotMatch(budget, /^\s*node generate-pdf\.mjs\s*$/m);
pass('translated and budget docs use A-G, API-first discovery, and valid PDF boundaries');

// modes/_custom.md is an untracked user-layer file — include it only when it
// exists (clean checkouts and CI don't have one).
const crossAgentDocs = ['AGENTS.md', 'CLAUDE.md', '.agents/skills/career-ops/SKILL.md'];
if (existsSync(join(ROOT, 'modes/_custom.md'))) crossAgentDocs.push('modes/_custom.md');
for (const file of crossAgentDocs) {
  const text = read(file);
  for (const contract of [
    'modes/_shared.md',
    'modes/apply.md',
    'modes/_custom.md',
    'queue-resolve.mjs',
    'application-receipt.mjs',
  ]) {
    assert.match(text, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${file}: ${contract}`);
  }
  assert.match(
    text,
    /upload_controls:\[\{control_id,label,kind,required,multiple,enabled,accepts\}\]/,
    `${file}: upload control schema`,
  );
  assert.match(text, /control_id[\s\S]{0,220}(?:asset_sha256|SHA-256)/i, `${file}: attachment hash binding`);
}
pass('cross-agent instructions name the same five contracts and upload-evidence schema');

const queueMode = read('modes/queue.md');
assert.match(queueMode, /upload_controls:\[\{control_id,label,kind,required,multiple,enabled,accepts\}\]/);
assert.match(queueMode, /control_id[\s\S]{0,220}(?:asset_sha256|SHA-256)/i);
assert.match(queueMode, /enabled[\s\S]{0,30}`cover` or `supporting` control[\s\S]{0,180}(?:tailored )?cover letter/i);
pass('queue PREPARE/apply handoff preserves the upload-control receipt requirements');

// handover.md is an untracked user-layer file — assert on it only when it
// exists (clean checkouts and CI don't have one).
if (existsSync(join(ROOT, 'handover.md'))) {
  const handover = read('handover.md');
  assert.match(handover, /earlier\s+\*\*1989 passed \/ 0 failed \/ 0 warnings\*\* snapshot is superseded/i);
  assert.match(handover, /completed root\s+verification gate is \*\*\d+ passed \/ 0 failed \/ 0 warnings\*\*/i);
  assert.doesNotMatch(handover, /final unsandboxed gate and resulting count are\s+still pending/i);
  assert.match(handover, /five current application-contract files/i);
  const nextSteps = handover.match(/## Next Steps([\s\S]*?)## Open Questions/)?.[1] ?? '';
  assert.doesNotMatch(nextSteps, /0c\.|✅ DONE|All 23 live selected roles/);
  assert.match(nextSteps, /There is no active browser batch to resume/i);
  pass('handover marks old verification counts as superseded and contains only current next steps');
}

const readmes = ['README.md', ...readdirSync(ROOT)
  .filter((name) => /^README\..+\.md$/.test(name))
  .sort()];
let chromiumMentions = 0;
for (const file of readmes) {
  const line = read(file).split('\n').find((item) => item.includes('playwright install chromium'));
  if (!line) continue;
  chromiumMentions += 1;
  const comment = line.split('#').slice(1).join('#');
  assert.match(comment, /PDF/i, `${file}: Chromium install note must mention PDF rendering`);
  assert.match(comment, /Playwright/i, `${file}: Chromium install note must mention Playwright browser/liveness use`);
}
assert(chromiumMentions > 1, 'expected Chromium installation guidance in root and translated READMEs');
pass('Chromium guidance covers both PDF rendering and Playwright browser/liveness verification');
