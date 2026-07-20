# Mode: apply — Live Application Assistant

> Apply `voice-dna.md` (if present) to free-text answers and cover-letter fields — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

Interactive mode for when the agent is filling an authorized application form in Chrome
for the candidate. It reads the live page, loads the role context, answers every form
question through the layered resolver, and leaves the form at lean queue status
**`prefilled`** for candidate review and submission (default `lean-llm-v1`). Historical
receipt-v3 (`filled`) is opt-in only.

## Required current contracts

Before any live action, the browser controller must itself read all six current files:

1. `modes/_shared.md`
2. `modes/apply.md`
3. `modes/_custom.md` when present
4. `apply-page.mjs`
5. `queue-resolve.mjs`
6. `application-receipt.mjs`

A copied excerpt, earlier-session reading, or another agent's summary is not a substitute.
`apply-page.mjs` is the only agent-facing page driver. It is dual-protocol:

- **Default for every NEW live `begin`:** `lean-llm-v1` (`verification_mode: "selective"`,
  `receipt_required: false`). Lifecycle helper: `lean-application.mjs`. Loop ends at
  queue status **`prefilled`** via `apply-page.mjs page-done` / `apply-page.mjs finish`.
  Lean runs **reject** `complete` / `finalize`.
- **Historical / opt-in only:** `execution_protocol: "receipt-v3"` (explicit begin stamp).
  Then `lookup` → `complete` (after-snapshot + page receipt) → `finalize` → review-ready
  **`filled`**. See the Historical receipt-v3 appendix.

Lookup still uses Playwright MCP snapshot files under `.playwright-mcp/` so the driver can
derive fields and `control_id` values — never hand-serialize manifests for the driver.

## Queue integration

Before starting the interactive apply flow, match the role to a queue record by URL or
company+title. A queue record and stable role ID are a hard precondition for live filling:

- **If a queue record exists:** load its `employment_type`, `visa_answer`, `drafts`,
  `cv_pdf`, `cover_letter_paths`, and `free_text_fields`. Exact current-role drafts may
  resume verbatim. All other fields pass through the per-page resolver loop below.
- **If no queue record exists:** ingest/create the record first, then resume with its role
  ID. Never use an untracked legacy/manual fallback because `apply-page.mjs` lookup,
  page-done / finish (lean) or complete / finalize (receipt-v3), and persistence all
  require that ID.

This protocol applies to every portal — SEEK, Indeed, JobAdder, Gem, Workday,
PulseSoftware, Greenhouse, Lever, Ashby, and any other — including direct browser-tool
fills.

### Application asset quality gate

After any `deep-eval` work and before opening or filling the form, run:

```
node verify-userdata.mjs --role <role-id>
```

Continue only when it exits zero. A non-zero result means the assets are missing,
stale, structurally invalid, mismatched to the role, unsupported by their cited
evidence, contain untraced candidate numbers/named terms, violate the configured
`open`/`allowlist` model policy, lack release-eligible interactive provenance, or fail
another configured quality rule. Stop and run queue
PREPARE again, stamp fresh model/effort provenance with `generation-provenance.mjs`, and rerun the
validator; do not attach an older file and do not waive the error in conversation.
This gate applies to every active-agent live fill, including custom and structured ATS
forms. `form-fill.mjs` may prepare an offline plan, but it cannot satisfy this live gate
or mutate the browser, queue, or role status.

### Deep-eval marker (oferta-first)

A role may carry the `deep-eval` flag in its `flags[]` (set from the dashboard's
★ Deep-eval button — `POST /api/role/:id/flag`). The flag means **"this role is worth a
full evaluation before I apply."** Honour it automatically — the candidate does not need to
ask for it each time; the mark is the standing instruction.

- **At the start of the apply/fill flow for a `deep-eval`-marked role:** if no current A–G
  report already exists for it in `reports/`, run a full `oferta` evaluation and persist
  its report first. Then run the ordinary queue PREPARE phase to generate fresh tailored
  CV and cover assets before proceeding with the normal apply/fill. If a current report
  already exists, reuse it — do not re-run `oferta`; PREPARE remains the asset-creation
  authority.
- This only adds an evaluation-first step for **marked** roles. It does **not** change the
  deterministic fill pipeline stages executed inside the active-agent flow
  (`queue-resolve.mjs` plus L1/L1.5/L2/L3) or how any individual field is filled.
  Unmarked roles behave exactly as before.
- The dashboard web server cannot run `oferta` or browser automation. Its Fill/Run action
  only queues a durable `application_request`; the active agent consumes that request and
  enforces this gate before opening or filling the role.

**On open:** re-verify liveness with `node check-liveness.mjs <url>` for supported
ATS hosts. For non-ATS or inconclusive results, inspect the current role tab with a
Playwright snapshot; if the exact posting must be reopened, use a new role tab rather
than navigating or reloading a preserved/filled application tab. If the posting is
closed, mark the queue record `status: "closed"` and inform the candidate.

**Complete-but-reviewable fill:** populate every application question. Resolve fields in
order: deterministic/profile rules (L1), learned/exact and semantic cache (L1.5/L2), then
the capable interactive model (L3). When the permitted sources do not establish an exact
answer, L3 chooses the most conservative truthful response the context supports, fills it,
and marks it `review_required: true` with a short note. Never fabricate qualifications,
achievements, authorship, citizenship, clearance, diagnoses, or other factual claims.
Uncertainty changes the final review flag, not whether the field is answered.

**Part-time hours guardrail:** for part-time roles, any hours/week or availability
field must use `application_answers.availability_parttime` (text) or
`application_answers.max_hours_per_week_parttime` (number). Never enter a value
above the configured work-rights or availability limit in `config/profile.yml`.

**Stop before submit:** this mode fills and presents answers; the candidate submits manually.
Never click a final application submission control. After the candidate has submitted,
they record that outcome through the dashboard's explicit **Mark Submitted** /
**Submitted** confirmation UI. For lean **`prefilled`** roles that is the manual /
`--external` path; receipt-backed **`filled`** roles keep receipt-gated Mark Submitted.
That UI first obtains a short-lived, role-bound, one-use nonce from
`POST /api/role/:id/submission-confirmation` using the exact phrase
`I submitted this application in the portal`, then supplies the returned
`confirmation_nonce` to `POST /api/role/:id/decision {decision:"submitted", ...}`.
The agent must not infer submission, synthesize either request, or bypass the candidate UI.

---

## Login-gated portals (standing procedure)

Some ATSes gate the application form behind a candidate account login.
These roles carry the `login-required` flag in the queue and show a 🔐 badge
in the dashboard.

The same exact-host state machine applies to deterministic and custom ATS paths:

1. Follow the posting's Apply route in its own tab, then derive the credential key from
   `new URL(page.url()).host` **after every redirect**. Never use the discovery/board host
   when a different host renders the login or registration form.
2. Classify the current page before touching credentials:
   - **Registration form + no exact-host credential:** read candidate PII from
     `config/profile.yml`, inspect the displayed/DOM password constraints, pass those
     constraints to `generatePassword(policy)`, and keep the password only in memory.
     Fill and submit the **account-registration confirmation**. That confirmation is
     permitted because it creates the portal account; it is not the final job-application
     submission. After the portal accepts the account or transitions to a
     verification/authenticated state, capture exact-host accepted-registration evidence
     (`version`, `classification: "registration-accepted"`, `result: "accepted"`,
     `portal_host`, `registration_url`, `account_email`, `account_created: true`,
     `application_submission_detected: false`, `role_id`, `application_request_id`,
     `run_id`, `controller_id`, `tab_id`, `observation_source: "playwright-mcp"`,
     an `acceptance_signal` of `registration-accepted`, `verification-required`, or
     `authenticated`, `accepted_at`, the accepted-page `snapshot_digest`, and the
     DOM-derived `registration_control_id`). Before persisting the staged password, bind
     that secret-free observation to the durable queue with
     `node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'`, then call
     `commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)`.
     Binding may happen while the dashboard request is still `queued`, before receipt
     `--begin`; after begin, the same evidence must also match `application_progress.tab`.
     A commit without matching active role/request/run/controller/tab and durable
     Playwright observation is invalid. If the portal still rejects the value, add it to the in-memory
     `rejectedPasswords` policy list and generate a different compliant replacement.
     A missing store entry does not prove the account is new; if
     the portal says the email already exists, move to the existing-account path.
   - **Sign-in form + exact-host credential:** call `getCredentials(host)` and attempt one
     sign-in without logging or exposing the values. If rejected or still on the login
     wall, treat the stored password as stale; never overwrite it.
   - **Sign-in form + no credential, or rejected stored credential:** alert the candidate once,
     keep the tab/session open, continue other applications, and return after they have
     signed in manually and the application form is visible. Never create a duplicate,
     reset/change a password, or start account recovery.
   - **CAPTCHA, email verification, OTP/MFA, security question, password change, or
     recovery:** the candidate completes it in the browser. Do not ask them to paste a secret into
     chat. Park and poll the tab non-blockingly while other applications continue.
3. Once the form is visible, continue the mandatory per-page resolver loop. A login gate
   blocks only its own tab, never the rest of the batch. A headed watcher may keep polling
   beyond `automation.login_timeout_min`; the timeout triggers an alert/checkpoint, not
   session destruction.
4. For Workday/PageUp and other CV-parsed forms, verify and correct every pre-filled value
   against `config/profile.yml`; do not fill blanks only.
5. Leave the browser/tab open at final review. Never click any final action whose normalized
   label is **Submit, Submit application, Send application, Confirm and submit, Apply now,
   Submit my application, or Submit now** (or an equivalent final control).
6. Only after the candidate actually submits: capture any visible confirmation metadata
   and leave the outcome for the candidate to record through the dashboard's explicit
   **Submitted** confirmation UI. The dashboard obtains a role-bound one-use nonce from
   `/submission-confirmation` before it calls `/decision`; the agent must not mint or
   bypass that confirmation.

**Multi-role sessions — tab management (CRITICAL):**
- When filling multiple roles in one session, open each role in a **separate browser tab**.
- Use `browser_tabs` with `action: "new"` and `url:` to open the next role. **NEVER use
  `browser_navigate` with `newTab: true`** — that replaces the current tab (the generated
  JS is `page.goto()`) and destroys the filled form.
- Fill **all** roles first, leaving every tab open. Present a summary of open tabs when done.
  Include per-role provenance in the summary so the end-of-batch review is effective:
  for each tab note how many fields were `deterministic` / `learned` / `model` (LLM-generated).
  Flag any `learned` or `model` answers on knockout/screener fields for extra scrutiny —
  everything else can be skimmed. No blocking prompts; the candidate submits at the end.
- The candidate reviews all filled forms together and submits manually at the end.
- **Never close a tab** — closing is the candidate's job, not the agent's.
- **Concurrency ceiling: four roles/workers.** One browser-controller owns the live
  Playwright tab ledger and serializes browser actions plus queue-store writes. It may
  delegate compact, secret-free `novel[]` field JSON to as many as three concurrent L3
  reasoning workers and then apply their answers. Do not run multiple active-tab agents
  against one browser or let workers write `--teach` themselves. The dashboard and offline
  planner never create private or headless fill sessions. Park a login-gated tab and
  continue the other roles.

**Note on passwords:** `data/portal-credentials.json` is the one narrow credentials
exception. Use the helpers and access only the current exact-host entry. Never enumerate
the store or print/paste any password into chat, reports, tracker rows, logs, or
`handover.md`. Registration must stage with `generatePassword()` and commit with
`commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)` only
after the secret-free accepted observation has been bound by `--bind-registration` to
the active dashboard role/request/run/controller/tab. The commit independently reloads
that durable queue binding and never overwrites an existing exact-host entry; there is
deliberately no helper that pre-persists unaccepted credentials.

---

## Requirements

- **Best with Playwright in visible mode**: In visible mode, the candidate sees the browser and the agent can interact with the page.
- **Without Playwright**: supplied screenshots/text may support a draft-only checkpoint,
  but they cannot satisfy live observation, tab preservation, or lean/receipt finish.
  Do not transfer transcription or unfinished live filling to
  the candidate; preserve the session and report the operational blocker.

## Workflow

```text
1. DETECT      → Read active Chrome tab (screenshot/URL/title)
2. IDENTIFY    → Extract company + role from the page
3. QUEUE       → Match/create the queue record and stable role ID
4. SEARCH/LOAD → Match report; load full context + prior Application Answers
5. PREFLIGHT   → Confirm posting liveness + company/role match before drafting
5b. PRE-SCAN   → Scan page for knock-out questions (degree, experience, work authorization/visa, sponsorship, salary floors)
6. PAGE LOOP   → observe → lookup → fill L1/L1.5/L2/L3 → teach reusable novels → page-done → selective re-observe only on risk → Next
7. REVIEW GATE → Reach final review with every question answered; never submit
8. PERSIST     → apply-page.mjs finish → queue status prefilled; compact Application Answers
9. PRESENT     → Show one compact combined review; candidate alone submits
```

## Step 1 — Detect the job

**With Playwright:** Take a snapshot of the active page. Read title, URL, and visible content.

**Without Playwright:** use supplied screenshots/text if available. If the live form cannot
be observed at all, record an operational blocker before fill begins; never pretend a
partial or inferred form is review-ready.

## Step 2 — Identify the role

Extract the company, role title, requisition/job ID when visible, and the current URL from
the page. Re-read them after the Apply redirect so the destination ATS cannot silently
change the role or portal host.

## Step 3 — Match or create the queue record

Match by canonical URL/requisition first, then company+title. If absent, ingest/create the
queue record before opening the live fill. Record the stable role ID in the tab ledger;
all per-page `--lookup`, `--teach`, checkpoint, and persistence actions use that ID.

## Step 4 — Search and load context

Search `reports/` for the matched role and load the full A-G report, any legacy Section H,
and any `## Application Answers`. Evaluation no longer creates new application prose;
legacy drafts are optional context only. Reports provide JD, company, role, scoring, and
application-history context; they are never independent evidence for a candidate fact.
Before reusing any wording, option, number, status, or claim from a legacy Section H or
`## Application Answers`, revalidate it against the current rendered form and the approved
candidate sources. Load `cv.md`, `article-digest.md`, `config/profile.yml`,
`modes/_profile.md`, `voice-dna.md` (style only), and applicable story-bank material under
the source contract. If no report exists, run the normal evaluation/report preparation
for the matched live role before filling rather than continuing with thin context.

## Step 5 — Preflight gate

Before application answers are generated, verify that the form is for the intended active
role and that there is no cross-channel duplicate:

1. Verify liveness with `node check-liveness.mjs <url>` for a supported ATS; use the live
   Playwright page/snapshot for non-ATS or inconclusive results. Never infer liveness from
   a search snippet or generic careers redirect.
2. Compare visible company, title, requisition, and URL with the queue record/report. A
   material mismatch is an authorization/scope issue before fill starts: preserve the tab
   and resolve/re-evaluate the correct role rather than drafting against the wrong job.
3. Check `data/applications.md` for the same employer+role/requisition through another
   channel. Apply the standing `_custom.md` duplicate rule in every authorized run without
   interrupting the batch: prefer the employer-hosted/direct route over a board mirror,
   then an already-started preserved route over opening another. Keep the duplicate
   unfilled and explain the decision in the final review; never create two applications
   for one role.
4. If an agency hides the end employer, use any sourced client clue and run a degraded
   check against unknown-company rows from the same agency and similar roles. If no
   positive duplicate can be established, continue the selected route and add a
   `review_required` duplicate-risk note. Preserve a strong probable match unfilled as an
   operational blocker and continue the remaining roles; do not stop the batch to ask for
   the client name or another authorization.
5. A definitively closed role is closed/skipped through the queue workflow. An
   access/login failure is not evidence of expiry.

After liveness and destination match are verified and the role has its own preserved tab,
begin the durable run ledger before touching page fields:

```bash
node apply-page.mjs begin <role-id> '@/tmp/<slug>-run.json'
```

The object must include the dashboard response's exact opaque `controller_id`, identify
the browser tab (`tab.id`, `tab.url`, `tab.title`), and include
structured `liveness_evidence` plus `destination_evidence`; bare verification booleans are
rejected. Each evidence object records `method`, `checked_url`, and `result`. Prefer
`evidence_path` / `snapshot_path` file paths when available — the driver hashes those
files itself. Hash the raw `check-liveness.mjs`/ATS response into `evidence_digest` only
when a file path is unavailable; for Playwright (including non-ATS pages), pass the
`.playwright-mcp/page-*.yml` snapshot path so the driver derives `snapshot_digest` and
`observed_at`. Destination evidence also records `observed_company`, `observed_title`, and
`observed_requisition` (use `"not shown"` only when the page exposes none). The gate
derives liveness/match booleans from `result: "active"` and `result: "matched"`. Keep the
request's `run_id` and `controller_id` with that tab; never reuse either binding for
another controller, role, or tab. The executable begin gate accepts only a queue
role already in `prepared` state or a legacy non-review-ready `prefilled` checkpoint being
resumed — a **finished** lean run (`prefilled` carrying `lean_review_ready: true`) is
review-ready, not resumable, and begin rejects it — **and** a durable queued dashboard
`application_request` whose role ID, run ID,
`active-agent` controller, and `controller_id` match the receipt payload and the queue's
single browser-controller lease. It rejects duplicate tab IDs, mixed controller leases,
and more than four queued/in-progress roles. Begin consumes that exact request
into `in-progress`; it also executes `verify-userdata.mjs` and binds a hash-bound quality
stamp to the exact current candidate sources, JD context, policy, CV, cover assets, and
file hashes. A bare role status, hand-written run ID, stale request, or filename-only
asset claim cannot authorize browser filling.

**Default begin stamp (lean-llm-v1):** every NEW live begin stamps:
```json
{
  "execution_protocol": "lean-llm-v1",
  "verification_mode": "selective",
  "receipt_required": false
}
```
Do **not** stamp `evidence_protocol: "v3"` unless the candidate explicitly requested
historical **receipt-v3** (`execution_protocol: "receipt-v3"` in the begin payload).
Lean finish (`apply-page.mjs finish`) promotes the queue role to **`prefilled`** for
candidate review; it does not create page receipts or review-ready `filled`.

A finished lean run is terminal for the agent, exactly as `filled` is for receipt-v3:
`beginApplicationProgress` and both dashboard fill gates refuse it, and the dashboard
reports it as already review-ready instead of queueing new browser work. Re-filling it
would discard the compact review and risk a duplicate application. If the candidate
confirms a fill genuinely must be redone, reset the role explicitly first.

A recorded `apply-page.mjs fallback` never disappears from a lean run: `finish` copies
the reason and the unsupported control IDs into the compact review warnings so the
candidate checks those controls before submitting.

A receipt-backed `filled` role is never queued back into begin: a valid receipt is already
review-ready. If an inherited/corrupt `filled` row fails verification, preserve its
evidence and run `node application-receipt.mjs --repair-filled <role-id>`; this archives
the failed ledger, returns the role to `prepared`, and allows one fresh dashboard request
without overwriting the old run. Never use this repair while a candidate-decision
transaction is pending. Lean `prefilled` roles are candidate-review checkpoints; Mark
Submitted uses the dashboard manual / `--external` path (not the receipt Mark Submitted).

These are pre-fill identity/authorization gates, not application-question pauses. Once
the intended live role is authorized and Step 6 begins, the page loop is uninterrupted.

## Step 5b — Pre-scan for knock-out questions

Read the entire visible page/form and classify questions likely to auto-disqualify, such
as minimum experience, degree, work authorization/visa/sponsorship, salary floors,
clearance, criminal-history, or other eligibility assertions.

1. Check them against `config/profile.yml`, `cv.md`, and the other permitted sources.
2. Resolve them through L1/L1.5/L2/L3 like every field. Use the explicit profile answer
   when known; otherwise choose the most conservative source-supported L3 answer and mark
   it `review_required: true` with the rejection risk in `review_note`.
3. Fill and continue. Surface every knockout mismatch/provisional answer only in the final
   combined review. Never ask how to answer, pause the page loop, or leave one blank solely
   because it is sensitive or potentially disqualifying.

For a multi-role batch, run the pipeline liveness sweep first
(`node check-liveness.mjs --file <urls>`), then still verify each destination form before
its fill begins.

## Step 6 — Analyze and resolve form fields (per page)

**For every portal and ATS**, including structured ATSes and custom-portal roles
(`ats: custom` — SEEK, JobAdder, Gem, Workday, Amazon, Vic Gov, etc.):

Default protocol is **lean-llm-v1**. Repeat this lean loop on **every wizard page** as it
becomes visible. `apply-page.mjs` remains the agent-facing driver; `lean-application.mjs`
is the lean lifecycle helper it wraps. Snapshot files under `.playwright-mcp/` feed
`lookup` so the driver can extract fields and stable `control_id` values — never
hand-author field manifests for the driver.

1. **Observe.** Take a Playwright MCP browser snapshot (or a compact field observe). The
   file lands on disk as `.playwright-mcp/page-*.yml`. Prefer the snapshot path for
   lookup; do not dump the full accessibility tree into model context.

2. **Lookup (Layer 1+2, zero LLM tokens).** Run:
   ```
   node apply-page.mjs lookup <role-id> '{"page_index":N,"url":"<page-url>","snapshot":".playwright-mcp/page-….yml"}'
   ```
   The driver parses the snapshot file, extracts editable fields (each with a stable
   `control_id`) and
   `upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]`
   (including `[]` when none exist), runs L1/L1.5/L2 via
   `queue-resolve.mjs`, and prints compact `{resolved, novel, upload_controls, …}`.
   Cover-letter and KSC textareas route to `novel` unless an exact current-role draft
   already exists. Huge/virtualized selects stay bounded — the driver caps options in
   model-visible output. When uploading on any protocol, bind each file as
   `{control_id,kind,expected,displayed,asset_sha256,verified:true}` to the observed
   control, exact local asset path/content SHA-256, and portal-displayed basename.

3. **Fill resolved fields verbatim.** Each entry in `resolved[]` carries the
   `answer` text directly — read it from `resolved[i].answer`. Note provenance inline:
   - `✓ deterministic` — profile rule (name, email, salary, work-rights, etc.)
   - `✓ learned` — exact-label screener store hit (filled silently, no confirmation)
   - `✓ cache 0.91` — semantic cache hit (score shown)
   - `✓ model` — prior teach answer for this role

   **All store and cache fills are silent** — first-use or not. Everything is visible
   in the end-of-batch review; no per-field confirmation pause is needed.

   **Truthfulness floor — tag for final review regardless of source:**
   years of experience, security clearance, disability status, veteran status. These
   are eligibility assertions; a cached or learned answer must never assert something
   false. Fill them without pausing, but include them in the combined end review.

4. **Generate and fill every novel field now (L3).** Use only the permitted candidate
   sources plus the current JD/report/form context. Respect visible limits and available
   options. If context does not establish an exact answer, choose the most conservative
   truthful response it supports, fill it, and attach `review_required: true` plus a short
   `review_note`. There is no "Ask candidate" or blank-field branch during the page loop.

5. **Teach reusable novels only.** After filling novels, teach high-confidence,
   employer-independent answers (`reusable: true`) through the driver's teach path.
   Company-specific, sensitive, uncertain, and `review_required` answers stay role-local
   (`reusable: false`) and must never enter cross-role stores. Teaching is optional for
   pages with no reusable novels — do not invent a mandatory after-snapshot receipt.

6. **Record page-done (lean barrier).** Run:
   ```
   node apply-page.mjs page-done <role-id> '{"page_index":N,"url":"<page-url>","final_page":false}'
   ```
   Lean runs **reject** `apply-page.mjs complete`. Do not require an after-snapshot or
   page receipt before Next on the default lean path.

7. **Selective verification (risk triggers only).** Re-observe / re-snapshot only when a
   risk trigger fires, for example: visible validation errors; conditional fields appeared
   after fill; upload/attachment chips look wrong or missing; Next is disabled; knockout
   or work-rights answers just changed; or several `review_required` fields on the page.
   When triggered, re-snapshot, re-run lookup for new controls if needed, correct, then
   `page-done` again. Absent a trigger, advance without a mandatory after-snapshot.

8. **Advance the page.** Click a navigation button matching
   `Continue | Next | Save and continue | Save & continue | Review | Proceed | Next step | Next page`
   to move forward. **Never click a final-submit button** (Submit / Submit application /
   Send application / Confirm and submit / Apply now / Submit my application / Submit now,
   or an equivalent final control). Stop when the page shows a review/summary (entered data
   echoed, no further editable inputs visible).

**Embed unavailable:** if the embedding endpoint is down, lookup returns all
non-deterministic fields as novel — the apply continues normally; L3 answers them inside
the current page loop.

**Pre-resolved drafts from `--pre`:** if `--pre` ran at prepare-time, `role.drafts`
may already contain fields. Lookup validates and reuses exact current-role drafts when
they still match the live options; stale option picks fall through for re-resolution.
Drafts for fields not present on the live form are silently ignored.

**Unsupported widgets:** if a control genuinely cannot be machine-extracted, record
`node apply-page.mjs fallback <role-id> '{"reason":"…","control_ids":[…],"url":"…","page_index":N}'`
and continue with a compact review flag. Lean finish still ends at `prefilled` for
candidate review; receipt-v3 runs with a fallback block can never become review-ready
`filled`. Do not invent a generic escape hatch.

## Work authorization and sponsorship

Read `config/profile.yml` before answering any visa, work-rights, or sponsorship
question. Specific phrasings and work-rights framing are in `modes/_profile.md`
under the "Negotiation / Application Framing" section.

Resolve every work-rights field from the current profile rather than from defaults in
this replaceable system file:

- Sponsorship required now or in the future: use the exact configured sponsorship answer.
- Authorization to work in the role's jurisdiction: use the exact configured status,
  timing, and conditions.
- Visa category and expiry: use the appropriate configured full-time/part-time answer.
- Citizenship, residency, or security clearance: do not claim any status not explicitly
  present in `config/profile.yml`.

If a form only allows an option that does not accurately describe the candidate's
work rights, select the closest conservative option supported by the profile, mark it
`review_required: true`, explain the mismatch in `review_note`, and continue to the
final review. Never claim a status the profile does not support.

For each field, preserve the application form contract:
- `field_type`: `text`, `textarea`, `select`, `radio`, `checkbox`, `number`, `file`, or `unknown`
- `required`: `yes`, `no`, or `unknown`
- `limit`: exact character/word limit if visible; otherwise `unknown`
- `options`: visible options for select/radio/checkbox fields
- `review_required`: `true` when a legal, demographic, work authorization, visa,
  relocation, salary, disability, veteran, sponsorship, background-check,
  self-identification, years-of-experience, or other answer required a conservative L3
  inference rather than an explicit profile fact
- `review_note`: concise reason the candidate may want to change the provisional value

Never invent facts for these fields. When the exact fact is absent, L3 must still choose
and fill the most conservative response the permitted context supports, force it
role-local with `reusable: false`, and flag it for the final review rather than stopping.

## Step 7 — Final review gate

L3 generation happens inside each page loop before that page is advanced. Its
answer-quality rules are:

1. **Report context**: Use Blocks A-G only for current JD/company/role requirements,
   evaluation context, and question targeting. Candidate proof points and STAR facts must
   come from the approved candidate sources, not from report prose.
2. **Previous Section H / Application Answers**: Reuse only after revalidating every
   factual claim, option, number, and status against the approved candidate sources and
   the current rendered form. Otherwise regenerate a truthful role-local L3 answer.
3. **"I'm choosing you" tone**: Same auto-pipeline framework
4. **Specificity**: Reference something specific from the JD visible on screen
5. **career-ops proof point**: Include in "Additional info" if there is a field for it
6. **Recruiter-side risk map**: Use `modes/heuristics/recruiter-side.md` to identify what doubt the question is trying to resolve (motivation, stack fit, logistics, comp, work-auth, availability, seniority) and answer that doubt directly.
7. **Disclosure discipline**: Answer logistics questions truthfully when asked, but do not volunteer sensitive or HR-only details in unrelated motivation/fit answers.

At the final portal review/summary page, verify echoed answers at a glance and prepare a
**compact lean review** without clicking a final action. The candidate reviews and submits;
the agent never clicks a final action.

```text
## Responses for [Company] — [Role] (lean-llm-v1)

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]
Protocol: lean-llm-v1 → queue status prefilled

---

### Important / screening answers
1. [Label]: [Answer] (provenance)
…

### Review-required
1. [Label]: [Answer] — [why check]
…

### Attachments (displayed)
- CV: [filename]
- Cover: [filename]

Notes:
- [Knockouts, login blockers, selective-verification warnings]
```

Record the final page with `apply-page.mjs page-done` (`"final_page":true`). Do **not**
run `complete` / `finalize` on lean runs. (Receipt-v3 final-page complete is in the
Historical receipt-v3 appendix only.)

## Step 8 — Persist application snapshot

After the final answers are filled into the live form, persist a compact
`## Application Answers` section (lean finish writes this for you when given the report
path). Prefer:

```bash
node apply-page.mjs finish <role-id> '{"final_url":"…","final_control":"…","application_answers_report":"reports/NNN-….md","attachments":{…},"important_answers":[…],"review_required":[…]}'
```

`apply-page.mjs finish` (wrapping `lean-application.mjs`) sets queue status **`prefilled`**,
writes `**State:** prefilled` and `**Execution protocol:** lean-llm-v1` into the report,
and never promotes to receipt-backed `filled`. Lean runs **reject** `complete` /
`finalize`.

The section should include at least:
- `**Date:** YYYY-MM-DD`
- `**State:** prefilled` (lean default end state)
- Important / screening answers and all `review_required` flags
- Displayed CV / cover filenames when known
- Page/lean-page counts and any selective-verification warnings

Write the section at the end of the report, or replace only the existing
`## Application Answers` section if it already exists. Do not rename, reorder, or edit the existing A-G report blocks, any legacy Section H that is already present, or
`## Keywords extracted`.

Optional helper before finish:

```bash
node application-answers.mjs --report reports/NNN-company-role-date.md --role <role-id> --state prefilled
```

**Only the receipt finalizer may set review-ready `filled`** — that path is opt-in
receipt-v3 (`apply-page.mjs finalize`); see the appendix. New lean begins never claim
`filled`. After the candidate submits in the portal, Mark Submitted may advance the
report section to `**State:** filled` (receipt path) then `**State:** submitted`
(candidate confirmation), or lean `prefilled` → submitted via manual / `--external`.
The CLI may author only `**State:** prefilled`; never hand-write `filled` or
`submitted` into the report.

## Step 9 — Present one combined review

After every authorized role has reached either the final review page or an operational
blocker, present one compact batch table: role/company, tab and current URL, liveness,
lean fill state (`prefilled` / partial / blocked), displayed CV and cover filenames,
deterministic/learned/cache/model counts, knockout answers, all `review_required`
answers with notes, and any login/tool blocker.
Leave every tab open. The candidate reviews and submits; the agent never clicks a final
action.

## Step 10 — Post-apply (only after candidate confirmation)

If the candidate confirms that they submitted the application:
1. Have the candidate use the dashboard's explicit **Mark Submitted** / **Submitted**
   confirmation UI. For lean **`prefilled`** roles this is the manual / `--external`
   candidate-attested path (not receipt-gated Mark Submitted). The UI obtains a
   five-minute, role-bound, one-use nonce from
   `POST /api/role/:id/submission-confirmation` using the exact phrase
   `I submitted this application in the portal`, then sends that nonce with
   `POST /api/role/:id/decision {decision:"submitted", confirmation_nonce:"..."}`.
   The agent must never call these endpoints as a substitute for candidate action or
   synthesize the nonce. If the server is unavailable, restart it and let the candidate
   retry in the UI; do not hand-edit any store.
2. Seed the follow-up schedule: run `node followup-seed.mjs {num} --json` (where `{num}` is the tracker row number). If the candidate applied on a different day than today, pass `--date YYYY-MM-DD` with the actual submission date. It's idempotent, so re-running is safe.
3. Suggest next step: run the `contacto` mode (`/career-ops contacto` where available) for LinkedIn outreach.

## Scroll handling

If the form has more questions than the visible ones:
- Scroll the live page/container automatically and aggregate every exposed control into
  one ordered, de-duplicated `control_id` manifest for the current wizard page. Run one
  `apply-page.mjs` lookup → fill → page-done cycle against that complete stable
  manifest—not a separate page-done for each viewport. If filling reveals conditional
  controls (selective verification trigger), rebuild the manifest, re-lookup, and
  page-done again before advancing.
- If browser automation is unavailable and only screenshots/text are possible, process
  every supplied field and record the operational visibility gap; do not call a partial
  page review-ready.

---

## Historical receipt-v3 appendix (opt-in / regression only)

Use this path only when begin explicitly stamps `execution_protocol: "receipt-v3"`
(repair, regression, or an explicit candidate request). It is **not** the default for
new live begins.

Per page after fill:
```bash
node apply-page.mjs complete <role-id> '{"after_snapshot":".playwright-mcp/page-….yml","answers":[…],"attachments":[…],"final_page":false}'
```
Re-snapshot and complete (teach + verify + page receipt). `answers` lists novel fields only
(`control_id`, `answer`, optional `reusable` / `review_required` / `review_note`), including
`"answers":[]`. Complete runs teach, machine-verifies populated values in the after-snapshot,
and records the page receipt. Never advance without a successful complete on a receipt-v3 run.

At the final review page, run lookup then complete with `"answers":[]`,
`"final_page":true`, and the complete verified attachment ledger (or
`attachments_not_applicable_reason` when the ledger proves none). Then:

```bash
node apply-page.mjs finalize <role-id> '{"application_answers_report":"reports/NNN-….md","attachments":[…]}'
```

Finalize promotes report/queue to review-ready **`filled`**. Only the receipt finalizer
may set review-ready `filled`. Attachment evidence binds an observed `control_id` to the
exact current-role local asset path, content SHA-256, and matching portal-displayed
basename as `{control_id,kind,expected,displayed,asset_sha256,verified:true}`. This
requires a verified CV in every enabled `cv` control and a verified cover letter in every enabled `cover` or `supporting` control.
`attachments_not_applicable_reason` is valid only when the complete page ledger proves
that no enabled upload control accepts an attachment. Digests, field manifests,
`upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` (including
`[]`), and populated-value checks are derived from snapshot files by code — never
hand-authored. A run with a verification fallback block cannot finalize. Dashboard Mark
Submitted for receipt-backed `filled` roles remains receipt-gated.

---

## Known ATS Quirks

Field-tested across ~12 Playwright-driven applications (Ashby, Greenhouse, Lever, Workable). These quirks silently break an apply run if not accounted for.

### Ashby — email-based candidate dedup

- **Symptom:** Submitting a second application at the same company silently fails or merges into the existing candidate record. Ashby deduplicates by email per company.
- **Agent:** Before filling the email field, check whether an earlier report for the same
  company exists. Keep the configured email unless the portal itself rejects it; do not
  invent a `+tag` identity. Record any dedup warning in the final review.

### Lever — hCaptcha intercepts checkbox/radio clicks

- **Symptom:** Programmatic `click()` on checkboxes or radio buttons triggers an hCaptcha challenge mid-form, blocking the rest of the fill.
- **Agent:** Fill text, textarea, select, checkbox, and radio questions through fresh
  element queries and verify the selected state. Never interact with the captcha widget.
  If hCaptcha appears, park this tab, let the candidate solve only that human challenge,
  continue other roles, then return and finish every remaining field.
- **Candidate:** Solves the captcha and performs the final submit only.

### Workable — SPA re-renders break form refs

- **Symptom:** Workable's SPA re-renders form components between fills, invalidating element references. Sequential `fill()` calls hit stale-element errors.
- **Agent:** Copy each answer to the clipboard internally and dispatch `Ctrl+V` per field with a fresh element query before each paste — do not cache refs across fields.
- **Agent:** If clipboard dispatch fails, re-query and fill/type through a supported DOM
  interaction. Treat a persistent tool failure as an operational blocker for this tab,
  preserve it, and continue other roles; never convert unanswered questions into candidate
  work.
- **Candidate:** Reviews and submits only.

### React-select autocomplete widgets

- **Symptom:** `react-select` (common in Greenhouse, Ashby, Lever for location/department fields) destroys and recreates its internal DOM on every keystroke. Cached refs go stale instantly.
- **Agent:** Type character-by-character with short delays (~100 ms). Re-snapshot after every selection to pick up the new DOM state. Never cache element references across interactions.
- **Agent:** Verifies each selected value before moving on and corrects mis-selections
  inline. The candidate reviews the completed form only at the final boundary.

### Huge native `<select>` elements (1 000+ options)

- **Symptom:** Country, university, or field-of-study dropdowns contain thousands of `<option>` entries. Snapshotting them floods context and stalls the agent.
- **Agent:** Use `select_option` directly by verified value/visible label. Never snapshot
  the full list. Query a compact DOM exact/prefix match from the profile/context and, if
  still ambiguous, choose the most conservative bounded L3 option, mark it
  `review_required: true` and `reusable: false`, and surface it at final review.
- **Candidate:** Reviews provisional picks and submits only.

### Job-board host ≠ application host — re-check the URL after "Apply"

- **Symptom:** The posting is discovered on one ATS, but clicking **Apply** hands off to a *different* ATS for the actual form. Enterprise career sites (commonly Phenom-, iCIMS-, or Radancy-hosted) frequently redirect into a Workday, Greenhouse, or SmartRecruiters application flow. Choosing fill tactics from the *board* URL applies the wrong quirks.
- **Agent:** After the Step 5 preflight, follow the Apply button/redirect and read the URL of the page that actually renders the form fields. Match your fill tactics to *that* host — not the board the job was discovered on. A `myworkdayjobs.com` handoff in particular means the Workday quirk below applies.
- **Agent:** Re-confirms the destination company/role/requisition against the queue record
  before filling. A material mismatch is a pre-fill scope blocker; ordinary matches do
  not create a candidate prompt in One-shot or an already-authorized fill.

### Workday — set-value doesn't register on React fields

- **Symptom:** Setting a Workday text field's value programmatically (without real keystrokes) leaves it visually filled but empty to Workday's validation — the React `onChange` never fires, so Save throws "required" on a visibly-filled field. Yes/No dropdowns also vary their option order per question, so a positional click can select the wrong answer (e.g. "No" on *are you authorized to work?*).
- **Agent:** For required text fields, **type** real keystrokes (focus → select-all → type), or verify each value registered before Save. Survey the whole step top-to-bottom first (the address block is often below the fold) and fill from the candidate's saved profile (`config/profile.yml` / `cv.md`) proactively, rather than discovering fields via validation errors. For dropdowns, use **type-ahead** (open → type the option text → confirm the highlight) instead of positional clicks, and verify each selection.
- **Agent:** Verifies the filled step, including work-authorization/sponsorship dropdowns
  and EEO/legal attestations, before Save/Next. The candidate reviews them at the final
  combined boundary and alone performs final submission.
