# PR102: Atomic summary-boundary admission

> Status: **PLANNED — NEXT UP AFTER `093`**. Prevent context construction from excluding covered transcript rows unless the rolling summary that replaces them is actually present in the rendered request.

## Goal

Preserve a gap-free conversation context under every section-budget outcome: either include the rolling summary together with the strict post-summary message tail, or retain a transcript path that does not discard the messages the absent summary would have replaced.

## Current state

- `runAgentLoop()` obtains a persisted summary section and independently passes both the section and `summary?.coversThrough` to `ContextBuilder.build()` (`src/main/agent/index.ts:1501-1507`, `src/main/agent/index.ts:1599-1609`).
- `ContextBuilder.composeSystemBlock()` may drop any optional section whose cost does not fit the section-budget share, including the highest-priority summary (`src/main/agent/context/context-builder.ts:126-166`).
- History selection currently depends only on whether `historyAfterSeq` is defined, not whether the summary was admitted. After plan `094`, a defined boundary causes SQLite to load only `seq > historyAfterSeq`.
- Therefore, if a summary exists but is dropped by section budgeting, the rendered request can contain neither the summary nor messages at or below its coverage boundary.
- Summary generation caps digest output at 1,024 tokens (`src/main/summaries/service.ts:37-44`), so this is most likely with a very low configured context threshold or an unusually costly rendered summary envelope, but correctness must not depend on typical settings.

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
- `src/main/agent/index.ts` and focused tests if the input contract changes
- `src/main/agent/context/sections.ts` and tests if summary metadata moves into a typed replacement contract

## Out of scope

- Changing summary generation prompts, cadence, or size cap.
- Adding a general transcript context-window truncation policy.
- Changing the persisted summary schema or sequence-boundary meaning.
- Optimizing unrelated optional-section admission.
