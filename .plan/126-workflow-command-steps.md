# PR126: Deterministic command steps in Workflows

> Status: **Proposed.** Bring first-class command execution to Workflows, distinct from the completed [PR104: Process command phases](104-process-command-phases.md). JSON-array iteration is a follow-up in [PR127](127-workflow-command-iteration.md).

## Objective

Let a workflow step run a Python script or ordinary workspace command directly, without an agent/model call, and pass its bounded output and result references to the next step. A workflow can mix agent and command steps in its existing ordered execution model.

## Definition and editor

Introduce an explicit `agent | command` step kind, defaulting old definitions and exports to `agent`. Command configuration includes the reviewed executable/arguments or shell command, workspace-relative working directory, timeout and output cap. Clearly distinguish argument-vector execution from shell syntax; script paths, arguments and interpreter selection must be explicit rather than guessed at runtime.

The step editor offers Agent and Command choices. Command steps expose command configuration and hide agent, skill, model/effort and LLM-validator controls. Switching kinds must not silently discard incompatible configuration. Validate kind-specific fields in the main process as well as the UI. Persist configuration across save, duplication and versioned import/export; import and preview never execute anything.

## Inputs and downstream results

Provide an explicit, documented binding from earlier step results to command input. For v1, prefer a versioned JSON envelope on stdin containing the selected earlier step outputs and objective, alongside static reviewed arguments. Do not interpolate model-generated text into shell source. If file-backed input is needed for existing scripts, use a managed workspace-confined input file with a documented lifetime and pass its path as an argument.

Persist a bounded receipt with command identity, working directory, status, exit code/signal, timestamps, stdout/stderr and truncation metadata. Make that receipt available to later command inputs and to later agent prompts as result data, not instructions. Where scripts produce files, retain explicit workspace-relative artifact references for downstream use and validate them at access time; do not imply that captured stdout alone preserves generated files. Historical receipts belong to the run snapshot, not the editable workflow definition.

## Execution and lifecycle

Dispatch command steps directly from `src/main/workflows/service.ts`; never fabricate an agent conversation or ask a model to invoke a tool. Reuse the shared command-session, Environment and approval policy seams established for ordinary command tools and Process command phases. Do not duplicate Process orchestration or bypass workspace confinement, command analysis, approvals, timeout/output bounds, cancellation or process-tree cleanup.

Exit code zero completes the command step and unblocks the next step. Non-zero exit, spawn failure, timeout, cancellation and cleanup failure produce explicit terminal outcomes and diagnostics, not LLM judgments. Freeze the reviewed configuration and bound inputs for each attempt. Preserve workflow pause/cancel/retry behavior; pause must not advance to another step while a command is unsettled. A command retry is an explicit action that may repeat side effects. After an ambiguous app interruption, mark the attempt interrupted and require explicit retry rather than silently replaying it.

Run details show command identity, approval/running/terminal state, bounded live output, final receipt and artifact references without fabricated agent/model badges. Keep existing agent handoff and validation behavior intact; adapt result contracts explicitly rather than coercing command receipts into an assistant response.

## Implementation touchpoints

Inspect shared workflow definition, run and result contracts; workflow schemas/repositories; workflow export/import; workflow service dispatch and recovery; editor and run-detail components; and IPC validation. Review the PR104 executor for reusable policy/execution code before adding a workflow-specific adapter. Preserve the installed Trace presentation and existing workflow response pairing for agent steps.

## Verification

Cover old-definition migration, kind validation, persistence/import/export, inert previews, editor switching and command-only control visibility. Service tests must prove commands make no model request; approval allow/deny, environment selection, exit handling, timeouts, output caps, pause/cancel, explicit retry and interrupted recovery behave correctly; and later steps receive bounded receipts and usable artifact references. Verify that data containing shell metacharacters never becomes executable syntax through input binding.

Run focused workflow and shared executor tests, then typecheck, full tests, build and roadmap verification. Manually run an Agent → Python/command → Agent workflow, inspect its receipt and generated file handoff, deny an approval, cancel a running command and test explicit retry after interruption. Record platform/environment qualification limits.

## Acceptance

Users can save and run mixed agent/command workflows without an LLM invocation for command steps. Commands obey existing execution policy, expose durable bounded results to subsequent steps, and retain understandable cancellation, failure and retry behavior.

## Out of scope

Per-item loops (PR127), runtime-generated shell programs, automatic dependency installation, interactive TTY steps, background services, and changes to Process scheduling.
