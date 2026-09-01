---
status: RESOLVED
severity: P2
trigger: "The open Info sidebar keeps showing stale todo statuses after the foreground agent updates its task list"
created: 2026-08-31
updated: 2026-08-31
---

# Todo sidebar stays stale after an agent task-list update

## Symptoms

- Expected: when the foreground agent updates the current conversation's todo
  list, an already-open Info sidebar immediately reflects the new item statuses.
- Actual: the persisted todo rows change, but the open sidebar can continue to
  show the previous state—for example, task 1 remains `in_progress` after the
  agent marked it `completed` and moved task 2 to `in_progress`.
- Switching conversations, closing and reopening the right-hand sidebar, or
  reloading causes the correct statuses to appear.
- No error is reported because the database write succeeds; only the rendered
  snapshot is stale.

## Resolution

- Implemented a todo-change publisher in `src/main/db/repositories/todos.ts`.
  `replaceTodos` and `mergeTodos` now publish the committed conversation-scoped
  snapshot after the transaction succeeds; `listTodos` remains read-only and
  silent.
- Added `db:todos:subscribe` / `db:todos:unsubscribe` IPC handlers that forward
  `db:todos:change` events to subscribed renderers and remove
  `WebContents.destroyed` listeners on explicit unsubscribe.
- Exposed `window.cowork.db.todos.onChange(callback)` through preload with a
  shared reference-counted subscription.
- Updated `TodosSection` to apply matching todo snapshots immediately while
  retaining task events only for todo-run lifecycle refreshes.
- Added regression coverage for repository publish behavior, preload
  reference-counting, and main-process todo subscription cleanup.

## Verification

- `pnpm exec vitest run src/main/db/repositories/todos.test.ts src/preload/index.test.ts src/main/ipc/subscription-handlers.test.ts`
- `pnpm run typecheck`

## Original Focus

- hypothesis: foreground `todo_write` mutations have no dedicated renderer
  invalidation event. `TodosSection` loads on conversation changes and borrows
  the durable task-event tail as a refresh trigger, but a foreground chat tool
  call does not emit a durable task event.
- test: keep the Info sidebar open, perform two successful foreground
  `todo_write` calls for one conversation, and verify that the rendered list
  advances after each committed write without remounting the panel or changing
  conversations.
- expecting: each committed todo mutation produces one conversation-scoped
  change notification, and the open sidebar displays the resulting statuses
  promptly while unrelated conversations remain unaffected.
- next_action_completed: add a dedicated main-to-renderer todo-change subscription and
  make `TodosSection` consume it while retaining task events for background-task
  lifecycle changes.
- reasoning_checkpoint: React has no new state to render until some external
  event invalidates or replaces the component's todo snapshot. The persisted
  data is correct; synchronization between the main-process todo store and the
  renderer is missing.

## Evidence

- timestamp: 2026-08-31
  observation: `todo_write` calls `replaceTodos` or `mergeTodos`, both of which
  commit the mutation and return the current rows but emit no change event.
- timestamp: 2026-08-31
  observation: `TodosSection` fetches on `conversationId` changes and subscribes
  to `window.cowork.tasks.onEvent`; its own comment states that there is no
  dedicated todo event.
- timestamp: 2026-08-31
  observation: the task-event subscription receives durable background-task
  events, not ordinary foreground `chat:event` tool completions.
- timestamp: 2026-08-31
  observation: foreground tool completion reaches `App.tsx`, where it updates
  the transcript's live tool row, but the sibling `ActivityPanel` receives no
  todo refresh signal.
- timestamp: 2026-08-31
  observation: reopening the panel or switching conversations triggers a fresh
  database read and displays the correct state, which isolates the defect to UI
  invalidation rather than persistence.
- timestamp: 2026-08-31
  observation: the current task-event listener refetches for every non-token
  task event, including events unrelated to the displayed conversation; it is
  both incomplete for foreground writes and broader than necessary.

## Recommended Direction

1. Introduce a small main-process todo-change notifier owned by the todo data
   boundary. Publish only after `replaceTodos` or `mergeTodos` commits
   successfully; reads must not publish.
2. Include the mutated `conversationId` and preferably the resulting `Todo[]`
   snapshot in the event. Sending the committed snapshot avoids a second IPC
   read and prevents overlapping refetches from resolving out of order.
3. Add reference-counted `todos:subscribe` / `todos:unsubscribe` IPC lifecycle
   handling, following the corrected task-subscription pattern. Remove the
   associated `WebContents.destroyed` listener on explicit unsubscribe.
4. Expose the subscription through the preload bridge, for example
   `window.cowork.db.todos.onChange(callback)`, with an unsubscribe function.
5. Have `TodosSection` track the conversation whose todos it is displaying and
   apply matching snapshots immediately. Ordinarily this is the selected
   conversation; after a todo handoff it is the `todo_run` worker conversation.
6. Keep the existing durable task-event subscription for task creation, status
   transitions, and selecting or clearing the background worker view. Todo
   events should own todo-content/status freshness; task events should own task
   lifecycle freshness.
7. Filter both event paths to relevant conversations/tasks so unrelated
   activity does not trigger database reads or renders.

## Why Not the Smaller UI-Only Alternative

A tactical patch could detect `event.name === "todo_write"` in `App.tsx`, bump a
refresh key, and thread it through `main.tsx` and `ActivityPanel`. That would fix
the immediate foreground case, but it couples data freshness to one tool name
and misses other writers such as automatic list clearing, background seeding,
or future non-chat mutations. The data boundary should announce successful
mutations directly.

## Likely Files

- `src/main/db/repositories/todos.ts` or a neighboring todo event/store module
- `src/main/ipc/db-handlers.ts` or a dedicated todo subscription handler
- `src/preload/index.ts`
- `src/renderer/src/components/todos-section.tsx`
- main-process IPC subscription lifecycle tests
- preload subscription reference-count tests
- renderer todo synchronization tests

## Acceptance Criteria

- With the Info sidebar open, a successful foreground todo write updates its
  rendered statuses without switching conversations, remounting the panel, or
  reloading the app.
- Consecutive writes such as task 1 `in_progress` → `completed` and task 2
  `pending` → `in_progress` are displayed after each committed mutation.
- Failed or rejected todo writes do not publish a successful change snapshot.
- Todo reads do not emit change notifications.
- Clearing a completed list updates an open sidebar to its empty state.
- A background `todo_run` continues to show its forked conversation's progress,
  including final statuses.
- A todo change for another conversation does not alter the visible list.
- Multiple mounted renderer consumers share one main-process subscription until
  the final consumer unsubscribes.
- Repeated mount/unmount cycles leave no accumulated IPC or
  `WebContents.destroyed` listeners.
- Regression tests cover foreground replacement, merge, clear, unrelated
  conversation filtering, background-worker selection, and subscription
  cleanup.

## Eliminated

- hypothesis: the agent failed to persist the updated statuses.
  reason: a remount, conversation switch, or reload reads and displays the
  correct rows.
- hypothesis: React fails to rerender after `setTodos`.
  reason: the stale path does not call `setTodos`; remount-driven fetches render
  correctly.
- hypothesis: polling is required for cross-process state.
  reason: Electron IPC already provides event subscriptions for tasks and other
  live services, so todo mutations can use the same push model.
