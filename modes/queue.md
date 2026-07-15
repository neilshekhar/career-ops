# Mode: queue — Incremental Score + Prepare

Two phases in one mode, invoked by `/career-ops queue [score|prepare]`.
Default (no sub-argument) runs the **score** phase.

Both phases operate on `data/apply-queue.json`. Read the file first; update
only the records relevant to the current phase; write the file back.

---

## Sources of truth (read before either phase)

| File | When |
|---|---|
| `data/apply-queue.json` | ALWAYS — the queue |
| `config/profile.yml` | ALWAYS — visa/work-rights, comp targets |
| `modes/_profile.md` | ALWAYS — scoring overlays, visa-answer rule, employment-type policy |
| `modes/_shared.md` | ALWAYS — A-F scoring framework and global rules |
| `cv.md` | ALWAYS — proof points for scoring and drafting |
| `article-digest.md` | If present — richer proof points |

---

## Phase 1: Score

**Trigger:** `/career-ops queue` or `/career-ops queue score`

Find every role in `data/apply-queue.json` with `"status": "new"`. For each:

### Step 1 — Read the JD (no JD → fetch first, never score a title)

Use `role.jd_text` if present and substantive (roles discovered by the cron
carry the full JD text directly). Otherwise read the file at `jd_path`.

If neither holds substantive content (responsibilities + requirements — a
title, snippet, placeholder, or page shell does not count), **fetch before
scoring**. First ask the executable retry policy whether an automatic fetch is
allowed:

```bash
node queue-sweep.mjs retryable <role-id>
```

- `attempt: false`, `code: manual-action-required` → do **not** automatically
  retry a deterministic login/robots/auth blocker. Surface it so the candidate
  can log in or paste the JD.
- `attempt: false`, an attempt/age-cap code → do not fetch again. The end-of-run
  sweep closes it as unreachable on the local backend; on Supabase it remains
  active but non-retryable until atomic cloud revival exists.
- `attempt: true` → fetch using the cheapest rung first:

1. Public ATS API / deterministic fetcher (zero tokens).
2. `node check-liveness.mjs <url>` for liveness; a definitive `expired` →
   close the role through the normal queue workflow, do not score.
3. Playwright for non-ATS or inconclusive pages.

On success, persist the JD into `role.jd_text` and score normally. On failure,
record the attempt and **skip scoring this role**:

```bash
node queue-sweep.mjs record <role-id> --reason "<why it failed>"
```

The role stays `status: new` with the `no-jd` flag; `queue-sweep.mjs` applies
the class-aware retry cap (login/robots: no retries, ~7d grace; transient: ≤3
attempts or ~14d). An exhausted local role closes as `unreachable` — never as
expired. An exhausted Supabase role remains active but non-retryable until the
store supports atomic revival. A JD the candidate pastes counts as a valid
retrieval.

After a successful fetch, persist the substantive JD and clear the active
failure state through the checked recovery transition:

```bash
node queue-sweep.mjs recover <role-id>
```

This command refuses to clear `no-jd`/`jd_fetch` when the persisted content is
still a title, placeholder, listing page, expired page, bot challenge, or portal
shell. Reload the role after the command, then score it normally.

### Step 2 — Determine employment type (do this while reading the JD)

Classify as `"full-time"`, `"part-time"`, or `"ambiguous"`:

- `"full-time"`: JD says "full-time", "permanent", "40 hours/week", or does not
  mention hours at all and does not use part-time language.
- `"part-time"`: JD explicitly says "part-time", "casual", specifies hours below
  35/week, or uses "flexible hours" alongside other part-time signals.
- `"ambiguous"`: the JD is genuinely unclear — e.g. "flexible hours" with no
  other signal, or conflicting signals. **Never guess. Set ambiguous and flag.**

Store the result in `employment_type`.

### Step 3 — Select visa answer (locked rule — DO NOT CHANGE)

Read the locked rule from `modes/_profile.md` → `## Location Policy →
Visa status dropdown — locked rule`. Apply it exactly:

- Full-time role → `visa_form_answer_fulltime` from `config/profile.yml`
- Part-time role → `visa_form_answer_parttime` from `config/profile.yml`
- Ambiguous → `null` (add flag `ambiguous-employment`; route to review-carefully)

Store in `visa_answer`.

### Step 4 — Score (A-F framework)

Apply the scoring framework from `modes/_shared.md` with the user overlays
from `modes/_profile.md`. Read the JD; match against cv.md.

Produce:
- `score_raw` — weighted score before caps
- `score` — final score after all caps (use the strictest if multiple apply)
- `size_bucket` — "startup" | "mid" | "large" | "unknown" (research headcount)
- `eligibility` — "ok" | "cap" | "blocked" (see _profile.md eligibility rules)
- `confidence` — "high" | "medium" | "low"
- `reason` — one sentence explaining the score and the single biggest factor

Do NOT write a full A-G report. Do NOT generate a PDF. This is a lightweight
score pass only. The score caps and visa-eligibility rules in `modes/_profile.md`
apply exactly as they do in the full evaluation.

**Part-time scoring:** Do NOT downscore solely because a role is part-time.
Apply scoring preference #6 from `modes/_profile.md`. Score on data quality,
tech stack, and fit exactly as you would a full-time role.

### Step 5 — Flags

Populate `flags[]` with any active signals:

| Flag | When |
|---|---|
| `ambiguous-employment` | `employment_type == "ambiguous"` |
| `large-co-visa-cap` | large company + student-visa window active, cap applied |
| `pr-citizenship-required` | eligibility == "blocked" |
| `low-confidence` | `confidence == "low"` |
| `custom-form-fields` | any `free_text_fields` entry has `kind: "custom"` |
| `no-jd` | neither `jd_text` nor the `jd_path` file passes the shared substantive-JD gate (short text, placeholders, listing/expired pages, bot challenges, and portal shells fail) |

### Step 6 — Update the record

Write these fields back into the role object in `apply-queue.json`:

```
employment_type, visa_answer, score_raw, score, size_bucket,
eligibility, confidence, reason, flags (merge, don't replace),
status: "scored", scored_at: <ISO timestamp>
```

Leave all other fields unchanged. Write the updated queue file. `no-jd` is the
one removal exception to the flag-merge rule: the checked `recover` command
must remove it (and `jd_fetch`) before the role is marked scored.

### Step 7 — Summary

After processing all new roles, print a summary table:

```
Scored N role(s):

Company           | Title                        | Type      | Score | Lane
------------------|------------------------------|-----------|-------|------------------
EasyGo            | Senior Data Analyst – Kick   | full-time | 4.4   | ready
...

→ Open the dashboard: node dashboard-server.mjs
→ Or set threshold and prepare: /career-ops queue prepare
```

### Step 8 — Sweep unreachable no-jd roles (zero tokens)

End every score run with:

```bash
node queue-sweep.mjs --summary
```

On the local backend it closes roles whose retry cap is exhausted
(`closed_reason: unreachable`). On Supabase it deliberately leaves exhausted
roles open and non-retryable: moving them into `seen_urls` is one-way until the
store has an atomic revive transaction, so terminal closure would violate the
reversibility guarantee. In both cases it prints the still-open no-jd list.
**Relay that list to the candidate** — they can log in or paste the JD text to
unblock a role before it ages out (local) or while its cloud closure is deferred.

---

## Phase 2: Prepare

**Trigger:** `/career-ops queue prepare`

Find every role with `"status": "prepare-queued"`. For each:

### Step 1 — Resolve form fields with the layered resolver (minimum tokens)

Field answers are produced by three layers, cheapest first. The first two run
deterministically with **zero model tokens**; you (the agent) only answer the
few fields that survive to Layer 3.

1. **Run Layer 1 + Layer 2 (a script, no tokens):**

   ```
   node queue-resolve.mjs --pre <role-id>
   ```

   - **Layer 1 — profile rules** (`field-rules.mjs`): exact/keyword matches for
     the fixed fields (name, email, phone, salary, notice/availability, visa
     dropdown, hours, resume attach) **and** employer-independent custom fields
     (country, residence, relocation, office-days, work-rights free-text,
     website, verification consent). Values come from `config/profile.yml`.
     Select fields are mapped to an exact option.
   - **Layer 2 — semantic answer cache** (`answer-cache.mjs` + local
     embeddinggemma via `embed.mjs`): any field not caught by Layer 1 is
     embedded and matched against previously answered questions. A cached answer
     is reused only if cosine ≥ threshold AND it is marked `reusable` AND its
     entities match. **Never** reused when the answer depends on a differing
     location, number, date, or dollar amount.
   - Resolved answers are written into `role.drafts` with provenance. The
     command prints a JSON `novel` list — the only fields needing Layer 3.

   You do **not** read the form DOM. You only act on the printed `novel` list.

2. **Layer 3 — answer the novel fields, then teach the cache.** For each item in
   the `novel` list, write an answer grounded in `config/profile.yml`, `cv.md`,
   and the JD (`role.jd_text` if present and non-empty, else `jd_path`; use `article-digest.md` if present; never invent).
   For each, decide whether the answer is **employer-independent** (safe to
   reuse → `reusable: true`) or company/role-specific (`reusable: false`), and
   note any key `entities` it is tied to. Then store + teach in one call:

   ```
   node queue-resolve.mjs --teach <role-id> '@/path/to/answers.json'
   ```

   where each item is `{ "label", "type", "answer", "reusable", "entities", "confidence" }`.
   This writes the answers into `role.drafts` (provenance `model`) and stores
   each question + its embedding in the cache so future paraphrases hit Layer 2
   for free.

Motivational / "why this company/role" questions are employer-specific →
`reusable: false`. Behavioural or skills questions ("describe your SQL
experience") are usually employer-independent → `reusable: true`.

### Step 2 — Generate and review tailored application assets

Run the existing CV pipeline:

1. Read cv.md + article-digest.md.
2. Extract keywords from the JD: use `role.jd_text` if present and non-empty, otherwise read `jd_path`.
3. Tailor and rewrite as per `modes/pdf.md` (keyword injection, summary rewrite,
   project reorder — never invent experience).
4. Save the filled HTML beside the PDF, not in `/tmp`:
   `output/cv-{candidate}-{company-slug}-{date}.html`.
5. Generate with the role-appropriate style selected by `modes/pdf.md`:
   `node generate-pdf.mjs output/cv-{candidate}-{company-slug}-{date}.html output/cv-{candidate}-{company-slug}-{date}.pdf --style={standard|conservative}`
6. Store the PDF path in `cv_pdf`. The retained HTML is required for content QC,
   staleness-safe regeneration, and punctuation checks.

Then run the full interactive `modes/cover.md` workflow for this role. The company
research confirmation, gap resolution, keyword confirmation, and all four candidate
answers are mandatory even in queue PREPARE. Generate MD, PDF, and DOCX from one
canonical payload with `generate-cover-formats.mjs`, then store all paths (including
the payload) in `cover_letter_paths`. Do not use a batch-template cover as the final
letter and do not mark the role prepared while those confirmations are missing.

Before release, store this local-only review record on the role:

```json
{
  "application_quality_review": {
    "reviewed_at": "<ISO timestamp>",
    "top_requirements": [
      { "requirement": "<JD phrase>", "evidence": "<matching proof>", "source": "cv.md" },
      { "requirement": "<JD phrase>", "evidence": "<matching proof>", "source": "article-digest.md" },
      { "requirement": "<JD phrase>", "uncovered": true }
    ],
    "company_specific_references": ["<reference used in cover>", "<second reference used in cover>"],
    "sources_used": ["<optional exact repo path for each additional style/factual input used>"],
    "uncovered_requirements": ["<honest gap, if any>"]
  }
}
```

Map at least the top three requirements. Every mapped item must contain sourced
evidence or `uncovered: true`; never manufacture evidence to make the manifest green.
The `evidence` value must be an exact source excerpt, not a paraphrase:
`verify-userdata.mjs` normalizes it and proves that it occurs in the cited file.
Omit `sources_used` when there are no additional inputs. When present, list only
files actually used for this role (for example a writing sample or the matching
company-role prep file); the validator binds those exact files into generation
provenance and rejects traversal, symlinks, README scaffolds, and retracted/red-flag
notes. Writing samples remain style-only and never satisfy candidate fact tracing.

### Step 3 — Update the record

**Do not mark a role `prepared` until `queue-resolve.mjs --pre` has run** and
`role.drafts` is populated (or the role has no `free_text_fields` at all). The
failure mode to avoid: a shortcut script that only writes `cv_pdf` +
`cover_letter_paths` and flips status to `"prepared"` without running the resolver —
this leaves `drafts` empty, which means every field is regenerated by the LLM at fill
time on every portal. This is exactly what happened in the 2026-06-25 session (all 40
roles had `drafts: {}`). Always run `queue-resolve.mjs --pre` (Layers 1+2), then run
`queue-resolve.mjs --teach` only when Layer 3 novel answers exist, before writing status.

**Custom-portal roles (`ats: custom`) may have sparse `role.drafts` after `--pre`** —
that is expected and not a failure. Their real form fields only render inside the live
portal (behind JS / login walls / multi-page wizards), so `free_text_fields` captured at
ingest time rarely matches the live form exactly. The live `--lookup` call in `modes/apply.md`
Step 6 fills the gap at apply time. As long as `--pre` ran without error and `cv_pdf` is
set, the role is safe to mark `prepared`. The "no `prepared` without drafts" rule is about
not skipping `--pre` entirely — not about requiring a full `drafts` object for custom portals.

First write these fields via `saveQueue()` while leaving the status as
`prepare-queued`:

```
drafts, cv_pdf, cover_letter_paths, application_quality_review
```

Then stamp the release provenance after every asset and the quality manifest are
final. Read the active model from the CLI's status/model selector; do not guess or
write `unknown`:

```
node generation-provenance.mjs stamp \
  --role <role-id> \
  --cli <exact-active-cli-id> \
  --model <exact-active-model> \
  --effort <exact-active-effort-if-configured>
```

This writes `generation_provenance` with `flow: interactive-prepare`, the CLI/model,
optional effort, current asset paths, and SHA-256 hashes. The stamp command and independent
release gate both enforce `application_quality.release_model_policy`: `open` accepts
any explicitly identified model, while `allowlist` checks
`application_quality.allowed_release_models`. A CLI-wide `allowed_release_efforts` floor
can have exact-model exceptions in `allowed_release_model_efforts`; unlisted models retain
the CLI-wide floor. Missing provenance, batch provenance,
an unapproved model/effort or flow, a later file edit, or a path swap all fail closed.
Batch/headless outputs cannot be stamped as interactive merely because they look good;
regenerate selected roles through this PREPARE flow.
`release_model_policy: open` supports any current or future CLI/model while retaining
the deterministic gates. `allowlist` enforces a user's exact local choices. See
`docs/MODEL_SELECTION.md`; never infer that compatibility means equal writing quality.

Then run:

```
node verify-userdata.mjs --role <role-id>
```

Only when it exits zero may you write `status: "prepared"` and
`prepared_at: <ISO timestamp>` via `saveQueue()`. If it exits non-zero, leave the
role at `prepare-queued`, report every failed check, and regenerate or ask the
candidate for the missing input. Never waive a validator error silently.

### Step 4 — Summary

```
Prepared N role(s):

EasyGo – Senior Data Analyst – Kick
  CV: output/cv-{candidate}-{company-slug}-{date}.pdf
  Fields: 13 resolved (11 deterministic, 0 cache, 0 model) · 0 novel
  Tokens: 0 (all Layer 1)

→ Open the dashboard to review and fill: node dashboard-server.mjs
   (form-fill applies the resolved drafts deterministically and attaches the CV;
    it labels each field deterministic / reused-from-cache / model-reasoned and
    never clicks submit.)
```

For roles that chained through one-shot auto-fill (Step 5), note it in the
summary line: `⚡ auto-fill: form-fill launched — review in the open browser`.

### Step 5 — One-shot auto-fill (`auto-fill` flag / `auto_fill_all` setting)

A role is **one-shot** when either holds:

- its `flags[]` contains `auto-fill` (per-card ⚡ Auto-fill toggle in the
  dashboard inbox), or
- the queue's `settings.auto_fill_all` is `true` (header-level "⚡ One-shot"
  toggle — applies to every role this phase prepares).

For each one-shot role, chain straight into the fill after marking it
`prepared` — do not park it at Prepared waiting for a dashboard Fill click:

- **Deterministic ATS (greenhouse / lever / ashby / …):** launch the same fill
  the dashboard Fill button runs — `node form-fill.mjs <role-id>`, headed,
  detached (run it in the background so the open review browser doesn't block
  you). `form-fill.mjs` handles login walls itself and never clicks Submit.
- **Custom ATS (`ats: custom`):** after finishing all prepares, continue inline
  into the agent apply flow (`modes/apply.md`) for that role.
- **Deep-eval marked too:** the deep-eval rule wins the ordering — full
  `oferta` first (see `modes/apply.md` → "Deep-eval marker"), then prepare,
  then fill.

Roles **without** the flag (while `auto_fill_all` is off) keep the existing
behavior: stop at `prepared` and wait for the candidate's Fill action in the
dashboard.

Guarantees unchanged: the asset gate holds because the fill runs strictly
*after* this PREPARE produced fresh CV + cover assets for the role, and nothing
is ever submitted — every chained fill parks at In Review for the candidate's
manual review and submit.

---

## Login-gated portals

Roles with `flags` containing `login-required` use portals that gate the form behind
a candidate account. Follow the standing procedure in `modes/apply.md →
## Login-gated portals` for the login/registration flow. `form-fill.mjs` handles
login-wall detection and polling automatically for deterministic-fill ATSes; for
custom ATSes, the agent apply path handles it interactively.

---

## Hard rules (both phases)

- **Never auto-submit.** The only side effects of this mode are apply-queue.json
  writes, asset generation, and (for `auto-fill`-flagged roles) launching the
  never-submitting `form-fill.mjs` — Submit stays manual in every path.
- **Never modify** cv.md, portals.yml, or the locked scoring rules.
- **Never duplicate** scoring literals from `_profile.md` into this file.
  Always delegate: "as per `modes/_profile.md`" — not "cap at 3.4".
- **Part-time = same score weight** as full-time. Score on fit, not on type.
- **Ambiguous employment → never guess.** Flag it and route to review-carefully.
- **Minimum tokens.** Always run `queue-resolve.mjs --pre` first; only answer the
  printed `novel` fields. Never read the form DOM to answer fields.
- **No `prepared` without drafts.** A role must not be marked `status: "prepared"`
  until `queue-resolve.mjs --pre` has run and `role.drafts` is populated (or the role
  has no `free_text_fields`, or the role is `ats: custom` whose live fields are resolved
  at apply time via `--lookup` — sparse drafts after `--pre` are expected and not a
  failure for custom portals; see Step 3). Shortcut scripts that flip status without
  running `--pre` break the fill pipeline on every portal — see Step 3 above.
- **Cache safety.** Mark an answer `reusable: true` only when it is genuinely
  employer-independent and not tied to a specific location/number/date/amount.
  The resolver enforces this on lookup, but set the flag honestly.
