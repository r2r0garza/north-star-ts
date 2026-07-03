# PR24: Index filesystem/git watcher — keep the workspace index (and its summary) fresh

> Status: **PLANNED** (2026-07-03). Starting hypothesis, not a locked spec — resolve the open
> questions before building. Depends on 008 (workspace indexing: the index tables, `IndexService`,
> `ensureRunning`, the compact prompt summary) and 009 (durable task runner: the `workspace_index`
> kind, pause/resume/cancel). This is the "live file watching" follow-up explicitly deferred in 008
> ("Out of scope → Live file watching (chokidar)") and again in 014.

## Context

The workspace index is **only refreshed by an explicit `IndexService.ensureRunning` call**, and
today that fires from a narrow set of triggers, *none of which react to the workspace on disk*:

- `maybeAutoIndex` on conversation **create/update** (`src/main/ipc/db-handlers.ts:28`), gated by
  the `autoIndexNewWorkspaces` setting + the per-workspace `enabled` flag + mode
  (`interactive`/`north_star`).
- Manual UI actions — `index:start` (Start/Rebuild) and `index:setEnabled`
  (`src/main/ipc/index-handlers.ts`).

There is **no filesystem or git watcher anywhere in `src/main`** (confirmed: no `chokidar`,
`fs.watch`, `watchFile`, or `FSWatcher` usage). So the index — and the compact summary
`buildIndexSummary` injects into the Interactive/North Star system prompt on **every message send**
(`src/main/agent/index.ts:494`) — is only as fresh as the last time a run happened to fire.

Every line of that summary is a snapshot read from the index DB (`getRunByWorkspace`, `countByExt`,
`listMetadata`, `countSymbols`), so **all of it can be stale**: file counts, `package.json`
name/scripts, config presence, README excerpt, symbol count, and the **git branch**.

**Why the git branch stands out.** It's the one field that changes *without any file content
changing*. Stage 1 (`file_map`) is hash-skip incremental, so a `git checkout` that swaps branches
but leaves the working tree identical (e.g. checking out a just-merged branch) produces **zero
dirty files** — nothing to re-index — while the branch label the agent sees is whatever
`.git/HEAD` said at the last run. Branches flip constantly; file bodies don't. So the branch drifts
farthest, fastest. (When a run *does* fire, the branch self-heals: the metadata stage re-reads
`.git/HEAD` unconditionally every run — `src/main/index/service.ts:322`. The bug is trigger
frequency, not read logic.)

Observed symptom that motivated this plan: the injected summary reported
`Git branch: pr21-approvals-context-section` while the user was actually on `main`.

## Goal

Re-index (incrementally) when the workspace changes on disk, so the index and its summary track
reality without the user having to create/update a conversation or click Rebuild. Two distinct
change sources, deliberately called out because they have very different cost/precision:

1. **Working-tree file changes** — edits/adds/deletes under the workspace root. Should trigger an
   incremental re-index (the existing hash-skip `file_map` → dirty-only `symbols` path is already
   cheap; we just need something to *kick* it).
2. **Git ref changes** — `git checkout`, `commit`, `branch`, `rebase`, `merge` (i.e. `.git/HEAD`
   and the ref it points at). Should at minimum refresh the `git` metadata row (branch/sha), and —
   because a checkout can swap many files at once — kick an incremental re-index too.

## Design options (resolve in Q-section before building)

### Option A — targeted git-HEAD watch only (cheapest, fixes the loud symptom)
Watch just `.git/HEAD` and the current ref file (e.g. `.git/refs/heads/<branch>`, plus
`.git/packed-refs`). On change, re-run the **metadata stage only** (or even just
`readGitBranch` → `upsertMetadata("git", …)`). Does **not** address working-tree file staleness,
but kills the most-visible drift for near-zero cost and no new dependency (`fs.watch` on a handful
of paths).

> Not the chosen scope on its own — captured because it's the minimal fix and a viable fallback if
> the full watcher proves too janky. A strictly-cheaper non-watcher variant also exists: read
> `.git/HEAD` **live** inside `buildIndexSummary` instead of from the metadata row (single small
> file read via the existing `readGitBranch`). That was considered and rejected as the *primary*
> fix because it only patches the summary surface, not the index the `index_query_tool` reads.

### Option B — full workspace watcher (recommended scope)
A real recursive watcher over the workspace root that debounces bursts and kicks
`IndexService.ensureRunning` (incremental) on any change, **plus** the git-ref watch from Option A
for branch/sha freshness. This is the "live file watching" 008 deferred.

**Watcher mechanism — decide in Q1:**
- **`chokidar`** — robust, cross-platform, handles the recursive + `.gitignore`-ish exclusion story
  well, but a new runtime dependency (008 deliberately avoided it). Widely used, batteries-included.
- **Node core `fs.watch(root, { recursive: true })`** — no new dep, but `recursive` is only
  reliable on macOS + Windows (not Linux), event coalescing/rename semantics are platform-specific,
  and it hands back bare filenames (we'd re-derive ignore filtering ourselves). Given this is an
  Electron app, macOS/Windows-first is defensible; Linux would need a fallback (per-dir watches or
  polling).
- **`@parcel/watcher`** — native, recursive, fast, cross-platform including Linux, supports an
  ignore list; a heavier native dep (prebuilds; interacts with the `@electron/rebuild` native-module
  story already in the repo — see the native-module rebuild memo).

### Watcher lifecycle & wiring (Option B shape)
- A new **`IndexWatcher`** in `src/main/index/` (sibling to `service.ts`), owned by the main process
  and constructed alongside `IndexService` in `src/main/index.ts` (which already holds
  `taskRunner` + `indexService`). It does **not** run as a 009 task — it's a long-lived listener,
  not a unit of work; it *produces* work by calling `indexService.ensureRunning`.
- **Which workspaces are watched?** Options: (a) watch a workspace whenever a conversation
  referencing it is opened (mirror `maybeAutoIndex`'s trigger, so watch lifetime tracks "is this
  workspace in use"); (b) watch every workspace with an `enabled` index run. Lean (a) to bound the
  number of live watchers. **Decide in Q2.** Needs a `start(workspaceId, path)` /
  `stop(workspaceId)` surface and de-dup (one watcher per workspace path).
- **Debounce/coalesce:** a per-workspace trailing debounce (e.g. 500ms–2s) so a `git checkout`,
  `pnpm install`, or editor save-storm collapses into a single `ensureRunning` call. `ensureRunning`
  is already idempotent (no-op if a run is live), and `file_map` is hash-skip, so an over-eager kick
  is cheap but not free (a full tree walk + stats). Debounce keeps walks rare.
- **Ignore rules:** the watcher must honor the same exclusions as the walk (`DEFAULT_SKIP_DIRS` +
  `.gitignore`) so `node_modules`/`dist`/`.git` churn doesn't trigger constant re-indexes. Note the
  tension: we must **exclude `.git/` from the file-change watch** (commits rewrite tons of objects)
  but **specifically watch `.git/HEAD` + refs** for branch changes — two separate, deliberately
  different watch scopes. Reuse `loadGitignore` + `DEFAULT_SKIP_DIRS` from
  `src/main/agent/env/walk.ts`.
- **Priority:** watcher-triggered re-indexes use `low` (background) priority — they're maintenance,
  never on a user's turn latency.
- **Respect the disable flag & setting:** never watch/kick a workspace whose run is
  `enabled = 0`, and gate the whole feature behind the indexing settings (see below).

## Settings

Extend the existing **Workspace Indexing** settings group (`IndexingSettings` in
`src/main/settings/service.ts` — currently `autoIndexNewWorkspaces`, `useIndexForContext`,
`includeEmbeddings`). Add one toggle:

```
Workspace Indexing
  [x] Automatically index new workspaces
  [x] Use index to improve agent context
  [x] Watch workspace for changes and re-index automatically   ← new (024)
  [ ] Include embeddings   (later)
```

- **Watch workspace for changes…** — global on/off for the watcher. Off = today's behavior
  (index-on-conversation-activity + manual only). Defaults **on** (fresh index is the point). This
  is a global settings-store toggle → **no migration** (mirrors how 008 added its group).
- The existing per-workspace `index_runs.enabled` flag still wins: a disabled workspace is neither
  indexed nor watched.

## Open questions to resolve BEFORE building

1. **Watcher mechanism** — `chokidar` vs core `fs.watch({recursive})` vs `@parcel/watcher`? Weigh
   the new-dependency cost (008 avoided one) against Linux recursive-watch reliability and the
   native-rebuild story (`@electron/rebuild`, per the repo's native-module memo). Recommendation to
   pin down: `chokidar` for correctness/portability unless the dep is unwelcome, in which case
   `fs.watch` with a Linux fallback.
2. **Watch scope / lifetime** — watch on conversation-open (tracks active use) vs watch every
   `enabled` workspace (simpler, more watchers)? How/when to `stop()` (conversation closed? app
   quit only?). Bound the number of concurrent recursive watchers.
3. **Git-ref freshness path** — when only `.git/HEAD`/refs change (branch switch, no working-tree
   diff), is a **metadata-only** refresh enough, or always kick a full incremental `ensureRunning`?
   (A checkout usually *does* change files, so a full incremental is often warranted anyway — but a
   pure branch label change with an identical tree is the pathological case that started this.)
   Consider a lightweight `IndexService.refreshMetadata(workspaceId)` seam so a branch flip doesn't
   pay for a whole tree walk.
4. **Debounce window** — single trailing debounce, or separate windows for file-change vs git-ref
   events? Value (500ms? 2s?). Must swallow a `pnpm install` / large `git` op without a walk per
   event.
5. **Backpressure / churn guard** — a build watching its own `dist`, a dev server writing logs, or
   a `git rebase` can fire thousands of events. Beyond ignore rules + debounce, do we need a
   circuit-breaker (e.g. if >N kicks in M minutes, back off / surface a "watcher paused" state)?
6. **Interaction with container workspaces** — 008 indexes the **host** workspace via
   `LocalEnvironment`; container-backed workspaces are out of scope there. The watcher is
   host-filesystem only; confirm it's a no-op (not an error) for a workspace whose files aren't on
   the host.
7. **Do we still keep the message-send read as-is?** `buildIndexSummary` runs per turn regardless;
   with a watcher the DB it reads is fresh, so no change needed there. Confirm we're **not** also
   adding a per-message `ensureRunning` (that was "Option 2" in the triage and is made redundant by
   the watcher).

## Likely implementation shape (hypothesis — revisit after Q1/Q2)

- **`src/main/index/watcher.ts`** — `IndexWatcher` class: `start(workspaceId, path)`,
  `stop(workspaceId)`, `stopAll()`. Holds a `Map<workspaceId, {watcher, debounceTimer}>`. On a
  debounced change → `this.indexService.ensureRunning(workspaceId, "low")`; on a git-ref change →
  metadata refresh (Q3) then optionally the same kick. Constructed in `src/main/index.ts` with a
  reference to `indexService`; gated by `getIndexing().watchWorkspaces`.
- **Trigger wiring** — where `maybeAutoIndex` fires (`db-handlers.ts`), also `watcher.start(...)`
  for the workspace (Q2 decides exact lifetime). On app `will-quit`, `watcher.stopAll()` (alongside
  the existing `taskRunner.stop()` / `closeDb()`).
- **Settings** — add `watchWorkspaces` to `IndexingSettings` + default `true`; surface the toggle in
  the Workspace Indexing settings section; thread it into the watcher's start gate. No migration.
- **Reuse** — `loadGitignore` + `DEFAULT_SKIP_DIRS` (`agent/env/walk.ts`) for the ignore filter;
  `readGitBranch` (`index/metadata.ts`) for the ref refresh; `ensureRunning`'s existing idempotency
  + hash-skip for cheap re-runs.
- **Optional metadata-only seam** — if Q3 says branch flips shouldn't pay for a tree walk, add
  `IndexService.refreshMetadata(workspaceId)` that runs just the metadata stage (it's already a
  handful of small parses) and reuse it from the git-ref watch.

## Verification (when built)

- **The motivating case:** on branch `A`, index; `git checkout B` (identical working tree, e.g. a
  merged branch) with **no** conversation activity → within the debounce window the summary's
  `Git branch:` line updates to `B`. (Reproduces the original bug: was stuck on a stale branch.)
- **File change:** edit a source file → an incremental re-index fires (only that file re-hashed /
  re-symbol'd), symbol count / file map reflect it on the next message.
- **Add / delete:** new file appears in the index; deleted file's rows are removed.
- **Debounce:** `pnpm install` / a large `git rebase` collapses into a single (or a few)
  `ensureRunning` calls, not one per file event (observe via `task:event` / logs).
- **Ignore rules:** writes under `node_modules`/`dist`/`.git` objects do **not** trigger re-indexes;
  `.git/HEAD` + ref changes **do** (branch freshness).
- **Setting off:** "Watch workspace for changes…" disabled → no watcher; behavior reverts to
  index-on-conversation-activity + manual.
- **Per-workspace disable:** a workspace with `index_runs.enabled = 0` is not watched.
- **Idempotency / no jank:** an over-eager burst never runs concurrent duplicate indexes
  (`ensureRunning` no-ops while live); typing stays smooth (low priority + inter-batch yield).
- **Lifecycle:** watchers stop on app quit (no leaked FS handles); (Q2) stop when the workspace is
  no longer in use.
- `pnpm typecheck` + `pnpm build` clean; unit tests for the debounce/coalesce logic and the
  ignore-filter decision (pure-function seams where possible, since real FS-watch timing is hard to
  unit test); manual E2E for the branch-switch and file-edit cases.

## Out of scope

- **Watching container-backed workspaces** — host filesystem only (mirrors 008's local-only index).
- **Nested `.gitignore` merging** — inherits `loadGitignore`'s v1 root-only limitation.
- **Per-file surgical re-index from the event path** — the watcher only *kicks* the existing
  incremental run; it does not try to re-index just the changed file directly (the hash-skip walk
  already makes that cheap and correct). Revisit only if the tree walk proves too costly at scale.
- **Stage 4 embeddings refresh semantics** — embeddings are still deferred (008); when they land,
  their re-embed-on-change policy is that plan's problem.
- **A cross-machine / network-FS watch strategy** — assume a local disk; network mounts may fall
  back to polling (a watcher-mechanism detail, Q1), not a designed feature here.
