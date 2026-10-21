# Workflow Step Validation — Requirements and Implementation Plan

## Scope

Add optional, per-step completion validation to workflow definitions and execute it after a step agent reports completion but before the workflow advances. This plan is for the requested feature; this planning step makes no application-code changes.

## Requirements and testable acceptance criteria

1. Each workflow step can independently enable or disable **Validate step completion**. New steps and existing steps without the setting behave as disabled; enabling or disabling is persisted in the workflow definition.
2. When enabled, the edit view displays a **Maximum correction loops** slider with integer values 0–10, defaulting to 2 when no value has been saved, and help text that accurately reflects the selected value: “The validator runs once initially, plus up to X correction attempts.” The controls appear after Instructions and before the existing Model/Agent row.
3. When enabled, a separate validator model picker and validator agent picker are available for that step. They must not overwrite the step's normal model or agent settings. They are hidden when validation is disabled. Picker options follow the existing provider/model and agent selection patterns.
4. At run time, enabled validation occurs after the step agent produces a valid completion handoff and before marking the step complete/advancing. The validator receives the launch-snapshotted original objective, exact assigned step instructions, relevant earlier step outputs, the current step's completion claim, and access to the actual workflow workspace and relevant tools.
5. The validator response is parsed as a verdict with reason/findings. Accepted permits progression. Rejected feeds the reason/findings back into the *same step conversation* as a correction request, retains its useful transcript, and reruns the step agent. No new conversation is created for a correction loop or validation.
6. There is one initial validation attempt plus at most the configured number of correction attempts. An acceptance on any attempt permits the step to complete. If the last permitted correction still fails validation, the step and workflow run fail; subsequent steps do not run.
7. Validation disabled preserves existing workflow execution semantics. Pausing/resuming, retrying, and persisted run snapshots remain coherent; completed steps are not needlessly revalidated when a run resumes.

## Existing architecture and relevant integration points

- `src/shared/workflows.ts`: `WorkflowStep` is the shared persisted definition type. Add optional per-step validation settings here, with absence representing the off/default state for backwards compatibility.
- `src/renderer/src/components/workflow-detail.tsx`: `SortableStep` owns step editing, existing switch, model and agent comboboxes, and auto-save through `onChange`/`onSave`. Insert the toggle and conditional controls between instructions and the normal model/agent row. Reuse its `modelGroups`, `agents`, and combobox patterns while keeping validator selections separate.
- `src/main/db/repositories/workflows.ts`: workflow steps are JSON-backed and round-trip through `listWorkflows`/`updateWorkflow`. `validateWorkflow` and `importWorkflow` have explicit per-step allowed-key and field validation; extend these for new settings so saves/imports validate and round-trip without rejecting the new keys. Legacy definitions lacking the fields must remain valid. Workflow export/import also needs inspection and tests for the added fields.
- `src/main/workflows/service.ts`: `start` snapshots the workflow into `WorkflowRun.steps`. `execute` creates one conversation for each step, invokes `runAgentLoop` and parses its task handoff, then marks the step complete. Add validator execution in this lifecycle between the agent completion handoff and completion status transition. Reuse the existing step conversation for correction turns, and preserve workspace, abort, event, and failure handling.
- `src/shared/workflow-runs.ts`: run steps inherit the definition; any additional durable validation progress/state needed for pause/retry must be represented here (or intentionally derived from transcript/run state).
- Persistence and validation tests: `src/main/db/repositories/workflows.test.ts`, `src/main/db/repositories/workflows-import.test.ts`, `src/main/workflow-export.test.ts`, and `src/main/db/repositories/workflow-runs.test.ts`.
- UI and runner tests: `src/renderer/src/components/workflows-screen.test.tsx`, `src/main/workflows/service.test.ts`, and `src/main/workflows/service.integration.test.ts`.

## Ordered implementation tasks

1. Extend `WorkflowStep` with optional validation-enabled, correction-budget, validator model/account, and validator-agent fields. Set defaults in editor behavior (off, budget 2 when enabled without a value) without requiring a destructive migration; keep omitted fields backward-compatible.
2. Update workflow validation/import/export round-trips to accept, validate, and preserve only well-formed validation settings. Cover old workflow JSON and malformed values. Confirm that the run launch snapshot retains all validator settings.
3. Add editor controls in `SortableStep`: accessible switch; conditional 0–10 integer slider and dynamic explanatory text; conditional validator-only model and agent pickers. Preserve existing normal step model/agent values. Ensure each user change saves consistently with existing auto-save behavior.
4. Define and implement validator execution using the existing `runAgentLoop` and step conversation/workspace access. Construct the validation prompt with the required original objective, exact instructions, relevant earlier outputs and completion claim. Require a structured verdict and handle malformed/unusable output as a bounded failure rather than accidentally accepting it.
5. Add the validation/correction loop after the first valid step handoff. On rejection, persist the feedback in the same conversation and continue the existing agent there; count correction attempts precisely (initial validation plus up to N corrections). On acceptance, retain the accepted step result and proceed. On exhausted budget, fail the active step/run and stop advancement.
6. Ensure pause/abort, restart/retry, and resumed active steps do not lose or duplicate validation/correction work. Persist any state needed to distinguish pending validation from already-accepted completion; reuse existing workflow-run persistence and conversation transcripts.
7. Extend focused tests across editor rendering/saving, data validation and import/export, and runner lifecycle. Include enabled/disabled, defaults/range, accepted immediately, rejected then accepted, exhausted budget, malformed validator response, same conversation, workspace/prior-output context, and pause/resume or retry behavior.

## Potential regressions and dependencies

- New step keys can be rejected by the explicit import allowlist unless all import/validation paths are updated together.
- Legacy and imported workflow records lack the new fields; UI and runner must apply defaults without changing their existing behavior.
- The current workflow runner validates a step handoff and appends one report-only repair turn for malformed handoffs. The new correction path must remain distinct from that format-repair path and must not accept an unvalidated result or create a second conversation.
- `runAgentLoop` can stop for errors, aborts, questions, or approvals; validator calls must retain the runner's unattended-mode and abort semantics and must not bypass workflow failure handling.
- A validator should have a distinct model/agent selection while operating on the same step workspace and conversation; confirm that `runAgentLoop` supports selecting an agent/model per invocation without changing the conversation's original configured target.
- Persisting active validation progress matters for interruption/retry. Avoid repeating side effects or treating an unresolved validator result as accepted after a restart.
- The user says “relevant outputs from earlier steps”; current step prompts include earlier title/result text with bounded truncation. Confirm and reuse that context policy rather than inventing a new relevance algorithm.
- Slider accessibility, keyboard operation and dynamic help text should match existing UI conventions; inspect the available slider component before implementation.

## Verification approach

- Definition/editor: focused renderer tests verify initial off state, settings visibility/order only when enabled, slider min/max/default and changing help text, separate validator pickers, and workflow update payloads/reload persistence.
- Persistence: focused repository and export/import tests verify valid settings round-trip, bounds/type validation, and acceptance of legacy definitions with no validator properties.
- Runner: focused service tests mock the validator and step agent to verify supplied context, exact attempt counts, accepted/rejected outcomes, correction feedback appended to the original conversation, no progression after exhaustion, and existing no-validation behavior.
- Recovery: focused tests verify abort/resume/retry do not mark a pending validation accepted or unnecessarily rerun completed accepted steps.
- Run targeted test files and applicable typecheck/lint after implementation; do not run the full test suite as part of this planning step.

## Assumptions and unresolved ambiguities

- “Correction loops” means up to N additional executions of the original step agent after the first completion; each corrected completion is followed by another validator call. Thus N=0 still performs one initial validation.
- The validator verdict is expected to be `accepted` or `rejected`, with a reason and findings; schema details, tolerance for extra/missing fields, and the user-facing handling of malformed responses need a deliberate implementation decision. Safest behavior is not to treat malformed output as accepted.
- The validator agent/model may be unset and should use the existing system/default selection behavior, consistent with the normal picker; confirm the exact `runAgentLoop` invocation options before wiring selections.
- “Relevant tools” means the validator runs through the normal agent tool environment in the same workspace; exact tool restrictions, if any, were not specified and should not be added speculatively.
- It is not specified whether validator messages/results should appear separately in workflow run UI; retain them in the existing conversation unless a later requirement asks for dedicated run-level presentation.
