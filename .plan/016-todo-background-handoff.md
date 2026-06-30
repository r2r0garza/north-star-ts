# PR16: Todo → background handoff — run a todo list as one durable task

> Status: **BUILT**. Builds on the `todo_write` tool + `todos` table, the `TaskRunner`
> (`009`–`012`), and the producer contract / `registerKind` from `015`.

## Context

The agent can already build a per-conversation todo list (`todo_write` tool → `todos` table,
re-injected into the system prompt each turn — `src/main/agent/tools/todo_tool.ts`,
`src/main/db/repositories/todos.ts`). What's missing is the **handoff**: taking that list and running
it to completion in the **background** via the existing `TaskRunner`, so the agent (or the user) can
fire off a long list of work and keep going.

This is the first concrete consumer of the `015` producer contract. It is **not** subagents and **not**
one-task-per-item: a single durable task of a new kind `todo_run` inherits a **snapshot** of the
current todo list and works through every item sequentially in its own forked worker conversation,
marking each `completed` via `todo_write` as it goes.

Two entry points, **one** underlying operation (both must hit the same `TaskRunner.enqueue` path —
no parallel implementations):
- **Agent-driven:** a new dedicated tool `run_todos_in_background` the agent calls when it judges the
  remaining work is long-running. When it does, it must tell the user it's handing off and why.
- **User-driven:** a "Run all in background" button on a new **Todos** panel in the Workspace Activity
  sidebar.

Available in both `interactive` and `north_star` modes (same gating as `todo_write`); not in `chat`.

## Key constraints discovered (these shape the design)

1. **`enqueue` forks a fresh worker conversation, and todos are keyed per-conversation.** The forked
   conversation starts with an **empty** `todos` table. So the handoff MUST snapshot the source
   conversation's todos and **seed them into the forked worker conversation**. The snapshot rides in
   the task `input` blob (per the `015` contract — no new columns), and the runner seeds the fork's
   `todos` table at enqueue time.
2. **The agent layer cannot import the runner.** `src/main/tasks/runner.ts` imports
   `src/main/agent/index.ts` (`runAgentLoop`). A direct `import { taskRunner }` from a tool would be a
   cycle. The tool reaches enqueue via an **injected `enqueueTask` handle on `ToolContext`**, not a
   module import.
3. **Todos are not exposed to the renderer today** — no IPC, no preload bridge, no rendering. The
   "render todos + button" UI needs a new read path (`db:todos:list`) and a panel. The activity panel
   already reserves a "Todos" section slot (`activity-panel.tsx:28`).

## Approach

### A. Snapshot + seed mechanism (the core)

- **Extend `TaskInput`** (`runner.ts`) to optionally carry a seed list:
  ```ts
  interface TaskInput {
    kind: string
    message: string
    seedTodos?: Array<{ itemId: string; content: string; status: TodoStatus }>
  }
  ```
- **In `enqueue`,** after forking the worker conversation, if `input.seedTodos` is present, seed them
  into the fork via `replaceTodos(taskConversation.id, seedTodos)` (reuse the existing repo fn —
  `src/main/db/repositories/todos.ts:92`; `TodoInput` accepts `{ id, content, status }`, so map
  `itemId`→`id`). This is the only enqueue change, guarded by the optional field so the `agent_chat`
  path is untouched.
- **Register the kind** at app init, before `start()` (in `src/main/index.ts`, where `015` left the
  guiding comment): `taskRunner.registerKind("todo_run", { autoResume: true })` — a long list survives
  a restart and continues (decision: auto-resume).

### B. Agent tool `run_todos_in_background` (gated — delegation requires approval)

New file `src/main/agent/tools/run_todos_in_background.ts` (dedicated tool — does NOT extend
`todo_write`; building the list and dispatching it are separate operations):
- **Reads** the current conversation's todos via `listTodos(ctx.conversationId)`.
- If there are no actionable (pending/in_progress) items, returns a `toolError` telling the agent to
  build a list first.
- **Routes the delegation through the existing approval gate** (see B.1 below). The thing being
  approved is the *delegation of execution to the background*, NOT the todo list. Builds a
  `ToolAction { tool: "run_todos_in_background", kind: "delegate", summary: "Run N todos in the
  background", identity: "delegate:<conversationId>" }` and `await ctx.gate(action)`:
  - `approved` → snapshot the list and enqueue (below).
  - `denied` / `blocked` → return a result telling the agent the user declined; **do not enqueue**.
  - **No `ctx.gate`** (e.g. a bare unit-test context) → fail-closed (treat as denied), matching how
    every other gated tool behaves.
- On approval, **snapshots** the list and calls `ctx.enqueueTask({ conversationId, message, kind:
  "todo_run", title, seedTodos })` where `message` is a fixed kickoff instruction ("Work through your
  todo list to completion; mark each item as you finish it.") and `title` summarizes the list (e.g.
  "N todos: <first item>…").
- Returns the created `{ taskId, status }` plus a note that the work is now running in the background.
- **Description** instructs the agent: use this only after a todo list exists and the work is
  long-running; expect the user to be asked to approve the handoff; and after it's approved, tell the
  user you've handed the work off to the background and why (e.g. "I've prepared a 12-step plan; this
  will take several minutes — continuing in the background now").

Once approved and enqueued, **the TaskRunner owns execution.** Any gated actions the background task
hits while working the list follow the existing background-task approval flow (`task:approve`/`deny`,
durable `approvals` table) — unchanged, no new work here.

### B.1. `delegate` action kind (always require approval)

The gate's `ToolAction.kind` is a fixed union with deterministic classifiers (`approval/types.ts`,
`policy.ts`). Extend it for delegation — the intended extension path ("future tools route through the
ONE pipeline"):
- `approval/types.ts`: add `"delegate"` to `ActionKind`.
- New `approval/delegation-classifier.ts`: an `ActionClassifier` that returns
  `{ level: "require_approval", reason: "Starting a background task" }` for `kind === "delegate"`,
  `null` otherwise. **No `category`** — so the sandbox auto-approve downgrade (which keys on category)
  can never silence it. Register it **first** in the `PolicyEngine` classifier list (`index.ts:54`).
- **Not allowlistable:** delegation should be asked every time, not "always allow"-able. The approval
  event will carry the action `kind` so the renderer's `ApprovalCard` omits the "always allow for this
  workspace" remember affordance for `delegate` approvals. (Add `kind` to the `approval` event payload
  and thread it through the existing `chat:event`/`task:event` plumbing; the live-chat gate already
  emits these events at `index.ts:583`.)

The **user-triggered button (C) does NOT gate** — clicking "Run all in background" is already explicit
user intent, so it enqueues directly. Both paths still converge on the same `runner.enqueue`.

**Wiring (`ToolContext` injection — constraint 2):**
- `src/main/agent/tools/types.ts`: add optional `enqueueTask?: (input: { conversationId: string;
  message: string; kind?: string; title?: string | null; seedTodos?: ... }) => { id: string; status:
  string }` to `ToolContext`. Optional → live-chat-only contexts that don't supply it degrade
  gracefully (tool returns a "not available here" error).
- `src/main/agent/index.ts`:
  - Add `enqueueTask?` to `RunAgentLoopOptions` (threaded from the caller, not imported).
  - Add `run_todos_in_background` to the mode-gated tool list next to `todoWriteTool.definition`
    (line 335, guarded by the same `showTodos`).
  - Include `enqueueTask: opts.enqueueTask` when building `ctx` (line 638).
- **Provide the handle from the runner:** in `runner.ts` `runOne`, pass `enqueueTask: (input) =>
  this.enqueue(input)` into `runAgentLoop` so a background task can itself hand off (bound to the same
  instance). In `src/main/index.ts` `runChat` path, pass `enqueueTask: (input) =>
  taskRunner.enqueue(input)` so a **live** interactive/north_star turn can hand off too. Both routes
  call the identical `enqueue` — one operation.
- Register the tool in `src/main/agent/tools/index.ts` (`otherTools` array + `byName`).

### C. Todos panel + user button (UI)

- **Read path:** add `listTodos` IPC. `src/main/ipc/db-handlers.ts` → `db:todos:list`
  (conversationId) → `listTodos`. Bridge in `src/preload/index.ts` under `db.todos.list`. Add a
  `Todo` type to the renderer `@/types`.
- **Dispatch path (user trigger):** add `tasks.startTodos` to the preload + a `task:start-todos` IPC
  handler in `src/main/ipc/task-handlers.ts` that snapshots `listTodos(conversationId)` server-side and
  calls `runner.enqueue({ ..., kind: "todo_run", seedTodos })` — the SAME enqueue the agent tool hits.
  (Snapshotting server-side keeps the renderer from having to pass the list back.)
- **Panel:** new `src/renderer/src/components/todos-section.tsx` modeled on `tasks-section.tsx`
  (load via `db.todos.list(conversationId)`, render rows with status markers `[ ] [>] [x] [~]`), with a
  "Run all in background" button (enabled when there are actionable items) that calls
  `window.cowork.tasks.startTodos({ conversationId })` then opens the activity panel. Slot it into
  `activity-panel.tsx` as a new `<ActivitySection title="Todos">` (the reserved slot).
- Refresh the panel on the task event tail (reuse the `tasks.onEvent` subscription already in the
  panel) so seeding/the new task appears immediately.

## Out of scope

- One-task-per-item / true subagents (explicitly deferred — this is one task for the whole list).
- Chat-mode handoff (no todos in chat mode).
- Live progress mirroring of per-item status back into the SOURCE conversation's todo list (the work
  happens in the fork; the source list is a snapshot at handoff). → **followed up in `017` (item 2)**,
  which testing confirmed is needed: the Todos panel shows stale all-`[ ]` after a handoff while
  History shows the task completed.
- Editing todos from the UI panel (read + dispatch only this PR).

## Post-merge follow-ups (→ `017`)

Surfaced while manually testing the handoff:
1. **Large-file write robustness.** A background `todo_run` writing a big file (CONTRIBUTING.md) hit
   the model's output-token cap, truncating the `write_file_tool` JSON argument mid-stream → unparseable
   tool call. **Immediate fix shipped here** (`src/main/agent/index.ts`): raised the per-turn output cap
   `1024 → 8192` (`MAX_OUTPUT_TOKENS`) and added `finish_reason === "length"` truncation detection that
   returns a clean, retryable error instead of throwing an opaque JSON `SyntaxError`. The *structural*
   fix (surgical edits / chunked writes so large writes never ride one oversized completion) is `017`
   item 1.
2. **Live todo progress in the panel** — `017` item 2 (see above).

## Verification

**Unit (`src/main/tasks/runner.test.ts`):**
- `enqueue({ ..., kind: "todo_run", seedTodos: [...] })` seeds the forked worker conversation's todos:
  assert `listTodos(task.conversationId)` returns the seeded items (and the source conversation is
  untouched). With the stubbed `runAgentLoop`, the task settles `completed`.
- `registerKind("todo_run", { autoResume: true })` + an orphaned `running` `todo_run` task reconciles
  to `queued` and resumes (mirror the `015` auto-resume test).

**Unit (new `src/main/agent/tools/run_todos_in_background.test.ts`):**
- With a fake `ctx.gate` returning `"approved"`, a fake `ctx.enqueueTask` spy, and a seeded `todos`
  table, the tool snapshots the list and calls `enqueueTask` once with `kind: "todo_run"` and the seed
  list; returns the task id.
- `ctx.gate` returns `"denied"` → does NOT enqueue; returns a "user declined" result.
- No `ctx.gate` on ctx → fail-closed (does not enqueue).
- Empty/no-actionable list → returns a `toolError`, does not enqueue (and never reaches the gate).
- No `enqueueTask` on ctx → graceful "not available" error.

**Unit (new `src/main/agent/approval/delegation-classifier.test.ts`, or add to `approval.test.ts`):**
- A `delegate` action → `require_approval` with no `category`.
- The `PolicyEngine` does NOT downgrade a `delegate` action to allow even when `sandboxed: true`
  (no category → sandbox policy can't match) and even with an allowlist match (delegation isn't
  allowlistable in practice; assert the classifier verdict stands).

**Manual (real app):**
1. Interactive or North Star session: ask the agent to make a multi-step plan (it calls `todo_write`).
   Open the Workspace Activity panel → **Todos** section shows the list.
2. **Agent path (gated):** tell the agent "do all of this in the background." It calls
   `run_todos_in_background`, which surfaces an **approval card in the live chat** ("Run N todos in the
   background"). Approve → the agent tells you it's handing off and a new `todo_run` task appears in
   the Tasks section and runs to completion. Verify the forked task's transcript shows it working the
   list. Deny → no task is created and the agent acknowledges the decline. Confirm the delegate
   approval card has **no** "always allow" affordance.
3. **User path (no gate):** build a list, click **Run all in background** on the Todos panel → the
   `todo_run` task appears immediately with no approval prompt. Confirm both paths produce an identical
   task shape (kind `todo_run`, seeded todos in the fork).
4. **Nested approval:** give the background task a step that triggers a gated action (e.g. a risky
   shell command) → it pauses as `waiting_for_approval` and is resolvable from the Tasks section via
   the existing background-task approval flow (unchanged).
5. **Auto-resume:** start a long `todo_run`, quit mid-run, relaunch → it reconciles to `queued` and
   continues (not `interrupted`).

**Build/test note (from memory + `015`):** the runner/DB suites need `better-sqlite3` built for
**node** (`npm rebuild better-sqlite3`); restore the Electron build afterward
(`npx electron-rebuild -f -w better-sqlite3`). Run `npm run typecheck`.
