# Mode: reply-watch — Classify Replies & Reconcile Tracker

Classify employer replies and generate an action digest to reconcile the application tracker. This workflow separates real application progress (e.g. interviews, offers, rejections) from recruiting noise and marketing alerts, and recommends tracker status updates.

Local-first, human-in-the-loop: **nothing here auto-updates without user confirmation.** Recommended status updates are displayed as recommendations and require explicit user approval before modifying the tracker. After approval, `reply-watch.mjs` must delegate each exact row-number transition to `set-status.mjs --external --note ...`; it never rewrites `data/applications.md` itself.

## Purpose

- Classify reply candidates into candidate-facing categories (`Interview`, `Responded`, `Need Action`, `Rejected`, `Offer`, `Auto-confirmation`, `Noise`, `Unknown`).
- Match candidates to active tracker rows in `data/applications.md` based on company names, role titles, and domain matching.
- Generate a concise review digest highlighting updates, signals, and evidence.
- Prompt for human-in-the-loop tracker status updates.

## Inputs

- `data/reply-candidates.json` — Normalized reply candidates (subject, body, sender, signal)
- `data/applications.md` — Application tracker (source of truth)
- `data/follow-ups.md` — Follow-up history (for contact matching)

## Invocation

Run the reply-watch command:

```bash
node reply-watch.mjs
```

Or pass a custom candidates file path:

```bash
node reply-watch.mjs path/to/candidates.json
```

Suggestion-only / non-interactive preview:

```bash
node reply-watch.mjs path/to/candidates.json --dry-run
```

## Step 1 — Review the Digest

The script will analyze candidate replies and output a structured digest:

```text
Today: 3 application updates need review

1. 杭州赢云贸易有限公司 — PY01_python开发工程师
   Type: Interview
   Signal: resume passed + AI WeChat mini-program interview
   Evidence: 简历通过; 邀您面试; AI微信小程序面试
   Suggested tracker update: Interview

2. Example Labs — Full-stack Engineer
   Type: Rejected
   Evidence: 很遗憾; 暂不匹配
   Suggested tracker update: Rejected

3. Zhaopin job alert
   Type: Noise
   Evidence: 邀请投递; 立即投递
   Suggested tracker update: none
```

## Step 2 — Confirm Tracker Updates

If the script identifies recommended updates (e.g. `Applied` → `Interview`), it lists the changes and prompts for confirmation:

```text
Suggested status updates to apply:
  #2 Example Labs (Full-stack Engineer): Applied → Rejected

Apply recommended status updates through set-status.mjs? (y/N):
```

Type `y` or `yes` to apply the changes. For each confirmed recommendation, the script invokes the canonical locked tracker writer with the exact numeric row selector, `--external`, and a reply-evidence `--note`. It never hand-edits the Markdown tracker. After all transitions succeed, it rebuilds the derived SQLite index.
