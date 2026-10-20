# Conversation sidebar Workflows — implementation handoff

Implemented step 4 only. No commits, pushes, dependencies, schema changes, or workflow-engine changes.

## Changes

The Info sidebar now contains a real Workflows section. Its Shell-scoped controller lists only explicitly enabled saved definitions, refreshes on reopening/returning from Workflows and on explicit Refresh, and disables definitions without a nonblank default objective or valid step instructions. Empty, loading, refresh failure, missing workspace, and launch-error states are visible.

App publishes an independently resolved ready workspace/project context with draft/conversation identity and generation guards. Project workspace takes precedence, followed by conversation workingDirectory and stored workspace. Chat exposes no execution workspace. Draft identities reset for new conversations/view switches, and tracked runs migrate when first Send adopts the draft. Existing asynchronous draft workspace resolution now has cancellation cleanup; errors leave workflow context unavailable.

Launch re-reads visibility/default/steps, resolves only the exact conversation path, preserves project ID, and invokes the existing workflowRuns.start API. Main WorkflowService retains filesystem/project/provider validation. Duplicate pending starts are guarded; intentional repeated runs remain separate. No conversation creation, send, stop, or result insertion is performed by launch. Session-local tracking survives sidebar hiding and results navigation, including draft adoption while launch is in flight. Existing authoritative list/status infrastructure is polled every second while visible; stale/missing data is labeled and does not enable Add to Chat.

View Results targets the exact run in the existing WorkflowsScreen/RunDetail independently of filters. Missing/loading/error states do not silently substitute another run. App remains mounted behind the existing overlay.

Explicit Add to Chat re-fetches a Completed run, selects only its last step result, and appends snapshot workflow name/run ID and output into the existing editable composer without sending. Existing draft text is preserved, mention menus close, focus returns, and identity/generation checks reject stale insertion destinations. Shared provenance rendering was moved without changing its implementation; importers were updated. Output lines are explicitly untrusted agent DATA, encoded attribution cannot create extra header lines, and send-time normalization restores prefixes on edited lines in identifiable inserted blocks. Persisted message replay preserves that boundary. Deliberate removal/rewrite of attribution is not an immutable provenance guarantee; the composer remains editable as required.

## Files

Application integration: src/renderer/src/App.tsx, main.tsx, components/activity-panel.tsx, components/workflows-screen.tsx; new components/workflows-section.tsx and hooks/use-conversation-workflows.ts.

Shared formatting: new src/shared/workflow-result.ts; moved main/agent/context/provenance.ts to shared/context-provenance.ts, updating the ten direct main-process importers only.

Tests: new App.workflows.test.tsx, use-conversation-workflows.test.tsx, workflows-section.test.tsx, shared/workflow-result.test.ts, and main/workflows/service.integration.test.ts. Extended WorkflowsScreen and context-builder tests. Corrected reproduced stale workflow-storage agentName assertion and missing RunDetail provider mocks without changing production behavior.

## Verification actually performed

Final focused command used pnpm test with 16 separately specified test files: App workflow composer/context, workflow controller, formatter, section, WorkflowsScreen, RunDetail, context-builder, workflow service, real SQLite service integration, workflow storage/run repository, browser panel/slot, Files, Todos, and Indexing. All 129 tests passed, no skips. Native SQLite was rebuilt for Node and restored to Electron by the repository wrapper. Existing sidebar tests emitted act-environment warnings.

The SQLite integration used real migrations/repositories and a durable enqueue fixture (provider/agent execution stubbed); it verified a normal persisted run plus workflow_run task, immutable saved definition/default/workspace/project payload, service-list visibility, unchanged origin messages, and rejected deleted directory/project without extra runs/tasks. It did not run a real provider or the live task scheduler.

pnpm typecheck passed. pnpm build passed. git diff --check passed.

Final full pnpm test: 224 files passed, three failed, six skipped; 2,325 tests passed, four failed, 95 skipped. All four failures are untouched stale version assertions expecting 74 instead of the already-current 75: two in src/main/db/migrations.test.ts, one in repositories/index-runs.test.ts, one in repositories/settings.test.ts. No migration production code was changed by this feature. The previously reported eight workflow-focused baseline failures were reproduced and their stale fixtures corrected; all those focused tests now pass.

## Acceptance evidence and limitations

Automated evidence covers enabled-only definitions/reopening/default eligibility, exact launch payload/revalidation and duplicate guards, persisted normal run/task creation, all six authoritative statuses and stale/missing handling, exact requested detail/missing-run routing, real editable composer insertion without chat invocation, project/worktree precedence and delayed resolution, stale destination rejection, final-only attribution/edited-line normalization/model-bound replay, and existing sidebar regression suites.

No live Electron smoke test or configured-provider workflow execution was performed. Therefore no end-to-end acceptance criterion is represented as fully verified solely by implementation. In particular, AC-04/05 live Runs appearance and filesystem access behavior, AC-06 continued use during actual streaming, AC-07 actual live provider progression, AC-08 overlay/native-browser behavior and return during streaming, AC-09/10 explicit-send integration through the real App persistence/provider path, and AC-13 native resize/shortcuts/layering need interactive verification. AC-14's relevant focused tests/typecheck/build pass, but the complete repository suite does not pass because of the four unrelated stale schema assertions above.

Plan deviations: a full mounted Shell harness was not added; controller, real App composer/context, existing WorkflowsScreen, SQLite service, and existing sidebar suites provide focused integration coverage instead. Full explicit-send/persistence from App and streaming-state preservation were not exercised together; shared formatting/replay and no-auto-send tests are narrower evidence. No claim of absolute provenance safety against arbitrary intentional marker removal is made. Run tracking is intentionally session-local, not a new durable conversation/run relationship.
