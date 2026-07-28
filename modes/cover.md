# Mode: cover — Cover Letter Generator

Generates a tailored cover letter for any candidate from a job description.
Works in two modes:
- **Slug mode:** `/career-ops cover {slug}` — loads the existing evaluation report and
  JD context; a legacy report draft may be reused only as a starting point
- **Paste mode:** `/career-ops cover` or JD pasted directly — starts from scratch

### Authorized One-shot exception

The ordinary flow below is interactive. Its only no-prompt exception is a role that the
candidate explicitly authorized for One-shot through the per-role `auto-fill` flag or
queue-level `auto_fill_all` setting defined in `modes/queue.md` and `modes/_custom.md`.
For that role, the capable interactive agent performs and records the company research,
keyword choices, gap handling, four angle/tone decisions, and self-review without pausing;
unsupported claims are omitted and flagged, never invented. It may then generate the
canonical MD/PDF/DOCX assets before the candidate's single combined review. Every source,
quality, provenance, liveness, and final-submission guard remains mandatory. A batch,
headless draft, vague request, or missing One-shot authorization does not use this exception.

---

## Step 0 — JD Gate (mandatory)

Before doing anything, confirm a job description is present.

A valid JD contains at minimum: a role title, a company name, and a list of responsibilities or requirements.

- **No JD present** → Stop. Say: "Please paste the job description — I need it to tailor the letter."
- **Slug provided** → Read `reports/` to find the matching report. Load its JD,
  company, role, keywords, A-G evaluation context, and Block E customization plan.
  If a legacy `## Cover Letter Draft` exists, it may seed wording only after every
  candidate claim is revalidated against the approved sources. Then fetch the original
  JD URL from the report header when more current context is needed.
- **JD present** → Proceed to Step 1.

Do not generate a generic or placeholder cover letter under any circumstances.

---

## Step 1 — Load candidate profile

Read `config/profile.yml` for:
- `candidate.name`, `email`, `phone`, `location`, `linkedin`, `github`
- `candidate.credentials` (derive from cv.md Education + Certifications if not in profile.yml)
- `cover_letter.notice_period_days` (default: omit if key absent)
- `cover_letter.primary_domain` (default: infer from cv.md if absent)
- `cover_letter.language_learning` (default: empty list if absent)

Read `cv.md` for:
- Professional summary (profile introduction source)
- All achievement bullets across all roles (achievement selection pool)

Read `article-digest.md` if it exists — supplementary proof points and metrics take precedence over cv.md where they overlap.

Read `modes/_profile.md` if it exists — the candidate's personalization file. It captures their target roles, adaptive framing and archetypes, exit narrative, cross-cutting advantage, proof points, comp targets, negotiation scripts, location policy, and any voice or writing-style rules they have added. Its rules **govern the letter's voice and structure and override the generic defaults in this mode**, so the candidate's personalization is never lost.

---

## Step 2 — Parse the JD

Extract:
- **Role title** (exact wording from JD)
- **Company name**
- **Location / city**
- **Top 3-4 required competencies** (from requirements or responsibilities section)
- **Mission/vision language** the company uses (opening paragraphs)
- **Domain** (e.g. fintech, healthcare, media, logistics) — compare against `cover_letter.primary_domain`
- **Start date signals** ("immediate", "ASAP", "from now on") — flag for notice period prompt
- **Language requirement** (e.g. "German B2 required") — flag for language gap prompt
- **JD tone** (formal / direct / casual) — used in tone prompt default suggestion

---

## Step 3 — Company research (baked in, not optional)

Run three WebSearch queries (substitute the actual current year for {year}):
1. `"{company}" product strategy OR roadmap {year}`
2. `"{company}" challenges OR problems OR priorities {year}`
3. `"{company}" news OR announcement OR funding {year}`

Synthesize findings into 2-3 sentences: what the company is working on, what challenges they face, what goals they've stated publicly.

Present to the user:

```text
Here's what I found about {company}:

{2-3 sentence synthesis}

Does this match what you know? Correct or add anything before I write the letter.
```

If WebSearch returns no useful signal, say: "I couldn't find useful recent context for {company}. Can you share what you know about their current challenges or goals?" In an authorized One-shot run, record that no reliable external signal was found and rely only on the JD and approved sources; do not pause or invent company context.

Outside the authorized One-shot exception, wait for the user to confirm, correct, or add to the research before proceeding. This synthesis feeds directly into the "Problems I will solve" section.

---

## Step 4 — Keyword extraction

Extract the top 8-10 exact phrases the company uses in the JD. Separate into two groups:

**ATS-critical** — exact terms likely scanned by automated systems:
- Role-specific titles, tool names, methodology names

**Human trust signals** — language that shows you read the actual posting:
- Action verbs the company uses ("own", "drive", "define")
- Product/domain nouns as the company names them
- Outcome language ("business impact", "time to insight")
- Team framing ("embedded in", "partner with")

Present to the user:

```text
Keywords I'll mirror from the JD:

ATS-critical:
  • [keyword]
  • [keyword]

Language signals:
  • [phrase]
  • [phrase]

Anything missing or wrong? I'll use this list when drafting.
```

Outside the authorized One-shot exception, wait for confirmation or corrections before proceeding. In One-shot, persist the selected phrases in the role's quality evidence and continue.

**Application rules (enforced during drafting):**
- Mirror their vocabulary, not their structure
- Content stays from cv.md — only vocabulary shifts
- Fit naturally or don't use — if a keyword can't be woven in, flag it post-generation
- Apply to: opening, profile intro, achievements (vocabulary only), problems section
- Do NOT apply to: why-this-role angle (user's own words), closing
- Use each keyword once — never repeat for density

---

## Step 5 — Gap detection and conversation

Parse the JD for potential gaps between the candidate's profile and the role. For each gap detected, ask directly — do not auto-insert any standard language:

```text
I spotted potential gaps between your profile and this JD:

[Gap: domain mismatch]
The JD is in {JD domain} — your background is in {primary_domain}.
→ How do you want to handle this?
  a) Address it directly and briefly in the letter
  b) Don't mention it — let the application speak for itself
  c) Tell me your angle and I'll write it your way

[Gap: immediate start]
The JD asks for an immediate start. Your profile shows a {notice_period_days}-day notice period.
→ Confirm your actual notice period — I'll state it precisely.

[Gap: language requirement]
The JD requires {language} at {level}. Where are you with {language}?
→ Tell me your actual level and I'll reflect it accurately. Check your profile.yml
  language_learning section for what's already recorded.

[Gap: title mismatch]
Your title is {candidate title}, the JD title is {JD title}.
→ Do you want to address this? Or let the scope speak for itself?
```

Only prompt for gaps that are actually present. If there are no gaps, skip this step and say so. In an authorized One-shot run, do not prompt: omit unsupported gap claims, choose only source-supported framing, and record each omission/decision for the final combined review.

Outside the authorized One-shot exception, wait for the user's answers. In One-shot, write only what the approved sources support and persist the decision evidence.

---

## Step 6 — Four prompts (mandatory before drafting)

In the ordinary interactive flow, all four candidate answers are required before drafting.
The only bypass is the authorized One-shot exception above: the capable interactive agent
must derive and persist all four decisions from the JD, research, and approved candidate
sources before drafting. "Just generate it", batch/headless execution, or generic defaults
do not create a One-shot authorization.

```text
Before I write the letter, I need four things:

**A. Why this role / company?**
Here are angles I spotted — pick 1-2 or write your own:
  1. {Scale signal from JD}
  2. {Tech ambition signal from JD}
  3. {Domain/mission signal from JD opening}
  4. {Growth or stage signal — e.g. Series B, pre-IPO, category-defining}
  5. {Strategic learning — specific gap this role fills for you}
  6. Other — write your own angle

**B. What problem would you solve for them?**
Based on my research: {confirmed synthesis from Step 3}.
Does this match what you want to address? Refine or confirm.

**C. How would you approach it?**
In 1-2 sentences: what's your opening move if you join on day one?
(This is the most differentiated part of the letter — make it specific.)

**D. Tone?**
  1. Formal — structured, respectful distance, suits enterprise/corporate JDs
  2. Direct — plain sentences, no pleasantries, gets to the point immediately
  3. Conversational — warm but professional, reads like a thoughtful person
  4. Mirror the JD — I'll match whatever register the company used
```

Outside the authorized One-shot exception, wait for all four answers before proceeding to Step 7. In One-shot, verify that all four agent-derived decisions were persisted before continuing.

---

## Step 7 — Achievement selection (from approved evidence only)

Select 4-5 supported achievements from `cv.md` and, when present,
`article-digest.md`:
1. Read the achievement evidence in both approved sources; when they describe the
   same proof point, prefer the digest's more detailed supported version
2. Score each against the JD's top 3-4 required competencies
3. Pick the 4-5 highest-scoring, with at least one metric per bullet
4. Preserve every factual detail and metric from its source. Tighten wording for the
   letter only when meaning is unchanged; never combine unrelated proof points,
   invent a metric, or imply unsupported authorship
5. Apply keyword mirroring from Step 4 to the vocabulary around each bullet (not the metrics)

Format: `**Bold lead phrase,** one sentence of impact with metric.`

---

## Step 8 — Draft the letter in chat (mandatory before PDF)

Write the full letter as plain text in the chat. Follow this structure:

```text
[Candidate Name]
[Location] | [Email] | [Phone if available] | [LinkedIn if available]
[Credentials line if available]

Cover Letter: [Role Title]
[Company], [City]   [Date]

────────────────────────────────────────────────

[Salutation — REQUIRED]
Every letter opens with a salutation. Walk the fallback ladder; never omit it:
  1. A named hiring contact you actually know    → "Dear Jane Smith,"
  2. Otherwise, the company's hiring team        → "Dear {Company} Hiring Team,"
  3. Otherwise, a generic salutation             → "Dear Hiring Manager,"
Never invent a name to reach rung 1. `cover-quality.mjs` → `resolveGreeting()`
returns the exact string for the configured locale, and localized modes supply
native equivalents (German "Sehr geehrte Damen und Herren,", Japanese "ご担当者様",
and so on). Configure with `cover.greeting_required` / `cover.greeting_strategy`.

[Opening — 2 sentences]
Why applying + functional summary. Derived from Angle A. Uses JD mirror vocabulary.

[Profile introduction — 1 paragraph]
Years of experience, current/most recent role, domain. Read from cv.md summary.
Tone matches user's choice from Step 6D.

[Achievements — 4-5 bullets]
• **Lead phrase,** impact sentence with metric.
• **Lead phrase,** impact sentence with metric.
• **Lead phrase,** impact sentence with metric.
• **Lead phrase,** impact sentence with metric.

[Problems I will solve — 2-3 sentences]
Derived from: confirmed research (Step 3) + Angle B + Angle C.
Specific to this company's actual situation. Not generic.

[Closing — 1-2 sentences]
Availability + any gap acknowledgments the user chose to include (Step 5).

[Language closing — if applicable]
Only if user confirmed inclusion in Step 5. Written in that language. Italic in PDF.

[Sign-off — REQUIRED]
A sign-off line then the candidate's name, e.g.
  Kind regards,
  Neil Shekhar
Locale-aware: `cover-quality.mjs` → `resolveSignoff()` supplies the right form
("Mit freundlichen Grüßen,", "Cordialement,", "敬具", …). Rendered from the same
`signoff` / `signature_name` payload fields in Markdown, HTML/PDF, and DOCX.
```

End the draft with: "How does this read? Once you approve I'll generate the PDF."

**Outside an authorized One-shot run, do NOT generate any PDF until the user explicitly approves.** Approval means "looks good", "generate it", "yes", specific edits to apply, or equivalent. A question or silence is not approval. In One-shot, generate all validated formats before the final combined review; the candidate still reviews them before final job submission.

---

## Language rules (enforced in every sentence)

1. **Active voice only** — never "was delivered", "has been built", "were led"
2. **No abbreviations unless JD used them first** — write the full term on first use with abbreviation in brackets. After that, abbreviation is fine.
3. **No em dashes** — replace with a comma, full stop, or rewrite the sentence
4. **No buzzwords** — the canonical list is the machine-readable block in
   `voice-dna.md` (between `career-ops:banned-terms:begin/end`), enforced
   deterministically by `cover-quality.mjs`. It includes the cover-specific bans
   spearheaded, championed, orchestrated, passionate, excited, stakeholder
   alignment, actionable insights, move the needle, north star, unique
   opportunity, perfect fit, and strong track record. Per-user exceptions go in
   `application_quality.banned_terms_allow` / `banned_terms_add`, never by
   editing the shared list.
5. **No filler openers** — never "I am pleased to", "I am writing to express", "I am excited to"
6. **Concrete over abstract** — every claim needs a number, system name, or specific outcome. "Improved performance" is banned. "Cut latency from 2s to 380ms" is fine.
7. **Target 350-420 words** for the body (header + credentials not counted).
   The shared release guard accepts 250-500 by default so localized or unusually
   technical letters are not rejected mechanically; `application_quality`
   controls that hard range.
8. **Bullet format** — `**Bold lead phrase,** impact sentence with metric.` No em dash between lead and sentence.
9. **Self-check** — before finalising, re-read each sentence: could it appear in any cover letter for any company? If yes, rewrite it.
10. **Tone consistency** — apply the chosen tone (Step 6D) uniformly. Don't shift register mid-letter.

---

## Step 9 — Render the approved letter (all formats)

Only after explicit user approval, or after the authorized One-shot decision/evidence record and all quality gates pass.

The approved letter is authored once and rendered many ways. The **JSON payload is
the single source of truth**; every format is derived from it, so there is no
duplicated writing logic:

- **Polished PDF** (`generate-cover-letter.mjs` template) — the *human* format:
  direct email, hiring managers, applications where presentation matters.
- **DOCX** — the *machine* format: most reliable ATS parsing. Researched default
  for any portal upload field that accepts Word (DOCX out-parses PDF on Workday,
  Greenhouse, Lever, iCIMS and especially Taleo). Many AU government / university
  portals require it.
- **Markdown** — the canonical editable copy and the paste-ready version for
  rich-text boxes (CKEditor on ELMO, Seek "paste cover letter" fields). Not a
  file upload. Editing the `.md` by hand means re-rendering, not parsing it back
  into a payload.

Assemble the JSON payload:

```json
{
  "candidate": {
    "name": "{from profile.yml}",
    "email": "{from profile.yml}",
    "phone": "{from profile.yml, omit if empty}",
    "location": "{from profile.yml}",
    "linkedin": "{from profile.yml, omit if empty}",
    "github": "{from profile.yml, omit if empty}",
    "credentials": ["{degree}", "{MBA}", "{cert}"]
  },
  "letter": {
    "role_title": "{exact from JD}",
    "company": "{company name}",
    "city": "{JD city}",
    "date": "{YYYY-MM-DD}",
    "locale": "{BCP-47/ISO language code for this letter, e.g. en, de, ja}",
    "greeting": "{REQUIRED salutation from the fallback ladder, e.g. 'Dear Jane Smith,' or 'Dear Acme Hiring Team,' or 'Dear Hiring Manager,'}",
    "hiring_contact_name": "{named contact if genuinely known, else omit — never invented}",
    "opening": "{approved opening paragraph}",
    "profile_intro": "{approved profile intro}",
    "achievements": [
      {"lead": "...", "impact": "..."}
    ],
    "problems_section": "{approved problems paragraph}",
    "closing": "{approved closing}",
    "language_closing": "{approved language sentence or null}",
    "signoff": "{REQUIRED sign-off for the locale, e.g. 'Kind regards,'}",
    "signature_name": "{candidate name from profile.yml}"
  },
  "output_path": "output/{company-slug}-{role-slug}-cover.pdf"
}
```

Write payload to `/tmp/cover-payload-{company-slug}.json`.

Render all formats from that one payload:
```bash
node generate-cover-formats.mjs --payload /tmp/cover-payload-{company-slug}.json
```

This writes, next to each other under `output/`:
- `{company-slug}-{role-slug}-cover.payload.json` — canonical source (re-renderable)
- `{company-slug}-{role-slug}-cover.md` — markdown / paste copy
- `{company-slug}-{role-slug}-cover.pdf` — polished PDF (human format)
- `{company-slug}-{role-slug}-cover.docx` — Word (machine/ATS format; skipped with
  a warning if `pandoc` is not installed)

To render a subset, pass `--formats md,pdf,docx`. To render only the polished PDF
(legacy behavior) you may still call `node generate-cover-letter.mjs --payload ...`.

Report which formats were written and their file sizes. If DOCX was skipped because
pandoc is absent, say so and note that the polished PDF still covers uploads.

**Format selection at apply time is automatic.** When a role is later filled by the
active-agent apply layer, the agent reads the live field's accepted types and portal
host and picks the right rendering via `chooseCoverFormat()` (DOCX for parser-facing
portal uploads, polished PDF for PDF-only fields and direct/human channels). Record
the rendered paths on the queue role as:

```json
"cover_letter_paths": {
  "pdf":  "output/{company-slug}-{role-slug}-cover.pdf",
  "docx": "output/{company-slug}-{role-slug}-cover.docx",
  "md":   "output/{company-slug}-{role-slug}-cover.md"
}
```

(`cover_letter_path` remains supported as the polished-PDF fallback.)

---

## Step 10 — Post-generation note

After the PDF is confirmed, add a brief note:

- Any JD keywords from Step 4 that could not be incorporated naturally (flag for manual review)
- Which gap acknowledgments were included and which were omitted, and why
- Whether the word count hit the 350-420 authoring target (and whether it remains
  inside the configured hard release range)

---

## Slug mode specifics

When invoked as `/career-ops cover {slug}`:

1. Find the matching report in `reports/` by slug
2. Load its JD, A-G findings, keywords, and Block E customization plan. A legacy
   `## Cover Letter Draft` may seed wording, but evaluation no longer creates one.
3. Run the ordinary interactive steps or the authorized One-shot exception, as applicable.
4. When presenting the draft in Step 8, show the source-backed choices and what changed
   from any legacy seed.
5. Persist the canonical cover payload and rendered paths through the normal cover/queue
   asset flow; do not add application prose to an evaluation report merely to satisfy
   slug mode.
