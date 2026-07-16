# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Liveness sweep

**Run this before processing any URLs.** Entries added by the scanner in headless/batch mode carry `**Verification:** unconfirmed (batch mode)` because Playwright was unavailable at scan time — they were never checked for liveness. Without a sweep, dead postings reach evaluation one tab at a time, burning time and tokens on phantom roles (a single inbox of 8 stale URLs produces 8 wasted evaluations).

Sweep all pending URLs in one batch with the zero-token liveness checker before the per-URL loop:

1. Collect every `- [ ]` URL from the "Pending" section into a temp file (one URL per line).
2. Run `node check-liveness.mjs --file <tmpfile>` (add `--throttle` for large batches to stay under WAF rate limits). It uses public ATS APIs first and Playwright only for unsupported/inconclusive hosts, with zero model tokens. The checker prints a per-URL verdict and exits non-zero if any are expired/uncertain.
3. For every URL the checker reports as **expired/closed**, resolve the pipeline entry instead of processing it: move it to "Processed" as `- [x] ~~URL | Company | Role~~ — posting expired (liveness sweep)` and, if it already has a tracker row, run `node set-status.mjs <tracker#|company> Discarded --role "<role>" --note "posting expired (liveness sweep)"`. Never hand-edit the tracker. **Do not** extract the JD, evaluate, or generate a report/PDF for it.
4. Leave `uncertain` results in place to be confirmed during normal per-URL extraction (a transient timeout shouldn't drop a possibly-live posting).
5. Only the surviving live URLs continue to the per-URL processing loop below.

This complements — does not replace — the per-URL liveness gate in `auto-pipeline` (Step 0.5) and the `apply` preflight: the sweep drops the dead postings up front, in bulk, so the user never opens a tab or spends a token on them.

## Workflow

1. **Read** `data/pipeline.md` → search for `- [ ]` items in the "Pending" section. Run the **Liveness sweep** (above) first and drop any expired entries before continuing.
2. **For each surviving pending URL**:
   a. Claim the next sequential `REPORT_NUM` atomically by running `node reserve-report-num.mjs` (and release the sentinel using `node reserve-report-num.mjs --release <num>` after the report is written)
   b. **Extract JD** using a matched public ATS API/deterministic scanner record first →
      Playwright for unsupported/incomplete/SPA pages → WebFetch → WebSearch
   c. If the URL is not accessible → mark as `- [!]` with a note and continue
   d. **Execute the evaluation pipeline**: Evaluation A-G → Report `.md` →
      Evaluated tracker row. This mode is evaluation-only by default. Generate a
      non-release batch-draft PDF only when the candidate explicitly enabled PDFs
      for this pipeline run and the score meets the configured
      `auto_pdf_score_threshold`. Read `modes/_custom.md` → Pipeline Rules, if it
      exists, and apply its override here.
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`

   **About the opt-in PDF gate:** A threshold never enables PDF generation by
   itself. Unless the candidate explicitly requested PDFs for this run, write the
   report and Evaluated tracker row with PDF ❌. After explicit enablement, read
   `config/profile.yml` → `auto_pdf_score_threshold` (default `3.0` when absent);
   scores below it still skip the draft. Every pipeline-generated PDF is
   `batch-draft`; candidate-selected roles regenerate release-eligible CV and cover
   assets through queue PREPARE.

   **Tuning it:** Once PDFs are explicitly enabled, raise
   `auto_pdf_score_threshold` (for example `4.0`) to draft only high-scoring roles,
   or set `0` to draft every evaluated role. Path A (`/career-ops pipeline` with an
   explicit PDF request) and Path B (`batch/batch-runner.sh --draft-pdf`) read the
   same threshold. Without that explicit enablement, both remain evaluation-only.
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed — at most one agent per pending URL. Each is a **single-pass worker**: it evaluates its one URL and must **not** spawn further subagents or invoke other skills; its company/comp research stays inline and bounded (see `modes/_shared.md` → Subagent delegation). This keeps a pipeline run from fanning out into a recursive agent swarm.
4. **At the end**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [ ] https://jobs.ashbyhq.com/acme/789 | Acme Corp | Solutions Architect | Remote (US)
- [ ] https://jobs.ashbyhq.com/acme/790 | Acme Corp | AI Engineer | Remote (US) | 180000-220000 USD
- [ ] https://jobs.ashbyhq.com/acme/791 | Acme Corp | Staff PM | note: curated shortlist
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

Pending lines are variable-width. The rawest form is a bare pasted URL,
`- [ ] {url}` (1 column) — what you drop into the inbox by hand. Scanner-written
entries add `| {company} | {title}` (3 columns) plus two optional trailing
columns: `| {location}` (4th) and `| {compensation}` (5th). The scanner fills the
trailing columns only when the ATS exposes them, so 1-, 3-, 4-, and 5-column rows
are all valid — `{url} | {company} | {title} | {location} | {compensation}` is the
maximum (canonical) shape, not the only one. The columns are positional, so a row
carrying compensation always includes the location cell (empty if unknown); a row
with only a location stays 4 columns. Existing shorter rows remain valid and are
read as having empty values for the missing trailing columns.

One further trailing segment is optional and **labeled**, not positional:
`| note: {text}`. Unlike the positional cells above, it can ride on any row shape
(`- [ ] {url} | {company} | {title} | note: curated shortlist` is valid), because
the `note:` prefix identifies it regardless of column position. It carries a
free-text ranking signal an importer attached to the offer (the deterministic
scanner never sets it). Treat it as a hint when triaging; it does not change how
you process the URL.

## Intelligent JD detection from URL

1. **Public ATS API / deterministic scanner record first:** Reuse substantive JD text
   already stored for the exact canonical URL/requisition, or query the supported ATS
   provider's public posting JSON/API. Reject mismatched company/role/requisition data.
2. **Playwright:** `browser_navigate` + `browser_snapshot` for unsupported ATSes, SPAs,
   custom portals, or incomplete deterministic results.
   - **Opt-in compact Playwright extractor (`scan.extractor: cli` in
     `config/profile.yml`):** run `node browser-extract.mjs <url>` (default `--mode jd`)
     instead; it returns compact `{ "url", "title", "text" }`. Use its text only after
     identity matching. Fall back silently to the MCP snapshot if it errors or is missing.
3. **WebFetch:** For static pages when deterministic and rendered extraction are unavailable.
4. **WebSearch (last resort):** Search secondary portals that index the JD. Never use a
   search snippet as the liveness verdict.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. Run `node reserve-report-num.mjs` to claim the next sequential number (stdout returns `{###}`).
2. Write the report file using that number.
3. Release the sentinel by running `node reserve-report-num.mjs --release {###}` once the report is written.

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
