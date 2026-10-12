# PR111: Chat worktrees and background delegation opt-in

> Status: **RESCOPED — LEAK FIX ONLY** (2026-10-11 roadmap review). Previously **PLANNED**.

## Rescope decision (2026-10-11)

Ship only the policy-leak fix now. `TaskRunner` (`src/main/tasks/runner.ts`, the `runAgentLoop` call in
task execution) omits `conversationSubagentsEnabled`, and the shared loop treats omission as enabled
(`opts.conversationSubagentsEnabled !== false`). A background task can therefore spawn subagents even when
the user's "Allow agents to delegate to subagents" setting is off.

**In scope:** snapshot the existing global delegation setting as an explicit boolean when a chat-originated
`agent_chat`/`todo_run` task is enqueued (both the `run_todos_in_background` tool and the Todos button
route), persist it in `tasks.input`, and pass it into `runAgentLoop` on every execution, resume, retry and
restart. Legacy chat-originated tasks without the field resolve to `false`. Background-to-background
handoffs inherit the parent snapshot and cannot widen it. Process and Mission Control callers keep their
own independent policy; do not change the loop's global omission semantics.

**Acceptance:** with the setting off, a background worker is offered neither `spawn_subagent` nor
`spawn_subagents`, and stale calls are rejected before any worker, lease or worktree is created; with it on,
existing behavior is unchanged. Tests cover both values, both handoff routes, resume/retry and legacy tasks.

**Deferred:** the per-chat composer checkbox, first-message locking and a background-specific permission
separate from the global setting (the original proposal below). Revisit only if a single global setting
proves insufficient in practice.

---

## Original proposal (deferred)

> Original status: **PLANNED** (2026-10-11). Analysis and implementation proposal only; no application code changes in this task.
> Decision: one default-off composer checkbox controls whether a chat-originated background task's main agent may spawn subagents. Writing subagents use the existing writer-worktree workflow; worktrees are not an independent opt-in. Background execution itself remains available when unchecked, and foreground delegation policy is unchanged.

## Objective and interpretation

Add an explicit checkbox to the North Star chat composer so the user decides whether a background task's main agent may spawn subagents. The composer is where the user selects the permission; the background parent is where it takes effect. Carry that decision into background execution without relying on the foreground model to remember or rewrite it into a task description. This checkbox does not change whether the foreground chat agent may spawn subagents.

Unchecked means the background main agent does the work itself in the selected workspace. Checked means background delegation is available subject to existing policy, not required. The background task's main agent still chooses whether delegation is useful, which permitted children to use, and whether their assignments are read-only or writing. Background execution does not require delegation and remains available in either state.

Worktrees are an implementation consequence of writing subagents, not a separately selectable capability: read-only children do not require writer worktrees. Unchecked disables all background subagents, including read-only children. Do not implement a second mode that allows writing children to share the parent's checkout. Neither starting a background task nor checking the box relocates the background main agent into a worktree; writer worktrees are created only when the existing writing-subagent workflow needs them.

## Current implementation and the gap

`src/main/settings/service.ts` already defines `allowConversationSubagents`, defaulting to false. `src/renderer/src/components/settings-screen.tsx` exposes it as “Allow agents to delegate to subagents,” with copy saying it applies to new conversation turns rather than Process runs. There is no equivalent composer checkbox in the inspected chat path.

`runChat` in `src/main/agent/index.ts` snapshots that global setting into `conversationSubagentsEnabled`. The shared loop uses `opts.conversationSubagentsEnabled !== false`: explicit false suppresses spawning, while omission preserves the historical behavior for direct callers. Both the named-child `spawn_subagent` and batch `spawn_subagents` paths must be considered; the built-in main agent can receive the batch tool even without a custom agent definition.

Background handoffs do not currently carry an explicit background-subagent permission. `src/main/agent/tools/run_todos_in_background.ts` hands off the todo snapshot and Auto mode, but not delegation permission. The user-button route through `src/renderer/src/components/todos-section.tsx` and `src/main/ipc/task-handlers.ts` likewise passes only Auto mode. `TaskRunner.enqueue` in `src/main/tasks/runner.ts` persists task input and forks a private worker conversation; its execution path calls `runAgentLoop` without `conversationSubagentsEnabled`. Consequently, a false foreground setting can become an omitted value in the worker, which enables the background parent's spawn capability again. The gap is the absence of an explicit, persisted user permission for the background parent; the foreground global setting is not the new permission's source. This is not proof that every background task actually spawns children.

The batch implementation in `src/main/agent/index.ts` creates writer worktrees for assignments with `access: "write"`, after repository lease/preflight checks. Read-only assignments do not use this writer-worktree path. Existing isolation, commit/handback, parent integration, cancellation, and artifact-quarantine behavior must remain intact when enabled.

## Product behavior

Use a checkbox labeled **Allow background subagents** near the North Star composer execution controls. Suggested help text: “Allow the main agent of background tasks started from this chat to spawn subagents. Writing subagents use isolated Git worktrees. Off: background tasks run with one agent in the current workspace.” Do not label this as a general chat delegation switch or a standalone “Worktrees” option.

New North Star chats start unchecked, regardless of a legacy global true preference. The user may change the selection only before sending the first message. On the first accepted message submission, atomically persist the selected true or false with the conversation and lock it for that conversation's lifetime. Transfer the pre-first-message selection to the created conversation without a default-off race. Switching conversations, reopening a conversation, or restarting the app must preserve its locked value; only new conversations default to off. Existing conversations with messages but no stored permission resolve to locked false. Reuse existing conversation metadata if suitable; otherwise add the minimal persistence needed for this contract rather than keeping the choice only in renderer session state.

The checkbox is independent of Default, Plan, and Auto modes. Enabling Auto must not enable background delegation; checking this box must not bypass approvals or Plan-mode restrictions. After the first message is sent, keep the checkbox visible but disabled in its selected state, with help text such as “Set before the first message; locked for this conversation.” This applies to both off and on, even when no turn is active. Cancelling or failing the agent run, retrying, or editing/deleting messages must not unlock a conversation whose first submission was accepted. A submission rejected before acceptance must not lock an otherwise unsent conversation. To choose a different permission, start a new chat. Every later send and user-triggered handoff uses the locked value; queued/running tasks retain their own persisted snapshot.

This proposal scopes the new checkbox to North Star chat. Preserve existing behavior for other chat modes and for Process/Mission Control execution. Reword the existing global setting's help text to make clear that it continues to govern foreground conversation delegation, including North Star foreground turns, not this explicit background opt-in or already-created background tasks. Do not use two independently required switches for background delegation: checking the composer box supplies the background opt-in even if the global foreground setting is false, and a global true cannot enable background delegation when the box is unchecked. Existing agent/provider capability restrictions still narrow it.

## Policy contract and background lifecycle

Use one background-delegation boolean, for example `backgroundSubagentsEnabled`, in chat request, trusted handoff context, and task input contracts; do not add a separate worktree flag. Keep it distinct from the foreground run's `conversationSubagentsEnabled`. Resolve an explicit boolean in the main process; do not accept truthy strings or let an omitted North Star value fall back to the global foreground opt-in. When executing a background task, map its persisted background permission into the shared loop's effective `conversationSubagentsEnabled` gate. The foreground loop continues to resolve that gate from its existing policy, not from the composer checkbox. After first-message acceptance, the main process must resolve background permission from the persisted, locked conversation value and reject attempts to change it through later chat requests or direct task IPC. A disabled UI alone is not enforcement.

Snapshot the background permission at foreground turn start for model-triggered handoffs, without applying it to the foreground run's own spawn gate. The `run_todos_in_background` schema remains argument-free: the model cannot select or override the user's permission. The trusted tool context/enqueue wrapper supplies it. For the direct “Run all in background” button, snapshot the selected source conversation's persisted, locked value, not another open chat's state or a mutable renderer-supplied override.

Persist an explicit true or false in `tasks.input` for chat-originated `agent_chat` and `todo_run` tasks, alongside `autoMode`, and pass it back into `runAgentLoop` on every execution. Pause/resume, retry, backoff, provider switching, and app restart must use the persisted snapshot rather than rereading current settings or renderer state. A task created with false must never gain permission because its field was dropped during serialization.

Background-to-background handoffs inherit the parent's task snapshot. A worker must not upgrade a disabled permission via enqueue arguments or re-delegation. Centralize authoritative attachment of the effective permission at the loop/enqueue boundary so future handoff producers cannot accidentally omit it. Identify chat-origin task kinds/provenance explicitly; do not infer policy from message text, titles, or a missing source conversation.

Existing chat-originated `agent_chat`/`todo_run` tasks without the field resume with false, including tasks whose source conversation has since disappeared. This intentional conservative compatibility rule prevents old pending tasks from silently retaining unrequested delegation. Do not globally change the shared loop's omission semantics for Process or Mission Control callers; their independent policies remain unchanged.

Expose the snapshot in handoff approval details and the background task's existing details/status surface, for example “Background subagents: off.” Do not imply that an enabled task has actually created a worktree.

## Enforcement and instructions

Tool availability is the primary enforcement for North Star-managed background delegation. In a background worker with an effective false permission, omit both spawn tool definitions, omit spawn-specific catalog/guidance, and leave both spawn callbacks unavailable. Do not suppress foreground spawn tools based on the background checkbox; foreground availability continues to follow its existing policy. Verify that progressive discovery cannot expose either tool and that stale/replayed model calls cannot execute them: the dispatcher must reject calls that are not permitted by the effective run policy before any worker record, model request, lease, or worktree is created. Reuse existing dispatch checks if they already provide this guarantee; otherwise add the narrow guard at the shared spawn boundary.

Inject a concise runtime-owned instruction into the background parent, reconstructed from the structured task snapshot rather than copied through model-authored todo content:

> Subagents are disabled for this background task. Do not spawn or launch other agents, including through shell commands or external services, or create worktrees as an alternative execution workflow. Complete the task yourself in the selected workspace. Further background handoffs must retain this restriction.

The foreground run may receive runtime-owned context stating whether its background handoffs will permit subagents, but must not receive an instruction that applies this checkbox's restriction to its own foreground delegation.

When true, explain that subagents are permitted, not mandatory, and writing children must use the existing isolated-worktree workflow. Preserve named-child authorization, tool allowlists, depth/cycle limits, Plan mode, provider capability restrictions, approvals, repository preflight, and cleanup guarantees. A true checkbox cannot grant a capability otherwise denied by the runtime.

Removing spawn tools from a disabled background worker deterministically prevents its North Star built-in child workflow; it does not create a universal sandbox ban on `git worktree add`, external agent CLIs, scripts, or arbitrary MCP services. The runtime instruction explicitly forbids these alternatives when off. Do not advertise complete command-level prevention or attempt a fragile shell-string denylist in this feature. If a hard prohibition on all worktree creation or all external delegation is required, that needs a separately scoped execution-policy design. Existing worktrees must not be deleted or cleaned up just because the checkbox is unchecked; a user-selected workspace may itself already be a worktree.

## Implementation sequence

### Task 1: Wire the explicit North Star opt-in

Trace composer state and request types in `src/renderer/src/App.tsx`, `src/preload/index.ts`, and their declared renderer API types. Add the accessible pre-first-message checkbox and explicit request field, persist the conversation selection on first accepted submission, and enforce the lifetime lock in the main process. Restore the locked selection when loading conversations and default existing sent conversations without metadata to locked false. Resolve and snapshot the background permission in `runChat` separately from the foreground delegation gate, retaining existing global-setting behavior for all foreground turns. Update settings help text to explain the distinct scopes.

Acceptance: a fresh North Star chat sends a background permission of false, checked sends true, and a legacy global true cannot silently enable background subagents. The checkbox does not change foreground spawn availability, and a global false does not veto a checked background opt-in. Keyboard interaction, focus, disabled state, conversation switching, and first-send conversation creation preserve the intended UI state. Both false and true become immutable after the first accepted message, remain visibly disabled between turns, and survive reopening/restart. Later requests cannot override the persisted value; rejected initial submissions do not lock it, while cancellation, run failure, retry, and message edits/deletion do not unlock it.

### Task 2: Carry and persist the snapshot through every chat handoff

Extend the enqueue/tool-context contracts in `src/main/agent/tools/types.ts`, the loop wrapper in `src/main/agent/index.ts`, `TaskInput`/`enqueue`/execution in `src/main/tasks/runner.ts`, and the direct task IPC/preload contracts. Update `run_todos_in_background.ts` only as needed to consume the trusted snapshot; keep its model schema argument-free. Wire the Todos button through `src/renderer/src/main.tsx`, `components/activity-panel.tsx`, and `components/todos-section.tsx` using the source conversation's selection. Audit generic `task:start` and all chat-origin enqueue producers, not just the todo tool.

Acceptance: both true and false survive serialization, both handoff routes agree, recursive handoffs cannot widen permission, and retries/resumes use task input. Missing legacy chat-task values resolve to false without changing independent Process/Mission Control behavior.

### Task 3: Align tool enforcement, runtime context, and task visibility

Map the background snapshot into the shared loop's existing delegation gates for worker execution; cover both tool names and direct execution guards. Add the background runtime instruction and task/approval snapshot display without conflating foreground policy with background permission or modifying model-authored todos. Preserve enabled writer-worktree behavior rather than adding a shared-checkout fallback.

Acceptance: an off worker cannot call either built-in spawn path even with stale model history; it still has the ordinary tools needed to finish independently. An on worker may choose to work alone, explore with a read-only child, or use a permitted isolated writer. No worktree is created simply by enabling the checkbox.

### Task 4: Regression and manual qualification

Extend `src/main/agent/tool-error-feedback.integration.test.ts`, `src/main/agent/tools/run_todos_in_background.test.ts`, `src/main/tasks/runner.test.ts`, relevant task IPC/preload tests, and composer/Todos tests. Test the full background false/true matrix with Auto both off and on, named and batch spawn tools, Plan approval transitions, stale spawn calls, and progressive discovery. Cross the checkbox state with the global foreground setting: foreground spawn availability must remain unchanged, and background spawn availability must follow its own snapshot subject to existing capability restrictions. Assert absence of worker/task/artifact creation and worktree helper calls for rejected spawning.

Exercise handoff approval denial, both background-start entry points, nested handoffs, pause/resume, retry, restart recovery, legacy missing fields, settings changes after enqueue, and two conversations with different locked selections. Test pre-first-message toggling, first-submission persistence/locking for both values, restoration after reopening/restart, legacy sent conversations, forged later overrides, and cancellation/failure/retry/message-edit behavior. Confirm no changes to independent Process/Mission Control execution. Enabled-path regressions must retain writer preflight failure behavior, read-only execution without writer worktrees, cancellation, quarantine, and parent-only integration.

Run the repository's relevant tests, TypeScript checks, and build using its existing commands. Manually inspect checkbox placement, keyboard accessibility, disabled-state behavior, explanatory copy, and background snapshot visibility. Use isolated temporary test repositories for writer tests; do not create worktrees in the user's active repository merely to qualify the checkbox.

Acceptance: evidence covers UI defaults, end-to-end policy propagation and deterministic built-in enforcement. Report the shell/MCP limitation accurately rather than claiming an unimplemented sandbox guarantee.

## Scope boundaries

This plan adds one user-facing opt-in for background-parent subagent spawning, locks it for the conversation on the first accepted message, and carries that permission reliably from chat to background execution. It does not change foreground delegation policy. It does not force parallelism, add automatic parent worktrees, permit shared-checkout writing children, create a separate read-only delegation setting, change background approval requirements, cancel existing tasks when a box changes, clean up existing worktrees, redesign Process/Mission Control, or implement a universal external-agent/worktree sandbox.

This review updates only this `.plan/` file; application code and unrelated files remain untouched.
