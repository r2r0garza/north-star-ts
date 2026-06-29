# PR8: Workspace indexing — background, incremental, cancellable workspace index

> Status: **NOT STARTED** — pickup note (2026-06-27, updated 2026-06-29). Depends on 009 (durable
> task execution): **pause is a real task state**, so the indexer runs as a durable task and reuses
> 009's queue/resume/cancel machinery rather than inventing its own. Starting hypothesis, not a
> locked spec — resolve the open questions before building.

## Context

When a user assigns a folder to an **Interactive** or **North Star** conversation, the agent
should be able to answer questions about the workspace *immediately* — without the user waiting for
a scan. Today there is no index at all: every `read_file`/`search` tool call walks the live
filesystem (`LocalEnvironment.search`, `src/main/agent/env/local.ts:75`). That's fine for a
targeted grep but gives the model no cheap, structured overview ("what files exist", "what's the
package metadata", "where is symbol X defined") and re-walks the tree on every call.

This PR adds a **workspace index**: a persisted, structured snapshot of the workspace that the
agent can query cheaply, built **in the background** so the user can type the instant a workspace
is selected. The index is **incremental** (re-index only what changed, by content hash),
**resumable** (survives app restart and pause), **pausable**, **cancellable**, and can be
**disabled/re-enabled per workspace** or **cleared** entirely.

**Target flow:**
```
workspace selected
  → upsertWorkspace(path) record exists  (already implemented, db/repositories/workspaces.ts)
  → if auto-index enabled for this workspace: enqueue a durable indexing task (009)
  → UI stays usable; user can type immediately
  → agent answers from the partial index (and falls back to live fs for misses)
  → index improves stage-by-stage in the background
```

**Controls (all required):**
- **Auto-start** — configurable (global default + per-workspace override).
- **Pausable** — a real task state (009's task lifecycle), not an ad-hoc flag.
- **Resumable** — continue from the last cursor after pause or app restart.
- **Cancellable** — stop the run but **keep the existing partial index**.
- **Disable / re-enable per workspace** — a workspace can opt out of indexing entirely.
- **Clear index** — drop all index rows for a workspace (start fresh next time).

**Per-mode default behavior (hypothesis):**
- **Interactive:** auto-index at **low priority**; show "Indexing workspace…" status; chat allowed
  immediately.
- **North Star:** auto-index at **higher priority**; *prefer* Stage 1 (file map) + Stage 2
  (metadata) before deep task execution, but **do not hard-block** — if indexing is paused, allow
  deep task execution anyway (degrade to live-fs reads).

### Indexing stages (each stage usable on its own; later stages enrich)
1. **File map** — recursive walk: paths, extensions, sizes, mtime, content hash, ignored-dir
   markers. This alone lets the agent answer "what's in this workspace" and powers incremental
   diffing.
2. **Important metadata** — parse a known set: `package.json`, `tsconfig*.json`, `vite.config.*`,
   `README*`, `pnpm-workspace.yaml`, git branch/HEAD. Small, high-value, cheap.
3. **Symbols / imports** — per-file: functions, classes, exports, imports, and (for non-code
   files) extracted text/chunks. Runs through a pluggable **Extractor registry** (see below), not a
   special-cased `if ts / if pdf` ladder. TS/JS first; other languages/formats add an extractor.
   The heaviest non-optional stage.
4. **Embeddings** — *later, optional.* Vector index for semantic search. Out of scope for v1; the
   schema should leave room but the runner need not implement it.

> **Indexing is deterministic — no LLM in the build path.** All four stages (walk, hash, parse,
> extract) are scripted code: parsers and AST tools, never a model call. This is what makes the
> index cheap, incremental (hash-skip), and resumable. The LLM only appears on the *consumption*
> side (Q6) — reading an already-built index. Stage 4 embeddings are the lone model-touching part,
> and they're deferred. (Even then, an embedding model is not a generative/agentic call.)

### Extractors (Stage 3 architecture)
Stage 3 dispatches each file to the first registered `Extractor` that `supports()` it, instead of
hard-coding format branches. This keeps the stage open/closed (add a language/format = add one
extractor + register it) and mirrors the existing `Environment`/`Tool` interface seams in this
codebase.
```ts
interface Extractor {
  supports(file: IndexedFile): boolean          // by extension / sniffed type
  extract(file: IndexedFile): Promise<ExtractedDocument>  // symbols, imports, and/or text chunks
}
```
`ExtractedDocument` carries the structured output: `symbols` (name/kind/line/detail → `index_symbols`
rows) and/or `chunks` (text spans for later embedding/search). The registry is an ordered list;
first match wins; a `FallbackExtractor` (extension-based language detection + a simple line/chunk
splitter) handles anything no specific extractor claims, so every file gets *some* representation.

Likely tooling per extractor (all deterministic):
- **TypeScript / JavaScript** — TypeScript compiler API (`ts.createSourceFile` → AST), or
  `ts-morph` / `tree-sitter`. Start with one; the interface hides the choice.
- **Python** — `tree-sitter` (in-process, no Python runtime needed) or the `ast` module if a Python
  interpreter is available.
- **Java / Rust / Go / others** — `tree-sitter` grammars are the natural common path.
- **Markdown / plain text** — heading + paragraph chunker.
- **PDF / DOCX** — text extraction via a format library (no OCR in v1).
- **Image / Audio** — metadata only in v1 (dimensions, duration, EXIF); content extraction
  (OCR/transcription) is explicitly a follow-up and is the one place a *model* might later enter —
  flagged so it's a deliberate future decision, not smuggled into v1.

**v1 ships only a couple of extractors** (TS/JS + the fallback chunker); the rest are stubs/follow-
ups. The point of landing the interface now is that adding `PythonExtractor`, `PDFExtractor`, etc.
later is additive and needs no runner changes.

### Incremental & resumable rules (the important part)
- file **unchanged by hash** → skip (the whole point — cheap re-runs)
- file **changed** (hash differs) → re-index that file only
- file **deleted** → remove its rows from the index
- file **new** → add it
- A run records progress (last-completed stage, last-scanned cursor, scanned/total counts) so a
  restart/pause/resume continues rather than restarting.

### Ignore rules
Respect `.gitignore`; always skip `node_modules`, `dist`, `.next`, `.venv`, `build`, `out`,
`.git`; skip large binaries (size cap + NUL-byte sniff, like the existing search at
`local.ts:101-103`); skip lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) from
deep stages unless a stage specifically needs them. Reuse the existing `skipDirs` convention.

## UI

**Active indexing** (in the conversation header / a workspace status strip):
```
Indexing workspace…
1,248 / 6,420 files scanned
[Pause]  [Cancel]
```
- The `1,248 / 6,420` counts come from the run's progress (scanned vs. total discovered in Stage
  1). Before the total is known (mid-walk), show an indeterminate "Scanning…" with the running
  count.
- `Pause` → task transitions to `paused` (009). The strip shows "Indexing paused" with `[Resume]`.

**Cancelled** (partial index kept):
```
Indexing cancelled. Existing partial index was kept.
[Resume]  [Clear Index]
```
- `Resume` re-enqueues from the last cursor (incremental — already-indexed files hash-skip).
- `Clear Index` drops the workspace's index rows and resets the run.

## Settings

A new **Workspace Indexing** group in the settings pane (the v4 `settings` store + Settings tabs
already exist from 004 — add a group, no migration needed for global toggles):
```
Workspace Indexing
  [x] Automatically index new workspaces
  [x] Use index to improve agent context
  [ ] Include embeddings   (later — disabled/hidden in v1)
```
- **Automatically index new workspaces** — global default for auto-start; a per-workspace toggle
  (disable/re-enable) overrides it.
- **Use index to improve agent context** — gates whether the index feeds the system prompt / index
  tool (Q6). Off = index still builds but the agent ignores it (useful for debugging).
- **Include embeddings** — Stage 4 switch; shown disabled in v1 to signal the roadmap.

## Open questions to resolve BEFORE building

1. **Runner: this is a 009 task.** Pause must be a real task state, so the indexer runs as a
   durable task (009): one indexing task per workspace, using 009's queue, `paused`/`cancelled`
   states, checkpointing, and resume. **This makes 008 depend on 009** (sequence 009 first). Decide
   the seam: does the indexer get its own task `kind`/lane with a `priority` (low for Interactive,
   high for North Star), sharing 009's concurrency pool?

2. **Where does the index live — SQLite tables or a sidecar file?**
   The DB layer is `better-sqlite3` with a clean migrations pattern (`db/migrations.ts` — its
   comment *already* anticipates "future repo-indexing tables"). Proposal: new tables behind a
   **v7 migration** (see shape below), keyed by `workspace_id`. SQLite gives incremental upserts,
   hash lookups, and survives restart for free. A per-workspace sidecar inside the repo is rejected
   (pollutes the user's tree, complicates ignore rules).

3. **CPU cost & blocking — main thread, or worker_threads?**
   Stage 1 (walk + hash) and Stage 3 (parse) are CPU-heavy and would jank the main process if done
   synchronously. **Lean:** start with **chunked async + event-loop yielding + a priority-based
   inter-batch delay** (no new dependency, easy to make pausable/cancellable via 009's per-task
   AbortSignal, reusing the 005 pattern); revisit `worker_threads` if it janks. (better-sqlite3 is
   synchronous and main-process-owned, so a worker would have to marshal writes back.)

4. **Hashing strategy.** `(size, mtime)` fast-path → hash only on mismatch; store both. Pick the
   hash (sha1 via node `crypto` is built-in and fast enough; xxhash would need a dep).

5. **Change detection between runs — poll or watch?** v1: no file watcher (chokidar is *not* a
   dependency). Index on workspace open + a manual "re-index/Resume" action + opportunistic
   re-index when a tool writes a file. A live watcher is a follow-up.

6. **How does the agent consume the index?** Gated by the "Use index to improve agent context"
   setting. Two surfaces: (a) inject a compact workspace summary (file count, languages, key
   metadata) into the Interactive/North Star system prompt; (b) a new tool (e.g.
   `index_query_tool`) for "find symbol", "list files matching", "what imports X". Decide whether
   (b) is in this PR or a follow-up. Tool gating-by-mode lives at `agent/index.ts:274-288`.

7. **Partial-index correctness.** The agent answers from a partial/stale index — it must never
   *assert* something false. Index reads are advisory; on a miss or a staleness flag the tool falls
   back to live `LocalEnvironment` reads (always authoritative). The index accelerates; it is never
   the sole source of truth.

8. **Status surface & controls plumbing.** Need IPC to drive the "Indexing workspace…" UI and the
   pause/resume/cancel/clear/disable controls. Since the run is a 009 task, **prefer reusing 009's
   `task:event` live-tail + control verbs** over a parallel `index:*` channel — add only the
   index-specific bits (clear-index, per-workspace enable/disable, scanned/total counts) as
   `index:*` or `db:index:*` handlers. Mirror the preload bridge shape in `preload/index.ts`.

## Likely implementation shape (hypothesis — revisit after Q1/Q3)

### Schema (v7 migration — append to `db/migrations.ts` + new `SCHEMA_V7` in `db/schema.ts`)
Follow existing conventions: TEXT UUID PKs, INTEGER epoch-ms timestamps set in the repo layer,
TEXT+CHECK enums, JSON-as-TEXT, `ON DELETE CASCADE` from the parent. Note: run *lifecycle*
(queued/running/paused/cancelled/…) lives on the 009 **task**, not duplicated here — `index_runs`
links a workspace to its task and holds index-specific progress (cursor, counts, enabled flag).
```sql
-- Per-workspace indexing state: links to the 009 task, holds resumable progress
-- and the per-workspace enable toggle. Status lives on the task; this is the cheap
-- workspace-scoped record (one per workspace) for progress + the enable flag.
CREATE TABLE index_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id         TEXT,            -- the 009 task driving this run (NULL when idle/cleared)
  enabled         INTEGER NOT NULL DEFAULT 1,   -- per-workspace disable/re-enable
  stage           TEXT NOT NULL CHECK (stage IN ('file_map','metadata','symbols','embeddings')),
  priority        TEXT NOT NULL CHECK (priority IN ('low','high')),
  cursor          TEXT,            -- resume point (last-scanned path / batch marker), JSON
  files_scanned   INTEGER NOT NULL DEFAULT 0,
  files_total     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (workspace_id)
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
**Clear index** = delete the workspace's `index_files`/`index_metadata`/`index_symbols` rows and
reset `index_runs` (cursor/counts → 0, `task_id` → NULL); **disable** = set `index_runs.enabled =
0` and cancel any active task.

### Main-process service
- New `src/main/index/service.ts` (`IndexService`): builds the indexing work as a **009 task**,
  owning the stage state machine. Cancellation/pause flow through 009's per-task AbortSignal
  (reuse the 005 pattern); progress (`files_scanned`/`files_total`, stage) is written to
  `index_runs` and surfaced via 009's `task:event` tail. Chunked async with a `priority`-based
  inter-batch delay.
- New repositories under `src/main/db/repositories/` (`index-runs.ts`, `index-files.ts`,
  `index-metadata.ts`, `index-symbols.ts`) mirroring the `tasks.ts` style (prepared statements,
  row→camelCase mapping, JSON serialize/parse).
- New `src/main/index/extractors/` — the `Extractor` interface + an ordered registry, with v1
  shipping `TypeScriptExtractor` and a `FallbackExtractor` (extension detection + line/chunk
  splitter). Stage 3 iterates files, picks the first `supports()` match, and persists the returned
  `ExtractedDocument` to `index_symbols` (+ chunk rows when embeddings land). New extractors
  (`PythonExtractor`, `PDFExtractor`, …) register here — no runner change.
- Reuse `LocalEnvironment`'s walk/ignore/binary-sniff logic from `env/local.ts:75-122` rather than
  re-implementing — factor the shared traversal out if needed.
- `.gitignore` parsing: a small parser or the `ignore` npm package; decide in Q5/build.

### IPC & wiring
- Reuse 009's `task:event` + control verbs for pause/resume/cancel. Add index-specific handlers
  (`index:clear`, `index:setEnabled`, and the scanned/total progress if not carried on the task
  event) following the `db:<entity>:<action>` / `chat:*` naming; expose them through the preload
  bridge (`preload/index.ts`).
- Settings: add a **Workspace Indexing** group to the settings service (v4 store) + a tab in the
  settings pane; per-workspace enable/disable lives on `index_runs.enabled`.
- Trigger: when a conversation with a workspace is created/opened (Interactive/North Star) **and**
  auto-index is enabled for that workspace, kick `IndexService.ensureRunning(workspaceId,
  priority)`. North Star uses `high`, Interactive `low`.
- Agent consumption (gated by "Use index to improve agent context"): inject a compact workspace
  summary into the Interactive/North Star system prompt; optionally add an `index_query_tool`
  (Q6).

## Verification (when built)
- Select a workspace in Interactive → "Indexing workspace…" appears with a `scanned / total`
  count, the input is usable immediately (type + send before indexing finishes), and the agent
  answers using the partial index, falling back to live reads on a miss.
- Stage progression: file map first, then metadata, then symbols (observe `task:event` progress +
  DB rows).
- **Pause/Resume:** `[Pause]` halts progress and frees CPU, task state = `paused`; `[Resume]`
  continues from the cursor. Pause survives an app restart (resumes from `index_runs.cursor`).
- **Cancel keeps partial index:** `[Cancel]` → "Indexing cancelled. Existing partial index was
  kept." with `[Resume]`/`[Clear Index]`; the `index_files` rows are still present, and a query
  still hits them.
- **Clear Index:** drops all index rows for the workspace and resets the run; a fresh index builds
  on next start.
- **Disable/re-enable per workspace:** disabling stops + prevents auto-index for that workspace
  only; re-enabling resumes auto-index. Other workspaces unaffected.
- **Incremental:** re-run after no changes → near-instant (all files hash-skipped). Edit one file →
  only that file re-indexed. Delete → rows removed. Add → appears.
- **North Star:** higher priority; if paused, a deep task still runs (degrades to live-fs reads),
  confirming indexing never hard-blocks execution.
- **Settings:** "Automatically index new workspaces" off → a newly selected workspace does not
  auto-index until manually started; "Use index to improve agent context" off → index still builds
  but the agent ignores it.
- **Ignore rules:** `node_modules`/`dist`/`.git`/large binaries/lockfiles excluded; `.gitignore`
  respected.
- `pnpm typecheck` + `pnpm build` clean; new repository unit tests pass; v7 migration applies
  cleanly over a v6 db.

## Out of scope
- **Stage 4 embeddings / semantic search** — schema leaves room; runner deferred; settings toggle
  shown disabled in v1.
- **Live file watching** (chokidar) — index-on-open + manual/opportunistic re-index first.
- **Extractors beyond TS/JS + fallback** — the `Extractor` interface + registry land in v1, but
  only `TypeScriptExtractor` and `FallbackExtractor` ship; `Python`/`Java`/`Rust`/`Go`/`PDF`/`DOCX`/
  `Image`/`Audio` extractors are additive follow-ups.
- **OCR / audio transcription / any model-based extraction** — Image/Audio extractors do metadata
  only in v1; content extraction (the one place a model might enter the build path) is a deliberate
  future decision, not part of this PR.
- **Container-backend indexing** — index the host workspace via `LocalEnvironment`; indexing inside
  a container is out of scope (see env work in .plan/006 / .plan/005.1).
- **A standalone indexing runner** — indexing runs on 009's durable task runner (Q1); do not build
  a separate job system.
