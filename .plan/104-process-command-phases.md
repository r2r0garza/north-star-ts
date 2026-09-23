# PR104: Deterministic command phases in Processes

> Status: **PLANNED**. Extends the shipped Process engine so a phase can execute a persisted command directly instead of always starting an LLM worker. AI may help the user author the command in the Process builder, but running the saved Process does not ask a model to reconstruct or choose that command.

## Goal

Make deterministic execution a first-class Process phase type. A Process such as `Implement → Test → Publish` should be able to define `Test` as `pnpm test` (or another workspace command), execute it through the selected run environment, and use its exit status and bounded output as the phase result.

This is not an instruction to an agent to call `exec_command`. It is an engine-owned command invocation with no phase LLM call, no agent selection, and no possibility that a worker decides to skip or replace the command.

## Product decisions

1. **Persist the final command.** The phase stores the exact command authored in the builder. An optional Ask AI authoring action may propose or revise that value, but the user reviews and saves concrete text before it can run. Runtime command generation is out of scope.
2. **Use explicit phase kinds.** Introduce an execution kind such as `agent | command | subprocess` rather than inferring behavior from whichever nullable field happens to be populated. Existing phases migrate as `subprocess` when `subprocess_id` is set and `agent` otherwise.
3. **Command phases are deterministic workers.** The scheduler dispatches them when their normal DAG dependencies are satisfied, but the service invokes the command through the existing `Environment` execution seam instead of `runAgentLoop`.
4. **Exit status is the default completion contract.** Exit code `0` completes the phase. A non-zero exit, timeout, spawn failure, cancellation, or cleanup failure fails it with structured diagnostics. There is no LLM interpretation of whether a test “looks successful.”
5. **Output remains useful downstream.** Persist a bounded command receipt containing the command, working directory, status, exit code/signal, timing, truncation metadata, and bounded stdout/stderr. Render a concise textual phase output from that receipt so existing downstream `collectUpstream` behavior can consume it.
6. **Reuse execution policy.** Resolve the same workspace and Local/container Environment a normal worker’s command tool would use. Do not bypass confinement, command analysis, approval policy, timeout/output limits, cancellation, or process-tree cleanup by calling `child_process` directly from the Process service.
7. **No silent replay after an ambiguous interruption.** If the app exits while a command is running, the resumed Process must not automatically execute the command again because it may have produced side effects before the crash. Mark the attempt interrupted and require an explicit retry/re-run action. Commands known not to have started may remain pending.
8. **Keep v1 combinations understandable.** A command phase has no agent pool, routing, worker runtime model, assigned skill, LLM validator, or LLM fan-out decomposition. It may use ordinary dependencies, a post-phase human approval gate, retry initiated by the user, and downstream phases. Rich shell matrices and one-command-per-fan-out-child can be follow-ups.

## Data contract

Add phase-kind and command configuration to `process_phases`. Exact migration names should follow the schema version current at implementation time; a likely typed shape is:

```ts
type ProcessPhaseKind = "agent" | "command" | "subprocess"

interface ProcessCommandConfig {
  command: string
  cwd: string | null // workspace-relative; null means workspace root
  timeoutMs: number
  maxOutputBytes: number
}

interface ProcessCommandReceipt {
  version: 1
  command: string
  cwd: string | null
  status: "completed" | "failed" | "timed_out" | "cancelled" | "interrupted"
  exitCode: number | null
  signal: string | null
  startedAt: number
  finishedAt: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  capturedOutputBytes: number
  observedOutputBytes: number
}
```

Store command configuration as validated columns or a versioned JSON object on the definition. Store the execution receipt on the phase-run side, not on the reusable definition. Definition edits after a run starts must not rewrite historical receipts.

Repository validation must enforce the kind-specific invariants atomically:

- `agent`: no command config and no `subprocess_id`;
- `command`: valid non-empty bounded command config, no `subprocess_id`, and no phase-agent rows used at runtime;
- `subprocess`: `subprocess_id` is present and command config is absent.

Preserve existing import/export behavior by adding the phase kind and portable command config to the versioned Process format. Import validates bounds and workspace-relative `cwd`; it never executes a command as part of preview or import.

## Engine behavior

Add a command dispatch branch beside the scheduler’s existing agent and sub-process branches. It should share normal ready-set, concurrency, gate, cancellation, event, and terminal-status behavior, while calling a narrow Process command executor.

The executor should:

- resolve the run workspace and configured execution environment;
- fail clearly before spawning when no executable workspace/environment is available;
- run in the foreground with a bounded timeout and output cap;
- stream only bounded progress suitable for the monitor, while preserving a final structured receipt;
- connect the Process abort signal to command termination and process-tree cleanup;
- sanitize errors through the existing Process failure boundary; and
- settle the phase exactly once from the concrete command result.

Do not implement this by fabricating a conversation and invoking `exec_command` through an LLM. Extract or reuse the lower-level command-session/policy service needed by both the tool and Process execution so the safety and environment behavior stay aligned without a fake model turn.

A completed command phase’s official output should be derived from its receipt rather than from `lastAssistantOutput`. Downstream prompts should receive a bounded summary with the exit status and captured output. The run monitor should expose the full retained receipt within existing caps and clearly indicate truncation.

## Builder and monitor

The phase inspector gains an execution-type control with `Agent`, `Command`, and `Sub-process` choices.

For a command phase, show a multiline command editor, optional workspace-relative working directory, timeout, and output-limit controls. Hide agent pool, routing, skill, worker model, fan-out, and LLM-validator controls. Keep dependencies and post-phase approval controls visible. Switching kinds must use an explicit confirmation when it would discard incompatible configuration.

An optional **Ask AI** action may draft a command from the phase name, Process objective/description, and bounded workspace metadata. The proposal stays inert in the editor until the user accepts and saves it. It must not execute the proposal, silently install dependencies, or convert the phase back into an agent phase.

The run monitor should identify the phase as a command, show the persisted command before/during execution, display running/completed/failed state and duration, and render bounded stdout/stderr with exit and truncation metadata. It must not show a fabricated agent or model badge.

## Verification

Repository and import/export tests should cover kind migration/defaults, kind-specific invariants, bounded command fields, invalid/escaping working directories, portable round trips, and safe handling of old exports.

Engine tests should prove that a ready command phase invokes the Environment exactly once and never calls `runAgentLoop`; exit `0` completes and unblocks dependents; non-zero exit, timeout, spawn error, cleanup failure, and cancellation settle correctly; output is capped and available to downstream phases; Local/container selection and workspace resolution match existing command execution; approval policy is not bypassed; and crash reconciliation does not blindly replay an ambiguously interrupted command.

Renderer tests should cover kind switching, incompatible-control hiding, command validation, inert Ask AI proposals, and monitor output/status rendering. Manually run a Process with `Implement → pnpm test → Publish`, confirm the test phase makes no model request, observe its live output, and verify Publish receives the bounded command result.

Run focused tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm verify:roadmap`.

## Out of scope

- Generating or changing the command during a Process run.
- Treating shell output as instructions for an agent or using an LLM to decide command success.
- Interactive/TTY command phases, background daemons, persistent services, command matrices, shell pipelines represented as multiple phase attempts, or fan-out command children.
- Installing dependencies automatically when a command is unavailable.
- Replacing the existing structured diagnostics/test tools; those remain agent tools, while this feature is a generic deterministic Process primitive.
