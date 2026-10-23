# PR125: Workflow step model effort pickers

> Status: **Done.** Completed 2026-10-23 at the user's direction. Add effort selection beside every model picker in a workflow step, including the worker and completion validator. Automated verification passed (full suite's 3 failures pre-existing); the manual save/reopen/run check and live-provider verification were not performed.

## Objective

Let users choose reasoning effort for each workflow step's worker and validator without changing the account/model defaults elsewhere in the app. The saved choice must reach the actual model request, not just appear in the editor.

## Scope and behavior

Reuse the application's existing model-specific effort capability metadata and picker behavior. Show only effort values supported by the resolved account/model; do not assume every provider supports the same levels. Models without configurable effort must not display an actionable unsupported control.

Treat worker and validator effort as independent settings. Provide a default/inherit choice that preserves existing resolution behavior when no override is saved. Resolve the effective account/model before validating or applying effort, including account defaults, run defaults and the validator's fallback to the worker model. Changing an account/model must clear or explicitly reconcile an incompatible effort rather than sending an unsupported value.

Persist optional worker and validator effort overrides through workflow editing, repository validation, IPC, duplication and import/export. Old definitions with no effort fields retain their current behavior. Freeze the selections in run snapshots so editing the definition cannot change an active or historical run.

Carry worker effort through conversation creation/execution, correction turns and retries. Carry validator effort through the validator's model-selection override without mutating the worker selection or application-wide settings. Show the effective choice in run details wherever model configuration is displayed, distinguishing an explicit override from the default when useful.

## Implementation touchpoints

Inspect `src/shared/workflows.ts`, workflow definition/run repositories and schemas, `src/main/workflow-export.ts`, the workflow step editor in `workflow-detail.tsx`, and `src/main/workflows/service.ts`. Reuse existing shared effort types and resolution helpers rather than introducing a second provider capability table. Confirm both worker and validator picker locations, including any alternate editing surfaces, before implementation.

## Verification

Cover editing and persistence round trips for both settings, old definitions/imports, default inheritance, supported and unsupported models, account/model changes, and independent worker/validator selections. Service tests must assert the effective effort on actual execution inputs for the initial worker turn, correction/retry turns and validator requests. Verify that definition edits do not alter frozen run configuration and that no global account defaults are changed.

Run focused workflow editor, repository, import/export and service tests, then typecheck, full tests, build and roadmap verification. Manually save/reopen a workflow, select different supported efforts for worker and validator, run it and inspect the resolved selections; record any live-provider verification limitation.

## Acceptance

Every workflow-step model picker has a capability-aware effort control where supported, both selections survive save/export/import, and execution honors them independently. Existing workflows and models without effort controls remain usable with unchanged defaults.

## Out of scope

New providers or effort levels, global model-picker redesign, command-step configuration, and workflow scheduling changes.
