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
the merge **not yet committed** (or committed but not yet merged to `main`). Always run
`node test-all.mjs` outside the sandbox (it needs `go` on PATH, `git init` rights, and
network for the live Supabase RLS test — inside the sandbox those three show as false
failures).

---

## The Gate

### 1. Engine zero-diff
The apply/queue engine is Neil's, not upstream's. An upstream merge must **not** change
a single byte of it. This diff must be **empty**:

```bash
git diff main..HEAD -- \
  queue-ingest.mjs queue-resolve.mjs queue-store.mjs \
  supabase-client.mjs mint-cron-jwt.mjs \
  form-fill.mjs login-core.mjs generate-docx.mjs
```

If any engine file differs, **stop and show why** before doing anything else. A
non-empty diff means the merge silently re-pointed engine behavior — that is a hard
blocker, never a "merge it and patch later."

### 2. Test suite green
```bash
node test-all.mjs   # must be: 0 failed (warnings OK)
```
Includes the Neil-specific baseline tests (§16–§24) and any new tests added by the
work that motivated the pull. Run **outside the sandbox** (see note above).

### 3. Pipeline clean
```bash
node verify-pipeline.mjs   # must be: 0 errors, 0 warnings — "Pipeline is clean!"
```

### 4. Cron RLS boundary 6/6 (live Supabase)
```bash
node test-cron-rls-negative.mjs   # must pass 6/6 against live Supabase
```
Proves the split-credential RLS boundary survived: the cron JWT can only
INSERT/DELETE `status='new'`, and `sb_secret_` / privileged-role JWTs are rejected on
the cron path. Needs network + the configured Supabase secrets.

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

## Procedure

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
