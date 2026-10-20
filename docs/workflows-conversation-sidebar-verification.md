# Conversation sidebar Workflows — final verification report

Verification date: 2026-10-19. Scope: workflow step 6, independent assessment only. No application code or tests changed, no commits or pushes, and no live application database or configured-provider workflow was used. This report is the only file created in this step. Existing implementation and review documents were treated as reference material and checked against source and fresh command results.

## Verdict

Not ready for final manual acceptance or release. The integration is implemented rather than a UI mock, but three independently corroborated code-path defects remain, including a high-severity wrong-workspace launch. Passing focused tests do not cover these lifecycle paths. Manual exploratory testing can proceed in a disposable workspace, but mandatory acceptance is not established and wrong-workspace execution should be corrected first.

## Implementation assessed

The Info sidebar embeds WorkflowsSection using a Shell-owned controller. Enabled saved definitions are obtained through existing database IPC; refresh and reopen reload them. Definitions without a usable default objective or nonempty instructions remain visible but disabled. Run revalidates the saved definition and calls existing workflowRuns.start with the objective, resolved workspace ID, and project ID. WorkflowService validates the filesystem/project and persists a normal run and workflow_run task. No separate executor, dependency, schema migration, automatic chat submission, or sidebar results viewer was added.

Session-local tracked runs poll existing authoritative statuses. View Results targets the existing WorkflowsScreen/RunDetail. Explicit Add to Chat re-fetches completed final-step output, adds workflow/run attribution, and appends it to the editable composer. Shared provenance envelopes mark output untrusted, with send-time normalization and replay tests. These text boundaries are editable, not immutable provenance metadata.

## Fresh verification evidence

`pnpm test` executed the full repository suite: 224 files passed, three failed, six skipped; 2,325 tests passed, four failed, 95 skipped. Exit code 1. Failures are assertions expecting SQLite user_version 74 but receiving 75 at src/main/db/migrations.test.ts:123 and :433, src/main/db/repositories/index-runs.test.ts:69, and src/main/db/repositories/settings.test.ts:23. Git comparison confirms these tests and migration source are unchanged from HEAD; HEAD already contains sidebar-setting migration support. These are unrelated stale expectations, not evidence of a new feature migration. The suite nevertheless is not green; skipped cases are not verification.

A separate focused `pnpm test` invocation passed all 129 tests across 16 files, with no skips: App.workflows, use-conversation-workflows, workflows-section, workflows-screen, run-detail, shared/workflow-result, context-builder, workflow service, workflow service.integration, workflows repository, workflow-runs repository, browser-panel, browser-slot, files-panel, todos-section, and indexing-section. Existing sidebar tests emitted React act-environment warnings. The SQLite integration uses an in-memory database and temporary directory, real migrations/repositories, mocked provider/agent execution, and a durable enqueue fixture rather than the live scheduler. It verifies persisted normal run/task creation, workspace/project/objective payloads, service-list visibility, unchanged origin messages, and rejection of nonexistent directories and deleted projects. It does not prove live workflow execution or active conversation streaming continuity. Both test invocations restored native modules for Electron successfully.

`pnpm typecheck` passed. `pnpm build` passed. `git diff --check` passed. Source and Git status/diff were inspected, including existing workspace selection, draft adoption/deletion, targeted navigation, final output formatting, and surrounding service validation. No Electron GUI or provider smoke test was performed; no browser-control tool is available in this session. No credential or permission blocker occurred for the checks run.

## Acceptance disposition

“Verified” below means demonstrated by the named automated checks within their stated scope, not a claim of complete Electron end-to-end acceptance. “Failed” includes a concrete counterexample established by connected source paths, even if not interactively reproduced. “Unverified” means evidence is insufficient for the complete criterion. No criterion was blocked by credentials or permissions.

### AC-01 — Verified at controller/component scope

Enabled definitions are retained by the controller and rendered by WorkflowsSection; focused tests passed and ActivityPanel/Shell wiring was inspected. A real persisted-setting-to-mounted-Electron-sidebar sequence remains unverified.

### AC-02 — Verified at controller scope

The controller filters strictly on viewInConversationSidebar === true; disabled definitions are excluded and a launch rechecks current visibility. Focused tests passed. Native end-to-end discovery remains unverified.

### AC-03 — Verified at controller scope

The reopen test changes the returned saved definitions and verifies updated discovery without restarting; explicit Refresh uses the same fetch path. Existing editor/persistence coverage passed. The entire editor-save → close/reopen sidebar UI sequence was not exercised together.

### AC-04 — Failed

Normal launch-payload and real SQLite persistence checks pass, including predefined objective and project association. However R1 permits launch into an old workingDirectory after the current conversation's folder picker selects another valid workspace. Thus the criterion is not met across supported workspace changes.

### AC-05 — Verified at persistence/service scope

The real SQLite test proves normal persisted WorkflowRun and workflow_run task creation and visibility through the existing service list; existing Runs/detail tests pass. The configured-provider scheduler and live Runs UI appearance were not exercised together.

### AC-06 — Unverified

Launch code uses the independent workflow service, does not invoke chat/send/stop, and tests assert no automatic insertion and unchanged origin messages. App remains mounted under results overlays by source inspection. No mounted Shell active-stream launch/continued-send test or live concurrent execution was performed, so complete execution independence is not established.

### AC-07 — Failed

All six authoritative statuses, stale refreshes, missing runs, and non-completion on launch have passing focused coverage. R2 nevertheless hides subsequent newly launched runs after deleting a draft-adopted active conversation, making their sidebar status unavailable. Live provider progression also remains unverified.

### AC-08 — Failed

Targeted existing detail selection and missing-run behavior pass component tests. R2 can make View Results unreachable for a newly launched run, and R3 leaks a prior target into later ordinary Workflows navigation. Native overlay/return behavior was not exercised.

### AC-09 — Failed for affected lifecycle; otherwise demonstrated at composer scope

Controller and real App tests show explicit completed final-output retrieval, workflow/run attribution, existing draft preservation, stale-destination rejection, and no automatic chat submission. R2 can hide the completed run and its Add to Chat action entirely. Full composer → explicit Send → persisted message → provider processing, including untrusted-output handling, remains unverified as an integrated path.

### AC-10 — Verified at real App composer scope

The App test inserts attributed output into an enabled textarea, edits it through an input event, and asserts chat is never invoked automatically. A live Electron editing/send smoke test remains outstanding.

### AC-11 — Verified at eligibility/controller/component scope

Blank defaults and unusable steps are rejected, Run is disabled with an explanation, and saved visibility/eligibility is checked again before launch. The existing custom-objective setting/service semantics are not redefined. Assumption: enabled but ineligible workflows may remain visible if not directly runnable, as permitted by FR-02.

### AC-12 — Failed

Missing context blocks launch with an explanation, and the real service test rejects invalid directories/projects without creating extra runs/tasks. R1 can silently select the old directory despite a valid newly selected current workspace, violating the no-fallback/current-workspace requirement.

### AC-13 — Unverified overall

All ten existing browser panel/slot, Files, Todos, and Indexing tests pass. This is regression evidence, not proof of native resizing, keyboard shortcuts, browser layering, every task surface, or uninterrupted conversation use. R3 is also a confirmed surrounding-navigation regression.

### AC-14 — Failed overall

The 129 focused tests, typecheck, build, and whitespace validation pass, and this report explicitly identifies unverified criteria. The full repository suite still has four failures and 95 skipped tests. This cannot be represented as full automated acceptance.

FR-09 empty-state rendering has passing focused component evidence: real empty definitions show enable-setting guidance, not placeholder definitions/results. No extra mandatory-criterion status is inferred from that test.

## Unresolved defects

R1, high: App.tsx:530–537 resolves sidebar context from persisted workspace/project and then overrides it with conversation.workingDirectory when no project workspace exists. pickWorkspace at :1440–1455 changes chat's local workspace and persists only workspaceId, not workingDirectory. The controller launches the independently resolved old path at use-conversation-workflows.ts:157–168. For an unlocked worktree conversation, selecting a new folder leaves chat and workflow execution targeting different directories. Fix by sharing the settled effective conversation workspace authority; add a real App/controller folder-change launch regression, including removal of the old directory. Not interactively reproduced in this step.

R2, medium: main.tsx:529–531 clears activeConversationId on deletion but does not rotate workflowDraftKey. First Send already aliases that draft to the created conversation at :645–646. The controller retains the alias at :214–220 and stores subsequent responses under the deleted conversation at :171–177, while visible runs use the current context key at :231. Deleting an adopted conversation and launching from the resulting fresh draft can therefore hide status, View Results, and Add to Chat. Rotate fresh draft identity on deletion and cover late launches at Shell level. Not interactively reproduced in this step.

R3, low: main.tsx:283 retains requestedRun until the explicit Close handler at :678–681. Conversation selection and other overlay exits do not clear it; ordinary Workflows entry at :607–613 reuses it. WorkflowsScreen.tsx:92–98 reapplies the old run on remount. Consume/reset targeted navigation or clear it on ordinary entry/alternative exit, and add a Shell navigation regression. Not interactively reproduced in this step.

These are the same findings reported in the previous review, independently checked against current source; this verification step intentionally does not repair application code/tests.

## Outstanding acceptance work and risks

Correct R1–R3 and add targeted workspace, deletion/adoption (including late responses), and navigation regressions before final acceptance. Handle the four unrelated schema-version assertions separately without altering migration behavior simply to satisfy tests. Rerun the focused/full checks after corrections.

A disposable-workspace Electron acceptance pass must cover persisted toggle refresh, current workspace/project launch, normal Runs visibility, actual status progression, continued active streaming and conversation use during execution, View Results and return, editable final-only Add to Chat without submission, invalid/missing workspaces, and existing sidebar/native-browser behavior. Add the missing integrated explicit-send/persistence/provider provenance test before asserting FR-08 end-to-end safety. Arbitrary removal of text provenance markers remains a limitation. Session-local tracking and one-second all-runs polling are existing integration choices; large-history payload cost remains an unmeasured scalability risk, not a demonstrated defect.

Conclusion: verification/reporting step completed; feature acceptance not achieved. No production data was touched and no application/test fixes were made under this verification-only assignment.
