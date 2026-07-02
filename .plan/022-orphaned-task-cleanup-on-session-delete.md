# PR22: Orphaned tasks & worker conversations on session delete

> Status: **DONE** (commit ref pending). Found while manually verifying `021` (approvals context
> section). A data-lifecycle bug, unrelated to `021` — the approvals work only surfaced it.
>
> **Shipped.** Both decisions resolved before building: (1) **delete all** tasks a deleted session
> sourced, regardless of status; (2) reconcile safety net **reaps** source-less tasks of kinds with no
> independent UI surface. Runner reachability: threaded `taskRunner` into `registerDbHandlers`
> (type-only import — no cycle). Migration cascade: confirmed migrations run `foreign_keys = OFF`, so
> `SCHEMA_V9` deletes children explicitly via a recursive CTE (excluding `workspace_index`, which is
> born source-less by design and observable in the indexing panel).
>
> **Delivered:** a `hasIndependentSurface` capability flag on `TaskKindCapability`; an `inflight` map so
> a running task fully settles before its row is deleted; `TaskRunner.deleteSourceConversation(id)` —
> transitive (BFS over source links) cancel-then-delete; `reapOrphans()` run at the top of `start()`;
> `deleteConversations(ids)` transactional repo helper; runner-coordinated `db:conversations:delete`;
> and `SCHEMA_V9` (`user_version` → 9). Verified: `pnpm typecheck` + `pnpm build` clean; new runner
> tests (cascade + child rows, in-flight abort-before-delete with no FK throw, transitive nested reap,
> reapOrphans reaping `todo_run` vs. keeping `workspace_index`) and a new `migrations.test.ts` (fresh
> DB → v9; orphan + transitive reap with live/`workspace_index` preserved; `foreign_key_check` clean);
> two pre-existing `user_version` assertions bumped 8 → 9. **Verified against the real dev DB**: v9
> applied, orphaned tasks now 0, all sessions intact, `foreign_key_check` + `integrity_check` clean
> (after clearing unrelated `pr21-test-task` manual-test debris that predated this work).

## Context

Deleting a session from the sidebar leaves durable-task state behind — orphaned rows that the UI can
never reach again, that accumulate without bound, and (worse) that the runner may still auto-resume on
boot with no panel to observe or cancel them.

**How it happens (schema-level).** A durable task forks its **own worker conversation** to hold the
task's private transcript (`tasks.conversation_id`), and links back to the session it was started from
via `tasks.source_conversation_id`. The FK on-delete behaviors differ:

```
tasks.conversation_id        → conversations(id) ON DELETE CASCADE   -- the worker transcript
tasks.source_conversation_id → conversations(id) ON DELETE SET NULL  -- the originating session
```

The sidebar deletes the **source** session (`db:conversations:delete` → `deleteConversation` →
`DELETE FROM conversations`). Because the source is referenced by `source_conversation_id` (SET NULL),
the delete:
- **Nulls the task's `source_conversation_id`** — the task survives, but now belongs to no session.
- **Leaves the worker conversation intact** — it's a *different* conversation row, only cascade-deleted
  if the worker itself is deleted, which never happens (workers aren't shown in the sidebar, so the
  user can't delete them).

**Why the UI can't see it.** The tasks/activity panel fetches by `sourceConversationId`
(`tasks-section.tsx:204` → `db.tasks.list({ sourceConversationId })`). A task whose source was deleted
has `source_conversation_id = NULL`, so it matches **no** panel — invisible, unresumable, uncancellable
from the UI. And `listConversations` already hides worker transcripts
(`conversations.ts:67`, `id NOT IN (SELECT conversation_id FROM tasks …)`), so the orphaned worker never
appears in the sidebar either. The rows exist only in the DB.

**Why it's more than cosmetic.** `agent_chat` is manual-resume-only, but auto-resume kinds (`todo_run`,
`workspace_index`, and future `goal_run` from `018`) reconcile `interrupted` → `queued` on boot
(`runner.ts` `reconcile`/`seed`). An orphaned **non-terminal** task of such a kind will silently
auto-resume after a restart with **no UI to observe, pause, or cancel it** — a runaway with no handle.

**Observed in a real dev DB (2026-07-01):** 25 tasks with `source_conversation_id IS NULL`, 42 orphaned
worker conversations. In that snapshot the 25 orphans were all terminal (completed/failed/cancelled),
so no runaway — but the accumulation is unbounded and the auto-resume hazard is latent, not theoretical.

## Goal

Deleting a session cleans up the durable tasks it spawned — their worker conversations, and all
child rows (`approvals`, `task_events`, `task_checkpoints`, worker `messages`/`todos`) — with the
runner coordinated so an **in-flight** task is stopped first, never deleted out from under itself.
No orphaned worker conversations; no invisible auto-resuming tasks.

## Two parts

### A. Fix the delete path (behavior)

When a session is deleted, cascade to the tasks it sourced:

1. **Runner-coordinated delete.** `db:conversations:delete` must go through (or notify) the
   `TaskRunner` singleton — the runner owns in-flight tasks (`this.running`, backoff timers, the
   queue). The handler currently calls `conversations.deleteConversation` directly
   (`db-handlers.ts:83`) and has **no runner reference** (`registerDbHandlers(indexService?)` —
   `db-handlers.ts:51`; the runner lives in `main/index.ts:32` as `taskRunner`). Thread the runner in
   (or add a `runner.deleteSourceConversation(id)` seam it calls). For each task sourced from the
   deleted session: cancel it if running/queued/backing-off (reuse `cancel`/abort), then delete the
   task + its worker conversation. Cascades handle the child rows.
2. **What to delete.** For each `task` where `source_conversation_id = <deleted id>`: delete the
   **worker conversation** (`tasks.conversation_id`) — its `ON DELETE CASCADE` removes the task, its
   `messages`, `todos`, `approvals`, `task_events`, `task_checkpoints` in one shot. Then delete the
   source conversation itself.
   - **Decide (open question 1):** delete *all* sourced tasks, or **preserve terminal history** and
     only clean up non-terminal ones? Leaning: delete all (the session is gone; its task history has
     no home) — but a "keep completed tasks visible somewhere" stance is defensible. Resolve before
     building.
3. **Guard the auto-resume hazard regardless.** Even with the delete fixed going forward, `reconcile`
   should **not** auto-resume a task whose `source_conversation_id IS NULL` for a kind that has no
   independent surface — or should route it to `interrupted` (manual) rather than `queued`. This is
   the safety net if any orphan slips through. (Confirm which auto-resume kinds have their own panel:
   `workspace_index` surfaces in the indexing section, so it's observable; a bare orphaned
   `todo_run`/`goal_run` is not.)

### B. One-time cleanup of existing orphans (migration `SCHEMA_V9`)

Append a `SCHEMA_V9` migration (next `user_version` = 9) that sweeps orphans already in the DB. Follow
the existing migration conventions (`migrations.ts`): append a new entry, never edit a shipped one;
the loop runs with `foreign_keys OFF` and re-checks after.

```sql
-- 022: reap durable-task state orphaned by session deletes (source_conversation_id
-- was SET NULL when the originating session was removed; the worker conversation and
-- task rows were never cleaned up). Delete the worker conversations for orphaned
-- tasks; ON DELETE CASCADE clears tasks + messages + todos + approvals + task_events
-- + task_checkpoints. Terminal-vs-all follows the part-A decision.
DELETE FROM conversations
WHERE id IN (
  SELECT conversation_id FROM tasks WHERE source_conversation_id IS NULL
  -- AND status IN ('completed','failed','cancelled')  -- if "non-terminal only"
);
```

Because migrations run with FKs off, follow the `SCHEMA_V8` precedent and rely on the post-migration
`foreign_key_check`; delete child rows explicitly if the cascade won't fire with enforcement off
(verify — `V8`'s note says the DROP *would* cascade with FKs on; a plain `DELETE` with FKs off will
**not** cascade, so this migration likely must delete `tasks`/`messages`/`approvals`/… explicitly, or
toggle FKs on for this statement). **Resolve this mechanic before writing the migration** — get it
wrong and it leaves the very orphans it's meant to reap.

## Likely files

- `src/main/ipc/db-handlers.ts` — `db:conversations:delete` handler (thread the runner in;
  `registerDbHandlers` signature at `:51`, call site `main/index.ts:143`).
- `src/main/tasks/runner.ts` — a coordinated `deleteSourceConversation(id)` / cancel-then-delete seam;
  and the `reconcile` guard for orphaned auto-resume kinds (part A.3).
- `src/main/db/repositories/conversations.ts` — possibly a `deleteConversationCascadingTasks(id)`
  helper, or keep the orchestration in the runner and leave this repo as the raw delete.
- `src/main/db/schema.ts` + `src/main/db/migrations.ts` — append `SCHEMA_V9` + its `MIGRATIONS` entry.

## Open questions to resolve BEFORE building

1. **Terminal history:** delete *all* tasks a deleted session sourced, or keep completed/failed ones
   (and if kept — visible where, given their source is gone)? Drives both part A and the V9 `WHERE`.
2. **Migration cascade mechanic:** with `foreign_keys OFF` during migrations, does a `DELETE FROM
   conversations` cascade to tasks/children? If not (likely), the migration must delete children
   explicitly or re-enable FKs for that statement. Prototype against a copy of the real dev DB.
3. **Auto-resume policy:** should `reconcile` ever auto-resume a source-less task? Per-kind
   (`workspace_index` is observable via the indexing panel; `todo_run`/`goal_run` are not)?
4. **Runner reachability:** thread the `taskRunner` singleton into `registerDbHandlers`, or expose a
   module accessor? (`runChat` already can't import the runner due to a cycle — `main/index.ts:93`
   comment — so mirror however that's brokered.)

## Verification (when built)

- **Repo/runner test:** create a source conversation + a durable task (with a forked worker + an
  approval + a task_event); delete the source; assert the task, worker conversation, and all child
  rows are gone (no orphans), and — per the part-A decision — terminal tasks are handled as chosen.
- **In-flight guard:** a *running* task whose source is deleted is cancelled/aborted first, then
  removed — never deleted mid-turn (assert against a stubbed `runAgentLoop`, mirroring existing runner
  tests).
- **Reconcile guard:** an orphaned non-terminal auto-resume task does **not** silently go to `queued`
  on boot (goes `interrupted`, or is reaped) — assert via the reconcile path.
- **Migration:** run `SCHEMA_V9` against a copy of the real dev DB (25 orphaned tasks / 42 orphaned
  workers) → orphan counts drop to 0, no dangling refs (`PRAGMA foreign_key_check` clean), retained
  rows (if any) intact. `runMigrations` brings a fresh DB to `user_version = 9`.
- `pnpm typecheck` + `pnpm build` clean.
- **Manual:** start a durable task from a session, delete that session, confirm no orphaned worker
  conversation remains and the task doesn't reappear/auto-resume after a restart.

## Out of scope

- Any change to the approvals context section (`021`) — this is a separate lifecycle concern.
- Redesigning worker-conversation modeling (keep the fork-per-task pattern; just clean it up on delete).
- A general "trash/restore" or soft-delete system — this is a hard cleanup matching today's hard delete.
- Surfacing orphaned/background tasks in a new global UI — the fix removes them, not re-homes them.
