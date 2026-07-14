# Model selection and application quality

Career-ops accepts arbitrary model IDs and is compatible with current and future
models from any supported CLI.
Compatibility is deliberately separate from quality: the repository cannot maintain
an authoritative list of every provider's changing model catalogue, and a model name
alone is not proof that it will write a persuasive application.

## Recommended default

Use one balanced, capable model for all semantic work. If automatic effort routing is
available, vary effort by task; if you want one model and one setting, use high effort
throughout. Both approaches avoid manual model switching.

| Task | Model class | Effort | Why |
|---|---|---|---|
| Scan, extract, deduplicate, render, validate | Local scripts | None | These stages should use zero model tokens where possible. |
| Score and rank roles | Current balanced model | Medium | Scoring needs reliable multi-dimensional reasoning because it controls what you review. |
| Normal selected application | Same balanced model | Medium–high | Good tailoring without paying flagship cost for every role. |
| Candidate-marked priority role | Same balanced model | High or maximum | More computation for evidence selection and nuanced positioning, without changing models manually. |

Avoid using a provider's smallest/fastest model for final CVs, cover letters, novel
form answers, or irreversible triage until it has passed representative tests using
your own CV and job descriptions. Small models remain useful for bounded extraction,
classification, and formatting.

## Current examples (July 2026)

- **Codex/OpenAI:** `gpt-5.6-terra` at **high** effort is the conservative one-model,
  one-setting choice for scoring and final applications. With automatic routing,
  medium can score and high can generate final assets. `gpt-5.6-luna` at `xhigh` may
  be useful for provisional high-volume scoring, but higher effort does not make its
  base capability identical to Terra; do not assume it is equivalent for final prose.
  `gpt-5.6-sol` is the flagship option. The bare `gpt-5.6` alias routes to **Sol**, not
  Terra. See the [official GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model.md).
- **Claude:** `claude-sonnet-5` at medium effort for scoring and high effort for final
  application content is the economical single-model starting point. Raise effort
  only for priority roles. Opus 4.8 or Fable 5 are optional capability-first choices,
  not requirements for every application. Anthropic explicitly recommends tuning
  effort within one model before switching models. See [choosing a Claude model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
  and [Claude effort controls](https://platform.claude.com/docs/en/build-with-claude/effort).
- **OpenCode, Qwen, Kimi, Copilot, Antigravity, Grok, local, and other providers:**
  choose the CLI/provider's current balanced or flagship instruction-following model.
  Prefer reliable long-context synthesis and structured-output adherence over model
  size or marketing tier. Record the exact active CLI and model ID in provenance.

Model catalogues change. Treat the named examples as dated starting points and the
task/capability table as the durable policy.

## Configure compatibility or a personal floor

`config/profile.yml` controls only your installation:

```yaml
application_quality:
  require_generation_provenance: true
  allowed_generation_flows: ["interactive-prepare"]

  # Compatible with any current or future CLI/model. Truth, freshness, format,
  # asset hashes, and human-review gates still apply.
  release_model_policy: open
```

Users who want an enforceable personal floor can opt into exact IDs:

```yaml
application_quality:
  release_model_policy: allowlist
  allowed_release_models:
    codex: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"]
    claude: ["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"]

  # Optional provider-neutral effort floor for final assets.
  allowed_release_efforts:
    codex: ["high", "xhigh", "max"]
    claude: ["high", "xhigh", "max"]

  # Optional exact-model exceptions. Unlisted models keep the CLI-wide floor.
  allowed_release_model_efforts:
    codex:
      gpt-5.6: ["medium", "high", "xhigh", "max"]
      gpt-5.6-sol: ["medium", "high", "xhigh", "max"]
    claude:
      claude-opus-4-8: ["medium", "high", "xhigh", "max"]
      claude-fable-5: ["medium", "high", "xhigh", "max"]
```

The allowlists accept arbitrary CLI, model, and effort strings; they are not limited to the
examples above. `"*": ["*"]` explicitly permits every CLI/model while preserving an
allowlist-shaped configuration. Omitting `release_model_policy` preserves backward
compatibility: a non-empty allowlist is strict, while no allowlist is open.
Model-specific effort entries override the CLI-wide effort floor only for the exact
model ID. In the example, medium is accepted for Sol (including its bare alias), Opus,
and Fable; Terra and Sonnet still require high or above. This is a policy example, not
a universal quality guarantee: users should pin models they have validated against
their own CV, voice, and representative job descriptions.

Batch PDF assets are always non-release drafts. `allowed_batch_asset_models` can
optionally restrict which exact model IDs may create those drafts; when omitted, any
explicit model ID is accepted because batch provenance can never pass the final
application release gate.

## What remains model-independent

The executable release gate checks sourced evidence, candidate numbers and named
tools, asset freshness, role/path matching, hashes, formats, length, and configured
model policy. Separately, the workflow requires human review and never auto-submits.
Those controls reduce what review must catch. They do not guarantee identical prose,
identical scores, or excellent persuasion from every model. A true guarantee of
identical output would require deterministic templates and would sacrifice much of
the tailoring that makes a strong application useful.
