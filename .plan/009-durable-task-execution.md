# PR9: Durable task execution — runner over the existing task tables

> Status: **NOT STARTED** — pickup note (2026-06-27). Activates the task tables that have been
> storage-only since .plan/001. 008 (workspace indexing) depends on this — its indexer runs as a
> durable task on this runner (pause/resume/cancel are real task states). Starting hypothesis, not
> a locked spec.

## Context

The database **already has the task model** — `tasks`, `task_events`, `task_checkpoints`, and
`approvals` tables (`db/schema.ts:43-87`, repository at `db/repositories/tasks.ts`) — but it's
explicitly **storage-only**: the repo comment says *"rows persist a task's lifecycle, but no
runner acts on them yet."* The `status` enum already anticipates everything we need:
`'queued' | 'running' | 'waiting_for_approval' | 'interrupted' | 'completed' | 'failed' |
'cancelled'`.

Meanwhile the actual execution path — `runChat` (`agent/index.ts`) — is **synchronous and
ephemeral**: a chat turn runs to completion in-process tied to a live IPC call, with an
`AbortController` per conversation (`abortControllers` map). If the app quits mid-turn, or the
turn fails partway, there is no durable record to resume from and no retry — the work is simply
lost. There is no queue: two requests for the same conversation can't be ordered durably; nothing
runs unattended in the background.

This PR adds a **durable task runner** that consumes the existing task tables to make agent work:
- **resumable** — an interrupted task (app crash/quit, or explicit pause) can continue from its
  last checkpoint rather than restarting,
- **background** — a task runs without a live renderer attached; progress is persisted and
  streamed when a renderer is listening,
- **queued** — tasks are ordered and run under a concurrency policy instead of racing,
- **retried** — a transient failure (network blip, gateway 5xx) retries with backoff instead of
  dropping the turn.

This is the substrate 008's indexing job (and future long-running agent work) runs on.

## Open questions to resolve BEFORE building

1. **Relationship to `runChat`.** A "task" is a durable wrapper around agent work; `runChat` is
   the loop that does the work. Options: (a) the runner *invokes* `runChat` as its execution body,
   persisting checkpoints around each loop iteration; (b) `runChat` is refactored so its loop body
   is re-entrant/resumable and the runner drives it step-by-step. **Lean: (a)** for the first cut
   — wrap `runChat`, checkpoint at turn boundaries (after each model round-trip + tool batch) —
   then deepen to (b) if mid-turn resume is needed. Decide the checkpoint granularity here.

2. **What is a checkpoint?** `task_checkpoints` stores a JSON `state` blob. The cheapest durable
   resume point is the **message history** itself (already persisted in `messages`), so a
   checkpoint may be little more than `{ lastMessageSeq, status, loopState }`. Decide: do we need
   a separate checkpoint blob at all, or is "replay from persisted messages + a cursor" enough?
   (Replaying messages is attractive — it reuses the existing transcript and avoids a second
   source of truth.)

3. **Resume semantics & idempotency.** If a task is interrupted *after* a tool ran (a file was
   written, a shell command executed) but *before* the result was persisted, resuming must not
   re-run a non-idempotent side effect. Proposal: persist the tool result **before** continuing
   the loop (runChat already appends tool results via `appendMessage` — confirm ordering), so
   resume picks up after the last *persisted* tool result. Document the at-most-once vs.
   at-least-once guarantee per tool.

4. **Concurrency model.** How many tasks run at once, and is it per-conversation or global? The
   UI disables Send while a turn is loading (one turn per conversation today). Proposal: a single
   global runner with a small concurrency cap, FIFO within a conversation, configurable cap
   across conversations. Decide whether a long background task (e.g. indexing) shares this pool or
   has its own lane (priority — mirrors 008's low/high).

5. **Retry policy.** Which failures retry? Transient (gateway 5xx / network / timeout) → yes, with
   capped exponential backoff; deterministic (bad tool args, denied approval, blocked command,
   user cancel) → no. Decide max attempts, backoff schedule, and where it's recorded
   (`task_events` append-only log is the natural home). A user **Stop**/cancel must never retry.

6. **Interaction with the abort/approval/Stop work (005, shipped).** Cancellation already works
   for a live turn (Stop → `AbortController` → kill in-flight tool). For durable tasks, cancel
   must also: mark the task `cancelled`, not retry, and tear down cleanly. The approval gate
   already resolves to "denied" on abort, and `waiting_for_approval` is already a task status —
   wire the durable approval flow (`approvals` table) to the live gate (currently in-memory
   `pendingApprovals` in `agent/index.ts:536`). Decide how a task waiting for approval survives an
   app restart (the in-memory pending map does not).

7. **Background without a renderer — event buffering.** Today events stream live via `chat:event`
   only while the renderer is attached (`main/index.ts:67-72`). A background task with no listener
   must persist progress to `task_events` and let a (re)attaching renderer replay from the log.
   Proposal: `task_events` is the durable event stream; `task:event` IPC is a live tail of it.
   Confirm the renderer can reconstruct UI state from the event log on reattach.

8. **Crash recovery on startup.** On app launch, find tasks left `running`/`waiting_for_approval`
   (the process died mid-flight) and reconcile: mark `interrupted`, then auto-resume the resumable
   ones (or surface them for the user to resume). Decide auto-resume vs. manual.

## Likely implementation shape (hypothesis — revisit after Q1/Q2)

### Reuse what exists — minimal/no schema change
The tables and the `tasks.ts` repository already cover the lifecycle. Likely additions, only if
needed:
- A `attempts` / `next_run_at` column on `tasks` for retry backoff (v7/v8 migration — append,
  never edit a shipped migration, per `db/migrations.ts:5`).
- A `priority` column if the runner shares a pool with indexing (Q4) — or keep priority on the
  job type, not the row.
Otherwise: `task_events` is the durable progress log, `task_checkpoints` the resume state, and the
existing `createTask`/`updateTask`/`listTasks(status)` helpers drive the queue.

### Main-process runner
- New `src/main/tasks/runner.ts` (`TaskRunner`): a singleton that
  1. on startup, reconciles orphaned `running` tasks → `interrupted` (Q8),
  2. polls/awaits `queued` tasks (a simple in-memory wakeable queue seeded from
     `listTasks({status:'queued'})`, not a busy poll),
  3. runs each task under a concurrency cap by invoking the agent loop as its body (Q1),
     checkpointing at turn boundaries and appending to `task_events`,
  4. owns an `AbortController` per running task (reuse the 005 pattern; the
     `abortControllers` map generalizes from conversation-keyed to task-keyed),
  5. on transient failure, schedules a retry with backoff (Q5); on cancel, marks `cancelled` and
     does not retry.
- Refactor `runChat` so its loop body can be invoked by the runner with a persisted-message
  starting point (Q1/Q2). Keep the existing direct `chat` IPC path working (a "live task" is the
  same code path with a renderer attached) so this is additive, not a rewrite.

### IPC & wiring
- The task CRUD IPC already exists (`db:tasks:*`, preload `db.tasks`). Add control verbs:
  `task:start`/`task:pause`/`task:resume`/`task:cancel` (invoke) and a `task:event` live-tail
  channel mirroring `chat:event` (`main/index.ts:67-72`), exposed through the preload bridge.
- On reattach, the renderer replays `task_events` (via `db:taskEvents:list` or similar) then
  subscribes to `task:event` for the live tail (Q7).

### Convergence with 008
If 008 ships its own `IndexService` first (recommended there), this runner generalizes it: an
indexing job becomes a task with a `priority` lane. Note the migration path; don't block either PR
on the other.

## Verification (when built)
- **Queue:** enqueue several tasks; they run in order under the concurrency cap (not all at once),
  each transitioning `queued → running → completed` with events in `task_events`.
- **Resume after crash:** start a multi-step task, hard-kill the app mid-task → relaunch → the
  task is reconciled (`interrupted`) and resumes from its last checkpoint/persisted message, not
  from scratch; no tool side effect is duplicated (Q3).
- **Background:** start a task, close the conversation view (no live renderer) → it keeps running,
  progress lands in `task_events`; reopen → the UI replays the log and tails live.
- **Retry:** simulate a transient gateway 5xx → the task retries with backoff and eventually
  completes; a deterministic failure (denied approval) does **not** retry and ends `failed`/
  `cancelled`.
- **Cancel:** Stop a running durable task → status `cancelled`, in-flight tool killed (005), no
  retry, clean teardown.
- **Approval across restart:** a task hits `waiting_for_approval`, quit + relaunch → the pending
  approval is recoverable from the `approvals` table (not lost with the in-memory map) (Q6).
- `pnpm typecheck` + `pnpm build` clean; new runner/repository unit tests pass; the existing
  synchronous `chat` IPC path still works unchanged (live turn == task with a renderer attached).

## Out of scope
- **Distributed / multi-process execution** — single-process runner in main.
- **Cron / scheduled tasks** — this is queue + resume + retry, not a scheduler.
- **Reworking the LLM streaming layer** — the runner wraps the existing loop; it doesn't change
  how tokens stream (the Portkey path stays as-is, including the 005 consume-loop cancellation).
- **A full pause/resume of a mid-model-round-trip turn** — first cut checkpoints at turn
  boundaries (Q1); finer-grained mid-turn resume is a follow-up.
- **The 008 indexing job's domain logic** — 009 provides the runner; 008 provides the work.
