# career-ops

One-command installer for [**career-ops**](https://github.com/neilshekhar/career-ops) — the AI-powered job search pipeline built on Claude Code.

```bash
npx @neilshekhar/career-ops init
```

This sets up a ready-to-use workspace:

1. Clones career-ops at the latest stable release
2. Installs dependencies

Then open your AI coding tool in the folder. **On first launch the agent walks you through setup — your CV, profile and target roles — just by chatting.** Nothing to configure by hand. Keep the local kanban dashboard open with `npm run launch`; it is the main review UI for deciding what to prepare, fill, and submit. career-ops is AI-agnostic — Claude Code, Gemini, Codex, Qwen, OpenCode, GitHub Copilot CLI, Antigravity CLI, and Grok Build CLI all work.

The installer bootstraps CLI skill entrypoints after clone, so new CLIs (e.g. Grok) work even when `npx` pulled an older release tag.

## Usage

```bash
npx @neilshekhar/career-ops init [folder]   # default folder: ./career-ops
```

Prefer the manual route? `git clone` still works exactly as before — see the [setup guide](https://github.com/neilshekhar/career-ops/blob/main/docs/SETUP.md).

## Requirements

- Node.js 18+
- git

## License

MIT. Originally created by [Santiago Fernández de Valderrama](https://santifer.io); this installer publishes the [neilshekhar/career-ops](https://github.com/neilshekhar/career-ops) fork.
