# Upstream Merge Checklist — Standing Precedent

This checklist is **binding precedent for every future upstream pull**, not just the
one that created it. career-ops is a personal fork (`github.com/neilshekhar/career-ops`)
that periodically catches up to santifer's upstream. Upstream merges routinely touch
system-layer files that Neil's automation depends on (the apply/queue engine, the
Supabase cron credential boundary, the canonical state vocabulary, the dashboard).

**THE RULE: No upstream pull lands on `main` until every check below passes.**
If any check is red, **stop** and report the failure. Do not land the merge, do not
"fix it silently while merging." Investigate first; show the failure; fix on the merge
branch; re-run the whole gate from the top.

Run the gate on the merge branch **after** all conflicts are resolved and staged, with
the merge **not yet committed** (or committed but not yet merged to `main`). The default
`node test-all.mjs` run is local and non-mutating: it never reads `.env`, always runs the
pure eviction guard, and cleanly skips the separately authorized live Supabase proofs.
Use an environment with `go` on PATH and `git init` rights for the other full-suite checks.

---

## The Gate

### 1. Engine zero-diff

The apply/queue engine is Neil's, not upstream's. An upstream merge must **not** change
a single byte of it.

> **Pick the command that matches your timing.** The gate above says to run it with the
> merge resolved and staged but **not yet committed** — and at that moment `HEAD` still
> points at the pre-merge `main` commit, so `git diff main..HEAD` compares `main` to
> itself and is **empty no matter what the index contains**. That form is a silent
> no-op in exactly the situation this gate is meant to cover. Use `--cached`.

Define the protected runtime once. This is the current live application/queue engine,
including its controller, asset gates, and verification boundary:

```bash
PROTECTED_ENGINE_PATHS=(
  application-answers.mjs
  application-receipt-integrity.mjs
  application-receipt.mjs
  application-request.mjs
  application-safety.mjs
  application-source-contract.mjs
  answer-cache.mjs
  apply-page.mjs
  cover-quality.mjs
  credentials-store.mjs
  cv-tailoring.mjs
  dashboard-auth.mjs
  dashboard-launch.mjs
  dashboard-server.mjs
  dashboard/web/app.js
  field-rules.mjs
  form-fill.mjs
  generate-docx.mjs
  generation-provenance.mjs
  lean-application.mjs
  login-core.mjs
  mint-cron-jwt.mjs
  one-shot-request.mjs
  prepare-application.mjs
  queue-ingest.mjs
  queue-resolve.mjs
  queue-store.mjs
  queue-sweep.mjs
  run-partition.mjs
  screener-store.mjs
  set-status.mjs
  snapshot-extract.mjs
  supabase-client.mjs
  tracker-status-map.mjs
  verify-application-contract.mjs
  verify-userdata.mjs
)
```

**Staged, not yet committed (the default timing above)** — both commands must exit
zero. `--exit-code` is intentional: a visible diff is not merely advisory; it fails
the gate.

```bash
git diff --cached --exit-code main -- "${PROTECTED_ENGINE_PATHS[@]}"
git diff --exit-code -- "${PROTECTED_ENGINE_PATHS[@]}"
git diff --cached --check
git diff --check
git status --short
```

The first command catches staged merge resolutions. The second independently catches
well-formed but unstaged edits; `git diff --check` only detects whitespace errors and
cannot replace it. `git status --short` remains the final human-readable inventory.

**Already committed on the topic branch** — only then is the range form valid, and it
must also fail automatically on a non-empty diff:

```bash
git diff --exit-code main...HEAD -- "${PROTECTED_ENGINE_PATHS[@]}"
```

An empty diff is only evidence when the command matches the state of the tree. If you
are unsure which applies, run **both** — a genuinely clean merge passes both.

If any engine file differs, **stop and show why** before doing anything else. A
non-empty diff means the merge silently re-pointed engine behavior — that is a hard
blocker, never a "merge it and patch later."

### 2. Test suite green
```bash
node test-all.mjs   # must be: 0 failed, 0 warnings
```
Includes the Neil-specific baseline tests (§16–§24) and any new tests added by the
work that motivated the pull. Its clean live-test skip must not be reported as a live
RLS proof.

### 3. Pipeline clean
```bash
node verify-pipeline.mjs   # must be: 0 errors, 0 warnings — "Pipeline is clean!"
```

### 4. Cron RLS boundary 6/6 (live Supabase)
```bash
CAREER_OPS_RUN_LIVE_SUPABASE_TESTS=1 node test-cron-rls-negative.mjs
CAREER_OPS_RUN_LIVE_SUPABASE_TESTS=1 node test-cron-evict.mjs
```
Proves the split-credential RLS boundary survived: the cron JWT can only
INSERT/DELETE `status='new'`, and `sb_secret_` / privileged-role JWTs are rejected on
the cron path. This is a separate, explicitly authorized remote-mutation check. It needs
network access and the configured Supabase credentials already exported in `process.env`;
the scripts never load `.env`. Do not run it as part of an ordinary/default suite.

### 5. `jose` survived — cron JWT mints
```bash
# Bare `node mint-cron-jwt.mjs` only prints usage — pass the local signing key.
# Discard stdout; never print the token or open the key file.
node mint-cron-jwt.mjs career_ops_signing_key_private.json --exp-seconds 300 >/dev/null && echo OK
```
Confirms the `jose` dependency and ES256 minting path were not dropped or downgraded
by the merge.

### 6. State vocabulary intact
`templates/states.yml` must still carry the full queue vocabulary
(`scored`, `prepared`/`prepare-queued`/`ready`, `prefilled`, `filled`, `submitted`,
plus the canonical tracker states). Confirm a queue row round-trips:

```bash
node normalize-statuses.mjs && node verify-pipeline.mjs
```

### 7. Dashboard launches, kanban board renders
Smoke the dashboard and confirm the review queue renders its five kanban
columns (**Inbox / To Do / Prepared / In Review / Done**) with the risk-lane
badges (needs-input / review-carefully) on cards, and that cards drag between
columns per the transition rules. The Go TUI (`dashboard/`) must also
build — `go` must be on PATH (this is why §2 runs outside the sandbox).

### 8. DOCX cover letter still generates
```bash
node generate-docx.mjs   # (or the cover-letter path) must produce a valid .docx
```

### 9. Gains landed
Confirm the features the pull was supposed to bring are actually present. For the
2026-06-22 catch-up these were `modes/cover.md`, `generate-cover-letter.mjs`, and
`modes/interview.md`; for future pulls, list and check whatever that pull adds.

### 10. Secret and browser paths still ignored
An upstream `.gitignore` rewrite can silently un-ignore a credential path. Every one of
these must print a matching ignore rule:

```bash
git check-ignore -v \
  career_ops_signing_key_private.json \
  .browser-profiles/ \
  .playwright-mcp/ \
  data/portal-credentials.json \
  article-digest.md
```

A path that prints nothing is **not ignored**. Fix the tracked `.gitignore` before
landing — `.git/info/exclude` does not count, because a fresh clone never inherits it.

---

## Topic Merges: dependency safety, not path safety

**A new upstream file is not safe merely because the fork never touched that path.**
Providers, modes, liveness fixes, and tests routinely depend on edits to shared
registries and utilities that *do* collide. The redirect-SSRF topic, for example,
modifies existing liveness and test files alongside its new code, so it cannot be
banked by copying only the collision-free files.

Likewise, a count of paths changed on both sides since the merge base is **not** a
conflict count — git auto-merges many of them. Every overlap needs review; none of them
should be pre-announced as a conflict.

Merge in dependency-aware topics, in this order, one topic per branch:

1. Security and liveness.
2. Scanner providers **plus** their shared registries, utilities, and tests.
3. PDF/CV theming and section infrastructure.
4. Tracker/status/locking changes.
5. New modes **plus** their router and docs integration.
6. Dashboard changes.
7. Documentation-only / manifesto material (normally omitted from the private fork).

For each topic: branch from `main` → apply the complete dependency set → preserve fork
identity and the protected engine → run the staged diff in §1 → run the focused tests →
run the full gate → commit and review before starting the next topic.

**Semantic review, never a blind append.** Upstream blacklist-approval and portal-login
blocks must be reconciled against One-shot's no-intermediate-prompt authorization, the
fork's exact-host account/login workflow, and the never-submit boundary. Topic-level
tests must prove new providers and modes are actually registered and callable.

Use `git merge --no-commit --no-ff upstream/main` only for a full merge, and never rely
on "conflicts will stop it from auto-committing."

---

## Recurring Conflict Resolutions (standing precedent)

These come up in nearly every pull — resolve them the same way each time:

1. **Version identity stays on Neil's line.** `VERSION`, `package.json`,
   `scaffolder/package.json` (`@neilshekhar/career-ops`), `.release-please-manifest.json`,
   and `web/package.json` keep the fork's versions. Never take upstream's.
2. **CHANGELOGs interleave.** Keep the fork's release blocks and add upstream's new
   blocks below them as historical record — don't drop either side.
3. **`update-system.mjs` stays fork-pointed** at `neilshekhar/career-ops`
   (test-guarded; an upstream merge that reverts it turns the suite red).
4. **`merge-tracker.mjs` keeps `sanitizeCell` on EVERY cell** (Lesson #10) — adopt
   upstream's structural changes (e.g. Via/Location columns) but route all cells
   through `sanitizeCell`, not upstream's free-text-only `cell()`.
5. **Mode/doc lists union.** SKILL.md argument hints, mode routing tables, and
   DATA_CONTRACT tables take upstream's new entries PLUS the fork's `queue` entries.
6. **New upstream `README.<lang>.md` files need the fork's kanban-first copy**
   (feature-table row + `## Local Kanban Dashboard` section with `npm run launch`,
   TUI demoted to a subsection) or the fork doc gate in `test-all.mjs` goes red
   (hit with README.hi.md, 2026-07-09).
7. **Provider tests live in `tests/providers/` since upstream #1500** (auto-discovered).
   When resolving `test-all.mjs`, keep the fork-only engine suites (queue store,
   API-cron, form-fill safety, resolver, cron JWT/RLS, dashboard, DOCX, cover
   formats, answer-cache) and drop legacy in-file provider sections — verify each
   dropped provider has a `tests/providers/*.test.mjs` replacement first.
8. **Lean-llm-v1 is the default live apply protocol (fork-side).** Keep
   `apply-page.mjs` as the dual-protocol agent-facing driver, `lean-application.mjs`
   as the lean lifecycle helper, `snapshot-extract.mjs` for receipt-v3 file-derived
   receipts, and the six-file contract (`modes/_shared.md`, `modes/apply.md`,
   `modes/_custom.md`, `apply-page.mjs`, `queue-resolve.mjs`,
   `application-receipt.mjs`). Default for every NEW begin is
   `execution_protocol: "lean-llm-v1"` / selective verification /
   `apply-page.mjs page-done` → `apply-page.mjs finish` → queue **`prefilled`**.
   Reject upstream restoring a mandatory receipt loop (`lookup` → `complete` →
   `finalize` → `filled`) as the only path for new begins. Historical
   **receipt-v3** remains explicit opt-in only. Do not accept an upstream
   reintroduction of hand-authored `--lookup`/`--teach`/`--page` envelopes as the
   live agent-facing path. Inline `queue-resolve.mjs --lookup/--teach` remains valid
   only for PREPARE and historical revalidation.

9. **Upstream community-infrastructure workflows are deleted, not merged.** santifer's repo runs
   community automation that is meaningless on a private fork and, worse, fails loudly or carries
   an unnecessary trigger. Delete these on every pull that reintroduces them:
   `.github/workflows/manifesto-guestbook.yml`, `gh-events-feed.yml`, `ledger-bot.yml`,
   `signature-ci.yml`. Rationale (2026-07-28): `manifesto-guestbook` fires on **every push** and
   fails permanently here because `DISCORD_MANIFESTO_WEBHOOK` does not exist on the fork — it dies
   on `fetch('')`, so nothing is posted upstream, but every push gets a red X. `gh-events-feed` has
   the same shape on `pull_request_target`, the write-scoped trigger class this fork has no reason
   to carry. `ledger-bot` (discussions) and `signature-ci` (PR signature validation) are dormant
   community infra. Verify with `ls .github/workflows/` after resolving; nothing in the codebase
   references them (only a historical CHANGELOG line). **Keep** `MANIFESTO.md`, `SIGNATURES.md`,
   `CONTRIBUTORS.md`, `.all-contributorsrc`, and `.github/PULL_REQUEST_TEMPLATE/sign-manifesto.md` —
   inert documents whose deletion buys nothing and guarantees conflict churn on every future merge.

10. **Keep `windows-latest` in the CI matrix — this fork is distributed, not private.**
    The release publishes `@neilshekhar/career-ops` to npm and the README quick start tells people
    to clone this repo, so Windows users run this code even though it is developed on macOS. The leg
    pays for itself: the 2026-07-28 catch-up surfaced five Windows-only defects, one of them
    security-relevant — `path.relative()` between two drives returns the ABSOLUTE target rather than
    a `..` walk, so a containment guard built only from "falsy / starts with `..` / round-trips
    through `resolve()`" accepted a caller-authored artifact on another drive as being inside
    `reports/`. Every containment guard in this repo therefore carries an `isAbsolute(rel)` rung
    (`set-status.mjs`, `application-receipt.mjs` ×2, `application-receipt-integrity.mjs`,
    `dashboard-server.mjs`, and the pre-existing ones in `application-source-contract.mjs`,
    `queue-sweep.mjs`, `generate-pdf.mjs`, `reconcile-pipeline.mjs`).
    `tests/queue-receipt-guard.test.mjs` asserts that invariant under `win32` semantics, so it holds
    on any platform. When adapting a test for Windows, resolve interpreters through
    `getBash()`/`toBashPath()` in `tests/helpers.mjs` (identity operations off Windows) and use
    `path.delimiter` for PATH — skip a rung only when the platform genuinely cannot express its
    precondition, and say so in the skip message. Do not drop the leg to make a red build green.

## Procedure

0. **Fetch upstream without tags:** `git fetch upstream --no-tags`. Upstream
   (santifer) and this fork both cut releases tagged `career-ops-vX.Y.Z`
   independently, so the same version number can land on two different commits.
   Tags are a global ref namespace in git (not per-remote), so a tagged fetch
   from `upstream` can silently overwrite or collide with the fork's own
   `career-ops-vX.Y.Z` tag from `origin` — this already happened once (local
   `career-ops-v1.20.0` pointed at upstream PR #1884 instead of the fork's own
   release). `--no-tags` avoids importing upstream's tags into the local
   namespace at all; the fork's own tags always come from `origin`.
1. Create a `merge/...` branch off `main`; merge upstream into it.
2. Resolve conflicts. **Keep Neil's user-layer and engine files** (Data Contract);
   keep upstream's genuine system improvements only where they don't touch the engine.
3. Stage the resolved tree. Run the **entire** gate above, top to bottom.
4. **Any red → stop.** Report the failure verbatim. Fix on the merge branch. Re-run
   the whole gate.
5. All green → commit the merge, merge the branch into `main`, then cut a release on
   Neil's own version line (`career-ops-vX.Y.Z`) and update `handover.md`.

See `DATA_CONTRACT.md` for the user/system layer split and `handover.md` for the
running log of past merges and lessons.
