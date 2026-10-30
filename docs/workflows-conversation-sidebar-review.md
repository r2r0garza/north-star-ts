# Conversation sidebar Workflows — independent code review

Review scope: workflow step 5 only. Reviewed the actual tracked diff, new source/tests, implementation plan and handoff, and surrounding App, Shell, sidebar, persistence, and WorkflowService paths. No application code or tests were modified. Recommendation: request corrections before feature acceptance. Three confirmed code-path defects follow; none depends on assuming the previous step succeeded.

## Confirmed findings

### R1 — High: workflow Run can target a different directory from the current conversation

Evidence: `src/renderer/src/App.tsx:514–541` re-resolves existing-conversation workflow context from persisted records and unconditionally prefers `conversation.workingDirectory` when no project directory is set. The unlocked folder button remains available (`3030–3038`). Its handler (`1440–1455`) changes the actual composer `workspace` and persists only `workspaceId`, leaving `workingDirectory` unchanged. Conversation Send passes the new local `workspace` to chat (`1736–1743`), whereas sidebar start resolves and launches the separately published old path (`src/renderer/src/hooks/use-conversation-workflows.ts:157–168`).

Concrete path: open an unassigned conversation with workingDirectory `/old-worktree`, choose `/new-workspace` through its enabled folder picker, then Run a sidebar workflow. Chat uses `/new-workspace`; workflow context still selects `/old-worktree`. If the old directory exists, the service accepts it and executes there without warning; if removed, Run fails despite the current conversation having a valid selected workspace. This violates FR-03/04 and AC-04/12 and can operate on the wrong files. This is confirmed by the connected code paths, not an interactive reproduction.

Recommended correction: publish the same effective, settled workspace that App actually uses for chat, preserving project precedence and initial worktree resolution but respecting subsequent user selection. Avoid two divergent workspace authorities. Add a real App/controller integration regression covering an unlocked worktree conversation, folder change, and exact workflow start payload; include a removed old directory case.

### R2 — Medium: deleting an adopted conversation reuses its workflow draft alias and hides future launches

Evidence: Shell creates a workflow draft key and rotates it for New Conversation/view switches (`src/renderer/src/main.tsx:258–260,465–473,510–519`), but deletion of the active conversation only clears `activeConversationId` (`529–531`). First Send had already called `adopt(workflowDraftKey, id)` (`645–650`). The controller keeps that alias (`src/renderer/src/hooks/use-conversation-workflows.ts:214–220`) and routes all later launch responses from that draft key to the adopted conversation (`171–177`), while visible rows are selected by the current context key (`231`).

Concrete path: launch from a workspace-backed unsent draft D, Send to create C (D aliases C), delete active C, choose a workspace in the resulting fresh draft, and launch again. The fresh draft still has key D, but the new run is stored under deleted C, so its status/View Results/Add to Chat are absent from the visible sidebar despite a success toast and a real persisted run. Subsequent adoption can also leave those rows stranded. This violates FR-06/07 and AC-07/08 for that supported lifecycle. Confirmed by code-path evidence; not exercised in Electron.

Recommended correction: reset the workflow draft identity when active deletion creates a new draft, as for explicit New Conversation, and ensure aliases apply only to the original draft lifecycle. Add deletion-after-adoption coverage at Shell level, including a late in-flight launch.

### R3 — Low: explicit run navigation leaks into later ordinary Workflows navigation

Evidence: `src/renderer/src/main.tsx:283–290` sets `requestedRun` for View Results. Only WorkflowsScreen's Close callback clears it (`678–681`). Other exits unmount the overlay without clearing it, including selecting a conversation (`484–505`) or switching to another footer view (`595–619`). Ordinary Workflows navigation (`607–613`) opens the screen without clearing this request. A remounted WorkflowsScreen consumes the old request (`src/renderer/src/components/workflows-screen.tsx:92–98`).

Concrete path: View Results for run A, select another conversation from the left sidebar instead of pressing Close, then open Workflows from its normal footer entry. It unexpectedly reopens A instead of the ordinary Runs/library landing view. This is a navigation regression, confirmed by state transitions, not an interactive reproduction.

Recommended correction: consume/reset the target request after application, or clear it on ordinary Workflows entry and other exits. Add a Shell navigation regression for this sequence. Keep explicit repeated targeted requests supported.

## Verification gaps and potential risks (not confirmed production defects)

The planned mounted Shell harness was not implemented. The existing App workflow tests contain only two cases and do not launch through Shell, send a populated workflow draft, or exercise active streaming. The section test mounts WorkflowsSection alone, not ActivityPanel wiring; the targeted WorkflowsScreen test covers exact/missing IDs but not filters, request failures, or returning to a streaming conversation. The controller adoption tests manually change context and therefore do not cover R2. These are material omissions relative to plan tasks 1/3/4/5/6, especially the original streaming-independence and explicit-send acceptance gate. Recommended follow-up is focused Shell/real-send integration coverage, not broad refactoring.

Untrusted output formatting uses the existing shared envelope, encoded attribution, per-line DATA prefixes, and CR/LF normalization. I found no confirmed ordinary unedited-output trust escalation in the reviewed path. Provenance is editable text, not immutable structured metadata: send-time normalization recognizes only intact attribution/header/end-marker patterns (`src/shared/workflow-result.ts:24–40`). Arbitrary marker removal is outside the documented guarantee. Replay coverage calls the formatter/normalizer directly and supplies a mocked persisted message; it does not prove the complete composer → explicit Send → persistence → provider path. Add that planned adversarial integration check before asserting FR-08 is fully verified. No real provider prompt-injection behavior was tested.

Polling lists all workflow runs once per second while any session-tracked run exists and Info is visible, even if all tracked runs are terminal or belong to another conversation (`use-conversation-workflows.ts:73–129`). This follows existing list-based infrastructure and is not a confirmed functional failure; large-history IPC/payload cost remains a potential scalability concern, not a reason to introduce new execution machinery in this feature.

## Architecture and scope assessment

The implementation correctly reuses workflow definitions, existing start/list IPC, WorkflowService validation/task creation, authoritative run statuses, and existing RunDetail. It introduces no dependency, schema change, separate execution engine, automatic send, or results viewer. Shell owns session tracking and App stays mounted under overlays. Final output selects only the completed run's last step result; insertion preserves draft text and checks destination generation. The provenance relocation is a dependency-free shared move with importer updates, rather than unrelated agent behavior changes. Fixing reproduced stale workflow test fixtures is narrowly scoped. The main unnecessary complexity is the second independent workspace resolver, whose divergence causes R1.

## Checks actually run in this review

`pnpm test` with the 16 focused workflow/sidebar/context regression files: 16 files passed, 129 tests passed, no skips. This includes real SQLite service integration, with provider/agent/scheduler execution stubbed; it proves persisted run/task creation, not live execution independence. Existing sidebar tests emit React act-environment warnings.

`pnpm typecheck`: passed. `pnpm build`: passed. `git diff --check`: passed.

Full `pnpm test`: 224 files passed, 3 failed, 6 skipped; 2,325 tests passed, 4 failed, 95 skipped. Reproduced failures are schema-version expectations of 74 receiving 75 at `src/main/db/migrations.test.ts:123,433`, `src/main/db/repositories/index-runs.test.ts:69`, and `src/main/db/repositories/settings.test.ts:23`. These source/test files are untouched by the feature, and HEAD already contains the workflows/sidebar migration; no feature migration was added. The full suite is not green.

Inspected Git status/diff to distinguish existing implementation changes from this documentation-only review. No application/test edits, commits, or pushes were performed. Native test wrapper restored Electron modules after tests. Build produced normal ignored build outputs.

## Acceptance disposition and assumptions

Assumed session-local run tracking is intentional, visible but disabled ineligible definitions meet FR-02, plain Chat has no execution workspace, and initial project → workingDirectory → stored workspace precedence should remain unchanged. These match the implementation plan; none authorizes a divergence after an explicit folder change.

AC-01/02/03/11 and empty states have focused controller/component evidence, but persisted settings-to-mounted-sidebar behavior is not a full end-to-end test. AC-04/12 have payload and service validation evidence but are not satisfied across workspace changes because of R1. AC-05 has real SQLite persistence evidence, not a live provider/Runs smoke test. AC-06 has architectural separation and no-auto-insertion assertions, but no mounted Shell/active-stream execution evidence. AC-07 has six-status/stale/missing controller coverage but the lifecycle defect R2 remains. AC-08 has targeted detail selection evidence but R2/R3 and interactive overlay return are unresolved. AC-09/10 have real editable-composer insertion evidence, not full explicit-send/persistence/provider integration; R2 can make the action unreachable. AC-13 has passing existing sidebar regression tests, not Electron resize/keyboard/native-browser verification. AC-14 has passing focused tests/typecheck/build but four full-suite failures. No acceptance criterion is declared fully verified solely because code exists.

No credential/permission blocker prevented this review. Live Electron/provider execution, native layering, actual streaming continuity, and complete explicit-send provenance remain unverified. Correct R1–R3 and add the focused lifecycle/workspace/navigation regression coverage before final acceptance; handle the unrelated schema expectations separately without changing migration behavior merely to make tests pass.
