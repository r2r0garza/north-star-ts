# PR108: Per-round context usage logging

> Status: **PLANNED**. Step 1 (measurement only) of possible in-turn context management for long
> agent runs. Follow-up to `019` (rolling summaries) and `9e424d2` (full-transcript replay until
> summarization). Trimming old tool output and in-turn compaction are deferred until this plan's
> data shows they're needed (see Out of scope).

## Context

Before `9e424d2`, `ContextBuilder` kept only a ~12k-token walk-back of history. Long agent runs
dropped the user's original request and the agent "forgot" its task. That was especially visible
through OpenAI-compatible bridges such as the VS Code LM API bridge. The full transcript is now
replayed until a rolling summary covers it.

What's left: summaries are generated **between** turns (`summarize` task, `afterSeatTurn`). Inside
one turn, the in-memory `messages` array in `runAgentLoop` (`src/main/agent/index.ts`) grows with
every tool round and nothing ever shrinks it. If one turn outgrows the model's context window, the
provider or bridge may silently drop the oldest messages, and the symptom returns. We don't know
whether real runs get close to that limit, because we don't measure it:

- **Usage is read but only summed.** `round.diagnostics.usage` (`parseUsage` in
  `src/main/agent/model-request-retry.ts`) is added into `turnUsage` (index.ts ~2243). The size of
  each individual request, which is what matters for the context window, is never recorded.
- **Usage is probably missing on most streamed OpenAI-style calls.** The chat request
  (index.ts ~2198, `{ messages, tools, stream: true }`) doesn't send
  `stream_options: { include_usage: true }`. Native OpenAI and most compatible servers only emit a
  usage chunk on streams when that flag is set.
- **The local counter is a rough estimate.** `token-counter.ts` is chars/4. It's fine for
  budgeting but poor for calibration, especially on code and JSON tool output.
- **We have no context-window metadata** for any model, so "how close are we" can't be computed
  yet. This plan records absolute sizes. A limit can be added once we know which models matter.

## Goal

For every model round of every agent turn, record:

1. **Outgoing (the request):** the size of the prompt we sent, with a breakdown by role, so we can
   see whether growth is tool output, assistant reasoning, or the system block.
2. **Incoming (the response):** the size of what the model returned (text + tool calls).
3. **Source of each number:** provider-reported where available, otherwise a local
   `gpt-tokenizer` count, and flagged as such.

The answer we want afterward: do long runs approach their model's window, and if so, how much of
the prompt is old tool output?

## Proposed shape

### Where each number comes from

| Measure | Primary source | Fallback |
| --- | --- | --- |
| Request size | `usage.prompt_tokens` from the response | Local count of `messages` + `tools` just before sending |
| Response size | `usage.completion_tokens` | Local count of the reassembled text + tool-call names/arguments |
| Per-role breakdown | Always local (providers don't break it down) | — |

`prompt_tokens` describes the outgoing request but only arrives with the response. So we always
compute the local count of the request **before** sending: it's needed for the per-role breakdown
anyway, and when a request fails, hangs, or is retried, the local count is all we have. When
usage arrives, we log both and their ratio. That calibrates the local counter per provider/model
for free.

### Request usage reporting

- Send `stream_options: { include_usage: true }` on streamed chat requests for `openai`,
  `openai_compatible`, and `portkey`.
- Some bridges reject unknown parameters. If a request fails with a 400 that names
  `stream_options`, retry once without it and remember that per provider account for the session
  (in-memory map, no new column). Never let usage reporting fail a turn.
- The usage chunk arrives after the last content chunk with an empty `choices` array. Confirm the
  stream reader and `accumulateToolCalls` (`tool-stream.ts`) tolerate that, and that `parseUsage`
  still picks it up.
- CLI providers (Claude Code, Codex) and `codex-subscription` already report usage their own way.
  Log whatever they give and skip the local breakdown if we never see their message array.

### Local counting

- Add `gpt-tokenizer` (pure TS, no WASM, works in the Electron main process). Use `o200k_base`
  for everything. It's exact for current OpenAI models and an estimate for others (Claude,
  Gemini, DeepSeek). The log records `estimator: "o200k"` so nobody mistakes it for exact.
- New `src/main/agent/context/request-size.ts` (pure, Electron-free, unit-tested):
  - `measureRequest(messages, tools) → { total, byRole: { system, user, assistant, tool }, toolDefs, largestMessage: { role, toolName?, tokens } }`
  - `measureResponse(text, toolCalls) → number`
  - Per-message overhead of 4 tokens and a flat allowance for tool definitions (serialized JSON),
    documented as approximate.
- **Leave `defaultTokenCounter` (chars/4) alone.** It feeds `messages.token_estimate` and the
  summarize thresholds. Swapping it changes summarization behavior and belongs in its own change,
  ideally after this data shows how far off chars/4 is.
- Cost: `o200k` encoding of a large prompt every round is not free. Count each message once and
  cache by object identity in a `WeakMap`, because `messages` is append-only within a turn (apart
  from the user-message rewrite at build time). A round then only encodes what's new.

### What gets logged

One JSON line per completed or failed round, appended to
`app.getPath("userData")/logs/context-usage.jsonl`:

```json
{
  "at": "2026-10-02T18:04:11.201Z",
  "conversationId": "…", "turnStartSeq": 412, "round": 17, "attempt": 1,
  "provider": "openai_compatible", "model": "copilot/gpt-5",
  "mode": "north_star", "seat": "work",
  "request": {
    "reported": 48211, "estimated": 46030, "estimator": "o200k",
    "byRole": { "system": 6120, "user": 310, "assistant": 4402, "tool": 34198 },
    "toolDefs": 1000, "messageCount": 39,
    "largest": { "role": "tool", "toolName": "read_file", "tokens": 9120 }
  },
  "response": { "reported": 812, "estimated": 790, "finishReason": "tool_calls" },
  "outcome": "ok"
}
```

- `reported` is `null` when the provider sent no usage; `outcome` is `ok | retry | stalled | truncated | error | aborted`.
- Also log one short line to the console per round (`[ctx] round 17 · 48.2k in (reported) · 0.8k out`)
  so it shows up while running `pnpm dev`.
- The file is always on (it holds no message content, only counts, IDs, and tool names). Rotate
  at 10 MB: rename to `context-usage.1.jsonl` and start a new file, keeping one old file.
- No IPC, preload, or renderer changes. A UI meter is a possible later step.

## Files touched

| File | Change |
| --- | --- |
| `package.json` | Add `gpt-tokenizer` |
| `src/main/agent/context/request-size.ts` (new) | `measureRequest`, `measureResponse`, per-message cache |
| `src/main/agent/context/usage-log.ts` (new) | JSONL append + rotation; best-effort, never throws into a turn |
| `src/main/agent/index.ts` | Measure before each request; log after each round, including retry/stall/truncation paths |
| `src/main/agent/model-request-retry.ts` | `include_usage` flag; `stream_options` 400 detection + per-account fallback |
| `src/main/agent/tool-stream.ts` | Only if the trailing usage chunk with empty `choices` trips reassembly |

## Tests

- `measureRequest`:
  - the role breakdown sums to the total (minus overhead and tool definitions, which are reported
    separately)
  - `largest` names the tool for tool messages
  - counts are stable under repeated calls (cache hit)
  - assistant tool-call arguments are counted
- `measureResponse`: text plus tool-call arguments; empty response gives 0.
- Usage log:
  - writes one valid JSON line per call
  - rotates at the size cap and keeps one old file
  - a write failure is swallowed
- Agent loop (existing `tool-error-feedback.integration.test.ts` style):
  - a stream with a trailing usage chunk logs `reported`
  - a stream without usage logs `reported: null` with an estimate
  - a stalled/retried round logs its own line with the matching `outcome`
  - a provider that 400s on `stream_options` is retried without it once and the turn succeeds
- Request shape: streamed requests include `stream_options.include_usage` unless the account is
  flagged.

## Out of scope

- **Trimming old tool output** once the request passes a threshold: replace older tool results
  with a short stub (tool name, args, original size, "re-run if needed"), keep the newest N
  intact, never touch the turn's user request, and keep tool calls paired with their results.
  Plan only if this log shows tool output dominating large requests.
- **In-turn summarization** (a model call mid-turn). Plan only if runs still approach the limit
  after trimming.
- **Context-window metadata** per model (from the provider's model list or a manual setting).
  Needed for any threshold, not for measuring.
- Replacing `defaultTokenCounter` with `gpt-tokenizer` app-wide.
- A context meter in the UI.

## Open questions

1. **Bridge behavior.** Does the VS Code LM API bridge accept `stream_options`, and does it report
   usage at all? Test against it first. If it reports nothing, the local estimate is the only
   signal there, and the calibration ratio from other providers tells us how far to trust it.
2. **Where long runs live.** Is the data more useful aggregated per seat/user story (mission
   control) than per conversation? The log carries both IDs, so this can be decided at analysis
   time.
3. **Retention.** Is 10 MB with one rotated file enough to catch a few multi-hour runs? Each line
   is ~0.5 KB, so 10 MB is ~20k rounds. Likely fine.
