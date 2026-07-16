# Режим: pipeline — Черга URL

> This file is a localization wrapper. It does not define an independent pipeline workflow.

## Authoritative execution contract

Before processing any pipeline URL, read and execute `modes/pipeline.md` in its current
version. Also load `modes/_custom.md` when present and the root modes that the canonical
pipeline invokes. Retain every root gate, including the API-first bulk and per-role
liveness checks, atomic report-number reservation, A-G evaluation, explicitly activated
draft-PDF score filter,
single-pass/no-recursive-fanout worker limit, and canonical tracker writes.

Use this locale's `_shared.md` for regional vocabulary and conventions, and write
candidate-facing responses in Ukrainian. Localization may change language and regional
terminology only; it must never change liveness, numbering, evaluation, concurrency,
source, persistence, credential, review, or submission behavior.

If any copied instruction, README, historical handover note, or prior agent summary
conflicts with `modes/pipeline.md`, ignore the stale copy and follow the root workflow.
