# PR37: Process import / export — share a Process definition as JSON

> Status: **NOT STARTED**. Adds **export** (a Process definition → a `.json` file) and **import** (that
> JSON → a new Process definition) to the Process view (`026`). Unlike skills (`035`) and agents
> (`036`) — which are already files on disk and so are **import-only** here — a Process lives **only in
> the database** (`025`'s tables), so it needs an explicit **serialize ⇄ deserialize** round-trip to be
> shareable. **JSON** is the interchange format (portable, diffable, hand-editable).

## Context

A Process is a DB-resident **`ProcessGraph`** (`db/types.ts`): `{ definition, phases[], agents[],
edges[] }`, read whole via `db:processes:get` (preload `window.cowork.db.processes.get`) and authored
through granular CRUD verbs — `db:processes:{create, update, delete}` +
`db:processes:{phases, agents, edges}:{create, list, delete}` (edges/agents have no *update* verb;
`026`'s builder edits by delete+recreate — **mutate-then-refetch**). The tables (`SCHEMA_V15`) are all
**id-keyed with FKs**: `process_phases.process_id`, `process_edges.from_phase_id`/`to_phase_id`,
`process_phase_agents.phase_id`; a phase also has a human **`key`** (unique per process) and a
**`position`**; agents reference **`agent_name`** (a name, resolved at run time — not an FK to an agent
row). The Process screen (`process-screen.tsx`) has a definition rail (New + delete) + the list builder.

**Ids are the crux:** raw row ids are meaningless across machines and would collide on import. Export
must be **id-relative** (edges reference phases by **`key`**, not id) so import can mint fresh ids.

## Goal

1. **Export** the selected Process definition to a `.json` file the user saves anywhere — a
   self-contained, id-free (or id-relative) document capturing phases + their config (routing / gate /
   fan-out / position / key), the per-phase agent pool (names + skills/tools overrides), and edges
   (by phase **key** + trigger).
2. **Import** such a JSON → a **new** Process definition (fresh ids everywhere), validated, appearing
   in the definition rail ready to run/edit. Round-trips: export A → import → identical graph as A′.

## Likely shape (hypothesis — revisit per Open questions)

### A. The interchange format (`ProcessExport`, versioned)
- A top-level `{ formatVersion: 1, exportedAt, definition: { name, description }, phases: [...],
  edges: [...] }` where **phases carry `key`** (routing/gate/fan_out/position + `agents: [{ agentName,
  skills, tools }]`) and **edges reference `fromKey`/`toKey` + `trigger`** — **no raw ids**, so import
  is collision-free. `formatVersion` guards future shape changes. Agent references stay as **names**
  (a process is portable even if the importer lacks those agents — surfaced as a warning, see Q3).

### B. IPC / serialization (main process — `process/io.ts` + verbs in `index.ts`)
- **`processes:export(processId)`** → build the `ProcessExport` from `getProcessGraph` (drop ids, map
  edge endpoints id→key), then a native **save dialog** (`dialog.showSaveDialog`, `.json` filter) and
  write the file. (Or return the JSON string and let the renderer trigger the save — Open question.)
- **`processes:import(sourcePath)`** → read + `JSON.parse`, **validate** the shape (`formatVersion`,
  required fields, unique phase keys, every edge endpoint resolves to a phase key, enum values valid),
  then **replay** through the existing repo layer **in one transaction**: `createProcess` →
  `createPhase` per phase (mint id, keep key/position/config) → build a **key→newId** map →
  `createEdge` per edge (resolve from/to via the map) → `createPhaseAgent` per pool member. Reuses the
  granular creators — **no new write path**, so invariants (unique `(process_id, key)`, FK integrity)
  are enforced by the same code `026` uses. Name-collision on the *definition* name → import as
  "`<name> (imported)`" or let it duplicate (Open question).

### C. Renderer (`process-screen.tsx`)
- **Export** action on a selected definition (a row/menu button) → save dialog.
- **Import** action near **New** (dropdown: "New process" / "Import from JSON…") → open dialog →
  import → refresh rail + select the new definition. Validation errors via `toast`.

## Open questions to resolve BEFORE building
1. **Id strategy in the file.** Fully **id-free** (edges by phase `key`) — cleanest, requires unique
   keys (already a table constraint) — vs keep original ids + remap on import. Lean **id-free by key**
   (keys are already unique per process and human-meaningful).
2. **Missing agents on import.** A process references `agent_name`s the importer may not have. Import
   anyway and **warn** ("3 phases reference agents not found: …; author or import them via `027`/`036`")
   vs block. Lean **import + warn** — agent names resolve at *run* time (`025.3`'s router already falls
   back), so a process is still editable/inspectable without them; the run surfaces the gap.
3. **Save/open plumbing.** Do the file read/write in **main** (`dialog.showSaveDialog`/`showOpenDialog`
   + `fs`) returning done/error, vs return the JSON string to the renderer. Lean **main does the file
   I/O** (consistent with `pick-workspace.ts`; no blob shuttling over IPC).
4. **Definition-name collision.** Suffix "(imported)" vs allow duplicate names (ids differ anyway) vs
   prompt. Lean **allow duplicate** (names aren't unique in `process_definitions`; the rail shows both)
   — or suffix if that reads better in the rail.
5. **Format version / forward-compat.** Reject an unknown `formatVersion` with a clear message; keep the
   shape additive. Include enough (`key`, `position`) that a re-export is stable.

## Verification (when built)
- **Unit:** `export` produces id-free JSON with edges keyed by phase key; `import` replays it into fresh
  rows in one transaction and **round-trips** (export → import → `getProcessGraph` deep-equals the
  original modulo ids); a malformed file (bad `formatVersion`, dangling edge key, dup key, bad enum) is
  rejected without partial writes (transaction rollback); a process referencing missing agents imports
  with a warning.
- **Manual (real app):** build a multi-phase process with fan-out + an `on_each_subtask` edge + a
  2-agent dispatch pool; export it; delete it; import the file; confirm the graph is identical in the
  builder and it **runs**; hand-edit the JSON (rename a phase) and re-import as a second definition.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Exporting a run** (a `process_runs`/`process_phase_runs` execution) — only the reusable
  *definition* is shareable; run history stays local.
- **A process marketplace / remote share (URL / gist)** — later; this is local file JSON only.
- **Bundling referenced agents/skills into the export** — the export carries agent *names*; importing
  the agents themselves is `036` (a future "bundle" format could pair them — deferred).
- **Skill / agent import** — `035` / `036`.
