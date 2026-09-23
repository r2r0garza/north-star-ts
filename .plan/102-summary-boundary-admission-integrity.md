# PR102: Atomic summary-boundary admission

> Status: **DONE** (2026-09-23). Context construction can no longer exclude covered transcript rows unless the rolling summary that replaces them is actually present in the rendered request.

## Goal

Preserve a gap-free conversation context under every section-budget outcome: either include the rolling summary together with the strict post-summary message tail, or retain a transcript path that does not discard the messages the absent summary would have replaced.

## Current state

- `runAgentLoop()` obtains a persisted summary section and independently passes both the section and `summary?.coversThrough` to `ContextBuilder.build()` (`src/main/agent/index.ts:1501-1507`, `src/main/agent/index.ts:1599-1609`).
- `ContextBuilder.composeSystemBlock()` may drop any optional section whose cost does not fit the section-budget share, including the highest-priority summary (`src/main/agent/context/context-builder.ts:126-166`).
- History selection currently depends only on whether `historyAfterSeq` is defined, not whether the summary was admitted. After plan `094`, a defined boundary causes SQLite to load only `seq > historyAfterSeq`.
- Therefore, if a summary exists but is dropped by section budgeting, the rendered request can contain neither the summary nor messages at or below its coverage boundary.
- Summary generation caps digest output at 1,024 tokens (`src/main/summaries/service.ts:37-44`), so this is most likely with a very low configured context threshold or an unusually costly rendered summary envelope, but correctness must not depend on typical settings.

## Analysis completed and decision (2026-09-23)

- **Call sites:** `ContextBuilder.build()` has one production caller (`runAgentLoop()`), and only the summary supplied `historyAfterSeq`. Only tests passed it otherwise.
- **Measured edge:** the Settings UI floor for `summarizeTokenThreshold` is 6,000, so the section budget is at least 3,000 tokens (`0` falls back to 12,000 → 6,000). A summary costs at most ~1,024 digest tokens plus a ~100-token fixed header, so it fits alone at shipped settings. It is still droppable when a higher-priority section (`planMode`, 70) consumes the share or when the setting file is hand-edited below the UI floor. The gap is reachable, so correctness cannot rely on typical settings.
- **Chosen policy: non-droppable replacement unit** (policy 1). Policy 2's full-history fallback would reintroduce the `094` latency/memory cost on exactly the very long conversations that have summaries, and no bounded gap-free alternative exists without truncating the summary or covered rows (out of scope).
- **Invariant:** a section carrying `replacesHistoryThrough` is always admitted; its cost still counts against the section budget, so lower-priority sections yield to it. The builder derives the history boundary from the admitted section itself (`composeSystemBlock` returns `replacedThroughSeq`), so admission and history selection are one synchronous decision and `runAgentLoop()` no longer passes `historyAfterSeq`.
- **Summary larger than the whole budget:** admitted anyway and logged as `+summary(cost, required, over budget)`. `tokenBudget` is a summarization threshold, not a hard window, and silently truncating the summary is out of scope.
- **Blank or absent summary** (`0` boundary aside): full-history path. A `0` boundary still takes the bounded path. More than one replacement section is a programmer error and throws.
- **Logging:** `[context] history: full transcript` / `messages after seq N (replacement section admitted)`; no summary or message contents.

## Required plan/analysis pass

Before implementation, reproduce the edge with a deterministic token counter and a summary section whose cost exceeds the section budget. Trace all `ContextBuilder.build()` call sites and verify whether any non-summary caller supplies `historyAfterSeq`. Measure the fixed summary envelope plus the maximum generated digest against shipped and user-configurable budgets. Record the chosen invariant and fallback behavior here before editing production code.

Compare these coherent policies:

1. **Non-droppable replacement unit:** when a summary boundary exists, reserve/admit the associated summary outside the ordinary optional-section share, then query only the uncovered tail. Define behavior if the summary itself exceeds the entire usable request budget.
2. **Admission-aware fallback:** keep summaries budgeted, but query the bounded tail only when the associated summary is admitted; otherwise replay full history. Evaluate the latency and memory regression this can cause on very long conversations and whether a bounded-but-gap-free alternative exists.

Do not keep the current mixed state. Summary content and the boundary it authorizes must be treated as one semantic unit. Priority alone is insufficient because a highest-priority section can still fail the absolute budget check.

## Design constraints

- The decision must use actual admission, not the mere presence of a summary record or section name.
- Avoid implicit coupling by string matching `name === "summary"` if a typed replacement-section contract or explicit summary input can express the invariant more safely.
- Preserve plan `094`'s SQLite tail-query optimization whenever the summary is rendered.
- Preserve complete-history behavior when no usable summary exists.
- Do not silently truncate the summary, covered transcript, or uncovered tail as part of this fix.
- Keep optional-section priority and declaration-order rendering behavior unchanged unless the selected policy explicitly requires summary reservation.
- Logging must make the chosen summary/history path inspectable without logging summary or message contents.
- Do not change summary generation cadence, `coversThrough` semantics, or repository schema.

## Proposed implementation direction

After the required analysis chooses a policy, refactor ContextBuilder so section admission is represented as structured data rather than only a rendered string. For example, composition may return the rendered system block plus admitted section identities, or summary replacement metadata may become an explicit typed input. Select `listMessagesAfterSeq()` only after the builder can prove the matching summary is included; otherwise use the chosen gap-free fallback.

Keep admission and history selection in one synchronous build decision so later call-site changes cannot accidentally separate them again. Do not make `runAgentLoop()` predict admission by duplicating token-budget logic.

## Verification and acceptance

- A fitting summary is rendered and authorizes the strict `seq > coversThrough` repository path.
- A non-fitting summary cannot cause covered messages to disappear: the selected fallback preserves a gap-free context.
- A boundary of `0`, an absent summary, a blank summary, and an empty post-boundary tail retain explicitly tested behavior.
- Other optional sections may still be dropped by priority without changing history selection.
- Tests assert both rendered content and which repository path was called; they do not rely only on log text.
- Add a regression where the summary is highest priority but individually exceeds the section budget, proving priority does not mask the edge.
- Run focused ContextBuilder and agent call-path tests, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Likely files

- `src/main/agent/context/context-builder.ts`
- `src/main/agent/context/context-builder.test.ts`
- `src/main/agent/index.ts` (drops the `historyAfterSeq` argument)
- `src/main/agent/context/sections.ts` and tests if summary metadata moves into a typed replacement contract

## Out of scope

- Changing summary generation prompts, cadence, or size cap.
- Adding a general transcript context-window truncation policy.
- Changing the persisted summary schema or sequence-boundary meaning.
- Optimizing unrelated optional-section admission.

## Implementation notes

- `ContextSection.replacesHistoryThrough` is the typed replacement contract; `summarySection()` sets it from `coversThrough`. Declaration-order rendering is unchanged.
- Tests (`context-builder.test.ts`): fitting summary → tail path; summary exceeding the section budget still admitted with the tail path; highest-priority/`planMode` case; lower-priority sections yield to reserved cost; declaration order; other dropped sections leave history selection alone; boundary `0`; blank summary; empty tail; multiple-replacement rejection; log path excludes contents. Assertions cover both rendered content and which repository function was called.
- Verification: `pnpm typecheck` and `pnpm build` pass; `pnpm test` shows 1,255 passing and the same 4 pre-existing CLI adapter failures (missing `cli_probes` fixtures) that occur without this change.
