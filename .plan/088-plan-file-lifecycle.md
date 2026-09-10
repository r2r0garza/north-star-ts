# PR88: Conversation plan-file lifecycle and retention

> Status: **COMPLETED**. Plan-mode documents are conversation-owned temporary artifacts: they are deleted
> with their conversation and regular Markdown plans older than 30 days are pruned at startup and daily.

## Context

Plan mode writes one Markdown document per conversation to
`~/.<system_name>/plans/<conversationId>.md`. A later `write_plan` call replaces the whole file, while
`read_plan` and `present_plan` read it back. Today no path removes these documents: approval leaves the
file intact, deleting the owning conversation only removes database state, and startup performs no plan
maintenance. Plans therefore accumulate indefinitely, including files orphaned by deleted conversations.

## Product decisions

1. A plan belongs to its conversation. Hard-deleting a conversation also deletes that conversation's plan
   file if one exists.
2. Plan files are temporary rather than durable conversation history. Any plan older than 30 days is
   eligible for pruning even when its conversation still exists.
3. Age is measured from filesystem `mtime`. Rewriting a plan refreshes its retention window; reading or
   presenting it does not.
4. Plan cleanup is best-effort. Failure to remove an artifact must not undo or block an otherwise valid
   conversation deletion or prevent application startup.
5. The TTL sweep runs once at startup and once every 24 hours while the app remains open. The timer must
   not keep the Electron process alive and must be stopped during shutdown.

A conversation retained for more than 30 days can therefore outlive its plan. A later `read_plan` should
continue to return its existing `no_plan` result; expiry does not need a new user-facing state in this
phase.

## Architecture

Keep `src/main/db/repositories/conversations.ts` synchronous and concerned only with SQLite. Add an
asynchronous conversation-lifecycle layer that coordinates repository deletion with app-owned artifacts,
and put all plan-path filesystem behavior in the plan storage module.

The deletion order is:

1. Determine the complete set of conversation IDs to remove, including descendant task-worker
   conversations where applicable.
2. Stop and await in-flight work using the existing `TaskRunner` behavior.
3. Commit the synchronous database deletion.
4. Await best-effort deletion of the corresponding plan files. Missing files are success; other failures
   are logged with bounded context and do not turn a completed database deletion into a reported failure.
5. Rely on the TTL sweep as a repair path if immediate artifact cleanup fails.

Do not put filesystem I/O in the database repository and do not launch unobserved fire-and-forget cleanup
from deletion paths. Existing synchronous callers that delete conversations during startup or inside a
larger service operation should be made async at their outer boundary, preserving any required SQLite
transaction and awaiting artifact cleanup immediately after it commits.

## Storage API

Expand `src/main/agent/tools/plan-file.ts` (or rename it to a nearby `plan-storage.ts` if that produces
cleaner imports) around these responsibilities:

```ts
const PLAN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const PLAN_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000

planFilePath(conversationId: string): string
ensurePlansDir(conversationId: string): Promise<string>
deletePlanFile(conversationId: string): Promise<void>
deletePlanFiles(conversationIds: Iterable<string>): Promise<void>
pruneExpiredPlanFiles(now?: number): Promise<PruneResult>
startPlanMaintenance(): void
stopPlanMaintenance(): void
```

Exact exported names may follow local conventions. `deletePlanFile` treats `ENOENT` as success. Batch
cleanup should attempt every ID even if one removal fails and should expose or log failures without
rejecting before the remaining files are attempted.

`pruneExpiredPlanFiles` must:

- return cleanly when the plans directory does not exist;
- inspect only direct children of the app-controlled plans directory;
- consider only regular files with a `.md` suffix;
- use `mtimeMs < now - PLAN_TTL_MS` as the expiry boundary;
- ignore directories, symlinks, and unrelated files;
- tolerate an entry disappearing between directory read, stat, and unlink;
- continue after a per-file error and return enough counts for bounded diagnostic logging; and
- never create the plans directory merely to prune it.

The fixed, server-computed path and conversation scoping of `write_plan`/`read_plan`/`present_plan` remain
unchanged.

## Implementation plan

### 1. Add plan deletion and pruning primitives

Extend the plan storage module with an explicit plans-directory helper, idempotent single/batch deletion,
and the 30-day `mtime` sweep. Keep time injectable through a `now` argument so boundary tests do not use
real waiting or fake global clocks.

Add focused tests beside the existing plan tool tests covering:

- deletion of an existing conversation plan;
- deletion when the file or plans directory is absent;
- batch deletion continuing after one per-file failure;
- an expired Markdown file being removed;
- a file just inside the 30-day window being retained;
- exact cutoff behavior;
- a rewritten file receiving a fresh retention window;
- unrelated extensions, subdirectories, and symlinks being ignored; and
- per-entry races/errors not preventing other expired files from being processed.

### 2. Coordinate all production conversation-deletion paths

Introduce a small conversation lifecycle service rather than coupling the database repository to plan
storage. Route every production conversation removal through it or explicitly through its
post-transaction artifact-cleanup seam.

Known call sites to cover:

- `src/main/ipc/db-handlers.ts` — sidebar/session deletion, including its no-runner fallback;
- `src/main/tasks/runner.ts` — `deleteSourceConversation`, including every collected descendant worker
  conversation;
- `src/main/tasks/runner.ts` — startup `reapOrphans`; make the startup boundary awaitable so cleanup is
  tracked before reconciliation/pumping continues; and
- `src/main/tasks/process/service.ts` — stale validator-worker replacement in `retryReview`. Preserve the
  existing SQLite transaction, then await cleanup of the deleted worker conversation immediately after
  commit; propagate async through its IPC handler.

Search again for direct `deleteConversation`/`deleteConversations` production imports during implementation
so newly added or overlooked paths cannot bypass lifecycle cleanup. Tests should assert both database
removal and plan removal for single, cascaded worker, orphan-reaper, and stale-reviewer cases.

### 3. Add startup and daily retention maintenance

At `app.whenReady`, launch and await-or-observe one startup prune using the same explicit error-reporting
pattern as existing startup maintenance. Start a once-daily unref'd interval only after startup
initialization. Add `stopPlanMaintenance()` to the existing quit teardown path.

Prevent overlapping sweeps: if one maintenance run is still active when the next tick arrives, skip or
reuse it rather than scanning concurrently. Maintenance failures should emit one bounded warning and leave
the app usable.

Use fake timers or injected scheduling dependencies to verify that maintenance starts once, runs at the
expected cadence, does not overlap, and stops cleanly.

### 4. Verify behavior and regressions

Run the focused plan-storage, conversation lifecycle, task-runner, process-service, and IPC tests, followed
by the repository's configured typecheck/test checks. Manually verify with a temporary conversation that:

1. plan mode creates the expected plan file;
2. deleting the conversation removes it;
3. an artificially aged plan is removed at startup or a maintenance invocation; and
4. a current plan remains readable and approval behavior is unchanged.

## Acceptance criteria

- Deleting a conversation removes its `~/.<system_name>/plans/<conversationId>.md` file when present.
- Cascaded deletion removes plan files for the source and all deleted worker conversations.
- No production conversation-deletion path bypasses artifact cleanup.
- Missing or undeletable plan files do not block committed database deletion.
- Regular `.md` files with `mtime` strictly older than 30 days are pruned automatically at startup and on
  a daily cadence.
- Current files and non-plan entries are retained; pruning never follows symlinks or recurses.
- Rewriting through `write_plan` refreshes the effective TTL through normal filesystem `mtime` behavior.
- Cleanup work is awaited or explicitly owned; there are no untracked cleanup promises.
- Existing `write_plan`, `read_plan`, and `present_plan` behavior remains unchanged for retained plans.

## Likely files

- `src/main/agent/tools/plan-file.ts`
- `src/main/agent/tools/plan-file.test.ts` or adjacent plan-tool tests
- `src/main/conversations/lifecycle.ts` and tests (exact folder may follow existing service conventions)
- `src/main/ipc/db-handlers.ts` and relevant tests
- `src/main/tasks/runner.ts` / `src/main/tasks/runner.test.ts`
- `src/main/tasks/process/service.ts` / `src/main/tasks/process/service.test.ts`
- `src/main/ipc/process-handlers.ts`
- `src/main/index.ts`

## Out of scope

- Persisting plan contents in SQLite or rendering them as permanent conversation history.
- Versioning plan revisions; `write_plan` continues to replace the document.
- User-configurable retention settings or a plans-management UI.
- Deleting conversations merely because their plan expires.
- Recursively cleaning arbitrary files beneath the app data directory.
