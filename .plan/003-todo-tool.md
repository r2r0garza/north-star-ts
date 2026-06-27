# Cowork Agent Tools — PR3: `todo_tool` (agent task list)

> Status: **COMPLETE** — shipped on `feat/agent-tools-3` (2026-06-26). Decisions below held
> up exactly; the **"As built"** section at the bottom records what shipped. `pnpm typecheck`
> + `pnpm build` clean; 82 unit tests (14 new DB-integration tests + pure/tool tests).

## Context

For multi-step work (especially North Star / Interactive modes), the agent has no way to
plan and track its own progress across a turn or across turns. A `todo_tool` gives the model
a small, bounded task list it can write to ("here's my plan: 1…2…3"), update as it works
(mark in_progress / completed), and that gets **re-surfaced into the prompt** each turn so the
plan survives context compression and tool round-trips. This is the standard agent-todo
pattern (cf. hermes `todo_tool.py`): a scratchpad that keeps a long task on the rails.

Two payoffs: (1) the model stays coherent over many steps; (2) the user gets a visible plan/
progress view in the UI — a natural fit for the `tool-group` rendering on `main`, and for the
North Star "task" framing.

This is the deliberate next step after PR2 (`002`): it improves **task continuity** without
introducing any new risk boundary (no network, SSRF, browser drivers, MCP lifecycle, or
delegation). It's local-only and rides the SQLite layer we already have.

Reference pattern: hermes `todo_tool.py` — an in-memory `TodoStore` per session, bounded
(≤256 items, ≤4000 chars/item), statuses pending / in_progress / completed / cancelled,
re-injected into the prompt after compression, with a single `todo` tool (replace-all by
default, optional `merge`). We diverge from hermes on **storage** (we persist; hermes is
in-memory) — see decisions below.

## Decisions (locked)

The Q1 storage fork and the rest are resolved per the PR3 scope:

1. **Storage → (b) new `todos` table.** Per-conversation, todo-specific status enum, own repo.
   Rejected: (a) reusing the `tasks` table — its status enum is agentic-work-flavored
   (`queued/running/waiting_for_approval/…`), and overloading it couples two unrelated
   concepts. Rejected: (c) in-memory — the whole point is continuity across reloads/turns, and
   we already reconcile messages from SQLite; the todo list should reload the same way.
2. **Scope/lifetime → one list per conversation, persists across turns.** Matches the "plan
   survives" goal. No cross-conversation / global todos (explicitly out of scope).
3. **Prompt re-injection → yes, each turn, when non-empty, gated by mode.** Rendered into the
   system prompt after the skills section (same seam as `buildSkillsPrompt` in `agent/index.ts`).
   **Modes:** `interactive` + `north_star` get the tool and the injection; **`chat` does not**
   (chat is the lightweight, tool-light mode — consistent with how it only gets `read_file`).
   The injected block shows the **full current list with status markers**, capped, so the model
   sees progress (and is told not to redo completed items) rather than hermes' active-only view.
4. **Tool op shape → single `todo_write` (replace-all default, optional `merge`).** Replace-all
   is the least error-prone interface for the model and **covers every operation the PR3 scope
   listed** without a multi-verb API:
   - *create* → include the new item in the array.
   - *update status* → re-send the item with a new `status` (or `merge:true` + just that item).
   - *reorder* → array order **is** priority; reorder the array.
   - *delete one* → omit it from a replace-all array.
   - *clear all* → send `todos: []`.
   - *read* → call with **no args**; every call returns the full current list + summary counts.
5. **Gating → mode, not workspace, and no approval gate.** The todo tool touches only its own
   table — it's not a dangerous action, so it does **not** route through `ctx.gate`. It does
   **not** require a workspace (it's pure conversation state), so it's offered whenever
   `mode !== "chat"`, with or without a workspace. This is the first tool gated by **mode**,
   so it introduces the small bit of plumbing (pass `mode` into the tool-offering logic) that
   later mode-specific tools will reuse.
6. **UI → tool-marker only for this PR; dedicated checklist panel deferred.** `todo_write`
   calls already render in `tool-group.tsx`; we add a `deriveLabel` case so they read nicely
   (e.g. "Updated task list (3 done, 1 in progress)"). A live checklist panel/marker is a clean
   follow-up but not required to ship the capability.

### Out of scope for PR3 (per the locked direction)
- Subagents / delegation. Durable background task execution / runners. `memory_tool`.
  `web_search`/`web_extract`. Cross-conversation or global todos; sub-tasks / dependencies;
  due dates. Auto-deriving todos from the user message (the model writes them explicitly).

## Implementation shape (the spec)

### A. Schema + migration (`SCHEMA_V3`)
- Add `SCHEMA_V3` to `src/main/db/schema.ts` and append it to the `MIGRATIONS` array in
  `src/main/db/migrations.ts` (never edit a shipped migration — current head is v2). The
  migration runner stamps `user_version = 3`.
- Table (mirrors existing conventions — TEXT keys, epoch-ms timestamps set by the repo, TEXT
  enum with a CHECK constraint mirroring the union in `types.ts`):
  ```sql
  CREATE TABLE todos (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    item_id         TEXT NOT NULL,        -- model-chosen id, unique within a conversation
    seq             INTEGER NOT NULL,     -- list order = priority
    content         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN
                      ('pending','in_progress','completed','cancelled')),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, item_id)
  );
  CREATE INDEX idx_todos_conversation_seq ON todos(conversation_id, seq);
  ```
  Composite PK `(conversation_id, item_id)` lets the model reuse simple ids ("1","2","3")
  per conversation without global collisions, and dedupes by id within a write. `ON DELETE
  CASCADE` cleans up when a conversation is deleted (same as `messages`).

### B. Types + repo
- Add to `src/main/db/types.ts`: `TodoStatus = "pending" | "in_progress" | "completed" |
  "cancelled"` and a `Todo` interface (camelCase, mirroring `Message`/`Task`).
- New `src/main/db/repositories/todos.ts` (mirror `tasks.ts` style — `getDb()`, prepared
  statements, a `toTodo(row)` mapper):
  - `listTodos(conversationId): Todo[]` — ordered by `seq ASC`.
  - `replaceTodos(conversationId, items): Todo[]` — in a single `db.transaction`: delete all
    rows for the conversation, then insert the validated/bounded items with `seq = index`.
    Returns the new list.
  - `mergeTodos(conversationId, items): Todo[]` — update existing rows by `item_id`
    (content/status), append new ones to the end (`seq = max+1`), in one transaction.
  - Apply bounds here (single source of truth): `MAX_TODO_ITEMS = 256`,
    `MAX_TODO_CONTENT_CHARS = 4000` (truncate with a marker), drop blank content, coerce
    invalid status → `pending`. Reuse the spirit of `truncateForModel`/`toolError` patterns.
- Register the namespace in `src/main/db/repositories/index.ts`
  (`export * as todos from "./todos"`).

### C. Tool (`src/main/agent/tools/todo_tool.ts`)
- Implements the `Tool` interface (`{ definition, execute }`), name **`todo_write`**.
- Params (schema description carries the behavioral guidance — "use for 3+ step tasks", "only
  ONE item in_progress at a time", "mark completed immediately", "list order is priority",
  "call with no args to read"):
  - `todos?: Array<{ id: string; content: string; status: pending|in_progress|completed|cancelled }>`
    — omit to read.
  - `merge?: boolean` (default `false`) — `false` replace-all, `true` update-by-id + append.
- `execute(args, ctx)`:
  - Requires `ctx.conversationId` (added to `ToolContext` in PR2); if missing, return
    `toolError("no_conversation", …)` (fail-safe, mirrors how gated tools fail closed).
  - Guard the `todos`-as-JSON-string case (LLMs sometimes stringify arrays) like hermes does.
  - Read path (no `todos`): `listTodos`. Write path: `merge ? mergeTodos : replaceTodos`.
  - Return a compact JSON string: `{ todos: [...], summary: { total, pending, in_progress,
    completed, cancelled } }` — routed through the existing output helpers as needed.
- **No `ctx.gate` call** (not a dangerous action).
- Register in `src/main/agent/tools/index.ts`. NOTE: `todo_write` must **not** be auto-added by
  the existing `hasWorkspace` block (it's mode-gated, not workspace-gated) — see D.

### D. Wiring in `runChat` (`src/main/agent/index.ts`)
- `conversation.mode` is already loaded. Compute `const showTodos = conversation?.mode !==
  "chat"`. Add `todoWriteTool.definition` to the `tools` array when `showTodos` (independent of
  `hasWorkspace`).
- After the skills section is appended to `systemPrompt`, append a **"Current task list"**
  block when `showTodos` and `listTodos(conversationId)` is non-empty. Format compactly with
  status markers (`[ ]` pending, `[>]` in_progress, `[x]` completed, `[~]` cancelled), capped
  in size. This is the load-bearing piece that makes the list survive compression.
- `ctx` already carries `conversationId`; no `ToolContext` change needed (PR2 added it).

### E. Renderer label (`src/renderer/src/lib/timeline.ts`)
- Add a `deriveLabel` case for `todo_write` summarizing the write (e.g. derive counts from
  `args.todos`): "Updated task list — 3 todo, 1 in progress" / "Read task list". Purely
  cosmetic; the tool marker already renders via the existing `tool-group` path.

### F. (Deferred, optional) dedicated checklist UI
- A live checklist marker/panel reusing `tool-group.tsx` collapsible patterns. Tracked as a
  follow-up; not required for this PR. If built, it reads via a new `db:todos:list` IPC channel
  (preload `window.cowork.db.todos.list` + `ipcMain.handle` in `ipc/db-handlers.ts`), mirroring
  the existing `db:tasks:*` wiring.

## Verification (when built)
- **Multi-step flow:** in north_star/interactive mode, ask for a multi-step task; confirm the
  model calls `todo_write` with a plan, the tool returns the list + summary, and statuses
  update as it progresses.
- **Persistence:** reload the conversation (or send a new turn) → the list is still present and
  re-injected into the prompt; completed items aren't redone.
- **Replace vs merge:** `merge:false` replaces the whole list; `merge:true` updates one item's
  status without dropping the others; `todos:[]` clears; reordering the array reorders the list.
- **Bounds:** an oversized item is truncated with a marker; >256 items is capped; invalid status
  coerces to `pending`; blank content is dropped — all without throwing.
- **Mode gating:** `chat` mode is **not** offered `todo_write` and gets no injected list;
  `interactive`/`north_star` are, with or without a workspace.
- **No approval prompt:** `todo_write` never triggers the approval card (it's not gated).
- **Migration:** a fresh DB reaches `user_version = 3`; an existing v2 DB migrates cleanly and
  keeps its data.
- `pnpm typecheck` + `pnpm build` clean; new repo/tool unit tests pass (`vitest`).

---

## As built (shipped on `feat/agent-tools-3`)

The locked decisions held exactly. Files:

- **Schema/migration:** `SCHEMA_V3` (`todos` table, composite PK `(conversation_id, item_id)`,
  `seq`, CASCADE) in `src/main/db/schema.ts`; appended to `MIGRATIONS` in `migrations.ts`
  (head is now v3).
- **Types:** `TodoStatus` + `Todo` in `src/main/db/types.ts`.
- **Repo:** `src/main/db/repositories/todos.ts` — `listTodos` / `replaceTodos` / `mergeTodos`,
  plus an exported pure `normalizeItems` (bounds: `MAX_TODO_ITEMS=256`,
  `MAX_TODO_CONTENT_CHARS=4000`, status coercion, blank-drop, dedupe-by-id, append-cap on
  merge). Registered in `repositories/index.ts` as `todos`.
- **Tool:** `src/main/agent/tools/todo_tool.ts` (`todo_write`) — read on no-args, replace-all by
  default, `merge:true` to update-by-id+append; JSON-string `todos` arg tolerated; fails closed
  with `ERROR[no_conversation]` when no conversation. **Not** gated by `ctx.gate` (not a
  dangerous action). `tools/index.ts` split into `workspaceTools` (in `toolDefinitions`) vs
  `otherTools` (dispatchable but offered by mode); `todoWriteTool` re-exported.
- **Wiring (`agent/index.ts`):** `showTodos = mode != null && mode !== "chat"` offers
  `todoWriteTool.definition` (independent of `hasWorkspace`) and appends the re-injected list
  via `buildTodoListPrompt` after the skills section. New `src/main/agent/todo-prompt.ts`
  renders the full list with `[ ] [>] [x] [~]` markers.
- **Renderer:** `deriveLabel` case for `todo_write` in `src/renderer/src/lib/timeline.ts`
  ("Read task list" / "Cleared task list" / "Updated task list (N items) — …").
- **Tests:** `todos.test.ts` (repo + `normalizeItems` + migration-to-v3 + CASCADE + scoping),
  `todo_tool.test.ts` (arg routing, fail-closed, summary counts).

### Divergence / known limitation
- **Test ABI gap.** `better-sqlite3` is built for Electron's ABI (the app needs it; see the
  native-module-rebuild note). Under plain-Node `vitest` the native binary won't load, so the
  14 DB-integration tests `describe.skipIf(!sqliteLoads)` rather than fail. They were verified
  by temporarily rebuilding for the Node ABI (`npm rebuild better-sqlite3 --build-from-source`
  → all 82 pass) and then restoring the Electron ABI (`electron-rebuild -f -w better-sqlite3`).
  The pure `normalizeItems` and tool tests always run. See CONSIDERATIONS.md #6.
- No dedicated checklist UI this PR (deferred, §F); the tool marker carries it.
