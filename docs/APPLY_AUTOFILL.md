# ATS Auto-Fill Flow

The live application workflow has one executable source of truth: [`modes/apply.md`](../modes/apply.md). Candidate-specific procedural overrides live in [`modes/_custom.md`](../modes/_custom.md), and the resolver contract is implemented by [`queue-resolve.mjs`](../queue-resolve.mjs). This page is an overview only; it must not be used as a second ATS playbook.

## What the workflow guarantees

- Every role is matched to a queue record and stable role ID before filling.
- Liveness, company, role, requisition, and duplicate-channel checks happen before the fill starts. Receipt begin requires structured method/URL/result evidence plus a digest of the ATS response or Playwright snapshot; bare verification booleans are rejected.
- Each authorized role keeps its own browser tab/session. Filled tabs are never reused for another role.
- Login-gated portals use the exact post-redirect host. The agent may create a new portal account with a staged random password or attempt one stored-credential login; the candidate alone handles CAPTCHA, email verification, OTP/MFA, recovery, and stale/missing credentials. After acceptance, evidence v2 records the active queued role/request/run/controller/tab plus Playwright source, URL, timestamp, snapshot SHA-256, DOM registration control, and accepted/verification/authenticated signal. The controller first runs `node credentials-store.mjs --bind-registration <role-id> '@acceptance.json'`, then persists with `commitAcceptedRegistrationCredentials(host, email, password, acceptanceEvidence)`. Pre-receipt account creation is supported while the request is `queued`; after receipt begin, the tab must also match `application_progress`. A caller-authored shape/digest alone cannot commit, and existing exact-host credentials are never overwritten.
- Every wizard page runs the complete resolver cycle: take a Playwright MCP snapshot; extract all stable `control_id`/field/option records; bind `--lookup` to the snapshot SHA-256 and capture time; fill deterministic/learned/cache hits; answer every novel field with L3; fill it; run `--teach` (including `answers:[]`); and record exact before/rescan/after control manifests, populated-answer hashes, rendered validation state, and attachments before advancing. Every page receipt also carries the Playwright-extracted `upload_controls:[{control_id,label,kind,required,multiple,enabled,accepts}]` manifest, using `[]` only when that page truly has no upload control. Each attachment binds its observed `control_id` to the exact current-role local asset path, the asset content SHA-256, and the matching portal-displayed basename. Every enabled `cv` control receives the verified CV; every enabled `cover` or `supporting` control receives the verified tailored cover letter. `attachments_not_applicable_reason` is allowed only when the complete ledger proves there is no enabled upload control that accepts an attachment. The agent must verify the rendered state before the page receipt consumes that evidence instead of trusting self-attested completion flags. A zero-field receipt is valid only for an evidenced final review page with a visible submit boundary.
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
  `State: prefilled`; the queue role itself remains `prepared` on new runs. Only the
  canonical receipt finalizer may change the report and queue to review-ready
  `filled` after all pages, role-bound attachments, validation, Application Answers
  persistence, and handover evidence pass. A queue role already in `prefilled` is a
  resumable legacy checkpoint, not a state any new dashboard/planner path creates.
- After the candidate confirms that they submitted, the localhost dashboard's
  canonical decision endpoint promotes the receipt-bound report to `State: submitted`,
  records receipt provenance in the tracker through `set-status.mjs`, and completes
  the queue decision through a durable pending transaction. Once candidate submission is
  confirmed, the truthful submitted report is never rolled back because of infrastructure;
  tracker or queue failures leave the same decision safely and idempotently retryable.
- Knockout, legal, salary, work-rights, demographic, and other sensitive questions are not left blank merely because they require review. The agent uses the most conservative source-supported or decline-to-disclose answer, stores uncertain answers role-locally, and flags them in the final review.
- A CAPTCHA or operational failure parks only that role. Other applications continue, and the agent returns later without destroying the blocked session.
- The agent never invents an email alias, identity, citizenship, permanent-residency status, clearance, qualification, achievement, or other candidate fact.
- All roles are presented together at one final combined review. Only the candidate clicks the final application submission control.

## ATS quirks

Ashby, Lever, Workable, Workday, React Select, virtualized dropdown, and redirect-host handling are maintained in the “Known ATS Quirks” section of `modes/apply.md`. Update that canonical section instead of copying rules here.

If this overview ever differs from `modes/apply.md`, `modes/_custom.md`, `queue-resolve.mjs`, or `application-receipt.mjs`, the canonical files win and this overview must be corrected.
