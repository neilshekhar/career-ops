# Shared localization overlay — 한국어

> This file is a language and market-vocabulary overlay only. It does not define
> candidate facts, scoring, evaluation, pipeline, live-application, credential,
> browser, persistence, review, or submission workflow.

## Canonical contracts

Before any task, read root `modes/_shared.md`, `modes/_profile.md`,
`config/profile.yml`, and `modes/_custom.md` when present. Then execute the selected
root mode in its current version:

- evaluation: `modes/oferta.md`
- pipeline processing: `modes/pipeline.md`
- live application: `modes/apply.md` plus `apply-page.mjs`,
  `queue-resolve.mjs`, and `application-receipt.mjs`

Localization may change language and regional terminology only. It may never omit,
reorder, weaken, or add an exception to a root gate. In particular, API-first
liveness, source boundaries, atomic numbering, queue persistence, exact-host auth,
one-browser-controller ownership, per-page lookup/L3/teach/receipt barriers, combined
review, and the ban on final job submission remain unchanged.

## Source boundary

Candidate-facing factual content may use only the approved sources listed in
`AGENTS.md` plus statements the candidate makes in the current conversation. This
locale file is never a source of candidate history, achievements, metrics, authorship,
work rights, identity, compensation, availability, or credentials. `voice-dna.md`
controls style only. Never reuse a sample narrative, number, demo credential, or
portfolio claim from a system/localization file as candidate evidence.

Unsupported prose claims are omitted. A mandatory live form control is handled only
through root `modes/apply.md` and `modes/_custom.md`: choose the most conservative
source-supported or non-claiming response, fill it, store it role-locally, and flag it
for final review without inventing a factual status.

## Locale output

- Write candidate-facing responses in Korean when this locale is selected.
- Use natural professional terminology for South Korea; preserve exact JD/ATS
  keywords and established English technical terms where translation would reduce
  accuracy.
- Infer the governing country/jurisdiction from the posting and candidate profile;
  never assume it from language alone.
- Compensation, tax, employment-law, visa, and benefits claims are high-stakes and
  time-sensitive. Verify them from current official sources when needed, distinguish
  observation from advice, and mark unavailable facts rather than relying on copied
  localization examples.

If any README, copied instruction, historical handover note, or prior agent summary
conflicts with the canonical files above, ignore the stale copy and follow the root
contract.
