# Mode: auto-pipeline — Verdict-First Evaluation

When the user pastes a JD (text or URL) without an explicit sub-command, evaluate it,
persist the A-G report and `Evaluated` tracker row, show the verdict, and stop at the
candidate-selection boundary. Tailored assets and application work are a later,
explicitly authorized phase.

## Step 0 — Extract JD

If the input is a **URL** (not pasted JD text), follow this strategy to extract the content:

**Priority order:**

1. **Public ATS API or deterministic source first:** Reuse substantive JD text already
   captured by the scanner/queue, or use the supported ATS provider's public posting
   JSON/API. Accept it only when the company, role, requisition, and source URL match.
2. **Playwright:** For unsupported ATSes, SPAs, custom portals, or incomplete API results,
   use `browser_navigate` + `browser_snapshot` to render and read the JD.
3. **WebFetch:** For static pages when no supported deterministic source is available.
4. **WebSearch (last resort):** Search for the role title + company in secondary portals
   that index the JD in static HTML. Treat it as extraction help, never liveness evidence.

**If no method works:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use directly, without needing to fetch.

## Step 0.5 — Liveness gate

Before running any evaluation, confirm the posting is still live through the canonical
API-first ladder, before spending tokens on A-G, a report, or a PDF:

1. For a URL, run `node check-liveness.mjs <url>`. A definitive public ATS/API
   `expired` result is authoritative; **stop here**, do not run the evaluation, tell the
   candidate, and resolve any matching pipeline entry as inactive.
2. If the checker is inconclusive or the host has no supported public ATS endpoint,
   classify the rendered Step 0 Playwright page/snapshot. Title + substantive JD or a
   genuine application path is active evidence. Expired/closed text, 404/410, a generic
   careers redirect, or nav/footer without a JD is closed evidence. WebFetch/WebSearch
   snippets are extraction aids, never a liveness verdict.
   Treat only those explicit page/API signals as closed posting evidence.
3. If only JD text was pasted (no URL), there is no link to verify; note that limitation
   and proceed.

Do not continue to Step 1 until this gate is resolved.

## Step 1 — Execute the canonical A-G evaluation

Read and execute `modes/oferta.md` once, in full. It owns the bounded research, A-G
analysis, atomic report-number reservation, report persistence, and exactly one
`Evaluated` tracker addition. Do not repeat those writes in this wrapper.

For agency-mediated postings, follow `modes/oferta.md` and `modes/tracker.md`: identify
the agency before the tracker write, use `?` for an unknown end employer, and preserve
the Via/notes evidence.

## Step 2 — Present the verdict and stop

Show the score, recommendation, legitimacy result, report path, and dashboard link.
Do not generate a tailored CV, cover letter, form-answer draft, queue PREPARE asset,
or live browser form from score alone. A score threshold is a recommendation/filter,
never candidate selection.

## Step 3 — Continue only after explicit authorization

After the candidate explicitly continues with this exact role or selects it in the
dashboard:

1. Ensure the role has a queue record and stable role ID.
2. Run the canonical Queue PREPARE flow to create the fresh tailored CV and cover letter,
   persist provenance, and pass `verify-userdata.mjs`.
3. For a live application, require the dashboard's durable `application_request`, then
   execute `modes/apply.md` and its per-page lookup/L3/teach/receipt loop.
4. If the candidate requested only a standalone PDF, cover letter, or LaTeX export, run
   that explicit mode without implying that an application was selected or filled.

The candidate alone performs final job submission.
