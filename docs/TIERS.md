# Infrastructure Tiers

career-ops runs entirely on **your machine and your own AI subscription**.
Nobody hosts anything for you, and nothing here costs the project maintainer
money — every optional cloud piece uses *your own* account, and every one of
them has a workable free tier.

Pick a tier. You can start at Tier 1 today and upgrade later without losing
data — each tier adds automation, not features.

| | What you get | Accounts needed | Cost |
|---|---|---|---|
| **Tier 1 — Local** (default) | The full pipeline: scanning, scoring, kanban dashboard, tailored CV/cover generation, form-fill | None | $0 |
| **Tier 2 — Cloud queue + scan cron** | Job discovery keeps running while your laptop is off; queue syncs across devices | Free Supabase project, your GitHub fork | $0 |
| **Tier 3 — Job-board discovery** | SEEK / Indeed / Workday-ATS discovery via Apify actors in the same cron | Apify account | ~$5 free credit granted monthly; light use stays inside it |

Your AI agent can do most of the work at every tier — after cloning, just ask
it: *"set me up on Tier 2"*.

---

## Tier 1 — Local (default)

```bash
git clone https://github.com/neilshekhar/career-ops.git
cd career-ops && npm install
npx playwright install chromium   # for PDF generation + form-fill
claude                            # or gemini / codex / qwen / opencode / agy / grok
```

On first launch the agent walks you through onboarding — CV, profile, target
roles — by chatting. No accounts, no keys.

- The apply queue lives in `data/apply-queue.json` (the store backend
  auto-resolves to `local` when Supabase is not configured).
- Scanning is on-demand and free: `/career-ops scan` hits Greenhouse / Lever /
  Ashby APIs directly with zero AI tokens.
- The local kanban dashboard is the primary review UI and stays
  localhost-only: `npm run launch` → `http://127.0.0.1:7777`.

There is nothing else to set up. Everything below is optional.

---

## Tier 2 — Your own free Supabase + GitHub scan cron

What this buys you: discovery runs on a schedule in GitHub Actions (free for
public repos), inserting new roles into a cloud queue while your laptop is
closed. The dashboard reads the same queue.

### 2a. Cloud queue

1. Create a free project at [supabase.com](https://supabase.com) (any region —
   pick one near you).
2. In the Supabase **SQL editor**, paste and run
   [`supabase/migrations/202606060001_queue_store.sql`](../supabase/migrations/202606060001_queue_store.sql)
   (idempotent — safe to re-run). It creates `active_roles`, `seen_urls`, the
   `save_queue` RPC, and an RLS-bounded `career_ops_cron` role. Candidate PII
   (drafts, CV paths, answers) never goes to the cloud — it stays in a local
   sidecar by design.
3. Add to `.env` in the repo root:
   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_DASHBOARD_KEY=<sb_secret_... key>   # Settings → API keys
   ```
4. Pin the backend in `config/profile.yml` so a broken env fails loud instead
   of silently writing locally:
   ```yaml
   queue:
     backend: supabase
   ```
5. Migrate your existing local queue (safe on an empty one too):
   ```bash
   node migrate-queue-to-supabase.mjs
   ```

### 2b. Scheduled discovery cron (GitHub Actions)

Runs `.github/workflows/api-cron.yml` daily in **your fork** with **your
secrets** — the workflow ships disabled-by-default because forks never inherit
secrets.

1. Fork this repo on GitHub (public fork = free Actions minutes).
2. Mint the cron credential (an ES256 signing key; the workflow mints a
   short-lived RLS-bounded JWT from it on every run — see
   [`docs/architecture/supabase-migration-schema.md`](architecture/supabase-migration-schema.md)):
   ```bash
   node mint-cron-jwt.mjs --generate-key
   ```
3. In your fork: **Settings → Environments → New environment** named `cron`,
   then add these environment secrets:
   - `SUPABASE_URL`
   - `SUPABASE_CRON_PUBLISHABLE_KEY` (the *publishable* key — never the
     `sb_secret_` one; the workflow refuses keys that bypass RLS)
   - `SUPABASE_CRON_SIGNING_KEY` (from step 2)
   - `PORTALS_YML` — your scan config: `gh secret set PORTALS_YML < portals.yml`
4. Trigger a test run: **Actions → api-cron → Run workflow**. New roles appear
   as `new` stubs in the dashboard inbox after your next `/career-ops queue`.

Re-run `gh secret set PORTALS_YML < portals.yml` whenever you edit
`portals.yml` — the cron reads the secret copy, not your laptop's file.

---

## Tier 3 — Apify job-board discovery (SEEK / Indeed / Workday ATS)

The ATS APIs in Tier 2 only cover companies you list. Apify actors add
job-board-wide discovery. Apify grants roughly **$5 of free usage every
month** — the default schedule (a couple of runs a week, ~20 results per
query) is sized to stay inside it.

1. Create an account at [apify.com](https://apify.com) and copy your API token.
2. Add `APIFY_TOKEN` to your fork's `cron` environment secrets (and to `.env`
   if you want local runs: `node apify-discover.mjs --source seek` dry-runs by
   default).
3. Set your targeting in `portals.yml` — searched titles and market:
   ```yaml
   apify_discovery:
     titles:
       - senior backend engineer
       - platform engineer
     location: "Sydney NSW"
     country: "AU"
   ```
   (Full field list in `templates/portals.example.yml`.) Then refresh the
   secret: `gh secret set PORTALS_YML < portals.yml`.
4. The schedule lives in `.github/workflows/apify-cron.yml` — adjust the cron
   lines if your credit budget differs.

---

## Cost summary, honestly

- **The AI does the expensive thinking, and you already pay for it** (or use a
  free-tier CLI — see [FREE_TIER.md](FREE_TIER.md)). career-ops is designed to
  spend as few tokens as possible: scanning, liveness checks, field resolution,
  and form-fill are deterministic scripts, not model calls.
- **Supabase free tier** is far beyond what a job search needs (the queue is a
  few hundred small rows).
- **GitHub Actions** is free for public repos.
- **Apify** is the only piece with a real meter; its monthly free credit
  covers the default cadence.
