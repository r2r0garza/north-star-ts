# PR13: Durable task history — completed/failed/cancelled tasks in the panel

> Status: **NOT STARTED**. Builds on `009` Phase 1 (the durable task runner +
> Workspace Activity panel). The panel today shows only **actionable** tasks
> (`queued`/`running`/`waiting_for_approval`/`interrupted`) and deliberately hides
> terminal ones; this PR adds a History view so a finished task is still findable.
> Depends on `009`.

## Context

`009`'s Workspace Activity panel is intentionally a *situational* view — "what's happening / what
needs my attention" — so `tasks-section.tsx` filters to the actionable statuses and drops
`completed`/`failed`/`cancelled`. That was the right call for the live panel, but it means a
finished task effectively disappears: the only trace is a dismissible completion card in the source
chat (ephemeral, session-local) and the row vanishing from the panel. There is **no way to browse
past tasks**, re-open an old task's transcript, or see why one failed after its card is gone.

The data is all already persisted — `tasks` (with `status`, `result`, `error`, timestamps,
`source_conversation_id`) and each task's private transcript + `task_events` audit trail. This PR
surfaces it as a **History** section/view in the panel, without disturbing the actionable Tasks
section.

## Goals

- A **History** section in the Workspace Activity panel listing terminal tasks
  (`completed`/`failed`/`cancelled`) for the active source conversation, newest first.
- Each row shows title, terminal status (✓ / ⚠️ / ⏹), and relative time; clicking opens the
  existing **read-only task transcript viewer** (`task-transcript-sheet.tsx`).
- Keep the actionable **Tasks** section unchanged and on top; History is collapsible and below it,
  collapsed by default so it doesn't crowd the situational view.
- Live-update: when a task reaches a terminal state, it leaves Tasks and appears in History (reuse
  the existing `tasks.onEvent` tail — both sections already re-query on lifecycle events).

## Likely shape — reuse, minimal new surface

- **No schema change.** `listTasks({ sourceConversationId, status })` already exists; History just
  queries the terminal statuses (three calls, or extend `listTasks` to accept `status[]` /
  add a `terminal` convenience — decide during build; a `status` array is the cleanest).
- **Renderer only, mostly.** New `History` section rendered by `activity-panel.tsx` via the existing
  `ActivitySection` wrapper (the panel was built to grow this way). Likely a new
  `tasks-history-section.tsx` mirroring `tasks-section.tsx`'s load + `onEvent` refetch pattern, but
  rendering compact read-only rows (no Resume/Cancel/gate UI) that call the same `onOpenTask`.
- **Scope cap to decide:** how many history rows to show (e.g. last 25) and whether to paginate or
  add a "show all" — `task_events`/`tasks` can grow. Start with a capped recent list; note the cap
  in the UI ("showing last N") rather than silently truncating.
- **Open question:** History scoped to the **source conversation** (consistent with the Tasks
  section) vs. a global "all tasks" history. Lean: per-conversation for parity now; a global view
  is a later, separate surface (and pairs naturally with search/filter).

## Out of scope (this PR)
- **Search / filter / sort controls** — flat capped recent list first.
- **A dedicated full-screen Task History view** — this is a panel section, not a new route.
- **Deleting / archiving tasks** from the UI (the `deleteTask` repo fn exists, but exposing it is a
  separate decision).
- **Global cross-conversation history** — per-source-conversation for now.
- **Retention / pruning policy** for old tasks and their transcripts.

## Verification (when built)
- Run a background task to completion → it leaves the Tasks section and appears under **History**
  with a ✓ and a relative timestamp; clicking it opens its read-only transcript.
- A failed task shows ⚠️ with its error; a cancelled task shows ⏹.
- History stays collapsed by default and doesn't push the actionable Tasks section off-screen.
- The cap is honored and labeled ("showing last N") when more terminal tasks exist.
- `pnpm typecheck` + `pnpm build` clean; existing task tests still pass.
