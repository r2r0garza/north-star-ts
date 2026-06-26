# Cowork Agent Tools — todo_tool: agent task list (DRAFT / PICK-UP)

> Status: **NOT STARTED** — written ahead as a pickup point. Independent of PR2
> (shell/approval, `002`); can be built before or after it. Needs a short
> design decision (see "Open questions") before execution; the shape below is a
> starting hypothesis, not a locked spec.

## Context

For multi-step work (especially North Star / Interactive modes), the agent has no way to
plan and track its own progress across a turn or across turns. A `todo_tool` gives the model
a small, bounded task list it can write to ("here's my plan: 1…2…3"), update as it works
(mark in_progress / completed), and that gets **re-surfaced into the prompt** each turn so the
plan survives context compression and tool round-trips. This is the standard agent-todo
pattern (cf. hermes `todo_tool.py`): a scratchpad that keeps a long task on the rails.

Two payoffs: (1) the model stays coherent over many steps; (2) the user gets a visible plan/
progress view in the UI — a natural fit for the `marker` / tool-group rendering just shipped
on `main`, and for the North Star "task" framing.

Reference pattern: hermes `todo_tool.py` — in-memory `TodoStore` per session, bounded
(≤256 items, ≤4000 chars/item), statuses pending / in_progress / completed / cancelled,
re-injected into the prompt after compression. Either `add`/`update`/`list` ops or a
`replace-all` write.

## Open questions to resolve BEFORE building (decide first)
1. **Storage — the key fork.** Options:
   - **a) Existing `tasks` table** (`schema.ts:43-57`, repo `db/repositories/tasks.ts`:
     `createTask`/`listTasks`/`updateTask`/`deleteTask`). It's per-conversation and already
     wired through IPC. BUT its status enum is agentic-work-flavored
     (`queued/running/waiting_for_approval/interrupted/completed/failed/cancelled`), not todo
     -flavored (`pending/in_progress/completed/cancelled`). Reusing it means either mapping
     todo statuses onto that enum or widening the CHECK constraint (a schema migration).
   - **b) New `todos` table** — clean separation, todo-specific status enum, own repo. Costs a
     migration + repo boilerplate but avoids overloading `tasks`.
   - **c) In-memory only** (like hermes) keyed by conversationId — simplest, no persistence,
     but the list dies on reload and can't be reconciled like messages are.
   **Recommendation to weigh:** (b) if we want the list to persist + render in the UI like the
   tool markers; (c) if it's purely a within-turn scratchpad. Avoid (a) unless we deliberately
   want todos and tasks unified.
2. **Scope/lifetime:** one list per conversation (persists across turns) or one per turn
   (reset each send)? Per-conversation matches the "plan survives" goal.
3. **Prompt re-injection:** render the current list into the system prompt each turn (like the
   skills section in `agent/index.ts`), or only when non-empty? Cap size so it can't bloat the
   prompt. How does it interact with the per-mode prompts (chat probably shouldn't get it;
   north_star/interactive should)?
4. **Tool op shape:** single `todo_write` that replaces the whole list (simplest, matches how
   models like to rewrite plans) vs. granular `add`/`update_status`/`list`. Replace-all is
   usually less error-prone for the model.
5. **UI surfacing (optional, later):** render the list as a marker/checklist in the transcript
   or a side panel, reusing the `tool-group` / `marker` components. Could be deferred.

## Likely implementation shape (hypothesis — revisit after Q1)

Assuming **(b) new table + per-conversation + replace-all op + prompt re-injection** as the
leading hypothesis:

### A. Schema + repo
- New `todos` table (or a single-row JSON blob per conversation): `id`, `conversation_id`
  (FK, cascade), `seq`/order, `content` (≤ ~1–4 KB), `status` IN
  (`pending`,`in_progress`,`completed`,`cancelled`), `created_at`, `updated_at`. Add to
  `schema.ts` as a v2 migration (current schema is single-migration v1 — confirm how
  migrations are applied before adding).
- New `src/main/db/repositories/todos.ts`: `replaceTodos(conversationId, items)`,
  `listTodos(conversationId)`. Mirror the existing repo style (transaction, seq assignment).

### B. Tool
- New `src/main/agent/tools/todo_tool.ts` implementing the `Tool` interface
  (`{ definition, execute }`). Op: `todo_write` with `items: [{ content, status }]` →
  validates/bounds, calls `replaceTodos`, returns a short confirmation (count by status).
  Bound item count + per-item chars (reuse the `truncateForModel`/validation patterns).
- Needs the conversation id in `ToolContext` — currently `ToolContext` is
  `{ workspace, attachments? }` (`tools/types.ts`). Add `conversationId` and thread it from
  `runChat`'s `ctx` (`agent/index.ts`, where `ctx = { workspace, attachments }` is built).
  This is the first tool needing per-conversation state — it validates that plumbing for
  later stateful tools (memory, etc.).
- Register in `tools/index.ts`. Decide gating: offered in north_star/interactive (and maybe
  chat?) — tools are currently gated by `hasWorkspace`; todo may want a different gate (by
  mode), which means passing mode into the tool-offering logic.

### C. Prompt re-injection
- After building the system prompt (where `buildSkillsPrompt` is appended in `agent/index.ts`),
  append a "Current task list" section from `listTodos(conversationId)` when non-empty and the
  mode warrants it. Keep it compact. This is the load-bearing piece that makes the list useful.

### D. (Optional, later) UI
- Render the list in the transcript via a marker/checklist, reusing `marker.tsx` and the
  `tool-group.tsx` collapsible pattern from the chat-ui-updates work now on `main`.

## Verification (when built)
- Ask the agent (north_star mode) to do a multi-step task; confirm it writes a todo list, the
  list appears (UI and/or prompt), statuses update as it progresses, and the list persists
  across a reload / next turn.
- Bounds: oversized list / item is rejected or truncated with a clear tool error.
- Mode gating behaves as decided (e.g. chat doesn't get the tool if we exclude it).

## Out of scope
- The PR2 shell/approval work (`002`).
- Cross-conversation / global todos; sub-tasks / dependencies; due dates.
- Auto-deriving todos from the user message (the model writes them explicitly).
