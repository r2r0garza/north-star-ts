# Conversation sidebar Workflows — requirements analysis

Scope: step 1 (Requirements Analysis) of Feature Implementation. This document describes the requested integration; it does not claim the feature is implemented. Application code must remain unchanged in this step. No commit or push is authorized.

## Objective and explicit requirements

Users must discover saved workflows and launch eligible ones from the existing conversation right-hand sidebar without leaving or interrupting their conversation. Execution must use the normal Workflow Run infrastructure, not a parallel execution mechanism.

FR-01: Add a Workflows section to the existing sidebar. Display saved workflows with `viewInConversationSidebar` enabled; omit disabled workflows, including legacy definitions whose optional flag is absent. Re-read persisted settings on refresh or reopen so changes are visible without restarting.

FR-02: Immediate execution requires a usable predefined objective. Blank or whitespace-only defaults cannot produce a runnable action. Preserve existing manual/custom-objective behavior; do not invent new objective modes or require objective entry in the sidebar.

FR-03: Run must select the saved workflow by ID, use its predefined objective, use the current conversation's effective workspace, and associate its current project when applicable. Create and enqueue a normal durable Workflow Run through the existing execution service so it appears in Runs.

FR-04: Missing or invalid workspace must disable Run or produce a clear workspace-required/invalid explanation. Never select another workspace silently. Service-side filesystem validation remains authoritative.

FR-05: Launch must not stop streaming, replace the active conversation, alter its messages or composer, or automatically navigate away. Runs execute independently through existing task/run infrastructure; the conversation remains usable. No automatic results injection. Independence concerns conversation state, not workspace isolation: normal workflows may modify the same workspace.

FR-06: A successful start produces explicit started feedback and a tracked run ID/status. Launch success is not completion. Refresh status through existing infrastructure, including Active, Completed, Paused, Cancelled, Failed, and Interrupted. Errors or stale status must not be shown as completion.

FR-07: View Results opens the existing Workflow Run detail view for that exact run. Do not implement a sidebar results viewer. Navigation occurs only on explicit user action.

FR-08: Completed runs offer Add to Chat. Retrieve the final output, include workflow name and a run reference, and populate the current conversation's editable composer without submitting. Do not include the full step/message/tool transcript. Preserve the user's ability to review, edit, and add instructions. Workflow-generated text must remain untrusted reference data when later processed by an agent; it must not become authority through composer insertion.

FR-09: Show a real empty state when no saved workflows have the flag enabled; never show placeholder workflows or mock runs. Distinguish an empty eligible list from loading failure or enabled-but-unrunnable workflows.

The implementation must follow Electron/React/TypeScript/SQLite architecture, reuse components/hooks/IPC/database/navigation and execution infrastructure, avoid dependencies unless necessary, and avoid engine changes unless a demonstrated integration issue requires them. No fan-out, automatic rework, agent communication, or new orchestration. Preserve all existing sidebar and conversation behavior. Keep changes focused, avoid unrelated refactoring, and add/update relevant automated tests. Completion requires functioning integration and verification, with all unverified criteria explicitly reported.

## Existing functionality and integration points

`src/shared/workflows.ts` defines `WorkflowDefinition` with `defaultObjective`, optional `viewInConversationSidebar`, and per-step agent/account/model settings. There is no separate custom-objective requirement flag or template-variable schema. `src/main/db/repositories/workflows.ts` persists the flag and objective, reads fresh SQLite data via `listWorkflows`, and treats missing visibility as false. No new workflow persistence schema is indicated.

`src/renderer/src/components/workflow-detail.tsx:452–503` edits Default Objective and persists the existing sidebar switch. The switch is disabled when the objective is blank, but an already-enabled definition can lose its default, so sidebar eligibility must be independently checked. `new-run-dialog.tsx:55–77,171–177` populates manual-run objective from the default and permits editing it; this behavior must remain unchanged.

`src/preload/index.ts` exposes `cowork.db.workflows.list()` and `cowork.workflowRuns.start/list/pause/resume/cancel/retry()`. `StartWorkflowRun` takes workspaceId, optional projectId, workflowId, and objective. There is no dedicated run-get/output IPC endpoint; existing list data includes step results.

`src/main/workflows/service.ts:104–171` validates nonblank objectives, workspace existence/directory/read-write access, project/workspace consistency, and nonempty workflow steps/instructions. It snapshots the saved definition, creates the durable run, and enqueues a `workflow_run` task transactionally. It resolves existing configured model defaults and per-step overrides; sidebar launch must not override this behavior with the conversation model. Provider/agent failures remain possible and need clear feedback, not a new setup flow.

`WorkflowService.list():174–199` reconciles run status with durable task status. `WorkflowsScreen` polls this API every second with cancellation and overlap guards. Reuse this status source/pattern rather than treating a resolved start promise as completion. `execute():246–259` creates separate step conversations rather than reusing the caller's conversation.

There is no run-level `finalOutput`: `execute():337–351` stores each handoff's summary/changes/verification/unresolved/nextAction in `step.result` and returns the last step result as workflow output. `run-detail.tsx:261–272` also selects the last step for Completed runs. This is the existing final-output source, not the transcript.

`src/renderer/src/components/activity-panel.tsx:733–789` contains the Info sidebar sections (Tasks, Indexing, Todos, History), using `ActivitySection`. Browser, Changes, and Files surfaces share the panel. Add a section to Info rather than a new sidebar architecture.

`src/renderer/src/main.tsx:599–682` owns Shell navigation and wires App, ActivityPanel, workspace path, and composer ref. It keeps App mounted while WorkflowsScreen is displayed, preserving streaming state. WorkflowsScreen currently owns its selectedRunId internally and accepts only onClose; opening a particular run requires a focused selection/navigation seam, not a second detail implementation. Missing/deleted runs must produce a truthful unavailable/error state rather than an unrelated run.

`src/renderer/src/App.tsx:976–1003` resolves effective workspace from project, then conversation workingDirectory/workspaceId. App reports a path to Shell, not a workspace ID or project context. Sidebar launch needs an accurate, stale-guarded path/ID/project resolution seam. Do not blindly reuse a stored parent workspace ID when the effective working directory is a worktree. Existing workspace list/upsert infrastructure can resolve the exact current path without choosing a different directory; a project mismatch must surface clearly rather than silently dropping or changing the project.

`AppHandle` currently exposes appendTerminalSelection/appendFileSelection, not workflow-result insertion. Their implementations at App.tsx:1151–1189 append to existing text and focus the editable textarea without sending. Add an analogous focused integration for workflow output; do not masquerade workflow results as terminal/file selections. The message state lives inside App.

`src/main/agent/context/provenance.ts` provides untrusted-data envelopes, including agent provenance. Existing terminal/file composer wrappers alone do not establish a workflow-specific trust contract. Implement and test an explicit workflow-output data boundary, including adversarial text containing instructions or fake delimiters/provenance, and inspect the eventual model-bound message. Keep user-authored instructions outside that boundary. Any needed message/context change must be narrowly scoped; engine orchestration changes are not indicated.

## Assumptions and edge-case decisions

These are implementation assumptions, not additional original requirements.

A usable default means `defaultObjective.trim()` is nonempty, matching current editor/dialog/service semantics. No placeholder expansion or semantic objective validator is warranted without an existing setting. Saved step validation still applies: enabled workflows lacking steps or containing blank instructions may remain visible with an unavailable explanation, but must not appear runnable.

To preserve FR-01 discovery, show all enabled workflows; disable Run with a reason for invalid objectives/steps. This reconciles visibility with FR-02, which forbids direct execution but does not require hiding these workflows. If no flags are enabled, explain how to enable the editor setting; if flags exist but none are eligible, explain why rather than saying no workflows exist.

Use the current effective workspace and actual conversation project; for an unsent workspace-backed draft, use its selected workspace and pending project without creating a conversation merely to launch. Plain Chat currently reports an empty workspace and should show workspace-required behavior. During context loading or switching, disable launch until the new context is resolved; never run against the previous conversation's path.

Preserve existing composer text by appending an attributed result block, not overwriting a draft. No auto-send, queue, foreground abort, or approval bypass. Re-fetch completed run data before insertion where needed. Empty/missing final output should explain that no final output is available, not fabricate content or insert the transcript.

A run reference can be the stable run ID with the workflow name; a new URL/deep-link scheme is not required. Use run snapshot title/output even if the saved workflow is renamed or deleted later. View Results remains available for non-completed runs; Add to Chat is available only for Completed runs with usable output.

Prevent duplicate starts while a start request is pending; allow intentional later launches. Track launched runs by run ID so a second launch cannot overwrite the first run's status/actions. Durable conversation-to-run linkage across application restarts is not explicitly required and is not provided in the existing run schema; avoid a new schema solely for that purpose. At minimum, preserve launched-run tracking across sidebar close/reopen and explicit results navigation within the session. Existing Runs remains the durable history.

Guard asynchronous refresh/start/result reads against unmount and conversation/workspace changes. A pending launch keeps its captured origin context; a late output read must not populate a different conversation after a switch. Recover from list/start/status failures without clearing valid results into a misleading empty/completed state. A workflow deleted/edited between list and Run should be refreshed or fail clearly; never run a different workflow or stale objective silently. Polling while the sidebar is visible plus refresh on reopen is sufficient; push notifications are not required.

## Verifiable acceptance criteria

AC-01: Persist an enabled valid saved workflow, open Info, and assert its real name/Run action appears. Verify via repository-backed persistence and renderer integration.

AC-02: Persist a disabled workflow (also test absent optional flag) and assert it is absent, even when runnable elsewhere.

AC-03: Toggle enabled to disabled and back, refresh/reopen without restarting, and assert the latest database state appears. Test edits while sidebar remains mounted but hidden.

AC-04: With a conversation in workspace A/project P and a different globally available workspace B, Run must call existing start with the selected workflow ID, its default objective, exact effective workspace A, and P. Cover projectless, draft, worktree, and context-loading cases. No objective prompt.

AC-05: Verify one normal durable run/task is created and appears in existing Runs with correct snapshot/context. Mocked UI invocation alone is insufficient; include service/repository integration and a live launch when feasible.

AC-06: Launch while the conversation is streaming and with composer draft text. Assert active conversation ID, messages, composer, and foreground stream remain unchanged; conversation input remains usable and completion inserts nothing automatically.

AC-07: After start returns Active, assert Active rather than Completed; advance authoritative responses through completion and failure/pause/cancel/interruption. Confirm independent IDs for multiple launches and truthful behavior on polling errors.

AC-08: View Results selects the launched run's existing RunDetail, not just the Runs list; closing it returns to the preserved conversation. Test unloaded/missing run IDs.

AC-09: For a Completed run, Add to Chat inserts final step output with snapshot workflow name and run ID; assert no message-send/start-agent call and no full transcript. Cover missing output, unavailable run, and conversation-switch races. Verify untrusted framing through the eventual agent input, including malicious delimiter/instruction text.

AC-10: Edit inserted text, append user instructions, and assert the composer updates normally; only explicit Send may submit. Existing draft content must remain intact.

AC-11: Enabled workflows with empty/whitespace default objectives, missing steps, or blank instructions are not directly runnable; workflows with usable defaults remain runnable without changing manual custom-objective behavior.

AC-12: Missing workspace ID/path, removed directory, file-instead-of-directory, access failures, project mismatch, and stale context cause disabled/explanatory behavior. Assert no fallback to another workspace and no unintended run creation.

AC-13: Re-run sidebar Tasks/Todos/History/Indexing, browser, Files, resizing, tab switching, shortcuts, and conversation regression coverage. Perform Electron smoke checks for native browser layering and continued streaming while a workflow executes.

AC-14: Run focused new eligibility/sidebar/composer/navigation tests, existing workflow storage/service/screen/detail tests, relevant sidebar regressions, and TypeScript checks. Report exact results and separate pre-existing failures from regressions; disclose any live/provider/Electron acceptance checks not performed.

Also test FR-09 empty, all-ineligible, loading, and error states without fixtures leaking into production UI. Automated tests must cover the integration, not only component markup.

## Verification performed in this analysis step

Inspected shared workflow/run types, workflow repositories/editor, start dialog, service/IPC/preload, run outcome rendering, WorkflowsScreen polling/navigation, Shell/App/sidebar wiring, composer insertion patterns, provenance utility, and relevant test sources.

Executed `pnpm test src/main/workflows/service.test.ts src/main/db/repositories/workflows.test.ts src/main/db/repositories/workflow-runs.test.ts src/renderer/src/components/workflows-screen.test.tsx src/renderer/src/components/run-detail.test.tsx`: 70 tests total, 62 passed, 8 failed; three files passed and two failed. Service: 26 passed. Run repository: 1 passed. WorkflowsScreen: 31 passed. Workflow storage: 4 passed, 1 failed because a creation assertion expects obsolete top-level `agentName: "Cowork"`. RunDetail: all 7 failed because the test mock lacks `cowork.providers.listWithModels`. These are baseline failures on unchanged application/test code, not regressions from this analysis.

Executed `pnpm test src/renderer/src/components/browser-panel.test.tsx src/renderer/src/components/browser-slot.test.tsx src/renderer/src/components/files-panel.test.tsx src/renderer/src/components/todos-section.test.tsx src/renderer/src/components/indexing-section.test.tsx`: all 10 tests in five files passed, with React act-environment warnings. The test wrapper rebuilt native SQLite for Node and restored native modules for Electron afterward.

No feature acceptance criterion is claimed satisfied: the Workflows sidebar is not implemented in this step. No live Electron launch/provider execution, full suite, build, or typecheck was performed. No credentials/permissions blocker was encountered. Baseline test drift must be addressed in a later implementation/testing step before claiming all relevant tests pass. Material integration risks are effective workspace/project resolution, cross-conversation asynchronous updates, and preserving untrusted result provenance after composer editing.
