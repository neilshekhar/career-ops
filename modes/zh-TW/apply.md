# 模式: apply — 即時表單填寫助理

> This file is a localization wrapper. It does not define an independent application workflow.

## Authoritative execution contract

Before taking any application action, the active agent must read these files completely in their current versions:

1. `modes/_shared.md` — the canonical source, safety, and writing rules.
2. `modes/apply.md` — the single canonical live-application workflow (**lean-llm-v1** default).
3. `modes/_custom.md` (when present) — the candidate's durable procedural overrides.
4. `apply-page.mjs` — the executable dual-protocol page driver (lean default; receipt-v3 opt-in).
5. `queue-resolve.mjs` — the resolver/teach contract used by the driver.
6. `application-receipt.mjs` — the review-readiness finalizer (receipt-v3 / historical `filled` only).

Execute the root `modes/apply.md` workflow without omitting, reordering, or weakening any gate. In particular, retain its queue/role-ID precondition, API-first liveness check, exact-host registration/login state machine, one-role-per-tab preservation, fill-every-question L1/L1.5/L2/L3 page loop, default lean `apply-page.mjs lookup` / `page-done` / `finish` → queue status `prefilled` (selective verification; never click final submit), attachment checks, compact combined review, and absolute ban on final application submission. Historical receipt-v3 (`complete` / `finalize` → `filled`) is explicit opt-in only — not the default path.

Use this locale's `_shared.md` for regional vocabulary and conventions, and write candidate-facing responses in Traditional Chinese. Localization may change language and regional terminology only; it must never change workflow, safety, credential, truthfulness, review, tab, or submission behavior.

If any copied instruction, README, historical handover note, or prior agent summary conflicts with the six authoritative files above, ignore the stale copy and follow the authoritative contract.
