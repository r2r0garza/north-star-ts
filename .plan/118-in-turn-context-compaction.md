# PR118: In-turn context compaction

> Status: **Proposed — not implemented.** Follow-up to the between-turn workflow step summaries (`SummaryService.summarizeIfDue`, batched summarizer input, work-state prompt; uncommitted on `experiment/rebuild-orchestration` when this plan was written). Builds on [PR019's rolling summary](019-conversation-summaries.md) and [PR102's summary boundary](102-summary-boundary-admission-integrity.md) (`replacesHistoryThrough`).

## Objective and recommendation

Keep a single long agent turn's request bounded. Today nothing shrinks the in-memory request between model rounds of one turn, so an autonomous step that runs hundreds of rounds replays its whole history on every request.

Compact at the model-round boundary in two tiers:

1. **Clear old tool results** (deterministic, no LLM call): replace the bodies of older tool results in the in-memory request with short stubs.
2. **Summarize and rebuild** (fallback): when tier 1 cannot get under the limit, fold the turn into a work-state summary and rebuild the request from it.

Both tiers change only the request sent to the model. The persisted transcript stays complete and unchanged.

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
- There is no context-overflow handling in the loop. Only the Claude subscription transport recognizes `model_context_window_exceeded`.
- `runAgentLoop` has eight callers (chat, task runner, workflow worker, validator and correction, subagents), so the hook must live inside the loop, not at each caller.

## Tier 1: clear old tool results

At the start of each round, after steering and notes are delivered and before `measureRequest`, if the estimated request exceeds the **high watermark**:

- Walk the in-memory messages oldest first, skipping the most recent rounds (keep at least the last few rounds, or a token budget's worth, verbatim).
- Replace each older tool result's content with a stub such as `[Earlier result cleared to save context: read_file_tool src/x.ts, ~9.7k tokens. Re-run the tool if you need it.]`. Keep `tool_call_id` pairing and the assistant `tool_calls` intact.
- Clear down to the **low watermark** in one pass, so the request prefix changes rarely; every change invalidates provider prompt caches.
- Drop replayed tool images for cleared results too.
- Never clear results from a small allowlist whose content is instructions rather than evidence (for example `read_skill`, plan approval outcomes). Already-stubbed results are skipped, so the pass is idempotent.

Implement as a pure function in `src/main/agent/context/` (for example `clearOldToolResults(messages, { target, keepRecent, keep })`) with unit tests, then call it from the round loop.

## Tier 2: summarize and rebuild

If the request is still above the high watermark after tier 1 (long reasoning, large write/edit arguments), compact the turn:

- **Preconditions:** no tool call in flight and every result from the previous round persisted. Verify the order of `appendMessage` against `messages.push` for tool results and steering before relying on it.
- **Summarize:** call an injected compactor that forces a work-state summary through the latest persisted seq, ignoring the between-turn thresholds. Reuse the batched `summarize` path and `WORK_STATE_SYSTEM_PROMPT` from `SummaryService`.
- **Rebuild:** replace `messages` in place with `contextBuilder.build(conversationId, …)` using freshly assembled sections, so the todo list and summary are current. The summary covers the whole transcript, so the uncovered tail is empty.
- **Continue:** append an in-memory, unpersisted user message containing the turn's opening request (the user's message, or the workflow step or resume prompt) plus "Earlier work in this turn is summarized above; continue from Remaining." Many providers reject a request with no user message, and the opening request must survive verbatim.
- **Failure:** if summarizing fails, log it, continue uncompacted, and do not retry until the request has grown by a meaningful margin. If the request would exceed a hard limit, end the turn with an honest error rather than sending it.

Refactor section assembly into a function the loop can call again mid-turn; today it is inline at the top of `runAgentLoop`.

## Wiring and safety

- Inject the compactor through a module-level registration in `src/main/agent/index.ts`, set once from `src/main/index.ts` with the app's `SummaryService`, so all eight callers get it without threading a new option through each. Do not import `src/main/index.ts` from the agent (cycle); the agent depends only on the registered function's type.
- Add `SummaryService.compactNow(conversationId, signal)`: forced work-state summarize, no threshold check.
- **Make summary upserts monotonic:** never store a summary whose `coversThrough` is lower than the stored one. A background `summarize` task started before a turn could otherwise overwrite a newer in-turn compaction with older coverage.
- **Settings:** add a turn compaction threshold (high watermark) next to the existing summarize thresholds, with the low watermark derived from it (for example half); `0` disables. There is no per-model context-window catalog, so the default must be conservative for every configured provider.
- **Providers:** the Claude subscription native-assistant carrier replays provider-native assistant blocks. Confirm that stubbed tool results (tier 1) and a rebuilt history ending in a fresh user message (tier 2) are both accepted, including thinking-block rules.

## Observability

- Log each compaction to `context-usage.jsonl` with tier, request estimate before and after, cleared result count and summary coverage.
- Emit a turn event so Trace activity can show "Context compacted". A transcript divider is optional and can be a later slice.

## Implementation sequence

1. Monotonic summary upsert, `compactNow`, tests.
2. `clearOldToolResults` pure function and unit tests; wire tier 1 into the round loop behind the setting.
3. Extract section assembly for mid-turn refresh.
4. Tier 2 rebuild, injected compactor, continuation message.
5. Setting, logging, turn event.
6. Verify against a real long workflow step.

## Verification and acceptance

- Unit: clearing preserves call/result pairing, never touches the protected recent rounds or allowlisted tools, reaches the low watermark in one pass, and is idempotent.
- Unit: a tier 2 rebuild yields system prompt, current summary, fresh todo section and the continuation user message, with no orphaned tool results.
- Unit: summary upserts never lower `coversThrough`.
- Integration with a mocked provider: a scripted turn of 200+ rounds never sends a request above the high watermark, and the persisted transcript is identical to an uncompacted run.
- Real run: re-run a Feature Implementation workflow of similar size. Acceptance: no request in `context-usage.jsonl` exceeds the threshold, and total estimated input tokens for the Implementation step drop well below the 93M baseline.
- Manual (user): a long turn on the Claude subscription provider still works after both tiers fire.

## Explicit non-goals

- No change to persisted messages, the message schema or transcript rendering.
- No per-model context-window catalog; a setting covers this for now.
- No model-callable "compact" tool.
- No replacement of the between-turn rolling summary; this complements it.

## Open questions

- Default high watermark: `gpt-6-luna` over the Codex subscription accepted a 325k-token estimate, but other configured providers may not.
- Whether interactive chat turns should use the work-state prompt mid-turn, or the conversation prompt.
- Whether tier 1 should also shorten large write/edit tool-call arguments in older assistant messages (57k tokens at the peak above).
- How much prompt-cache cost each provider pays per prefix change, which decides how far below the high watermark tier 1 should clear.
