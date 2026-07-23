# ATS Auto-Fill Flow

The live application workflow has one executable source of truth: [`modes/apply.md`](../modes/apply.md). Candidate-specific procedural overrides live in [`modes/_custom.md`](../modes/_custom.md). The agent-facing page driver is [`apply-page.mjs`](../apply-page.mjs) (dual-protocol). Default for every NEW live `begin` is **`lean-llm-v1`** (`verification_mode: selective`, `receipt_required: false`); the lean lifecycle helper is [`lean-application.mjs`](../lean-application.mjs). The resolver contract is [`queue-resolve.mjs`](../queue-resolve.mjs). Historical **receipt-v3** review-ready promotion is owned by [`application-receipt.mjs`](../application-receipt.mjs) and is opt-in only. This page is an overview only; it must not be used as a second ATS playbook.

## What the workflow guarantees

- Every role is matched to a queue record and stable role ID before filling.
- Liveness, company, role, requisition, and duplicate-channel checks happen before the fill starts. Begin requires structured method/URL/result evidence plus a digest of the ATS response or Playwright snapshot; bare verification booleans are rejected. Prefer `evidence_path` / `snapshot_path` so `apply-page.mjs begin` hashes the files itself.
- Each authorized role keeps its own browser tab/session. Filled tabs are never reused for another role.
- Login-gated portals use the exact post-redirect host. On a sign-in page with no exact-host credential, the agent first scans the full page for a visible Register / Create account / Sign up route, follows it in the same role tab, and reclassifies the resulting page; it creates the account only after reaching a registration form. It parks for candidate login only when no registration route is visible, the candidate has said an account already exists for that credential realm, or the one stored-credential attempt fails. The candidate alone handles CAPTCHA, email verification, OTP/MFA, recovery, and stale credentials. After registration acceptance, evidence v2 records the active queued role/request/run/controller/tab plus Playwright source, URL, timestamp, snapshot SHA-256, DOM registration control, and accepted/verification/authenticated signal. The controller first runs `node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'`, then persists with `commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)`. Account creation is supported while the request is `queued`; after begin, the tab must also match `application_progress`. A caller-authored shape/digest alone cannot commit, and existing exact-host credentials are never overwritten.
- **Default lean per-page loop (`lean-llm-v1`):** observe → `apply-page.mjs lookup` with `{page_index, url, snapshot}` → fill L1/L1.5/L2 hits → answer every novel field with L3 → teach reusable novels only → `apply-page.mjs page-done` → selective re-observe only when risk triggers fire → Next (never final submit) → … → `apply-page.mjs finish` → queue status **`prefilled`**. Lean runs reject `complete` / `finalize`. Lookup still uses snapshot files so the driver can derive `control_id` fields and `upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` (including `[]`); bind uploads as `{control_id,kind,expected,displayed,asset_sha256,verified:true}` with content SHA-256. Mandatory after-snapshot page receipts are not part of the lean default.
- Dashboard Fill/Run only queues a durable `application_request`; the active agent owns the browser and live fill. Begin requires that exact queued request's role ID, run ID, `active-agent` controller, and opaque `controller_id`, consumes it into `in-progress`, and executes the `verify-userdata` source/JD/CV/cover quality gate. `form-fill.mjs` is offline plan-only and cannot touch browser, queue, or status.
- One browser-controller lease owns at most four queued/in-progress roles. The executable begin gate rejects mixed leases and duplicate tab IDs. Lean finish ends at **`prefilled`** for candidate review; Mark Submitted is manual / `--external`. Only the receipt finalizer may set review-ready `filled` (receipt-v3 opt-in). An invalid inherited `filled` receipt is archived with `application-receipt.mjs --repair-filled` before one fresh request.
- Every answered question is stored role-locally when reusable would be unsafe, and conservative inferences are flagged for the compact lean / final combined review.
- Only the candidate clicks the final application submission control.

## Historical receipt-v3 (brief)

Explicit `execution_protocol: "receipt-v3"` on begin only: snapshot → lookup → fill → `apply-page.mjs complete` (after-snapshot + teach + page receipt) → `apply-page.mjs finalize` → review-ready `filled` → receipt Mark Submitted. Digests, `upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` manifests (including `[]`), and attachment control/hash binding (`control_id` + content SHA-256 / `asset_sha256`) are mandatory on that path — every enabled `cv` control needs the verified CV, and every enabled `cover` or `supporting` control needs the verified tailored cover letter. Do not treat it as the default for new begins.

## What it does not do

- It does not invent candidate facts, achievements, authorship, citizenship, clearance,
  diagnoses, or other statuses absent from the approved source files.
- It does not leave mandatory questions blank, interrupt the page loop for candidate
  answers, or treat knockout questions as a reason to abandon the fill.
- It does not submit the application.
- It does not let `form-fill.mjs`, the dashboard, or offline OpenRouter drafts claim
  review-ready completion.

If this overview ever differs from `modes/apply.md`, `modes/_custom.md`, `apply-page.mjs`,
`queue-resolve.mjs`, `lean-application.mjs`, or `application-receipt.mjs`, the canonical
files win and this overview must be corrected.
