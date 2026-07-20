# ATS Auto-Fill Flow

The live application workflow has one executable source of truth: [`modes/apply.md`](../modes/apply.md). Candidate-specific procedural overrides live in [`modes/_custom.md`](../modes/_custom.md). The agent-facing page driver is [`apply-page.mjs`](../apply-page.mjs) (Evidence Protocol v3 file-derived receipts); the resolver contract it wraps is [`queue-resolve.mjs`](../queue-resolve.mjs), and review-ready promotion is owned by [`application-receipt.mjs`](../application-receipt.mjs). This page is an overview only; it must not be used as a second ATS playbook.

## What the workflow guarantees

- Every role is matched to a queue record and stable role ID before filling.
- Liveness, company, role, requisition, and duplicate-channel checks happen before the fill starts. Receipt begin requires structured method/URL/result evidence plus a digest of the ATS response or Playwright snapshot; bare verification booleans are rejected. Prefer `evidence_path` / `snapshot_path` so `apply-page.mjs begin` hashes the files itself.
- Each authorized role keeps its own browser tab/session. Filled tabs are never reused for another role.
- Login-gated portals use the exact post-redirect host. The agent may create a new portal account with a staged random password or attempt one stored-credential login; the candidate alone handles CAPTCHA, email verification, OTP/MFA, recovery, and stale/missing credentials. After acceptance, evidence v2 records the active queued role/request/run/controller/tab plus Playwright source, URL, timestamp, snapshot SHA-256, DOM registration control, and accepted/verification/authenticated signal. The controller first runs `node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'`, then persists with `commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)`. Pre-receipt account creation is supported while the request is `queued`; after receipt begin, the tab must also match `application_progress`. A caller-authored shape/digest alone cannot commit, and existing exact-host credentials are never overwritten.
- Every wizard page runs the file-derived driver cycle: take a Playwright MCP snapshot (lands under `.playwright-mcp/`); run `apply-page.mjs lookup` with `{page_index, url, snapshot}`; fill deterministic/learned/cache hits; answer every novel field with L3; fill it; re-snapshot; run `apply-page.mjs complete` with novel-only `answers` (including `"answers":[]`) so the driver runs teach, machine-verifies populated values, and records the page receipt before advancing. Digests, field manifests, before/rescan/after observations, and `upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` (including `[]` when none exist) are derived from snapshot files — never hand-authored. Each attachment binds its observed `control_id` to the exact current-role local asset path, the asset content SHA-256, and the matching portal-displayed basename. Every enabled `cv` control receives the verified CV; every enabled `cover` or `supporting` control receives the verified tailored cover letter. `attachments_not_applicable_reason` is allowed only when the complete ledger proves there is no enabled upload control that accepts an attachment. Critical fields that cannot be verified hard-fail; ordinary unverifiable widgets become `verification_warnings` surfaced in the final combined review. A zero-field receipt is valid only for an evidenced final review page with a visible submit boundary. Verify the rendered state through the driver's after-snapshot check — self-attested completion flags are not proof.
- Dashboard Fill/Run only queues a durable `application_request`; the active agent
  owns the browser and live fill. Receipt begin requires that exact queued request's
  role ID, run ID, `active-agent` controller, and opaque `controller_id`, consumes it
  into `in-progress`, and
  executes the full `verify-userdata` source/JD/CV/cover quality gate. Finalization reruns
  that gate, requires the unchanged hash-bound evidence, and marks the request
  `review-ready`. `form-fill.mjs` is offline plan-only and cannot
  touch browser, queue, or status.
- One browser-controller lease owns at most four queued/in-progress roles. The executable
  begin gate rejects mixed leases and duplicate tab IDs, while dashboard re-clicks preserve
  an existing active/review-ready request instead of overwriting it. A valid `filled` role
  is already at review; an invalid inherited `filled` receipt is archived with
  `application-receipt.mjs --repair-filled` before one fresh request.
- Each verified page produces a durable compliance receipt.
  `application-answers.mjs --role` first writes the report checkpoint as
  `State: prefilled`; the queue role itself remains `prepared` on new runs. Only
  `apply-page.mjs finalize` (wrapping the receipt finalizer) may change the report and
  queue to review-ready `filled` after all pages, role-bound attachments, validation,
  Application Answers persistence, and handover evidence pass. A run with a verification
  fallback block cannot finalize. A queue role already in `prefilled` is a
  legacy non-review-ready checkpoint that may resume through the same receipt path.
- Every answered question is stored role-locally when reusable would be unsafe, and
  conservative inferences are flagged for the final combined review.
- Only the candidate clicks the final application submission control.

## What it does not do

- It does not invent candidate facts, achievements, authorship, citizenship, clearance,
  diagnoses, or other statuses absent from the approved source files.
- It does not leave mandatory questions blank, interrupt the page loop for candidate
  answers, or treat knockout questions as a reason to abandon the fill.
- It does not submit the application.
- It does not let `form-fill.mjs`, the dashboard, or offline OpenRouter drafts claim
  review-ready completion.

If this overview ever differs from `modes/apply.md`, `modes/_custom.md`, `apply-page.mjs`,
`queue-resolve.mjs`, or `application-receipt.mjs`, the canonical files win and this
overview must be corrected.
