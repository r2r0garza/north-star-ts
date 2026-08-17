# PR32: Process visual canvas — a node/edge graph builder for the Process view

> Status: **NOT STARTED**. The explicitly-deferred half of `026`. `026` shipped the Process builder as
> a **list-based** DAG editor (phases as cards; dependencies as per-phase "depends on" checkboxes, the
> graph implicit in the edges) and recorded — as an Open question (Q2) and an Out-of-scope note — that
> a **polished visual node/edge canvas** would come "later" as its own plan. This is that plan. It is
> **renderer-first + one additive migration**; it does **not** touch the engine (`025`/025.x),
> scheduling, routing, or resume.

## Context

The Process screen (`src/renderer/src/components/process-screen.tsx`, ~1621 lines) is a full-viewport
takeover with a left definition rail and a main pane that toggles **Builder** / **Run** (`PaneMode`).
The `ProcessBuilder` renders phases as `PhaseCard`s; each card owns a **"depends on"** checkbox set
that creates/deletes `process_edges` rows (`window.cowork.db.processes.edges.create/delete`), each edge
carrying an `on_complete` / `on_each_subtask` trigger, plus a per-phase inspector (routing
`single`/`dispatch`, gate `auto`/`approve`, fan-out toggle, agent pool). Every mutation is
**mutate-then-refetch** (edge/agent rows have no update verb → edit = delete+recreate). It uses
`NativeSelect` (not Radix `Select`) to sidestep the modal-dialog `pointer-events:none` interaction the
`023` takeover documented.

The data is already a real DAG on disk (`SCHEMA_V15`): `process_phases` (with a single **`position`**
integer — a *list* order, **not** x/y coordinates) + `process_edges` (`from_phase_id` →
`to_phase_id` + `trigger`). The full authored graph round-trips through `db:processes:get`
(`ProcessGraph` = definition + phases + agents + edges) and the granular
`db:processes:{phases,agents,edges}:{create,update,delete,list}` CRUD verbs.

**No graph library is in the repo today** (`react-flow`/`@xyflow/react`, `dagre`, `elkjs` — none in
`package.json`). Latest schema is **`SCHEMA_V18`**.

## Goal

1. A **visual canvas** builder mode for a Process definition — phases as draggable **nodes**,
   dependencies as **edges** you draw by connecting node handles (replacing/augmenting the "depends on"
   checkboxes), the same per-phase inspector (routing / gate / fan-out / agent pool) reachable from a
   selected node, and the same per-edge `on_complete` / `on_each_subtask` trigger on the edge itself.
2. **Persisted layout** — node positions survive reload (a new additive `pos_x`/`pos_y` on
   `process_phases`), with a deterministic **auto-layout** fallback for pre-existing definitions that
   have no saved coordinates (and a "Tidy" action).
3. **Parity, not regression** — everything the list builder can author, the canvas can author, mapping
   1:1 onto the **same** `db:processes:*` CRUD verbs (no new engine/IPC semantics). The list builder is
   kept as a toggle (see Open questions) so nothing is lost.

## Likely shape (hypothesis — revisit per Open questions)

### A. Storage (one additive migration — `SCHEMA_V19`)
- Add nullable **`pos_x` / `pos_y`** (REAL) to `process_phases`. Additive columns (no table rebuild —
  the `025` tables use bare-`TEXT`-status + repo-layer validation precisely to avoid CHECK-widening
  rebuilds, so a plain `ALTER TABLE ADD COLUMN` fits). `NULL` = "never laid out" → auto-layout on load.
- Extend `createPhase`/`updatePhase` in `db/repositories/processes.ts` + the `db:processes:phases:*`
  IPC/preload payloads to carry `posX`/`posY`. A **debounced** position write on drag-end (not per
  mouse-move) keeps the mutate-then-refetch model cheap. `position` (list order) stays for the list
  builder + monitor ordering.

### B. Canvas tech (Open question 1 — decide BEFORE building)
- Lean **`@xyflow/react`** (React Flow v12): first-class nodes/edges/handles, pan/zoom, a
  `MiniMap`/`Controls`/`Background`, and controlled `nodes`/`edges` state that maps cleanly onto our
  rows. Cost: a real dependency (bundle size — the renderer is already large; lazy-load the canvas
  chunk). Alternatives: hand-rolled SVG (full control, high effort, we'd reinvent drag/zoom/routing) or
  `dagre`/`elkjs` for *layout only* atop hand-rolled rendering. **Auto-layout**: React Flow pairs with
  `dagre`/`elkjs` for a directed-graph tidy; a small layered layout may suffice for our phase counts.
- **Modal-dialog caveat:** the Process screen is a Radix `Dialog` takeover; the `023`/`026` finding
  (an open Radix `Select` sets `body { pointer-events: none }`) means the inspector inside the canvas
  must keep using `NativeSelect`, and we must verify React Flow's own pointer handling composes with
  the dialog focus-trap / `onInteractOutside` (already `preventDefault`'d).

### C. Renderer (`process-screen.tsx` + a new `process-canvas.tsx`)
- A **`PaneMode`** gains a builder sub-mode (canvas vs list) — a segmented toggle in the builder header,
  defaulting per Open question 2. Extract the phase-inspector body from `PhaseCard` into a shared
  component both the list card and the canvas node-inspector reuse (so routing/gate/fan-out/agent-pool
  editing has one implementation).
- **Node** = a phase (name, key, status-agnostic in the builder; the run monitor stays list/nested for
  v1). **Edge** = a `process_edges` row; drawing a connection calls `edges.create`, deleting removes it;
  the trigger is an inline edge control (`on_complete` default, `on_each_subtask` opt-in) — the same
  semantics the checkboxes expressed. Fan-out / multi-dependency joins are just node/edge shapes (no new
  data). Every canvas mutation stays **mutate-then-refetch** onto the existing verbs.
- **Selection** opens the shared inspector (right-side panel or popover) for the selected node.

### D. Run monitor (unchanged for v1)
- The monitor stays the `026` nested list colored off the `process_phase` task-event tail. **Rendering a
  live run on the same canvas** (nodes lighting up by status, children nesting) is a natural follow-up
  but is **out of scope here** to keep the migration + canvas surface reviewable (see Out of scope).

## Open questions to resolve BEFORE building
1. **Canvas library.** `@xyflow/react` (rich, a real dep + bundle cost — lazy-load) vs hand-rolled SVG
   vs `dagre`/`elkjs`-for-layout-only. Lean **`@xyflow/react`**, lazy-loaded, with `dagre` (or its
   built-in) for auto-layout. Confirm bundle-size appetite (the renderer chunk is already ~2.6 MB).
2. **Replace vs. coexist with the list builder.** Keep both behind a toggle (canvas as the default,
   list as a fallback / accessibility path) vs. fully replace the list. Lean **coexist** — the list
   builder is proven, cheap, and keyboard-friendly; the canvas is the richer default.
3. **Auto-layout trigger.** Auto-layout only when *all* positions are `NULL` (first open of a legacy
   definition) vs. an always-available "Tidy" button vs. layout-on-every-load. Lean **layout legacy
   once, persist, then honor saved positions**, with a manual **Tidy** action.
4. **Run visualization on the canvas.** Ship the builder canvas only (v1) and defer live-run-on-canvas,
   or do both. Lean **builder only** — smaller, reviewable; run-on-canvas is a follow-up.

## Verification (when built)
- **Migration:** `SCHEMA_V19` adds `pos_x`/`pos_y` over a `V18` DB; existing definitions load with
  `NULL` coords → auto-layout; a `migrations.test.ts` case + bumping any "latest `user_version`"
  assertions (18 → 19).
- **Unit/component:** the canvas round-trips a definition (draw phases + edges → reload → identical
  graph + persisted positions); an edge draw/delete hits `edges.create`/`edges.delete`; a node-inspector
  edit maps onto the same CRUD the list card uses; auto-layout is deterministic for a fixed graph.
- **Manual (real app):** open a `026`-authored definition (list-built) → switch to canvas → it
  auto-lays-out → drag nodes, positions persist across reload; draw an `on_each_subtask` edge into a
  fan-out consumer and confirm it round-trips; **run** the definition and confirm the monitor is
  unchanged and correct (parity, no engine regression).
- `pnpm typecheck` + `pnpm build` clean (watch the bundle-size delta from the graph lib); verified in
  the running app.

## Out of scope
- **Engine / scheduling / routing / fan-out / resume** — `025`/025.x (this PR only *renders and
  authors* the same graph).
- **Live-run visualization on the canvas** (nodes lighting up by status) — a follow-up; v1 keeps the
  `026` nested-list monitor.
- **Per-pool-agent skills/tools tri-state overrides** — the `026` deferral, independent of layout.
- **Agent / skill authoring** — `027` / `028` (the canvas only *picks* existing agents).
