# PR110: Anthropic subscription usage investigation

> Status: **PLANNED** (2026-10-10). Investigation requested after the user observed Opus exhausting subscription allowance substantially faster in North Star than in native Claude Code.
> Evidence boundary: this is a user-observed difference, not a measured cache failure or an established token-to-allowance conversion. No root cause is established.
> Release posture: Anthropic Subscription is hidden from the provider picker in packaged builds and remains available in unpackaged development builds for internal testing. Do not restore packaged visibility merely because transport tests pass.
> References: [109 umbrella](109-claude-code-subscription-experimental.md), [109.3 replay/cache implementation](109.3-claude-subscription-replay-and-cache.md), [deferred 109.6 Windows startup work](109.6-windows-subscription-startup-optimization.md).

## Objective

Determine whether, where, and why comparable Opus work consumes more Anthropic subscription allowance in North Star than in native Claude Code. Distinguish model workload, prompt-cache behavior, output/thinking, retries and auxiliary requests from local process-startup latency. Produce reproducible evidence and the smallest justified remediation proposal before changing the transport or restoring broader availability.

## Task 1: Audit the actual usage path and competing hypotheses

Trace the current request lifecycle through the shared agent loop, context assembly, Claude subscription request/history/native-carrier translation, CLI invocation, admission relay, response accounting and persistence. Include tool continuations, titles, summaries, retries, output-cap reissues, provider/model switching and app restart. Inspect the current working implementation rather than assuming the earlier analysis or completed 109.3 qualification proves real-service efficiency.

Record exact CLI and resolved model versions, effective thinking/effort and output settings, tool inventory, context/summary policy, request counts and session reconstruction behavior. Determine which defaults are controlled by North Star and which come from the official CLI. Evaluate cache-prefix stability, cache breakpoint placement, native annotations, retained tool-output volume, rounds per completed task, generated thinking/output and failed or auxiliary generations as separate hypotheses.

Starting a new CLI process is not itself token consumption or proof of a cache miss. History replay must not be counted as extra upstream generations without evidence. Existing synthetic fixtures prove protocol behavior, not vendor cache hits or subscription savings.

**Acceptance:** a source-backed map identifies all potential model calls and accounting gaps, with testable hypotheses and no premature root-cause claim.

## Task 2: Add narrowly scoped, privacy-preserving usage evidence

Inspect existing startup diagnostics, provider usage capture and `context-usage.jsonl` before extending them. Preserve separate actual uncached input, cache-creation input, cache-read input and output buckets; record thinking separately only when the service exposes a reliable count. Do not double-count cached input or invent thinking counts from visible text. Mark unavailable fields as unknown, not zero.

Correlate bounded run/turn/round/attempt identifiers, resolved model, tool inventory size, context size by role, tool-result volume, outcome, retry/reissue reason and auxiliary-call category. Separate preparation/history replay, upstream admission, first response and completion timing where useful. Inspect wire stability through synthetic fixtures and structural or run-scoped digest comparisons without persisting raw request bodies.

Never log prompts, histories, tool arguments/results, thinking content/signatures, credentials, account metadata or private paths. Keep diagnostics bounded and test-only or explicitly opt-in where additional collection is needed. Record all admitted generations, including failed attempts when usage is available; acknowledge missing accounting for interrupted streams.

**Acceptance:** synthetic tests verify accurate bucket preservation and call attribution, and show that diagnostics do not expose sensitive content. Aggregate prompt tokens alone cannot be presented as measured allowance consumption.

## Task 3: Run a bounded, matched Opus comparison

Design the experiment before spending subscription usage. Obtain fresh explicit user approval for real-service runs, including the task, exact model/settings, maximum generations or workload bounds, auxiliary/continuation allowance and stop conditions. This plan is not authorization to run live subscription calls. Start with offline and official-CLI synthetic loopback checks.

Compare North Star Anthropic Subscription with native Claude Code against the same isolated repository baseline, task and definition of done, using the same account/plan, resolved Opus model and CLI version where feasible. Record effective reasoning settings, permissions, tool differences, summaries and context sizes. Run each trial from its own reversible workspace snapshot; do not let one trial's edits make the other easier. Use a controlled multi-round fixture to isolate request/cache effects, then a representative coding task to evaluate useful work per allowance consumed. Document remaining harness differences rather than claiming exact equivalence.

Distinguish cold-cache and warm-continuation trials. Record trial order, timestamps, concurrent account activity and reset windows; avoid claiming cold-cache isolation when cross-run reuse cannot be ruled out. Capture user-visible subscription usage before/after when available, keeping short-window and longer-window/model-specific limits separate. Allow for delayed or coarse usage-meter updates. Report actual token buckets independently from observed allowance change; consult current official documentation for usage semantics rather than treating API list prices as subscription billing rules.

**Acceptance:** bounded results compare total and per-successful-task usage, cache reads/writes/uncached input, output, model rounds, retries and auxiliaries, alongside actual allowance observations where available. Include task quality, sample count, confounders and uncertainty; inconclusive evidence remains inconclusive.

## Task 4: Diagnose and propose the minimum remediation

Use the results to distinguish unstable request prefixes or cache placement from excess context, unnecessary calls, higher effective thinking/output, more tool rounds, or service/account-limit behavior. Investigate anomalies at the responsible layer instead of assuming a persistent CLI session is the solution.

For each supported cause, propose the smallest change and a controlled before/after check. Changes to cache-wire transforms require qualified CLI layouts and lossless preservation of native identity, system/tool markers, tool-result semantics and signed assistant metadata. Context reductions must preserve needed task state and canonical history semantics. Do not silently reduce reasoning quality or change model defaults to manufacture savings. Reusing inference sessions, changing transport ownership or altering existing isolation guarantees requires a separately reviewed design, not an incidental optimization.

Preserve official CLI authentication ownership, private-state and managed-policy checks, North Star approval/tool execution ownership, one admitted upstream request per completion attempt, bounded cancellation and cleanup. Do not bypass the CLI to extract credentials, alter subscription accounting, or weaken safeguards.

**Acceptance:** a documented causal finding or explicit inconclusive result, plus an evidence-backed remediation proposal with regression scope. Implement only justified, bounded changes; split substantial architectural work into a follow-up plan.

## Task 5: Requalification and release decision

If a remediation is implemented, rerun the relevant synthetic replay/cache, usage accounting, tool continuation, auxiliary, retry, signed-carrier, summary/provider-switch and cancellation regressions, then typecheck and build. Qualify affected paths on native macOS/Linux/Windows and the packaged runtime as appropriate. Keep real-service experiments separately approved and out of ordinary tests.

Repeat the matched measurement with a user-agreed success threshold established from the baseline, including acceptable task quality and allowance consumption rather than speed alone. Document revisions, versions, settings, exact test scope and remaining uncertainty in a companion results file. If measurement is insufficient or the difference remains unacceptable, keep packaged provider selection hidden.

Restoring packaged visibility requires an explicit user release decision. Plan 109.6 remains in progress but deferred; a useful result here can inform resuming it, but this plan does not automatically reactivate or complete the Windows work.

**Acceptance:** reviewed before/after evidence supports the chosen release posture, with no unsupported claim of native parity, cache savings or subscription efficiency.

## Out of scope

Windows startup optimization itself (109.6), broader authentication/managed-policy enablement (109.4), host media (109.5), general provider refactoring, OpenAI subscription optimization, automatic background benchmarking, unlimited paid/subscription experiments, vendor quota circumvention and automatic packaged re-enablement.
