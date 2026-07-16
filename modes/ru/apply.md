# Режим: apply — Ассистент отклика

> This file is a localization wrapper. It does not define an independent application workflow.

## Authoritative execution contract

Before taking any application action, the active agent must read these files completely in their current versions:

1. `modes/_shared.md` — the canonical source, safety, and writing rules.
2. `modes/apply.md` — the single canonical live-application workflow.
3. `modes/_custom.md` (when present) — the candidate's durable procedural overrides.
4. `queue-resolve.mjs` — the executable lookup/teach contract.
5. `application-receipt.mjs` — the mandatory per-page ledger and only valid review-ready finalizer.

Execute the root `modes/apply.md` workflow without omitting, reordering, or weakening any gate. In particular, retain its queue/role-ID precondition, API-first liveness check, exact-host registration/login state machine, one-role-per-tab preservation, fill-every-question L1/L1.5/L2/L3 page loop, per-page `--teach` barrier and verification, attachment checks, persistence receipt, combined review, and absolute ban on final application submission.

Use this locale's `_shared.md` for regional vocabulary and conventions, and write candidate-facing responses in Russian. Localization may change language and regional terminology only; it must never change workflow, safety, credential, truthfulness, review, tab, or submission behavior.

If any copied instruction, README, historical handover note, or prior agent summary conflicts with the five authoritative files above, ignore the stale copy and follow the authoritative contract.
