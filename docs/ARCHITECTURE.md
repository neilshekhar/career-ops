# Architecture

This file describes the runtime flows. Design principles and the
system/user data-contract layers live in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## System Overview

```
                    ┌─────────────────────────────────┐
                    │         AI Coding CLI Agent      │
                    │   (reads AGENTS.md + modes/*.md) │
                    └──────────┬──────────────────────┘
                               │
            ┌──────────────────┼──────────────────────┐
            │                  │                      │
     ┌──────▼──────┐   ┌──────▼──────┐      ┌────────▼────────┐
     │ Direct JD/URL│   │ Portal Scan │      │  Batch Process  │
     │ evaluation   │   │ + pipeline  │      │ (headless triage)│
     └──────┬──────┘   └──────┬──────┘      └────────┬────────┘
            └──────────────────┴──────────┬────────────┘
                                         ▼
                         ┌────────────────────────────┐
                         │ A-G report + score/verdict │
                         │ tracker status: Evaluated  │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │ Local Kanban dashboard     │
                         │ explicit selection/continue│
                         └─────────────┬──────────────┘
                                       ▼
                  PREPARE CV + cover (HTML → Playwright PDF)
                                       │
                                       ▼
                  active-agent live fill → application receipt
                                       │
                                       ▼
                         candidate review + final submit
```

## Evaluation Flow (Single Offer)

1. **Input**: User pastes JD text or URL
2. **Extract**: Public ATS/API retrieval first, then Playwright for rendered pages; WebFetch is a static-page fallback
3. **Verify liveness**: `check-liveness.mjs` uses the public ATS/API rung first and rendered-page evidence when inconclusive
4. **Classify**: Detect archetype (1 of 6 types)
5. **Evaluate**: Blocks A-G:
   - A: Role summary
   - B: CV match (gaps + mitigation)
   - C: Level strategy
   - D: Comp research (WebSearch)
   - E: CV personalization plan
   - F: Interview prep (STAR stories)
   - G: Posting legitimacy (separate qualitative tier)
6. **Score**: Weighted average across 10 dimensions (1-5), with Block G reported separately
7. **Report**: Save as `reports/{num}-{company}-{date}.md`
8. **Track**: Merge one canonical tracker row with status `Evaluated`
9. **Present**: Show the score/verdict and dashboard, then stop. Under `modes/_custom.md`, a directly pasted JD/URL does not generate tailored assets, advance the tracker into an application state, select a role, open a browser, or live-fill a form before explicit continue/dashboard selection.
10. **Prepare/apply after authorization**: Generate fresh role-matched CV and cover assets with Playwright-backed PDF rendering, pass `verify-userdata.mjs`, let the active agent fill the live form, finalize `application-receipt.mjs`, and leave final submission to the candidate.

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv    →  batch-runner.sh  →  N × headless CLI workers
(id, url, source)     (orchestrator)       (self-contained prompt)
                           │
                    batch-state.tsv
                    (tracks progress)
```

Each worker is a headless AI CLI instance — the bundled `batch-runner.sh` supports multiple CLIs via the `--cli` flag (`--cli claude` or `--cli opencode`). See the Headless / Batch Mode table in `AGENTS.md`. Workers produce:
- A-G report `.md`
- Provisional triage score
- Tracker TSV line with status `Evaluated`

PDF generation is off by default. `--draft-pdf` may create a non-release draft, but final application assets must be regenerated through interactive PREPARE and pass the release gate.

The orchestrator manages parallelism, state, retries, and resume.

## Data Flow

```
cv.md                    →  Evaluation context
article-digest.md        →  Proof points for matching
config/profile.yml       →  Candidate identity
portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.html → PDF generation template
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges `Evaluated` batch TSV additions; explicit historical/external lifecycle imports delegate to `set-status.mjs --external` with provenance |
| `verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `normalize-statuses.mjs` | Maps status aliases to canonical values |
| `cv-sync-check.mjs` | Validates setup consistency |

## Dashboard and review surfaces

The primary review surface is the local Kanban dashboard opened with `npm run launch` at `http://127.0.0.1:7777`. It displays scored roles, records explicit selection and low-score override decisions, queues durable application requests for the active agent, and surfaces review-ready work. Its Fill/Run actions do not directly own a browser or submit applications.

The `dashboard/` directory also contains an optional standalone Go TUI for secondary tracker/report browsing, including filtering, sorting, grouped/flat views, report previews, and status updates.
