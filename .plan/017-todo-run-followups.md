# PR17: Todo-run follow-ups — robust large-file writes + live todo progress in the panel

> Status: **NOT STARTED**. Two independent follow-ups surfaced while testing `016`
> (todo → background handoff). Neither is a regression in `016`; both are pre-existing
> gaps the handoff flow made visible. Can ship in either order (or as two PRs).

## Context

Manual testing of the `016` handoff (run a 6-step "write CONTRIBUTING.md" todo list in the background)
exposed two problems:

1. **Writing a whole large file as one JSON tool argument is fragile.** `write_file_tool` inlines the
   entire file content as a string inside the tool-call's JSON arguments. For a big file that blob can
   exceed the model's output-token budget, so the streamed tool-call JSON is **truncated mid-argument**
   and won't parse. `016`'s testing hit exactly this: a CONTRIBUTING.md write was cut off at
   `{"path": "CONTRIBUTING.md"` (no closing brace). The immediate robustness fix already landed
   (raise the output cap to 8192 + detect `finish_reason === "length"` and fail cleanly/retryably
   instead of throwing an opaque JSON `SyntaxError` — `src/main/agent/index.ts`). **This plan is the
   longer-term structural fix** so large writes don't depend on a single oversized completion at all.

2. **The Todos panel doesn't reflect per-item progress of a background `todo_run`.** After a handoff,
   the **Todos** section in the Workspace Activity panel keeps showing every item as `[ ]` (pending)
   even after the task has finished — while the **History** section correctly shows the task
   `completed` (see the testing screenshot). This is the known limitation called out as *out of scope*
   in `016` ("Live progress mirroring of per-item status back into the SOURCE conversation's todo
   list") now biting the UX: the panel reads the **source** conversation's todos, but the background
   agent marks items completed in its **forked worker** conversation. The source list is a frozen
   snapshot from handoff time, so it never moves.

## Item 1 — Robust large-file writes

**Problem.** Full-file content travels as a JSON-string tool argument. Two compounding issues:
- It's bounded by the output-token cap (truncation → unparseable tool call). The cap bump + truncation
  detection mitigates the *symptom* but a large enough file still can't be written in one turn.
- Even when it fits, regenerating an entire file to change a few lines is wasteful and error-prone
  (the model can drift / drop content it wasn't changing).

**Direction (decide during planning — options, not yet chosen):**
- **a. Prefer surgical edits over full rewrites.** Steer the agent (prompt + tool descriptions) to use
  `edit_file_tool` (exact string replacement) for changes to existing files, reserving full-content
  writes for brand-new or wholly-replaced files. Cheapest; no new tool. Check what `edit_file_tool`
  supports today (`src/main/agent/tools/edit_file_tool.ts`) and whether it needs a multi-edit batch
  form.
- **b. A chunked/append write tool (`write_file_chunks` / `append_file`).** Write a large file across
  several tool calls (create/truncate, then append N segments), so no single call carries the whole
  blob. Each call's argument stays small and parseable. Needs a clear contract (ordering, overwrite vs
  append, finalize) and gate/approval semantics consistent with `write_file_tool`.
- **c. Both** — surgical edits as the default, chunked write as the escape hatch for genuinely large
  new files.

**Scope to settle in planning:** which option(s); whether `edit_file_tool` needs a batch/multi-edit
mode; how chunked writes interact with the approval gate (one approval for the whole write, not per
chunk); and what the model-facing guidance says about when to use which. This is general agent-tool
robustness — **not** specific to `todo_run`.

## Item 2 — Live todo progress in the panel

**Problem.** The handoff (`016`) snapshots the source conversation's todos into the forked worker
conversation and the background agent updates **the fork's** `todos` rows. The Todos panel
(`src/renderer/src/components/todos-section.tsx`) reads `db.todos.list(sourceConversationId)`, which
never changes after handoff → stale `[ ]` forever, contradicting the History row.

**Direction (decide during planning — options, not yet chosen):**
- **a. Panel reads the running task's fork todos.** When the active conversation has a live/terminal
  `todo_run` task (find via `listTasks({ sourceConversationId })`), the panel reads
  `db.todos.list(task.conversationId)` (the fork) instead of the source, so it shows real progress.
  Lowest-write-surface; keeps the source list as the pre-handoff snapshot. Needs a way to pick "the"
  task when there are several, and to refresh on the `tasks.onEvent` tail (already subscribed).
- **b. Mirror fork → source on each todo write.** The runner/agent writes per-item status back to the
  source conversation's todos as the fork progresses, so the existing source read "just works." More
  invasive (a cross-conversation write path; ordering/merge questions) and muddies the "source list is
  a snapshot" model — but means any reader of the source list sees progress.
- **c. Show the fork list in the task transcript/detail** rather than the source Todos panel, and make
  the panel clearly reflect "handed off" state. UX-led alternative.

**Scope to settle in planning:** which surface owns "live todo progress"; how the panel disambiguates
when a conversation has multiple `todo_run` tasks; whether completed/terminal tasks still show their
final list; and confirming the refresh path (the panel already refetches on `tasks.onEvent`, but the
fork's `todo_write` happens inside the task — verify those events reach the tail, or add one).

## Out of scope

- Reworking the `016` snapshot-and-seed mechanism itself (it's correct; item 2 is a read/display gap).
- One-task-per-item / subagents (still deferred).
- Chat-mode todos (todos remain interactive/north_star only).

## Verification (high level — detail during planning)

- **Item 1:** a write that previously truncated (a large CONTRIBUTING.md / multi-KB file) completes
  successfully via the chosen mechanism; surgical edits to an existing file don't regenerate the whole
  file. Unit coverage for any new/extended tool + its gate path.
- **Item 2:** run a `todo_run` handoff; the Todos panel advances `[ ] → [>] → [x]` as the background
  agent works, and shows the finished list when the task completes — matching the History row. No
  stale all-pending list.
- Standard: `npm run typecheck`; runner/DB suites need `better-sqlite3` built for node
  (`npm rebuild better-sqlite3`), restore Electron after (`npx electron-rebuild -f -w better-sqlite3`).
