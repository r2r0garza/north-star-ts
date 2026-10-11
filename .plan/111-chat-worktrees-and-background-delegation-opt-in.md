# PR111: Chat worktrees and background delegation opt-in

> Status: **PLANNED** (2026-10-11). Analysis and implementation proposal only; no application code changes in this task.
> Decision: one default-off checkbox controls both North Star subagent spawning and its associated writer-worktree workflow. Background execution itself remains available when unchecked.

## Objective and interpretation

Add an explicit checkbox to the North Star chat composer so the user decides whether the main agent may delegate work to subagents, including isolated implementation in Git worktrees. Carry that decision into background execution without relying on the foreground model to remember or rewrite it into a task description.

Unchecked means the main agent does the work itself in the selected workspace, whether foreground or background. Checked means delegation is available subject to existing policy, not required. The background task's main agent still chooses whether delegation is useful, which permitted children to use, and whether their assignments are read-only or writing.

Worktrees and subagents are different concepts: read-only children do not require writer worktrees, and a parent could invoke Git worktree commands without spawning a child. For this request, deliberately couple them in one opt-in; unchecked disables even read-only subagents. Do not implement a second mode that allows writing children to share the parent's checkout. Do not relocate the background main agent into a worktree merely because the checkbox is checked.

## Current implementation and the gap

`src/main/settings/service.ts` already defines `allowConversationSubagents`, defaulting to false. `src/renderer/src/components/settings-screen.tsx` exposes it as “Allow agents to delegate to subagents,” with copy saying it applies to new conversation turns rather than Process runs. There is no equivalent composer checkbox in the inspected chat path.

`runChat` in `src/main/agent/index.ts` snapshots that global setting into `conversationSubagentsEnabled`. The shared loop uses `opts.conversationSubagentsEnabled !== false`: explicit false suppresses spawning, while omission preserves the historical behavior for direct callers. Both the named-child `spawn_subagent` and batch `spawn_subagents` paths must be considered; the built-in main agent can receive the batch tool even without a custom agent definition.

The permission does not currently cross the background boundary. `src/main/agent/tools/run_todos_in_background.ts` hands off the todo snapshot and Auto mode, but not delegation permission. The user-button route through `src/renderer/src/components/todos-section.tsx` and `src/main/ipc/task-handlers.ts` likewise passes only Auto mode. `TaskRunner.enqueue` in `src/main/tasks/runner.ts` persists task input and forks a private worker conversation; its execution path calls `runAgentLoop` without `conversationSubagentsEnabled`. Consequently, a false foreground setting can become an omitted value in the worker, which enables the background parent's spawn capability again. This is a policy propagation gap, not proof that every background task actually spawns children.

The batch implementation in `src/main/agent/index.ts` creates writer worktrees for assignments with `access: "write"`, after repository lease/preflight checks. Read-only assignments do not use this writer-worktree path. Existing isolation, commit/handback, parent integration, cancellation, and artifact-quarantine behavior must remain intact when enabled.

## Product behavior

Use a checkbox labeled **Allow subagents / worktrees** near the North Star composer execution controls. Suggested help text: “Allow this chat and its background tasks to delegate work. Writing subagents use isolated Git worktrees. Off: the main agent works alone in the current workspace.” This is more accurate than a bare “Worktrees” label because unchecked also disables research children.

New North Star chats start unchecked, regardless of a legacy global true preference. Maintain the explicit selection per conversation for the current app session, including switching away and back; fresh conversations and an app restart default to off. A selection made before the first message must transfer to the created conversation. Only queued task snapshots need durable persistence; do not introduce a conversation DB migration solely for this checkbox.

The checkbox is independent of Default, Plan, and Auto modes. Enabling Auto must not enable delegation; checking this box must not bypass approvals or Plan-mode restrictions. Disable changes while that conversation has an active foreground turn so the UI cannot imply that an already-snapshotted run was changed. Previously queued/running background tasks retain their own visible snapshot; changing the composer affects future sends and future user-triggered handoffs, not those tasks.

This proposal scopes the new checkbox to North Star chat. Preserve existing behavior for other chat modes and for Process/Mission Control execution. Reword the existing global setting's help text to make clear that it governs other live conversation paths, not this explicit North Star opt-in or already-created background tasks. Do not use two independently required switches: in North Star, checking the composer box supplies the opt-in even if the legacy global setting is false. Existing agent/provider capability restrictions still narrow it.

## Policy contract and background lifecycle

Use one internal delegation boolean, reusing `conversationSubagentsEnabled` where practical instead of adding separate, potentially contradictory worktree/subagent flags. Extend the chat request and preload/renderer types to carry the checkbox value. Resolve an explicit boolean in the main process; do not accept truthy strings or let an omitted North Star value fall back to the global opt-in.

Snapshot at foreground turn start for model-triggered handoffs. The `run_todos_in_background` schema remains argument-free: the model cannot select or override the user's permission. The trusted tool context/enqueue wrapper supplies it. For the direct “Run all in background” button, snapshot the selected source conversation's current checkbox value at click time, not another open chat's state.

Persist an explicit true or false in `tasks.input` for chat-originated `agent_chat` and `todo_run` tasks, alongside `autoMode`, and pass it back into `runAgentLoop` on every execution. Pause/resume, retry, backoff, provider switching, and app restart must use the persisted snapshot rather than rereading current settings or renderer state. A task created with false must never gain permission because its field was dropped during serialization.

Background-to-background handoffs inherit the parent's task snapshot. A worker must not upgrade a disabled permission via enqueue arguments or re-delegation. Centralize authoritative attachment of the effective permission at the loop/enqueue boundary so future handoff producers cannot accidentally omit it. Identify chat-origin task kinds/provenance explicitly; do not infer policy from message text, titles, or a missing source conversation.

Existing chat-originated `agent_chat`/`todo_run` tasks without the field resume with false, including tasks whose source conversation has since disappeared. This intentional conservative compatibility rule prevents old pending tasks from silently retaining unrequested delegation. Do not globally change the shared loop's omission semantics for Process or Mission Control callers; their independent policies remain unchanged.

Expose the snapshot in handoff approval details and the background task's existing details/status surface, for example “Subagents/worktrees: off.” Do not imply that an enabled task has actually created a worktree.

## Enforcement and instructions

Tool availability is the primary enforcement for North Star-managed delegation. With false, omit both spawn tool definitions, omit spawn-specific catalog/guidance, and leave both spawn callbacks unavailable. Verify that progressive discovery cannot expose either tool and that stale/replayed model calls cannot execute them: the dispatcher must reject calls that are not permitted by the effective run policy before any worker record, model request, lease, or worktree is created. Reuse existing dispatch checks if they already provide this guarantee; otherwise add the narrow guard at the shared spawn boundary.

Also inject a concise runtime-owned instruction into both the foreground run and the background parent, reconstructed from the structured snapshot rather than copied through model-authored todo content:

> Subagents and worktrees are disabled for this run. DO NOT USE WORKTREES. Do not spawn or launch other agents, including through shell commands or external services. Complete the task yourself in the selected workspace. Sending work to the background does not change this restriction.

When true, explain that subagents are permitted, not mandatory, and writing children must use the existing isolated-worktree workflow. Preserve named-child authorization, tool allowlists, depth/cycle limits, Plan mode, provider capability restrictions, approvals, repository preflight, and cleanup guarantees. A true checkbox cannot grant a capability otherwise denied by the runtime.

Removing spawn tools deterministically prevents North Star's built-in child workflow; it does not create a universal sandbox ban on `git worktree add`, external agent CLIs, scripts, or arbitrary MCP services. The runtime instruction explicitly forbids these alternatives when off. Do not advertise complete command-level prevention or attempt a fragile shell-string denylist in this feature. If a hard prohibition on all worktree creation or all external delegation is required, that needs a separately scoped execution-policy design. Existing worktrees must not be deleted or cleaned up just because the checkbox is unchecked; a user-selected workspace may itself already be a worktree.

## Implementation sequence

### Task 1: Wire the explicit North Star opt-in

Trace composer state and request types in `src/renderer/src/App.tsx`, `src/preload/index.ts`, and their declared renderer API types. Add the accessible checkbox, session-scoped conversation selection, and explicit request field. Resolve the effective setting in `runChat`, retaining existing global-setting behavior outside North Star. Update settings help text to explain precedence.

Acceptance: a fresh North Star chat sends false, checked sends true, and a legacy global true cannot silently enable a fresh North Star chat. Keyboard interaction, focus, disabled state, conversation switching, and first-send conversation creation preserve the intended UI state.

### Task 2: Carry and persist the snapshot through every chat handoff

Extend the enqueue/tool-context contracts in `src/main/agent/tools/types.ts`, the loop wrapper in `src/main/agent/index.ts`, `TaskInput`/`enqueue`/execution in `src/main/tasks/runner.ts`, and the direct task IPC/preload contracts. Update `run_todos_in_background.ts` only as needed to consume the trusted snapshot; keep its model schema argument-free. Wire the Todos button through `src/renderer/src/main.tsx`, `components/activity-panel.tsx`, and `components/todos-section.tsx` using the source conversation's selection. Audit generic `task:start` and all chat-origin enqueue producers, not just the todo tool.

Acceptance: both true and false survive serialization, both handoff routes agree, recursive handoffs cannot widen permission, and retries/resumes use task input. Missing legacy chat-task values resolve to false without changing independent Process/Mission Control behavior.

### Task 3: Align tool enforcement, runtime context, and task visibility

Reuse the shared loop's existing delegation gates; cover both tool names and direct execution guards. Add the runtime instruction and task/approval snapshot display without duplicating a second policy source or modifying model-authored todos. Preserve enabled writer-worktree behavior rather than adding a shared-checkout fallback.

Acceptance: an off worker cannot call either built-in spawn path even with stale model history; it still has the ordinary tools needed to finish independently. An on worker may choose to work alone, explore with a read-only child, or use a permitted isolated writer. No worktree is created simply by enabling the checkbox.

### Task 4: Regression and manual qualification

Extend `src/main/agent/tool-error-feedback.integration.test.ts`, `src/main/agent/tools/run_todos_in_background.test.ts`, `src/main/tasks/runner.test.ts`, relevant task IPC/preload tests, and composer/Todos tests. Test the full false/true matrix with Auto both off and on, named and batch spawn tools, Plan approval transitions, stale spawn calls, and progressive discovery. Assert absence of worker/task/artifact creation and worktree helper calls for rejected spawning.

Exercise handoff approval denial, both background-start entry points, nested handoffs, pause/resume, retry, restart recovery, legacy missing fields, settings changes after enqueue, and two conversations with different selections. Confirm no changes to independent Process/Mission Control execution. Enabled-path regressions must retain writer preflight failure behavior, read-only execution without writer worktrees, cancellation, quarantine, and parent-only integration.

Run the repository's relevant tests, TypeScript checks, and build using its existing commands. Manually inspect checkbox placement, keyboard accessibility, disabled-state behavior, explanatory copy, and background snapshot visibility. Use isolated temporary test repositories for writer tests; do not create worktrees in the user's active repository merely to qualify the checkbox.

Acceptance: evidence covers UI defaults, end-to-end policy propagation and deterministic built-in enforcement. Report the shell/MCP limitation accurately rather than claiming an unimplemented sandbox guarantee.

## Scope boundaries

This plan adds one user-facing opt-in and closes chat-to-background policy loss. It does not force parallelism, add automatic parent worktrees, permit shared-checkout writing children, create a separate read-only delegation setting, change background approval requirements, cancel existing tasks when a box changes, clean up existing worktrees, redesign Process/Mission Control, or implement a universal external-agent/worktree sandbox.

Only this new `.plan/` file is created for the current request. Existing startup-guide edits and its untracked test are unrelated and must remain untouched.
