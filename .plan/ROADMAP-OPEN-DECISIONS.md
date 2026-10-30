# Roadmap — Open decisions

Questions a plan left unanswered. When one is decided, move it to
[ROADMAP-CLOSED-DECISIONS.md](ROADMAP-CLOSED-DECISIONS.md) with the answer and the date.

## From `122` — Anthropic API provider

- **Refusal fallbacks.** Whether to enable server-side refusal fallbacks (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`) for models that support them, and how a fallback should appear in the
  transcript. [Plan](122-anthropic-api-provider.md).
- **Append-only context for every provider.** Whether option B's append-only context assembly (a frozen system
  prompt, with changing context appended as messages) should become the default for every provider, since it also
  improves prompt caching elsewhere. [Plan](122-anthropic-api-provider.md#append-only-history-the-key-design-decision).
- **"Default effort" per model.** Whether "Default effort" should follow each model's own default (`medium` on Opus
  5.5, `high` on Sonnet 5.5) instead of a fixed `high`. [Plan](122-anthropic-api-provider.md).
