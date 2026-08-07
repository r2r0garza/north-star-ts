# PR26: Process UI — the sidebar view, DAG builder, and live run monitor

> Status: **NOT STARTED**. Builds on `025` (the Process engine: definitions/runs schema, the
> `process_run` task kind, `process:*` IPC — this PR is its renderer). Reuses the full-viewport
> takeover pattern from `skills-screen.tsx` / `settings-screen.tsx` (`023`) and the activity-panel
> approval-card affordance (`009`/`012`) for gated phases. Depends on `027` (agent authoring) for the
> per-phase agent picker to have agents to pick, but degrades gracefully if none exist.

## Context

The main sidebar exposes three views — `VIEWS = ["Chat", "Interactive", "North Star"]` in
`src/renderer/src/components/sidebar.tsx` (the ButtonGroup at ~622-640), mapped 1:1 to `Mode`
(`src/main/db/types.ts`) via `VIEW_TO_MODE`/`MODE_TO_VIEW`. The "[agent_name]" entry the user sees is
**not** a per-agent nav — it's the North Star button relabeled with the main-agent brand name
(`sidebar.tsx` ~636). Nav state (`view`/`setView`) is owned by `Shell()` in
`src/renderer/src/main.tsx` (~35), which also owns the `settingsOpen`/`skillsOpen` overlays.

There is **no Process surface**. `025` ships the engine + IPC but nothing renders it. This PR adds a
**Process** view: a list of authored process definitions, a **DAG builder** to compose one (phases,
edges, per-phase agent pool + skills/tools + routing + gate policy + fan-out), and a **run monitor**
that visualizes a live run (which phases are queued / running / parallel / blocked-on-approval /
done) off the `task:event` tail, with inline approval cards for gated phases.

## Goal

1. A **Process** entry in the sidebar view switcher and a full-viewport **Process screen** listing
   process definitions with a **New Process** action (and edit/delete/run per row).
2. A **DAG builder**: add/remove phases, draw dependency edges (with the `on_complete` vs
   `on_each_subtask` trigger), and per phase assign **one or more agents** + skills/tools + routing
   (`single`/`dispatch`) + gate policy (`auto`/`approve`) + fan-out.
3. A **run monitor**: a live graph/list of `process_phase_runs` colored by status, updating off the
   `task:event` tail (the `process_phase` event from `025`), with **inline approval cards** for
   `approve`-gated phases and a terminal completion state.

## Likely shape (hypothesis — revisit per Open questions)

### A. Sidebar + nav wiring
- Add `"Process"` to `VIEWS` in `sidebar.tsx`. Because `View` maps 1:1 to `Mode` today, decide
  whether Process is a **4th `Mode`** or a **non-mode overlay** (like Settings/Skills, which are
  `Shell`-owned booleans, not modes). **Lean: overlay** — a Process is not a conversation, so model
  it like the Skills screen (`skillsOpen`) rather than extending the `Mode` union and the DB CHECK.
  Add a `processOpen` (or a `screen` enum) to `Shell()` in `main.tsx`; the button opens the screen.
- A `NEW_LABEL` entry + brand-label handling as needed so the existing North Star relabel logic is
  untouched.

### B. Process screen (`src/renderer/src/components/process-screen.tsx`)
- Full-viewport takeover mirroring `skills-screen.tsx`/`settings-screen.tsx` (raw Radix `Dialog`
  primitive, `onInteractOutside` prevented — the `023` learnings). Left rail = definition list; main
  pane = the builder or the monitor depending on selection/mode.
- Definition CRUD + run controls via a new preload bridge `window.cowork.process.*` over the
  `process:*` IPC from `025` (`list`/`get`/`create`/`update`/`delete`/`startRun`/`subscribe`).

### C. DAG builder
- Phases as nodes, dependencies as edges. Per-node inspector: name, **agent pool** (multi-select from
  `agents:list`, each with optional skills/tools override), routing toggle, gate-policy toggle,
  fan-out toggle. Per-edge: trigger type.
- Canvas tech is an Open question — start with the **simplest thing that models a DAG** (a phase list
  + per-phase "depends on" multiselect renders the graph implicitly), upgrade to a visual
  node/edge canvas if warranted.

### D. Run monitor
- Reads `process_phase_runs` for the selected run + tails `process_phase` events. Each phase shows
  status; parallel phases render side by side; fan-out children nest under their parent. An
  `approve`-gated phase renders an inline approval card reusing the activity-panel affordance
  (`task:approve`/`deny` equivalents from `025`). Terminal state shows the completion summary.

## Open questions to resolve BEFORE building
1. **Process as Mode vs overlay.** Lean **overlay** (Skills-screen pattern) to avoid touching the
   `Mode` union + `conversations.mode` CHECK; confirm the sidebar affordance reads naturally as a
   peer of Chat/Interactive/North Star even though it's not a conversation mode.
2. **Builder canvas tech.** `react-flow` (rich, a dep) vs hand-rolled SVG vs a **list-of-phases +
   depends-on dropdowns** (no graph lib) for v1. Lean the **list-based** builder first; visual canvas
   later.
3. **Where gate approvals surface.** In the Process monitor only, or also in the existing activity
   panel (so a user not on the Process screen still sees the prompt). Lean **both**, reusing one card.
4. **North Star brand-label coexistence.** Ensure adding a 4th button doesn't break the
   `agentName`-relabel of the North Star button.

## Verification (when built)
- **Unit/component:** builder round-trips a definition (create → reload → same graph); the monitor
  colors phases from a stubbed `process_phase` event stream; an approval card fires the IPC.
- **Manual (real app):** click **Process** in the sidebar; build the 8-phase example graph; run it;
  watch parallel Construct/Validate and fan-out nesting update live; approve a gated phase from the
  monitor; delete a definition.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Engine internals** (scheduling, routing, fan-out, resume) — `025`.
- **Agent create/edit** — `027` (this screen only *picks* existing agents).
- **Skill create/edit** — `028`.
- **A polished visual graph canvas** if v1 ships the list-based builder — later.
