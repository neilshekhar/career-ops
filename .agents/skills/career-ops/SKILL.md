---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[scan | deep | pdf | latex | cover | email | add | eu-swe | oferta | ofertas | apply | batch | tracker | agent-inbox | pipeline | contacto | training | project | interview-prep | interview | interview-redflag | interview/plan | interview/practice | interview/debrief | patterns | offer-prep | titles | followup | queue | reply-watch | update]"
license: MIT
---

# career-ops -- Router

career-ops is a multi-CLI job-search command center. The routing below is shared across supported agent CLIs even when the invocation surface differs.

## Invocation Notes

- CLIs with slash-command registration can expose this router as `/career-ops`.
- Interactive Codex sessions use `codex` in the repo root. Slash commands are not guaranteed in Codex, so ask Codex to run the same mode by name if `/career-ops` is unavailable.
- Headless Codex workers use `codex exec "prompt"`.
- The routing semantics below stay the same regardless of whether the entrypoint is a slash command or a natural-language prompt.

Codex prompt examples that map to the same router semantics:

```text
Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123
Run the career-ops scan mode and summarize new matches.
Run the career-ops pipeline mode for data/pipeline.md.
Run the career-ops pdf mode for the latest evaluated role.
Run the career-ops tracker mode and summarize the current statuses.
```

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `interview-prep` | `interview-prep` |
| `interview` | `interview` |
| `interview-redflag` | `interview-redflag` |
| `eu-swe` | `regional/eu-swe` |
| `interview/plan` | `interview/plan` |
| `interview/practice` | `interview/practice` |
| `interview/debrief` | `interview/debrief` |
| `pdf` | `pdf` |
| `latex` | `latex` |
| `email` | `email` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `agent-inbox` | `agent-inbox` |
| `inbox` | `agent-inbox` |
| `reply-watch` | `reply-watch` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `offer-prep` | `offer-prep` |
| `titles` | `titles` |
| `followup` | `followup` |
| `queue` | `queue` |
| `queue score` | `queue` (score phase) |
| `queue prepare` | `queue` (prepare phase) |
| `update` | `update` |
| `cover` | `cover` |
| `add` | `add` |

**Auto-pipeline detection:** If `$mode` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `$mode` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

If your CLI supports `/career-ops`, show this menu. In Codex, surface the same options in plain text and map the requested mode the same way.

Concrete equivalents for Codex prompt-driven sessions:

```text
/career-ops {JD}           ↔ "Evaluate this JD with career-ops auto-pipeline: {JD or URL}"
/career-ops scan           ↔ "Run the career-ops scan mode and summarize new matches."
/career-ops pipeline       ↔ "Run the career-ops pipeline mode for data/pipeline.md."
/career-ops pdf            ↔ "Run the career-ops pdf mode for the latest evaluated role."
/career-ops email          ↔ "Run the career-ops email mode for the latest evaluated role."
/career-ops tracker        ↔ "Run the career-ops tracker mode and summarize the current statuses."
```

Show this menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate/score + verdict first; wait for explicit continue/dashboard selection
  /career-ops pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-ops oferta    → Evaluation only A-G (no auto PDF)
  /career-ops ofertas   → Compare and rank multiple offers
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
  /career-ops deep      → Deep research prompt about company
  /career-ops interview-prep → Generate company-specific interview prep doc
  /career-ops interview    → Interactive profile/CV onboarding interview
  /career-ops interview-redflag → Analyze company and process red flags
  /career-ops eu-swe    → Calibrate a European SWE application before CV/apply/interview
  /career-ops interview/plan → Time-blocked prep plan for an upcoming interview
  /career-ops interview/practice → Practice interview, one question at a time with feedback
  /career-ops interview/debrief → Post-interview debrief: close gaps, predict next round
  /career-ops pdf       → PDF only, ATS-optimized CV
  /career-ops latex     → Export CV as LaTeX/Overleaf .tex
  /career-ops cover     → Cover letter: standalone JD paste or /career-ops cover {slug}
  /career-ops email     → Formal application email draft (draft-only; never sends, submits, or clicks)
  /career-ops add       → Add a project/paper/role to your CV (fetch + preview + confirm)
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops agent-inbox → Queue/drain requests for the next session (data/agent-inbox.md)
  /career-ops reply-watch → Classify replies and suggest tracker updates
  /career-ops apply     → Fill every authorized form field; stop at final submission for review
  /career-ops scan      → Scan portals and discover new offers
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops offer-prep → Read a received offer/contract with the candidate: clause walk + lawyer questions (not legal advice)
  /career-ops titles    → Suggest adjacent job titles from your CV to broaden the search
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops queue     → Score new queue stubs (then: queue prepare to draft + PDF)
  /career-ops update    → Update career-ops system files with diff preview + compat check

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to evaluate/score it and show the verdict first; tailored assets and application work wait for explicit continue/dashboard selection.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

**Always also load the user's house rules.** If `modes/_custom.md` exists, read it
alongside the mode files below for **every** mode and honor it. It holds the user's
procedural preferences (house rules, custom workflows, output preferences, off-limits)
and overrides system defaults where they conflict, within the Data Contract (never
auto-submit an application; never put user-specific content in system files — see
`DATA_CONTRACT.md`). It may be absent on a fresh setup; if so, just skip it.

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `agent-inbox`, `reply-watch`, `deep`, `interview-prep`, `interview`, `interview-redflag`, `regional/eu-swe`, `interview/plan`, `interview/practice`, `interview/debrief`, `latex`, `training`, `project`, `patterns`, `titles`, `followup`, `queue`, `cover`, `email`, `add`, `offer-prep`

### Delegation and the single browser controller

`scan` and `pipeline` (3+ URLs) may launch bounded workers under their mode-specific
concurrency rules. A live `apply` run is different: exactly one browser controller owns
the shared tab ledger and every browser/queue write. The current agent should remain that
controller when it already has browser access. If no controller exists, it may designate
one worker as the controller, but it must resume that same worker for the entire session;
never spawn a second or parallel browser-backed apply agent. Additional workers may reason
over compact secret-free novel-field JSON only and may not touch the browser, queue,
credential store, resolver teach writes, or receipt ledger.

Before any live action, the designated controller must itself read current
`modes/_shared.md`, `modes/apply.md`, `modes/_custom.md` when present,
`apply-page.mjs`, `queue-resolve.mjs`, and `application-receipt.mjs`; a copied excerpt or
parent summary is not a substitute. Default for every NEW live begin is **`lean-llm-v1`**:
`apply-page.mjs lookup` → fill resolved → L3 all novel → teach reusable novels →
`apply-page.mjs page-done` → selective re-observe only on risk → Next → …
`apply-page.mjs finish` → queue status **`prefilled`**. Lookup derives
`upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` (including
`[]`); bind attachments with `control_id` + content SHA-256 / `asset_sha256`. Lean rejects
`complete` / `finalize`. Never click a final application submission control. Mark Submitted
for lean `prefilled` is manual / `--external`. Historical receipt-v3 (explicit begin stamp)
uses lookup → complete → finalize → review-ready `filled`. Account creation and one
exact-host stored-credential login attempt belong to
the controller; a staged registration password is persisted only after accepted-registration
evidence v2 is bound to the active dashboard role/request/run/controller/tab with
`node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'`, then
validated again by
`commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)`.
The binding may precede begin while the request is queued; an in-progress
request must also match `application_progress.tab`. A caller-authored digest alone cannot
persist a password, and an existing exact-host credential is never overwritten.
The controller fills every question, flags conservative inferences for the combined review,
and never performs final application submission. For modes where a worker is permitted, inject `_shared.md` plus the
selected mode and require the worker to follow the mode's own canonical references. If
your CLI exposes an `Agent(...)` primitive, a permitted non-browser worker call looks
like this:

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[content of modes/_custom.md if present]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.

### Localized apply aliases

Every localized live-application alias (`takdeem`, `bewerben`, `postuler`,
`aavedan`, `melamar`, `candidarsi`, `oubo`, `jiwon`, `aplikuj`, `aplicar`,
`basvuru`, and localized files named `apply`) executes root `modes/apply.md` as
the single workflow. Load the selected locale's `_shared.md` only for language and
regional vocabulary, then load root `modes/apply.md`, `modes/_custom.md` when
present, `apply-page.mjs`, the current `queue-resolve.mjs` contract, and
`application-receipt.mjs`.
The six-file controller read list above remains mandatory. Use
`apply-page.mjs` for per-page lean lookup/page-done/finish (default lean-llm-v1 →
`prefilled`) and keep `application-receipt.mjs` as the only valid
`prepared` (or legacy/receipt) → review-ready `filled` promotion on explicit receipt-v3.
A localized wrapper may not
replace, omit, or reorder queue, auth, resolver/teach, tab, persistence, review, or
never-submit behavior.

Localized evaluation and pipeline aliases follow the same pattern: execute root
`modes/oferta.md` or `modes/pipeline.md` as the single workflow, and use the selected
locale's `_shared.md` only as a language/market overlay. They may not copy, replace,
omit, or reorder liveness, research, numbering, scoring, persistence, or review gates.
