# PR15: Task producer API — every background producer goes through TaskRunner

> Status: **NOT STARTED** (contract + one small affordance). Builds on the `TaskRunner`
> (`src/main/tasks/runner.ts`) from `009`, its retry (`011`), and durable approvals (`012`).

## Context

Today the only thing that creates a task is the "Run in background" UI button → `task:start` IPC →
`runner.enqueue`. Several future producers will also create tasks, **none** of them user-button
driven:

- workspace indexing (`008`)
- re-index changed files
- North Star subtasks
- scheduled / background maintenance
- artifact generation
- long-running repo analysis

The goal of this PR is a stated, tested **contract**: every producer creates work through the same
`TaskRunner` API, so approvals (`012`), events/transcript, crash recovery, cancellation, and history
(`013`) behave identically no matter who enqueued the task. A producer must never reach into the DB
or drive `runAgentLoop` directly.

## Audit result — the runner is already general (no rework needed)

An audit of `enqueue` / `createTask` / the `tasks` schema / `task-handlers.ts` found **no** hardcoded
"this came from the background button" assumption:

- **No `source` / `origin` / `created_by` column.** `tasks` has `id`, `conversation_id` (NOT NULL),
  `source_conversation_id` (nullable, `ON DELETE SET NULL`), `title`, `status`, `input`, `result`,
  `error`, timestamps. Nothing encodes a UI origin (`src/main/db/schema.ts`).
- **`enqueue` does not require a *live* source conversation.** `getConversation` returning `undefined`
  is handled gracefully — the forked worker conversation defaults `mode:"interactive"`, null
  workspace/account/model (`runner.ts` `enqueue`).
- **Fully headless.** `enqueue` touches no IPC and needs no subscriber; `emit` is fire-and-forget and
  swallows listener throws. A producer with no renderer attached runs to completion.
- **`kind` is open.** `kindOf`/`capabilityOf` fall back to `{ autoResume:false }` for unknown kinds,
  so a producer can already pass `kind:"workspace_index"` today without registering it — it just
  won't auto-resume.

So the only real gap is **auto-resume registration**: `TASK_KINDS` is a module-private const
(`runner.ts`), only ever `{ agent_chat: { autoResume:false } }`. A producer that wants its kind to
re-queue itself on restart (indexing, scheduled maintenance) has no way to opt in without editing
that literal.

## Approach

1. **Add a registration affordance** on `TaskRunner` (replacing the private `TASK_KINDS` literal as
   the source of truth):
   ```ts
   registerKind(kind: string, capability: TaskKindCapability): void
   ```
   `agent_chat` stays pre-registered (`autoResume:false`). `capabilityOf` reads the registry;
   unknown kinds still default to `{ autoResume:false }` (unchanged fallback). Producers call
   `runner.registerKind("workspace_index", { autoResume: true })` once at app init, before
   `runner.start()` runs `reconcile`/`seed`.

2. **Document the producer contract** in a short module doc-comment at the top of `runner.ts` and in
   this plan: producers create work **only** via `enqueue` (in-process) or `task:start` (over IPC),
   never by writing the `tasks`/`messages` tables or calling `runAgentLoop`. `enqueue` is the one
   seam; everything downstream (approvals, retry, recovery, history) is shared by construction.

3. **No new IPC, no schema change, no new columns.** `kind` already rides in `tasks.input`. A future
   producer that needs richer config passes it inside the `input` blob (the runner reads back
   `{ kind, message }`; extend `TaskInput` per-kind as needed) rather than adding columns.

## Out of scope

- Implementing any specific producer (indexing/maintenance/etc.) — each lands in its own PR and just
  consumes this contract.
- A scheduler / cron for time-based producers (separate concern; `011` already noted reactive
  backoff ≠ scheduling).
- Per-kind tool/prompt policy beyond what `mode` already selects on the forked conversation.
- Persisting a `source`/`origin` for analytics — not needed for behavior; revisit only if history UI
  wants to group by producer.

## Verification

- Unit (`tasks/runner.test.ts`): `registerKind("auto_kind", { autoResume:true })` then an orphaned
  `running`/`waiting_for_approval` task of that kind reconciles to **`queued`** (auto-resumes), while
  an unregistered kind still reconciles to `interrupted`. A task enqueued with a custom kind and a
  **non-existent** `conversationId` still creates a valid forked worker conversation and runs.
- Confirm headless: a task enqueued with no subscriber attached still drives `runAgentLoop` and
  settles (already covered by existing enqueue+run tests; assert it holds for a non-`agent_chat` kind).
- The runner/DB suites need `better-sqlite3` built for **node** (`npm rebuild better-sqlite3`);
  restore the Electron build afterward (`electron-rebuild -f -w better-sqlite3`).
