# Mode: followup -- Follow-up Cadence Tracker

> **Read `voice-dna.md` (if present) and apply it to every generated email/LinkedIn draft.** This mode is standalone — it does NOT load `_shared.md`, so read `voice-dna.md` directly. Follow-up drafts are conversational, so apply the full guardrail: banned words/phrases/patterns, no em-dashes, no negative parallelisms (§3-4) AND conversational voice — contractions, varied rhythm, direct "I"/"you" (§1-2). Never drop or soften a real metric from `cv.md` for style.

## Purpose

Track follow-up cadence for active applications. Flag overdue follow-ups, extract contacts from notes, and generate tailored follow-up email/LinkedIn drafts using report context.

**Not in scope here:** a same-day follow-up after a recruiter/interviewer
confirmed a specific call time and then didn't call. That's not an
elapsed-time cadence case — see `confirmed_time_noshow` in `modes/email.md`
(`/career-ops email noshow`) instead.

## Inputs

- `data/applications.md` — Application tracker
- `data/follow-ups.md` — Follow-up history (created on first use)
- `reports/` — Evaluation reports (for context in drafts)
- `config/profile.yml` — User profile (name, identity)
- `cv.md` — CV for proof points in drafts
- `article-digest.md` — Optional approved proof-point detail
- `modes/_profile.md` — Approved candidate framing and application positioning

## Step 1 — Run Cadence Script

Execute:

```bash
node followup-cadence.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Analysis date, total tracked, actionable count, overdue/urgent/cold/waiting counts |
| `entries` | Per-application: company, role, status, days since application, follow-up count, urgency, next follow-up date, extracted contacts, report path |
| `cadenceConfig` | Cadence rules (applied: 7 days, responded: 3 days, interview: 1 day) |

If no actionable entries, tell the user:
> "No active applications to follow up on. Apply to some roles first with `/career-ops` and come back when they're aging."

## Step 2 — Display Dashboard

Show a cadence dashboard sorted by urgency (urgent > overdue > waiting > cold):

```
Follow-up Cadence Dashboard — {date}
{N} applications tracked, {N} actionable

| # | Company | Role | Status | Days | Follow-ups | Next | Urgency | Contact |
```

Use visual indicators:
- **URGENT** — respond within 24 hours (company replied)
- **OVERDUE** — follow-up is past due
- **waiting (X days)** — on track, follow-up scheduled
- **COLD** — 2+ follow-ups sent, suggest closing

## Step 3 — Generate Follow-up Drafts

For each **overdue** or **urgent** entry only:

1. Read the linked report (`reportPath` from JSON) for JD, company, role, and prior-contact
   context only. A report is not evidence for a candidate fact.
2. Read `cv.md`, `article-digest.md` when present, and `modes/_profile.md` for approved
   proof points and positioning.
3. Read `config/profile.yml` for candidate name and identity.
4. Revalidate any wording copied from an older report or follow-up against those approved
   candidate sources before using it.

**Agency-mediated applications (#1596):** when the entry's `via` field is set (the cadence JSON emits `via: null` for direct applications), the chase target is the **agency contact** (recruiter named in the notes/contacts), not the company — the recruiter owns the client relationship and has their own incentive to respond. Reference the role by the agency's framing.

**When the end employer is unknown (company `?`), this branch REPLACES the framework rules below — do not fall through to them.** There is no company name to mention and nothing company-specific to reference, so instead:
- Sentence 1 references the role by the **agency's framing** (their listing title + the recruiter's name) **plus when you applied** — the application date stays in the opening exactly as the framework requires; only the company reference is replaced, never with a placeholder company name.
- Sentence 2's value-add draws only on approved candidate proof points from `cv.md`,
  `article-digest.md`, or `modes/_profile.md`; use the report only to select what fits the
  listed role. Skip the "specific to THAT company" rule.
- Add the client-name ask: request the end employer's name as a natural part of the follow-up ("so I can prepare properly, could you share which company this role is with?") — that reveal is what unlocks cross-channel dedup in the tracker.

When `via` is set but the employer IS known, use the framework below unchanged except the recipient: address the recruiter, mention the client company by name.

### Email Follow-up Framework (first follow-up, followupCount == 0)

Generate a 3-4 sentence email:

1. **Sentence 1:** Reference the specific role + when you applied. Be specific — mention the company name and role title.
2. **Sentence 2:** One concrete, approved proof point from `cv.md`,
   `article-digest.md`, or `modes/_profile.md`, selected to answer a requirement identified
   in the report/JD. Quantify only when the approved source provides the number.
3. **Sentence 3:** Soft ask + availability. Offer a specific time window ("this week" or "next Tuesday").
4. **Sentence 4 (optional):** Brief mention of a relevant recent project or achievement.

**Rules:**
- Professional but warm, NOT desperate
- **NEVER** use "just checking in", "just following up", "touching base", or "circling back"
- Lead with value, not with the ask
- Reference something specific to THAT company (from report Block A)
- Keep under 150 words
- Include a subject line
- Use the candidate's name from `config/profile.yml`

**Example structure (placeholders only; never copy them as candidate facts):**
> Subject: Re: [Role] — [Company]
>
> Hi [contact name or "team"],
>
> I submitted my application for the [Role] position on [date]. One relevant example is
> [approved source-backed achievement], which maps closely to [specific requirement from
> the current JD].
>
> I’d be glad to discuss how that experience could support [specific team or company
> priority]. Would any time this week work for a brief conversation?
>
> Best,
> [Name]

### LinkedIn Follow-up (if no email contact found)

Reuse the contacto framework: 3 sentences, 300 character max.
- Hook specific to company → proof point → soft ask
- Suggest the user run `/career-ops contacto {company}` to find the right person first

### Second Follow-up (followupCount == 1)

Shorter than first (2-3 sentences). Take a **new angle**:
- Share a relevant insight, article, or project update
- Don't repeat the first follow-up's content
- Still reference the role specifically

### Cold Application (followupCount >= 2)

Do NOT generate another follow-up. Instead suggest:
> "This application has had {N} follow-ups with no response. Consider:
> - Updating status to `Discarded` if the role seems filled
> - Trying a different contact via `/career-ops contacto`
> - Keeping in `Applied` status but deprioritizing"

## Step 4 — Present Drafts

For each draft, show:

```
## Follow-up: {Company} — {Role} (#{num})

**To:** {email or "No contact found — run `/career-ops contacto` first"}
**Subject:** {subject line}
**Days since application:** {N}
**Follow-ups sent:** {N}
**Channel:** Email / LinkedIn

{draft text}
```

## Step 5 — Record Follow-ups

After the user reviews and says they've sent a follow-up, record it:

1. If `data/follow-ups.md` doesn't exist, create it (this exact header — the
   same one the web UI writes; `followup-cadence.mjs` parses these columns):

   ```markdown
   # Follow-ups

   | num | appNum | date | company | role | channel | contact | notes |
   |---|---|---|---|---|---|---|---|
   ```

2. Append a row with:
   - `num` = next sequential number in the follow-ups table
   - `appNum` = application number from tracker
   - `date` = today's date (YYYY-MM-DD)
   - `company` = company name
   - `role` = role title
   - `channel` = Email / LinkedIn / Other
   - `contact` = who it was sent to
   - `notes` = brief note (e.g., "First follow-up, referenced approved analytics proof point")

3. Optionally append "Follow-up {N} sent {YYYY-MM-DD}" through the canonical locked
   writer: `node set-status.mjs <appNum> <current-state> --note "Follow-up {N} sent
   {YYYY-MM-DD}"`. Keep the existing state unchanged; never hand-edit
   `data/applications.md`.

**IMPORTANT:** Only record follow-ups the user confirms they actually sent. Never record a draft as sent.

### Pinned next dates & automatic seeding

`data/follow-ups.md` also supports pin lines that override the computed
schedule for a single application:

```text
- next #42 2026-07-10 (set 2026-07-02)
```

`#42` is the application number, the first date is the pinned NEXT follow-up
date, and `(set …)` is the day the pin was made. Pins take precedence over
the computed schedule until a follow-up is logged on or after the set-date;
the latest pin per application wins; deleting the line clears the pin.

Pins may be seeded AUTOMATICALLY when an application turns Applied —
`node followup-seed.mjs <num>` (run by the `apply` mode's Step 9) appends a
pin scheduling the first follow-up at apply date + the `applied_first`
cadence. Seeding is idempotent, and a stale pin left behind by a later
Rejected/Discarded transition is harmless because the cadence analysis
ignores non-actionable statuses.

## Step 6 — Summary

After showing all drafts, summarize:

> **Follow-up Dashboard** ({date})
> - {N} applications being tracked
> - {N} overdue — drafts generated above
> - {N} urgent — respond today
> - {N} waiting — next follow-up dates shown
> - {N} cold — consider closing
>
> Review the drafts above and tell me which ones you've sent so I can record them.

## Cadence Rules Reference

| Status | First follow-up | Subsequent | Max attempts |
|--------|----------------|------------|-------------|
| Applied | 7 days after application | Every 7 days | 2 (then mark cold) |
| Responded | 1 day (urgent reply) | Every 3 days | No limit |
| Interview | 1 day after (thank-you) | Every 3 days | No limit |

These defaults can be overridden via `node followup-cadence.mjs --applied-days N`.
