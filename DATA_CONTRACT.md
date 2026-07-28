# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `config/cv-facts.json` | Your CV fact-check allowlist and forbidden phrases |
| `config/benchmarks.yml` | Your market calibration benchmark overrides (optional; copy `templates/benchmarks.yml` here and edit — read by `funnel-velocity.mjs`) |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `modes/_custom.md` | Your house rules, custom workflows & output preferences (procedural — survives updates) |
| `article-digest.md` | Your proof points from portfolio (personal — gitignored; the agent offers import/build/skip during onboarding) |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `interview-prep/{company}-{role}.md` | Company-specific interview prep reports (written by `/career-ops interview-prep`) |
| `interview-prep/sessions/*.md` | Interview sessions — real transcripts + mock sessions (sensitive: real names/companies; gitignored except scaffold). Drives `patterns` Step 1b targeting signal and `interview-redflag` analysis. Scaffold files (`README.md`, `.gitkeep`) are system-owned. |
| `portals.yml` | Your customized company list |
| `config/plugins.yml` | Your plugin activation toggles (opt-in; seeded from `config/plugins.example.yml`) |
| `plugins.local/` | Your own / private plugins (never auto-updated) |
| `plugins.lock` | Integrity pins + recorded consent for your enabled plugins (generated; never auto-updated) |
| `data/applications.md` | Your application tracker (source of truth) |
| `data/applications.db` | Derived query index over `applications.md` (SQLite, rebuilt by `node tracker.mjs sync` — safe to delete) |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history (9 tab-separated columns; col 8: local SimHash JD fingerprint for cross-listing detection, col 9: posting date) |
| `data/scan-runs.tsv` | Your per-run scan counters (appended by `scan.mjs`, read by `stats.mjs`) |
| `data/portal-health.tsv` | Consecutive reachability status for scanned portals (appended by `scan.mjs`) |
| `data/follow-ups.md` | Your follow-up history |
| `data/apply-queue.json` | Your apply queue — scored roles, drafts, decisions |
| `data/offers/*` | Your received offers/contracts, promise notes, prep reports, and reply drafts (PII — gitignored, written by the `offer-prep` mode) |
| `data/salary-observations.tsv` | Your append-only compensation observation log: `{tracker#}\t{date}\t{desired\|advertised\|actual}\t{amount}\t{currency}\t{source}\t{note}`. Written by interactive modes when a figure is stated/confirmed; never edited in place. Advertised figures come from reports' `advertised_comp` instead — reports are themselves observation sources. Read by `salary-gap.mjs` |
| `data/status-log.tsv` | Your append-only status transition ledger: `{tracker#}\t{date}\t{from}\t{to}\t{source}\t{note}`. Appended by `set-status.mjs` on every real status change (the tracker stays the source of truth for *state*; the ledger records *when* transitions happened; the `set-status.mjs` append path lands with #1695 — until then this file may simply not exist); never edited in place — corrections are new `correction`-source lines. Read by `funnel-velocity.mjs` |
| `data/upskill/*` | Your skill-gap analysis reports (written by the `upskill` mode) |
| `data/blacklist.md` | Your do-not-apply company list (opt-in — absence = no filtering; never auto-populated: only you, or the agent on your explicit instruction, write to it. Respected by `scan.mjs` and the `auto-pipeline`/`oferta`/`apply` gates; never a scoring input) |
| `data/assessments.tsv` | Your append-only skills-assessment log: `{date}\t{company}\t{report#\|-}\t{platform}\t{subject}\t{threshold%\|-}\t{score%\|-}\t{stale_note}`. Appended by `node assessment-log.mjs add`; never edited in place. Empty stale_note = no staleness observed. Read by `assessment-log.mjs` |
| `writing-samples/*` | Your personal writing samples for style calibration (except `writing-samples/README.md`, which is system-owned documentation delivered by updates) |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `jds/*` | Your saved job descriptions |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/_custom.template.md` | Template seed for the user's `modes/_custom.md` |
| `voice-dna.md` | **Opinionated shared writing default**, tracked and shipped to every install. Governs *how* generated prose reads (banned vocabulary, anti-AI-slop rules, formatting), and **never** introduces a factual claim about the candidate. Its `career-ops:banned-terms` block is the machine-readable list `cover-quality.mjs` parses deterministically. Do **not** edit it for personal preferences — put those in `modes/_custom.md`, `application_quality.banned_terms_allow` / `banned_terms_add`, or `writing-samples/`. There is deliberately no `voice-dna.template.md`: the real file *is* the default. |
| `cover-quality.mjs` | Locale-aware greeting/sign-off ladders, banned-term parsing, skeleton fingerprints (zero model tokens) |
| `cv-tailoring.mjs` | Contextual identical-CV / duplicate-cover checks (zero model tokens) |
| `application-request.mjs` | Shared browser-controller lease + four-active-role cap for durable application requests |
| `one-shot-request.mjs` | Durable One-shot chain (prepare → gate → fill → review-ready) drained by the active agent |
| `install-browser.mjs` | postinstall Chromium bootstrap with a genuine fallback; non-fatal by design |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/email.md` | Formal application email draft instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/regional/*` | Regional market calibration modes |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/titles.md` | Adjacent job-title suggestion instructions |
| `modes/upskill.md` | Skill-gap analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/queue.md` | Queue score + prepare mode instructions |
| `queue-store.mjs` | Locked queue read/write, lane logic, and role-local application progress utility |
| `queue-ingest.mjs` | Zero-token incremental queue ingest |
| `queue-resolve.mjs` | Three-layer field lookup and per-page teach contract |
| `queue-sweep.mjs` | Queue lifecycle recovery and closed-role sweep |
| `answer-cache.mjs` / `screener-store.mjs` | Locked reusable-answer and screener stores |
| `application-answers.mjs` | Receipt-derived `## Application Answers` formatter and report updater |
| `application-safety.mjs` | Context-aware application navigation, registration, and final-submit classifier |
| `application-receipt.mjs` | Consumes executable resolver evidence into a durable per-page ledger, solely finalizes report/queue review-ready `filled` state, and owns the idempotent receipt-bound report promotion/rollback used after candidate-confirmed submission |
| `verify-application-contract.mjs` | Read-only cross-agent and runtime application-contract consistency guard |
| `credentials-store.mjs` / `login-core.mjs` | Exact-host portal credential helper and login/registration state classifier |
| `field-rules.mjs` | Deterministic application-field rules |
| `run-partition.mjs` | Pure routing partition for durable active-agent application requests versus not-ready roles |
| `dashboard-launch.mjs` | Local apply-dashboard launcher |
| `dashboard-server.mjs` | Localhost apply-queue dashboard server |
| `dashboard/web/*` | Dashboard SPA (HTML/CSS/JS) |
| `form-fill.mjs` | Offline deterministic fill-plan generator; no browser, queue, or status mutation |
| `tests/*` | Auto-discovered system tests, including application-contract and receipt gates |
| `modes/offer-prep.md` | Offer-stage contract reading companion instructions |
| `modes/interview/*` | Interview prep planning, practice, and debrief skills |
| `modes/de/*` | German language modes |
| `modes/fr/*` | French language modes |
| `modes/hi/*` | Hindi language modes |
| `modes/ja/*` | Japanese language modes |
| `modes/nl/*` | Dutch language modes |
| `modes/pl/*` | Polish language modes |
| `modes/pt/*` | Portuguese language modes |
| `modes/ru/*` | Russian language modes |
| `modes/heuristics/*` | Shared candidate-facing application heuristics |
| `CLAUDE.md` | Agent instructions (Claude Code) |
| `CODEX.md` | Thin Codex wrapper importing `AGENTS.md` |
| `OPENCODE.md` | Thin OpenCode wrapper importing `AGENTS.md` |
| `KIMI.md` | Thin Kimi wrapper importing `AGENTS.md` |
| `GEMINI.md` | Legacy no-op context guard (prevents Antigravity duplicate imports) |
| `AGENTS.md` | Canonical agent instructions (imported by CLI-specific wrappers) |
| `*.mjs` | Utility scripts |
| `plugins/` | Bundled plugins + the plugin engine (opt-in external integrations) |
| `plugins.mjs` | Plugin CLI (list/run/available/add/new/enable/skill/trust/remove) |
| `plugins-registry/` | Curated community plugins, one `<id>.json` per plugin (the trust root) |
| `plugin-install.mjs` / `plugin-audit.mjs` / `validate-plugin-registry.mjs` | Plugin install/audit/registry-validation utilities |
| `config/plugins.example.yml` | Plugin activation template (seed for `config/plugins.yml`) |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions (Claude Code) |
| `.cursor/skills/*` | Skill definitions (Cursor) |
| `.opencode/skills/*` | Skill definitions (OpenCode) |
| `.qwen/skills/*` | Skill definitions (Qwen Code) |
| `.antigravitycli/skills/*` | Skill definitions (Antigravity CLI) |
| `.grok/skills/*` | Skill definitions (Grok Build CLI) |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |
| `UPSTREAM_MERGE_CHECKLIST.md` | Binding fork-protection gate for manual upstream merges |
| `writing-samples/README.md` | System-owned onboarding documentation for the writing-samples directory |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
