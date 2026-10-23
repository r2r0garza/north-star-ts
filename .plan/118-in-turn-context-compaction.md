# PR118: In-turn context compaction

> Status: **Implemented (2026-10-22). Verified live in North Star mode on Codex subscription (`gpt-6-luna`, both tiers) and Anthropic API (`claude-haiku-5-5`, server-side clearing). Pending: a workflow step on Codex. Google API not verified live (free-tier quota); its tier 2 rebuild is covered only by contract tests.** Tier 1 is client-side for chat-completions accounts and Codex, server-side context editing for Anthropic (tier 2 there is judged by the provider-reported input size), and off for Google. A tier 2 rebuild carries the latest, not-yet-seen round (clipped to fit), so the agent never re-runs tools whose results were summarized away. Compaction, including Anthropic's server-side clears, shows as a live "Context compacted" Trace line and in `context-usage.jsonl`; no persisted transcript divider. The work ledger is built from the turn's stored tool-call/result messages rather than `tool_call_lifecycle` (same records, simpler query).

## Objective and recommendation

Keep a single long agent turn's request bounded, without losing the instructions or the unfinished work the agent needs to finish correctly. Today nothing shrinks the in-memory request between model rounds of one turn, so an autonomous step that runs hundreds of rounds replays its whole history on every request.

Compact at the model-round boundary in two tiers:

1. **Clear old tool results** (deterministic, no LLM call): replace the bodies of older tool results in the in-memory request with short stubs.
2. **Summarize and rebuild** (fallback): when tier 1 cannot get under the limit, fold the turn into a work-state summary and rebuild the request from it, with instructions pinned verbatim and a work ledger built from tool records.

Both tiers change only the request sent to the model. The persisted transcript stays complete and unchanged.

Saving tokens must not bring back the requirement loss seen in DefectLab. Instructions are never summarized, and unfinished work never rests on the summary alone.

## Evidence and current seams

The Processes prod run of "Feature Implementation" for PR115 (step conversation `80a4a34f…`, model `gpt-6-luna`) logged in `logs/context-usage.jsonl`:

- 505 model requests in one Implementation step; estimated request size grew from 14k to 325k tokens across 1,020 messages.
- About 93M estimated input tokens in total for that step.
- At the peak, tool results were 248k of 325k tokens (76%); assistant messages, mostly tool-call arguments, were 57k; the system prompt was under 5k.

Code seams:

- `src/main/agent/index.ts` — `runAgentLoop` builds `messages` once via `contextBuilder.build(...)` at turn start, then only pushes to it. The `while (true)` round loop already measures each request (`measureRequest(messages, tools)`) before the model call; that is the compaction point.
- Context sections (todos, task state, approvals, summary) are assembled once at turn start (`const sections: ContextSection[]`), so the todo list in the system prompt goes stale during a long turn.
- `src/main/agent/context/context-builder.ts` replays the complete stored transcript until a summary exists, then the summary plus the uncovered tail. Its `tokenBudget` only trims droppable sections, never history.
- `src/main/summaries/service.ts` summarizes between turns only: the chat IPC handler calls `maybeSummarize` after a turn, and workflow steps await `summarizeIfDue` before resume, continuation and correction turns.
- `runAgentLoop` has eight callers (chat, task runner, workflow worker, validator and correction, subagents), so the hook must live inside the loop, not at each caller.
- **Context overflow is not handled.** Adapters that surface overflow as an HTTP 4xx fail the turn with a raw provider message, because `isTransientError` classifies 4xx as deterministic.
- **An overflow reported as `finish_reason: "length"` is resent unchanged.** The round loop treats `length` as output-cap truncation and re-issues the same input with a higher output cap (`OUTPUT_TOKEN_STEPS`, up to two more attempts), which cannot succeed. `claude-subscription/client.ts` does exactly this for `model_context_window_exceeded`. That adapter is out of scope here (see Provider adapters), but the loop must not rely on adapters to avoid it.

## What compaction must never lose

Two categories survive every compaction verbatim. They are pinned, not summarized.

**Instructions:**

- the turn's opening request: the user's message, or the workflow step prompt, including the overall objective and the current step's instructions;
- active user steering: workflow retry feedback and every steering message or note delivered during the turn;
- outstanding validator findings: the correction message of a validator rejection that has not been resolved;
- the protected tool results listed under tier 1.

**Work state (the work ledger):** built deterministically from tool records, not from the summarizer.

- files modified during the turn, from write/edit/patch tool calls and their outcomes;
- the latest result of each verification command or diagnostics target (tests, typecheck, lint), with pass/fail and a bounded excerpt of failures;
- open todo items (pending and in progress), from the todo store.

Rules:

- Tier 1 only ever touches tool-result messages. User and system messages are never cleared.
- Tier 2 rebuilds the request with the pinned instructions and the ledger in a dedicated continuation message, in addition to the summary.
- If the pinned instructions plus the ledger alone exceed the budget, do not drop any of it. Fail the turn with a clear error instead.

## Tier 1: clear old tool results

At the start of each round, after steering and notes are delivered and before `measureRequest`, if the estimated request exceeds the **high watermark**:

- Walk the in-memory messages oldest first, skipping the most recent rounds (keep at least the last few rounds, or a token budget's worth, verbatim).
- Replace each older tool result's content with a stub such as `[Earlier result cleared to save context: read_file_tool src/x.ts, ~9.7k tokens. Re-run the tool if you need it.]`. Keep `tool_call_id` pairing and the assistant `tool_calls` intact.
- Clear down to the **low watermark** in one pass, so the request prefix changes rarely; every change invalidates provider prompt caches.
- Drop replayed tool images for cleared results too.
- Never clear results whose content is instructions or current state rather than evidence: `read_skill`, plan approval outcomes, and the latest result of each verification command (the ledger's source). Already-stubbed results are skipped, so the pass is idempotent.

Implement as a pure function in `src/main/agent/context/` (for example `clearOldToolResults(messages, { target, keepRecent, keep })`) with unit tests, then call it from the round loop.

## Tier 2: summarize and rebuild

If the request is still above the high watermark after tier 1 (long reasoning, large write/edit arguments), compact the turn:

- **Preconditions:** no tool call in flight and every result from the previous round persisted. Verify the order of `appendMessage` against `messages.push` for tool results and steering before relying on it.
- **Summarize:** call an injected compactor that forces a work-state summary through the latest persisted seq, ignoring the between-turn thresholds. Reuse the batched `summarize` path and `WORK_STATE_SYSTEM_PROMPT` from `SummaryService`. Strengthen that prompt: every unresolved task, failing check, known defect and modified file in the turns must appear in Done, Verification or Remaining. Never condense them into status words such as "mostly complete".
- **Rebuild:** replace `messages` in place with `contextBuilder.build(conversationId, …)` using freshly assembled sections, so the todo list and summary are current. The summary covers the whole transcript, so the uncovered tail is empty.
- **Continue:** append one in-memory, unpersisted user message containing, in order:
  - the pinned instructions, verbatim;
  - the work ledger;
  - "Earlier work in this turn is summarized above. The ledger is authoritative where the summary disagrees. Continue from Remaining."

  Many providers reject a request with no user message, so this message also keeps the request well-formed.
- **Failure:** if summarizing fails, log it, continue uncompacted, and do not retry until the request has grown by a meaningful margin. If the request is still over the hard limit, end the turn with the context-overflow error below rather than sending it.

Refactor section assembly into a function the loop can call again mid-turn; today it is inline at the top of `runAgentLoop`.

## Context limits and overflow

A configurable threshold is not the provider's real context limit. A model with a smaller window can overflow before the threshold is reached. PR118 does not build a model-capability catalog. Instead:

- **Conservative default:** ship a high watermark well below the smallest context window among supported default models, for example around 120k tokens. The low watermark is derived from it (for example half), and `0` disables compaction.
- **Use the real window where known:** PR122 and PR123 record each model's input-token limit from the provider's model list (`contextWindowFor`). When it is known, the effective high watermark is the lower of the setting and a safe fraction of that window. This needs no separate capability database.
- **A distinct overflow error per in-scope adapter:** recognize context overflow as its own deterministic error, and never report it as `length`.
  - Anthropic API: an oversized request is rejected as an invalid request, and a response can also stop because the context window filled. Both map to overflow.
  - Google API: recognize its token-limit rejection.
  - Codex subscription (`response.incomplete` details) and Portkey: recognize the provider's overflow code or message.
  - Confirm each provider's exact codes and messages while building or auditing the adapter.
- **Loop guard:** the round loop raises the output cap only for a genuine output-limit stop. It never re-issues a request whose input already exceeded the window, whatever the adapter reports.
- **Never resend unchanged:** on an overflow error, compact once (tier 1, then tier 2) and retry only if the request actually shrank. Otherwise fail the turn with a clear, non-retryable message naming the estimated request size and the threshold, and suggesting a lower threshold or a larger-context model.
- **No outer retry either:** the task runner and workflow runner must not retry or auto-continue an overflow failure. The workflow `unfinished` continuation only follows a valid handoff, so it does not apply.

## Provider adapters

Keeping IDs intact is necessary but not sufficient: each adapter converts the shared message list into its own wire format with its own rules. Gate compaction per adapter. Enable it only for adapters with passing contract tests, and leave the rest uncompacted, failing clearly on overflow.

Adapters to cover:

- **Chat-completions accounts** (Portkey, `openai`, `openai_compatible`) — OpenAI-style `tool_calls` and `tool` messages. (The generic `responses` API mode is rejected by `createCompletion` today, so it is not covered.)
- **Codex subscription** (`codex_responses` bridge) — function calls and their outputs keyed by `call_id`.
- **Anthropic API** ([PR122](122-anthropic-api-provider.md)) — current Claude models bind thinking-block signatures to the conversation prefix (`system`, the tool set and every earlier message). Rewriting an old tool result client-side invalidates every later thinking block, and on enforced accounts that is a 400. So:
  - **tier 1 uses server-side context editing** (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`), not client-side stubs. Server-side clearing is not counted as an edit. Set its trigger high and its minimum clear (`clear_at_least`) large, because every clear rewrites the cached prefix;
  - tier 2's rebuild drops prior thinking by design and must start a fresh user turn;
  - tool results must still match the preceding `tool_use` IDs.
- **Google API** ([PR123](123-google-api-provider.md)) — function results pair with calls by `call_id` (Interactions API) or by name and position (`generateContent`). Thought steps and signatures must be resent unaltered. Whether client-side edits to earlier function results are accepted is unverified, so tier 1 stays off for Google unless PR123's contract tests prove it safe.
- **Claude subscription** — out of scope. Its transport is due to be reworked separately. It stays uncompacted and must not be enabled until it passes the same contract tests.
- **External CLI agents (`claude_code`, `codex_cli`)** — out of scope. They run their own loop and manage their own context.

Contract tests per adapter:
- serialize tier 1 and tier 2 compacted message lists through the adapter's real request converter;
- assert no orphaned tool results, matching call IDs, and a native-carrier structure the provider accepts;
- assert a request that starts with a user message after the system prompt.

Contract tests for the Anthropic API and Google API adapters are written alongside those providers, so compaction can be enabled for them as soon as they ship. Before any adapter is enabled, the user also checks it live (see Verification).

## Wiring and safety

- Inject the compactor through a module-level registration in `src/main/agent/index.ts`, set once from `src/main/index.ts` with the app's `SummaryService`, so all eight callers get it without threading a new option through each. Do not import `src/main/index.ts` from the agent (cycle); the agent depends only on the registered function's type.
- Add `SummaryService.compactNow(conversationId, signal)`: forced work-state summarize, no threshold check.
- Build the work ledger from `tool_call_lifecycle` and the todo store for the current turn (messages after `turnStartSeq`), not from transcript text.
- **Make summary upserts monotonic:** never store a summary whose `coversThrough` is lower than the stored one. A background `summarize` task started before a turn could otherwise overwrite a newer in-turn compaction with older coverage.
- **Settings:** add the turn compaction threshold next to the existing summarize thresholds.

## Observability

- Log each compaction to `context-usage.jsonl` with tier, request estimate before and after, cleared result count, summary coverage, and the sizes of the pinned instructions and the ledger.
- Log overflow errors with adapter, estimated size and threshold.
- Emit a turn event so Trace activity can show "Context compacted". A transcript divider is optional and can be a later slice.

## Implementation sequence

0. Prerequisites: [PR122](122-anthropic-api-provider.md) and [PR123](123-google-api-provider.md).
1. Distinct context-overflow error for each in-scope adapter, plus the loop guard that never resends an oversized request unchanged. This is useful on its own, before any compaction ships.
2. Monotonic summary upsert, `compactNow`, a strengthened work-state prompt, and tests.
3. `clearOldToolResults` pure function and unit tests; wire tier 1 into the round loop behind the setting and the per-adapter gate.
4. Extract section assembly for mid-turn refresh.
5. Pinned instructions and the work ledger; tier 2 rebuild, injected compactor, continuation message.
6. Per-adapter contract tests; enable adapters that pass.
7. Setting, logging, turn event.
8. Verify against a real long workflow step on each enabled adapter.

## Verification and acceptance

**Major acceptance criterion: no loss of unfinished work or instructions.** Use a fixture turn in which, before compaction:

- the step prompt holds an objective and step instructions;
- the user sent mid-turn steering;
- a validator rejection lists findings;
- three defects are still unresolved;
- one test target is failing;
- several files were modified.

After tier 1 and after tier 2, the request sent to the model must contain each of these:
- the objective, step instructions, steering and validator findings, verbatim;
- every modified file and the failing check's latest result, in the ledger;
- the open todo items.

The summary's Remaining section must name all three defects. That last part is checked with the real summarizer on the recorded fixture, and a summary reading "mostly complete" while defects stay open fails it.

Also:

- Unit: clearing preserves call/result pairing; never touches user or system messages, the protected recent rounds or protected tools; reaches the low watermark in one pass; and is idempotent.
- Unit: a tier 2 rebuild yields system prompt, current summary, fresh todo section and one continuation message with pinned instructions and the ledger, with no orphaned tool results.
- Unit: summary upserts never lower `coversThrough`.
- Unit: when the pinned instructions and the ledger alone exceed the budget, the turn fails clearly rather than dropping them.
- Unit: a context-overflow error from each in-scope adapter is classified as overflow; an overflow never raises the output cap; an oversized request is never resent unchanged; and an overflow failure is not retried by the task runner or the workflow runner.
- Contract: each enabled adapter accepts compacted message lists from both tiers (see Provider adapters).
- Integration with a mocked provider: a scripted turn of 200+ rounds never sends a request above the high watermark, and the persisted transcript is identical to an uncompacted run.
- Real run: re-run a Feature Implementation workflow of similar size. No request in `context-usage.jsonl` may exceed the threshold, total estimated input tokens for the Implementation step must drop well below the 93M baseline, and the Code Review and Acceptance Verification steps must find no requirement dropped because of compaction.
- Manual (user): a long turn on each enabled adapter, with both tiers firing, completes without provider errors.

## Explicit non-goals

- No change to persisted messages, the message schema or transcript rendering.
- No per-model context-window catalog or model-capability database; a conservative default plus clear overflow failure covers this for now.
- No model-callable "compact" tool.
- No compaction for external CLI agents or the Claude subscription provider.
- No fix to the Claude subscription transport; it is being reworked separately.
- No replacement of the between-turn rolling summary; this complements it.

## Open questions

- Exact default high watermark: `gpt-6-luna` over the Codex subscription accepted a 325k-token estimate, but the smallest window among supported default models decides the default.
- Whether interactive chat turns should use the work-state prompt mid-turn, or the conversation prompt.
- Whether tier 1 should also shorten large write/edit tool-call arguments in older assistant messages (57k tokens at the peak above), given the ledger already records which files changed.
- How much prompt-cache cost each provider pays per prefix change, which decides how far below the high watermark tier 1 should clear.
- How to bound a verification command's excerpt in the ledger when its output is very large.
