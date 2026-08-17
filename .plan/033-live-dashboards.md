# PR33: Live dashboards — agent-authored, data-source-agnostic dashboard views

> Status: **NOT STARTED**. A new top-level surface (a **Dashboards** button in the sidebar footer,
> alongside Processes / Agents / Skills / Settings) where a user prompts an agent to **compose a
> dashboard** — a saved layout of widgets — and to describe **how each widget pulls its data**. The
> agent fetches through whatever tools it already has (today: `run_shell` / Azure CLI, `web` fetch;
> **later: MCP servers**), so a dashboard is **data-source-agnostic by construction** and inherits new
> sources for free as they land. Likely splits on build (see below).

## The key framing

A dashboard is three things, and only the first two are net-new machinery:

1. **A layout of widgets** — persisted (title, chart/table/stat type, grid position, display config).
2. **Per-widget data-fetch recipes** — a durable description of *how to pull this widget's data*
   (natural-language intent + the concrete tool calls the agent settled on: a shell command, a CLI
   invocation, a web fetch, later an MCP tool call) plus a **normalizer** to shape the raw result into
   the widget's `{ series | rows | value }` contract.
3. **A refresh cadence** — "live" = re-running each widget's recipe on demand / on an interval, writing
   the latest normalized result into a cache the view reads.

**Crucially, the dashboard feature does not build any data connectors.** "How to pull data" is the
**agent's** job, executed with the tools available at run time. The Azure CLI works today via
`run_shell`; Jira / Azure DevOps land when **MCP** is implemented (backlog — deferred). Whichever ships
first, the other gets it for free: build dashboards first and they light up when MCP arrives; build MCP
first and dashboards can target it on day one. This plan therefore treats the data source as an
opaque **recipe the agent produced**, never a hard-coded integration.

## Context (how the app works today)

- **Sidebar footer surfaces** are full-viewport **overlays**, not conversation modes: `sidebar.tsx`
  (~711) renders `Processes` / `Agents` / `Skills` / `Settings` buttons wired to `onProcessClick`
  etc.; `main.tsx` owns a boolean per overlay (`processOpen`/`skillsOpen`/`agentsOpen`/`settingsOpen`,
  ~60-69) and renders `<ProcessScreen>`/`<SkillsScreen>`/`<AgentsScreen>` (~355-357). Each screen is a
  raw Radix `Dialog` takeover (the `023` pattern: `onInteractOutside` prevented, `h-11` drag header,
  `NativeSelect` to dodge the modal `pointer-events:none` finding). Dashboards add a **5th overlay**
  the same way (`dashboardsOpen` + `<DashboardsScreen>` + a footer button).
- **Rendering:** **`recharts` (3.8.0) is already a dependency** — the chart layer needs no new dep.
- **Agent-authored, definition-vs-run persistence** is a proven pattern: `025`'s Process tables
  (`SCHEMA_V15`) split reusable *definitions* from *run* instances, use **bare-`TEXT` status columns
  validated in the repo layer** (to avoid a v8-style CHECK-widening rebuild), and are driven by a
  `process_run` task kind on the runner's deterministic executor seam. Dashboards mirror this split
  (definition = layout + recipes; "run" = a refresh that populates the cache).
- **Durable background work + refresh** rides the `009` task runner (`enqueueKind` + `TaskKindCapability`,
  `task_events` tail over `tasks.onEvent`). A dashboard refresh is a natural durable task kind
  (`autoResume:false` — a stale panel is harmless, mirroring `019`'s `summarize`).
- **MCP is NOT wired up** anywhere in `src` yet (confirmed: no MCP client, no tool). This plan assumes
  it isn't and does not depend on it.

## Goal

1. A **Dashboards** overlay listing saved dashboards, with a **New dashboard** action.
2. **Agent authoring:** from within a dashboard, the user prompts an agent ("show me open Sev-1 bugs by
   team over the last 30 days") and the agent produces a **dashboard spec** — widgets + per-widget
   data-fetch recipes + a suggested refresh cadence — via a new gated **`dashboard_write`**-style tool
   (mirrors how `todo_write` / `present_plan` let an agent emit structured artifacts). The user can
   tweak the layout after.
3. **View + live refresh:** render each widget from its cached normalized result (recharts / table /
   stat); a **Refresh** action (and an optional per-dashboard interval) re-runs the recipes as a durable
   task and updates the cache; widgets show last-refreshed time + an error state when a fetch fails.

## Likely shape (hypothesis — revisit per Open questions)

### A. Storage (`SCHEMA_V19`/`V20` — additive, definition-vs-run split, mirrors `025`)
- `dashboards` (id, name, description, `refresh_interval_sec` NULL = manual-only, created/updated_at).
- `dashboard_widgets` (id, dashboard_id FK CASCADE, title, `type` bare-TEXT validated in repo:
  `line|bar|area|stat|table|…`, grid `x/y/w/h`, `display_config` JSON, **`fetch_recipe` JSON** — the
  agent's intent + the concrete tool plan + a normalizer spec, **`normalizer`** if kept separate,
  position).
- `dashboard_widget_data` (widget_id FK, `fetched_at`, `status` bare-TEXT `ok|error`, `payload` JSON =
  the normalized `{ series|rows|value }`, `error` TEXT) — the **cache** the view reads; one latest row
  per widget (upsert), so the view never blocks on a live fetch.
- All statuses **bare TEXT, repo-validated** (the `025` ruling, no CHECK rebuild).

### B. Agent authoring path
- A new **`dashboard_write`** tool (gated like `todo_write`/`present_plan`) the agent calls to emit /
  update the widget set + recipes for the *current* dashboard. The authoring conversation is a normal
  agent turn (foreground or a `009` background task) with the full tool set — so the agent can **probe
  the real source while authoring** (run the CLI once, inspect the shape) before committing a recipe.
- A dashboard's authoring is scoped to that dashboard (a `sourceConversationId`-style link), so the
  Dashboards overlay can show "last authored by …" and re-open the thread to refine.

### C. Refresh executor (a `009` durable task kind: `dashboard_refresh`)
- `enqueueKind("dashboard_refresh", { dashboardId })` on the deterministic executor seam: for each
  widget, **replay its fetch recipe** (the recipe is a stored, re-runnable tool plan — NOT a fresh LLM
  turn per refresh; determinism + cost), normalize, and upsert `dashboard_widget_data`. A per-widget
  failure is isolated (that widget shows an error; others still refresh).
- **Open question (below):** how re-runnable a recipe must be without the LLM — a fixed command/tool
  call is cheap and deterministic; a recipe needing judgment may need a bounded LLM normalize step
  (mirrors `019`/`025.3`'s single bounded `createCompletion`). Lean **deterministic replay first**, LLM
  normalize only where a recipe declares it needs one.
- `refresh_interval_sec` schedules the next refresh — but **there is no scheduler/cron in the app yet**
  (backlog: `cron`/`blueprints`). v1 lean: **manual Refresh + refresh-on-open**, with interval polling
  driven renderer-side while the overlay is open (like the activity panel's live tail). True background
  cron is deferred to the `cron` backlog item.

### D. Renderer (`dashboards-screen.tsx` + `dashboard-view.tsx` + widget components)
- Full-viewport takeover mirroring `skills-screen.tsx`/`process-screen.tsx` (raw Radix `Dialog`,
  `NativeSelect`, drag header). Left rail = dashboard list (New + delete-with-confirm); main pane =
  the selected dashboard's **grid of widgets** (recharts for charts, a table component, a stat tile).
- A **grid layout** (start simple: a CSS/flex or fixed 12-col grid with the stored `x/y/w/h`; a
  drag-resize lib is an Open question, deferred like `032`'s canvas). An **Author with agent** entry
  (prompt box) that runs the authoring turn; a **Refresh** button + last-refreshed indicator.
- Reuse the `dataviz` house palette/guidance for consistent, accessible charts.

## Open questions to resolve BEFORE building
1. **Recipe re-runnability (the crux).** How much of "pull the data" can be replayed **without an LLM**
   on refresh? A stored shell/CLI/MCP tool call + a declarative normalizer = cheap, deterministic,
   safe. A recipe that needs judgment each time = a bounded LLM step per refresh (cost + nondeterminism).
   Lean **deterministic-replay-first**; allow an opt-in bounded LLM normalize. This shapes B/C heavily.
2. **Refresh trigger for "live".** Manual + on-open + renderer-interval-while-open (v1, no new infra)
   vs. true background scheduling (needs the `cron` backlog item). Lean **v1 = manual/on-open/poll**,
   real cron deferred.
3. **Approval / safety of stored recipes.** A recipe re-runs a shell/CLI/tool call unattended on
   refresh — how does this compose with `002`/`012` approval gating and the `action_allowlist`? A
   refresh must not silently run an un-allowlisted destructive command. Lean: **recipes are
   read-only-by-contract**, the first author-time run goes through the normal gate, and refresh reuses
   the allowlisted grant (or re-prompts). Must be nailed down before shipping refresh.
4. **Split on build.** Likely `033.1` (storage + Dashboards overlay + view + a **manually-authored**
   widget, no agent) → `033.2` (the `dashboard_write` agent-authoring tool) → `033.3` (the
   `dashboard_refresh` durable executor + live refresh). Mirrors the `025.x` incremental pattern.
5. **Grid/layout tech.** Fixed grid vs a drag-resize lib (`react-grid-layout`, a dep). Lean **fixed
   grid first**, drag-resize later (the `032`-canvas deferral pattern).

## Verification (when built)
- **Migration:** additive tables over the latest schema; `migrations.test.ts` + bump any "latest
  `user_version`" assertions.
- **Unit:** repo CRUD + tri-state/JSON round-trips; the refresh executor normalizes a stubbed raw
  result into the widget payload contract and isolates a per-widget failure; the `dashboard_write` tool
  validates + persists a spec; a widget renders from a cached payload.
- **Manual (real app):** click **Dashboards**; create one; prompt the agent to build 2-3 widgets off a
  real local source (e.g. `az ...` via `run_shell`, or a `git`/filesystem stat); see them render;
  Refresh and watch values update + last-refreshed change; kill the source and confirm the per-widget
  error state; delete a dashboard.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Building data connectors / MCP servers.** Data arrives through the agent's existing tools; **MCP is
  its own effort** (backlog). Dashboards gain MCP sources for free once MCP lands — no dashboard change.
- **True background/cron scheduling** — the `cron`/`blueprints` backlog item; v1 is manual/on-open/poll.
- **Sharing / export / embedding dashboards** — later.
- **A polished drag-resize grid canvas** — later (fixed grid first).
- **Cross-dashboard alerting / thresholds / notifications** — later.
