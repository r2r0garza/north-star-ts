# Conversation sidebar Workflows — implementation plan

Scope: step 3, Implementation Planning. Execute the tasks below in order in the implementation step; this step changes documentation only. Inputs are `docs/workflows-conversation-sidebar-requirements.md` and `docs/workflows-conversation-sidebar-architecture.md`, checked against current source. No application changes, commits, or pushes are part of this step.

## Decisions and boundaries

Show Workflows only in the existing Info sidebar, not as a new tab or in the Changes fallback. Show persisted definitions with `viewInConversationSidebar === true`; enabled definitions with unusable defaults or steps remain discoverable with disabled Run and a reason. A usable objective is a nonblank trimmed `defaultObjective`; do not introduce custom-objective modes or template resolution.

Use existing `cowork.db.workflows.list`, workspace list/upsert, and `cowork.workflowRuns.start/list`. The service owns filesystem/project/configuration validation, immutable run snapshots, durable task creation, independent execution, and status reconciliation. No new database migration, IPC endpoint, dependency, execution abstraction, or engine change is planned. Service list responses already contain final step results.

Track launches per conversation/draft for the current Shell session, including sidebar hiding, results navigation, and draft adoption. Durable conversation/run linkage across restarts is not required; existing Runs remains durable history. A run reference is its stable ID, not a new deep-link scheme. Final output is `run.steps.at(-1)?.result` for a Completed run; never collect the full transcript. Workflow identity/name comes from the run snapshot, even after library edits/deletion.

## Dependency-ordered implementation tasks

### Task 1 — Publish ready conversation context and stable destination identity

Change `src/renderer/src/App.tsx` and `src/renderer/src/main.tsx`. Add a narrow renderer-local context callback carrying conversation/draft identity, context generation, effective workspace path, actual project ID, and readiness. Keep the existing `onWorkspaceChange` contract unchanged for Files/browser/terminal. Publish not-ready immediately on conversation, mode, pending-project, or workspace transitions; publish ready only after the current asynchronous resolver finishes. Errors must leave workflow launch unavailable rather than reuse the previous path.

Preserve App's existing project workspace → conversation workingDirectory → conversation workspace precedence. Plain Chat has no executable workspace. A workspace-backed unsent draft uses its selected path and pending project without creating a conversation. Give fresh drafts a stable Shell identity independent of the rotating terminal draft ID; migrate launch tracking to the created conversation on first Send. Capture generation as well as identity to reject stale operations after switching away and back.

Add `src/renderer/src/App.workflows.test.tsx` and `src/renderer/src/main.workflows.test.tsx` as focused integration harnesses (export Shell only if required for mounting it). Cover delayed project resolution, rapid switching, projectless/project-backed drafts, changing draft workspace, new draft reset, and draft adoption. Do not extract unrelated App/Shell functionality merely to ease tests.

### Task 2 — Add the feature-local launch/status controller

Create `src/renderer/src/hooks/use-conversation-workflows.ts` and its `.test.tsx`. Invoke it unconditionally at Shell scope; the conditionally mounted section must not own run tracking. Keep eligibility checks local to this feature and validate objective, nonempty steps, and nonblank step instructions without changing shared workflow semantics.

Load definitions on Info visibility/reopen/return from editing and explicit Refresh. Before Run, synchronously guard duplicate pending starts for that workflow, capture ready context, re-read definitions, and recheck the selected ID, visibility, and eligibility. Resolve only the captured exact path through workspace list/upsert (including hidden workspaces/worktrees); never choose the first/parent workspace or infer another project. Recheck identity before invoking `start({workflowId, objective: freshDefault.trim(), workspaceId, projectId})`. Preserve the actual project and surface mismatch/deleted-path/provider errors; never drop context to force success.

Store the returned run immediately under its captured origin and show started feedback with its actual status, not assumed completion. Keep intentional subsequent launches by distinct IDs, including launches whose definition is later hidden/deleted. Poll authoritative `workflowRuns.list` at the existing one-second cadence while visible with tracked runs; guard overlap, pause on hide, refresh on return, and clean up on unmount. Prevent older in-flight lists from overwriting newly returned runs. On refresh failure retain last-known data labeled stale; a missing run is unavailable. Do not enable Add to Chat on stale data.

Controller tests must cover default-objective selection, exact workspace/project payload, revalidation after edits, absent flags, invalid steps, duplicate clicks, all six statuses, multiple launches, stale/missing runs, rejected requests, polling cleanup, and late responses across context changes. No calls to conversation send/stop/create are allowed in this controller.

### Task 3 — Render the sidebar integration without altering existing sections

Create `src/renderer/src/components/workflows-section.tsx` and `.test.tsx`; change `src/renderer/src/components/activity-panel.tsx` and Shell wiring in `src/renderer/src/main.tsx`. Reuse ActivitySection and existing buttons/badges/layout. Pass controller state/actions and actual visibility (Info selected, panel open, no hiding overlay); do not add independent polling in the section.

Render real enabled workflows with Run, workspace/eligibility reasons, pending state, Refresh, loading/error/empty states, and tracked run rows with truthful status and View Results. Distinguish no enabled definitions from enabled-but-unrunnable definitions and failed loading. Offer Add to Chat only for fresh Completed runs with nonblank final output; explain unavailable output. No mock definitions/results or new objective prompt. Preserve Tasks, Indexing, Todos, History, Files, Changes, browser, sidebar width, and shortcuts.

Tests should mount the section and its ActivityPanel wiring, checking enabled/disabled/legacy visibility, refresh/reopen, every unavailable/empty state, action callbacks, and that the section does not leak into non-Info tabs.

### Task 4 — Route View Results into the existing run detail

Change `src/renderer/src/components/workflows-screen.tsx`, its existing test, and Shell. Add an optional targeted-run request consumed into existing selection state; clear workflow selection and activate Runs. Select the exact ID from the complete saved-run list regardless of list filters. Show loading/error/unavailable states for unresolved requested IDs rather than silently opening another run or the generic list. Support repeated explicit requests when already mounted.

The Shell handler opens the existing overlay and closes conflicting center overlays without changing conversation/view identity or unmounting App. Only explicit View Results navigates. Close restores the preserved conversation. Test exact selection, filtered runs, repeat requests, loading/error/missing IDs, and close/return with active streaming state intact.

### Task 5 — Append editable, attributed final output with an untrusted boundary

Change `AppHandle`/composer handling in `src/renderer/src/App.tsx`, Shell, and the feature controller. Add a typed `appendWorkflowResult` method with expected destination identity/generation. On explicit Add to Chat, capture destination, re-fetch authoritative run data, require exact ID + Completed + nonblank final step result, and recheck destination after awaits. Append snapshot workflow name, run ID, and only final output, preserving draft text; close mention menus and focus the textarea. Do not submit, queue a turn, create a conversation, navigate, stop a stream, or inject output automatically.

Create `src/shared/workflow-result.ts` and `.test.ts` for attributed formatting. Reuse the dependency-free provenance envelope by moving `src/main/agent/context/provenance.ts` to `src/shared/context-provenance.ts` and updating its direct importers; preserve its API/behavior, with no main-process import from renderer and no generic context refactor. JSON-encode attribution and prefix every output line as untrusted agent data, including forged headers/delimiters; visibly separate subsequent user instructions.

Test ordinary edits, added instructions, mention expansion, explicit Send, persistence, and replay through the actual model-bound message in the App harness and `src/main/agent/context/context-builder.test.ts`. If ordinary textarea edits can break generated line boundaries, normalize only identifiable inserted workflow blocks at send time and test that path. Do not treat output-supplied markers as trusted authority or claim a visible label alone proves provenance. User removal/rewrite of the entire attribution is outside any immutable-security guarantee; the composer must remain editable.

### Task 6 — Establish integration and regression evidence

Add `src/main/workflows/service.integration.test.ts` using real temporary SQLite/migrations/repositories and a durable enqueue fixture; stub only provider/agent execution as needed. Use existing `src/main/db/repositories/workflow-runs.test.ts` native-test patterns. Prove the sidebar launch contract produces one normal persisted WorkflowRun and workflow_run task, correct snapshot/default/workspace/project, service-list visibility, and no writes to the origin conversation/messages. Exercise invalid directory/project paths with no run created. Do not replace the engine to make the test pass.

Re-run and, if reproduced, correct only the known stale test fixtures: `src/main/db/repositories/workflows.test.ts` expects obsolete top-level agentName; `src/renderer/src/components/run-detail.test.tsx` lacks provider API mocks. Preserve production provider behavior. These eight failures were reported by step 1, not rerun or verified in step 3.

## Verification and acceptance gate

Use the repository's `pnpm test` wrapper so native SQLite is rebuilt/restored correctly; pass multiple test paths as separate arguments, not a single quoted filter. Run new controller/section/App/Shell/shared-formatter/service-integration tests, then existing workflow storage, run repository, service, WorkflowsScreen, RunDetail, context-builder, browser-panel, browser-slot, files-panel, todos-section, and indexing-section suites. Run `pnpm typecheck`, `pnpm build`, and the full `pnpm test` suite when feasible. Record actual pass/fail/skip counts and separate reproduced baseline failures from regressions; a skipped native test is not SQLite evidence.

| Acceptance | Required evidence before claiming satisfaction |
| --- | --- |
| AC-01–03, AC-11; FR-09 | Persist enabled/disabled definitions; renderer shows only enabled entries, disables unusable defaults/steps, handles empty/error states, and reflects edits after refresh/reopen without restart. Keep manual objective entry unchanged. |
| AC-04–05, AC-12 | Controller payload tests plus real SQLite run/task integration for exact current workspace/default/project; negative missing/loading/removed/file/inaccessible/mismatched context cases show errors and never substitute workspace. Live launch appears in normal Runs. |
| AC-06 | Mounted App/Shell test launches during streaming with an existing draft: identity/messages/draft/foreground stream unchanged, input still usable, no automatic insertion on completion. Confirm in Electron. |
| AC-07 | Fake-timer/controller tests for authoritative Active/Completed/Paused/Cancelled/Failed/Interrupted, multiple IDs, stale/error/missing data; real run status observed in Electron. |
| AC-08 | Existing RunDetail opens the exact launched ID, including after filters; error/missing handling and Close preserve App. Electron navigation/return smoke check. |
| AC-09–10 | Real composer integration verifies final output only, snapshot name + run ID, preserved draft, editable text, no send until explicit action, destination-race rejection, and untrusted data surviving send/persistence/model-bound replay with adversarial output. |
| AC-13–14 | Focused and existing regression suites plus typecheck/build; Electron checks for resize, Info/Changes/Files/browser switching, native-browser layering, shortcuts, and continued conversation use. Report all failures and unperformed checks. |

Electron smoke flow: enable a saved workflow with a default, return to a workspace/project conversation, refresh Info, run while chatting, observe authoritative status, explicitly open/close its existing detail, then append a completed result, edit it and add instructions without sending. Toggle visibility back off and reopen; repeat with no workspace and a removed directory. Use a configured provider for a real completion if available; otherwise report that live execution/completion and affected acceptance checks remain unverified rather than simulate success.

## Planning-step verification and handoff

Reviewed both prior documents and current App/Shell/sidebar wiring, run types, service start/status reconciliation, results navigation, provenance envelope/replay, SQLite test pattern, and package verification commands. Confirmed the proposed integration uses existing APIs; no application/test code was changed and no feature acceptance criterion is claimed satisfied here. Implementation tests, typecheck, build, and live Electron/provider checks are future work, not results of this planning step. No planning blocker was found. A local document check validated 18 explicit paths (11 existing, seven proposed) and coverage of AC-01 through AC-14; its initial literal-only acceptance check was corrected to expand ranges such as AC-01–03. Git diff showed no tracked changes; status contained only documentation.
