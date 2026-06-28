# PR8: Repository indexing — background, incremental, cancellable workspace index

> Status: **NOT STARTED** — pickup note (2026-06-27). Independent of 009 (durable task
> execution), but the two are complementary: indexing is the first real *background job* the app
> runs, and 009 generalizes background execution. This doc is a starting hypothesis, not a locked
> spec — resolve the open questions before building.

## Context

When a user assigns a folder to an **Interactive** or **North Star** conversation, the agent
should be able to answer questions about the repo *immediately* — without the user waiting for a
scan. Today there is no index at all: every `read_file`/`search` tool call walks the live
filesystem (`LocalEnvironment.search`, `src/main/agent/env/local.ts:75`). That's fine for a
targeted grep but gives the model no cheap, structured overview ("what files exist", "what's the
package metadata", "where is symbol X defined") and re-walks the tree on every call.

This PR adds a **repository index**: a persisted, structured snapshot of the workspace that the
agent can query cheaply, built **in the background** so the user can type the instant a workspace
is selected. The index is **incremental** (re-index only what changed, by content hash),
**resumable** (survives app restart and pause), and **cancellable**.

**Target flow:**
```
workspace selected
  → upsertWorkspace(path) record exists  (already implemented, db/repositories/workspaces.ts)
  → enqueue a lightweight indexing job (low/high priority by mode)
  → UI stays usable; user can type immediately
  → agent answers from the partial index (and falls back to live fs for misses)
  → index improves stage-by-stage in the background
```

**Per-mode behavior (hypothesis):**
- **Interactive:** auto-start indexing at **low priority**; show "Indexing workspace…" status;
  chat is allowed immediately; allow pause/resume.
- **North Star:** auto-start at **higher priority**; *prefer* Stage 1 (file map) + Stage 2
  (metadata) before deep task execution, but **do not hard-block** — if indexing is paused, allow
  deep task execution anyway (degrade to live-fs reads). Allow pause/resume **and** cancellation.

### Indexing stages (each stage usable on its own; later stages enrich)
1. **File map** — recursive walk: paths, extensions, sizes, mtime, content hash, ignored-dir
   markers. This alone lets the agent answer "what's in this repo" and powers incremental diffing.
2. **Important metadata** — parse a known set: `package.json`, `tsconfig*.json`, `vite.config.*`,
   `README*`, `pnpm-workspace.yaml`, git branch/HEAD. Small, high-value, cheap.
3. **Symbols / imports** — per-file: functions, classes, exports, imports. Language-aware
   (TS/JS first). The heaviest non-optional stage.
4. **Embeddings** — *later, optional.* Vector index for semantic search. Out of scope for the
   first cut; the schema should leave room but the runner need not implement it.

### Incremental & resumable rules (the important part)
- file **unchanged by hash** → skip (the whole point — cheap re-runs)
- file **changed** (hash differs) → re-index that file only
- file **deleted** → remove its rows from the index
- file **new** → add it
- A run records progress (last-completed stage, last-scanned cursor) so a restart/pause resumes
  rather than restarting.

### Ignore rules
Respect `.gitignore`; always skip `node_modules`, `dist`, `.next`, `.venv`, `build`, `out`,
`.git`; skip large binaries (size cap + NUL-byte sniff, like the existing search at
`local.ts:101-103`); skip lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) from
deep stages unless a stage specifically needs them. Reuse the existing `skipDirs` convention.

## Open questions to resolve BEFORE building

1. **Execution substrate — own runner, or build on 009's task runner?**
   Indexing is exactly the "durable, resumable, background, cancellable" job that 009 generalizes.
   Options: (a) ship indexing with a small dedicated `IndexService` in the main process now, and
   migrate it onto 009 later; (b) sequence 008 *after* 009 and make indexing the first client of
   the task runner. **Recommendation: (a)** — a focused `IndexService` keyed by workspace, so 008
   isn't blocked on 009; note the future convergence. Decide before building.

2. **Where does the index live — SQLite tables or a sidecar file?**
   The DB layer is `better-sqlite3` with a clean migrations pattern (`db/migrations.ts` — its
   comment *already* anticipates "future repo-indexing tables"). Proposal: new tables behind a
   **v7 migration** (see shape below), keyed by `workspace_id`. SQLite gives us incremental
   upserts, hash lookups, and survives restart for free. A per-workspace sidecar `.json`/`.db`
   inside the repo is rejected (pollutes the user's tree, complicates ignore rules).

3. **CPU cost & blocking — main thread, or worker_threads?**
   Stage 1 (walk + hash) and Stage 3 (parse) are CPU-heavy and would jank the main process if
   done synchronously. Options: chunked async on the main thread with `setImmediate`-style
   yielding (simple, no new dep — but shares the event loop with IPC); or `worker_threads` (true
   parallelism, more plumbing, must marshal DB writes back to main since better-sqlite3 is
   synchronous and the connection is main-process-owned). **Lean:** start with **chunked async +
   yielding + a low-priority delay between batches** for the first cut (no new dependency, easy to
   make cancellable via an AbortSignal per the 005 pattern); revisit worker_threads if it janks.

4. **Hashing strategy.** Content hash for the unchanged-skip check: full-file hash (correct,
   re-reads every file each run) vs. a cheap `(size, mtime)` pre-check that only hashes when those
   change (fast, but mtime can lie). **Proposal:** `(size, mtime)` fast-path → hash only on
   mismatch; store both. Pick the hash (sha1/xxhash — xxhash needs a dep; sha1 via node `crypto`
   is built-in and fast enough).

5. **Change detection between runs — poll or watch?** Re-index is triggered on workspace open and
   on demand; do we also want live updates while the user edits? A file watcher (chokidar — *not
   currently a dependency*) gives live freshness but adds a dep and lifecycle complexity. **First
   cut:** no watcher — index on open + a manual "re-index" action + opportunistic re-index when a
   tool writes a file. Watcher is a follow-up.

6. **How does the agent consume the index?** Two surfaces: (a) inject a compact repo summary
   (file count, languages, key metadata) into the system prompt for Interactive/North Star; (b) a
   new tool (e.g. `index_query_tool`) for "find symbol", "list files matching", "what imports X".
   Decide whether (b) is in this PR or a follow-up. The existing tool-gating-by-mode pattern
   (`agent/index.ts:274-288`) is where a new tool would be registered.

7. **Partial-index correctness.** The agent answers from a partial/stale index — it must never
   *assert* something false. Proposal: index reads are advisory; on a miss or a staleness flag the
   tool falls back to live `LocalEnvironment` reads (always authoritative). The index accelerates;
   it is never the sole source of truth.

8. **Status surface & pause/resume/cancel.** Need IPC to drive the "Indexing workspace…" UI and
   the pause/resume/cancel controls. Follow the existing event pattern: a `chat:event`-style
   `index:event` channel (progress, stage, counts) plus `index:pause`/`index:resume`/
   `index:cancel`/`index:reindex` invoke handlers. Mirror the preload bridge shape in
   `preload/index.ts`.

## Likely implementation shape (hypothesis — revisit after Q1/Q3)

### Schema (v7 migration — append to `db/migrations.ts` + new `SCHEMA_V7` in `db/schema.ts`)
Follow existing conventions: TEXT UUID PKs, INTEGER epoch-ms timestamps set in the repo layer,
TEXT+CHECK enums, JSON-as-TEXT, `ON DELETE CASCADE` from the parent.
```sql
-- One indexing run per workspace (resumable progress lives here).
CREATE TABLE index_runs (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN
                   ('queued','running','paused','completed','failed','cancelled')),
  stage          TEXT NOT NULL CHECK (stage IN ('file_map','metadata','symbols','embeddings')),
  priority       TEXT NOT NULL CHECK (priority IN ('low','high')),
  cursor         TEXT,           -- resume point (last-scanned path / batch marker), JSON
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_index_runs_workspace ON index_runs(workspace_id);

-- Stage 1: the file map. One row per tracked file; hash drives incremental skip.
CREATE TABLE index_files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,         -- workspace-relative
  ext           TEXT,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  indexed_stage TEXT NOT NULL,         -- highest stage completed for this file
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, path)
);
CREATE INDEX idx_index_files_workspace ON index_files(workspace_id);

-- Stage 2: parsed metadata (one row per key doc, value is JSON).
CREATE TABLE index_metadata (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,         -- 'package_json' | 'tsconfig' | 'readme' | 'git' | ...
  path          TEXT,
  value         TEXT NOT NULL,         -- JSON
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_index_metadata_workspace ON index_metadata(workspace_id, kind);

-- Stage 3: symbols & imports (one row per symbol; file_id ties back to index_files).
CREATE TABLE index_symbols (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- 'function'|'class'|'import'|'export'|...
  line          INTEGER,
  detail        TEXT,                  -- JSON (signature, source module for imports, etc.)
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_index_symbols_workspace_name ON index_symbols(workspace_id, name);
CREATE INDEX idx_index_symbols_file ON index_symbols(file_id);
-- (embeddings table deferred to a later migration)
```

### Main-process service
- New `src/main/index/service.ts` (`IndexService`): per-workspace state machine driving the
  stages, owning an `AbortController` per run (reuse the 005 cancellation pattern), writing
  progress to `index_runs`. Chunked async with yielding; a `priority` knob controls inter-batch
  delay (low = longer delay, high = tighter).
- New repositories under `src/main/db/repositories/` (`index-runs.ts`, `index-files.ts`,
  `index-metadata.ts`, `index-symbols.ts`) mirroring the `tasks.ts` style (prepared statements,
  row→camelCase mapping, JSON serialize/parse).
- Reuse `LocalEnvironment`'s walk/ignore/binary-sniff logic from `env/local.ts:75-122` rather
  than re-implementing — factor the shared traversal out if needed.
- `.gitignore` parsing: small parser or a tiny dep (`ignore` is the de-facto npm package);
  decide in Q5/build.

### IPC & wiring
- Register `index:*` handlers in `src/main/index.ts` (and a `db:index:*` set if the renderer
  reads index data directly), following the `db:<entity>:<action>` / `chat:*` naming.
- Emit progress via `event.sender.send("index:event", …)` mirroring the `chat:event` pattern
  (`main/index.ts:67-72`); expose `pause/resume/cancel/reindex` as `ipcRenderer.invoke` in the
  preload bridge (`preload/index.ts`).
- Trigger: when a conversation with a workspace is created/opened (Interactive/North Star), kick
  `IndexService.ensureRunning(workspaceId, priority)`. North Star uses `high`, Interactive `low`.
- Agent consumption: inject a compact repo summary into the Interactive/North Star system prompt
  (built from `index_metadata` + file counts); optionally add an `index_query_tool` (Q6).

## Verification (when built)
- Select a workspace in Interactive → "Indexing workspace…" appears, the input is usable
  immediately (type + send a message before indexing finishes), and the agent answers using the
  partial index, falling back to live reads on a miss.
- Stage progression: file map appears first, then metadata, then symbols (observe `index:event`
  progress + DB rows).
- **Incremental:** re-run after no changes → near-instant (all files hash-skipped). Edit one file
  → only that file re-indexed. Delete a file → its rows removed. Add a file → it appears.
- **Resumable:** quit the app mid-index → relaunch → the run resumes from its cursor, not from
  scratch.
- **Pause/resume/cancel:** pause halts progress and frees CPU; resume continues; cancel ends the
  run cleanly (no orphaned work — reuse the 005 abort pattern).
- **North Star:** indexing starts at higher priority; if paused, a deep task still runs (degrades
  to live-fs reads), confirming indexing never hard-blocks execution.
- **Ignore rules:** `node_modules`/`dist`/`.git`/large binaries/lockfiles excluded; `.gitignore`
  entries respected.
- `pnpm typecheck` + `pnpm build` clean; new repository unit tests pass; existing DB tests
  unaffected (v7 migration applies cleanly over a v6 db).

## Out of scope
- **Stage 4 embeddings / semantic search** — schema leaves room; runner deferred.
- **Live file watching** (chokidar) — index-on-open + manual/opportunistic re-index first.
- **Multi-language symbol extraction beyond TS/JS** — start with TS/JS; others are follow-ups.
- **Container-backend indexing** — index the host workspace via `LocalEnvironment`; indexing
  inside a container is out of scope (see env work in .plan/006 / .plan/005.1).
- **Convergence onto the 009 task runner** — note it, don't block on it (Q1).
