# PR127: Workflow command iteration over structured results

> Status: **Proposed.** Depends on [PR126: Workflow command steps](126-workflow-command-steps.md). Extend a command step with bounded, sequential execution over a JSON array produced by an earlier step.

## Objective and example

Allow an agent step to return a structured array and run one command invocation per array element, making the ordered results available to the next workflow step without an agent orchestrating the loop.

For example, step 1 publishes `["parameter1", "parameter2"]` as its structured result. Step 2 selects that result as its iteration source and configures executable `python`, script argument `python-script.py`, and arguments `--name` and the current item. The engine invokes `python python-script.py --name parameter1`, then `python python-script.py --name parameter2`. Each item is passed as one argument, never pasted into a shell program. An array of objects can similarly bind `item.name` to `--name`.

## Structured input contract

Define an explicit versioned structured-result channel for workflow steps, compatible with agent handoff/validation and command receipts from PR126. Select a completed earlier step by stable step ID, not its current display position, and optionally a restricted property/index path to an array in its structured result. Do not scrape JSON out of free-form prose or evaluate JavaScript/JSONPath expressions. If an agent needs to produce an array, its output contract must request and validate that data before the command loop begins.

Parse and validate the complete source before launching any invocation. Bound source bytes, item count, nesting and individual argument sizes. Missing results/paths, malformed JSON, non-array values, missing fields or unsupported value types fail with actionable errors and spawn nothing. An empty array completes successfully with an explicit zero-item receipt. Truncated stdout or a truncated agent summary must not be accepted as the source of a complete array.

Support string items directly and explicit scalar-field bindings for object items; document number/boolean serialization and reject null/compound argument values unless the user explicitly chooses JSON input on stdin. Preserve array order and duplicate values. Snapshot the validated items and bindings for the attempt so later definition edits or upstream retries cannot silently change an active loop.

## Command binding and safety

The editor adds an optional For each mode to Command steps, with source-step/result-path selection and structured argument fields for literals, current item, item fields and index. Bindings are typed configuration, not a string-replacement language for arbitrary shell text. Offer an inert preview of the resolved invocations before a run where source data is available.

Use argument-vector execution with a fixed reviewed executable and script path for per-item binding; do not allow upstream data to replace the executable or shell syntax. Extend the policy-backed execution seam if necessary rather than bypassing it with a direct spawn. Apply command analysis, approvals and confinement to each resolved invocation before it starts. A loop-level approval must not grant broader authority than the existing policy permits. Treat source values and command output as untrusted data even when produced by a preceding agent.

## Execution and recovery

Start with sequential execution in array order, a configured maximum item count, per-item timeout/output limits and aggregate duration/output bounds. Stop on the first failed item; do not offer concurrency or continue-on-error in v1. Check pause/cancel before starting each item, use PR126 cleanup for the active invocation, and never launch remaining items after cancellation or failure.

Persist per-item identity/index, input reference, resolved argument metadata, status, timing and bounded command receipt. Aggregate in source order with completed/failed/skipped counts and truncation metadata. Expose the aggregate structured result and bounded agent-facing summary to later steps; an incomplete loop does not unblock dependents as successful.

Recover completed item receipts without replaying them. If an item was running at interruption, mark it interrupted and require an explicit user decision before rerunning it. Distinguish resume of remaining items from restart of the whole loop, warn about repeated side effects, and do not claim exactly-once external effects. Persist progress at invocation boundaries so retry/resume is not inferred from a partially rendered transcript.

## Editor and run details

Show the source step, selected array path, bindings and execution limits in the saved definition and import/export. Reject deleted, later or incompatible source-step references before running. Run details show item progress and expandable per-item receipts, including the failing item, skipped remainder, empty input and interrupted state. Keep large arrays bounded in rendering and avoid manufacturing agent/model activity for each item.

## Verification

Test string and object arrays, literal/item/field/index bindings, ordering and duplicates, empty arrays, malformed or missing results, invalid references, source/argument/item-count bounds and truncated source rejection. Injection tests must include whitespace, quotes, newlines, shell metacharacters and option-looking values; preserve argument boundaries and document script-level option handling rather than promising argv makes every script safe.

Engine tests must cover no model call in the loop, policy approval/denial per resolved invocation, sequential execution, fail-fast behavior, pause/cancel, aggregate caps, durable progress, interruption and explicit resume/restart without automatic replay. Verify downstream structured aggregate consumption and versioned persistence/import/export. Run focused tests, typecheck, full tests, build and roadmap verification. Manually run the two-name Python example and an object-field variant, then exercise failure and interrupted recovery.

## Acceptance

A user can select an earlier agent's JSON array, bind each item to a Python script or other command argument, execute it sequentially under existing command policy and inspect durable ordered results for use by the next step. Invalid input launches no commands, and failures/interruption cannot silently replay side effects or report a partial loop as complete.

## Out of scope

Parallel fan-out, nested loops, dynamic workflow graph expansion, arbitrary expression evaluation, generated shell loops, implicit JSON extraction from prose, and guaranteed exactly-once external side effects.
