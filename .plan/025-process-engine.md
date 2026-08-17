# PR25: Process engine — a user-defined agentic DAG of phases, run start-to-finish

> Status: **NOT STARTED**. **Supersedes `018`** (agentic goal mode) — 018's fixed
> `plan → execute → review → fix → finalize` pipeline becomes one *built-in Process template* over
> this general mechanism. Builds on the `TaskRunner` (`009`–`022`, the executor seam +
> forked-worker-conversation model), `runAgentLoop` (the shared agent core), the file-based **agents**
> subsystem (`src/main/agent/agents/`, custom-agents PR), the durable **approval** pipeline (`002`/`012`,
> for the human-in-the-loop gates), and the dormant **`task_checkpoints`** table (`009`) — this is its
> first real consumer.

## Context

Every unit of agent work today is a **single task**: one turn (`agent_chat`), one todo list
(`todo_run`), or one deterministic executor (`workspace_index`, `summarize`). Tasks run FIFO with a
concurrency cap and **per-conversation serialization** (`runner.ts` `takeNext`), but **no task
depends on another** — there is no DAG, no sequencing, no join. The `task_checkpoints` table exists
(`src/main/db/schema.ts`, repo `src/main/db/repositories/task-checkpoints.ts`) but nothing reads or
writes it for orchestration ("Storage-only this phase" — the comment is still true).

`018` proposed a **hardcoded** five-phase quality loop inside `runOne`. But users want to compose
**their own** multi-phase workflows — e.g. `Ideate → Envision → Gather → Pathfind → Plan →
Construct → Validate → Publish` — where:

- most phases run **sequentially** (each depends on the previous),
- some run in **parallel** (Construct and Validate can overlap),
- some have **multiple upstream dependencies** (Publish depends on **both** Construct AND Validate),
- a phase can **fan out into N sub-tasks at runtime** (Construct tackles N pieces), and a downstream
  phase can start **per completed sub-task** (Validate validates each piece as Construct finishes it,
  not after the whole phase),
- each phase is handled by **one or more agents** — a single agent, or an **agent pool** (Construct
  with a frontend-coding agent AND a backend-coding agent) where each sub-task is **routed** to the
  best-fit agent — each agent carrying its own skills + tools,
- and the user picks a **human-in-the-loop policy** per phase: approve after every phase / approve
  only after specific phases / fully autonomous ("just tell me when you're done").

This PR builds the **engine**: the data model for reusable Process **definitions** and their
**runs**, and a DAG **orchestrator** that schedules phases respecting dependencies, runs independent
phases concurrently, fans out, routes to agents, gates on approvals, and resumes across a crash. The
visual builder + monitor are `026`; in-app agent authoring is `027`; skill authoring is `028`.

## Goal

1. **Storage** for reusable Process **definitions** (phases, dependency edges, per-phase agent
   pool + skills/tools, routing strategy, gate policy, fan-out) — separate from **run** instances
   (one per execution, with its own per-phase status/history). Definition/run split so a Process is
   authored once and re-run many times.
2. A **DAG orchestrator** task kind that: schedules a phase when its upstream dependencies are
   satisfied, dispatches independent ready phases **in parallel**, supports runtime **fan-out** and
   **partial-completion (`on_each_subtask`) triggers**, and **routes** each phase/sub-task to the
   best-fit agent in its pool.
3. **Per-phase human-in-the-loop gates** (`auto` | `approve`) reusing the durable approval pipeline,
   plus a process-level completion notification.
4. **Crash-resume at phase granularity** — a run interrupted mid-flight rebuilds its ready-set from
   persisted phase-run statuses + checkpoints, without re-running completed phases.

## Likely shape (hypothesis — revisit per Open questions)

### Schema (new migration — append to `db/migrations.ts` + a new `SCHEMA_V15`)

```sql
-- Reusable authored workflow (the "template").
CREATE TABLE process_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One node in the DAG.
CREATE TABLE process_phases (
  id          TEXT PRIMARY KEY,
  process_id  TEXT NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                 -- stable slug, e.g. 'construct' (unique per process)
  name        TEXT NOT NULL,
  routing     TEXT NOT NULL DEFAULT 'single' CHECK (routing IN ('single','dispatch')),
  gate_policy TEXT NOT NULL DEFAULT 'auto'   CHECK (gate_policy IN ('auto','approve')),
  fan_out     INTEGER NOT NULL DEFAULT 0,    -- 0 = single task; 1 = may spawn N sub-tasks at runtime
  position    INTEGER NOT NULL,              -- authoring order / layout hint
  UNIQUE (process_id, key)
);

-- The agent POOL for a phase: 1 row (routing='single') or N rows (routing='dispatch').
CREATE TABLE process_phase_agents (
  id         TEXT PRIMARY KEY,
  phase_id   TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,                  -- resolves against the file-based agents subsystem
  skills     TEXT,                           -- JSON tri-state override (null = agent's own)
  tools      TEXT,                           -- JSON tri-state override (null = agent's own)
  position   INTEGER NOT NULL
);

-- Dependency edges. 'on_complete' = fire when the whole upstream phase is done;
-- 'on_each_subtask' = fire per completed fan-out sub-task (partial-completion trigger).
CREATE TABLE process_edges (
  id            TEXT PRIMARY KEY,
  process_id    TEXT NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  from_phase_id TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  to_phase_id   TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL DEFAULT 'on_complete'
                  CHECK (trigger IN ('on_complete','on_each_subtask'))
);

-- One execution of a definition (the "run instance").
CREATE TABLE process_runs (
  id                     TEXT PRIMARY KEY,
  process_id             TEXT REFERENCES process_definitions(id) ON DELETE SET NULL,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL,       -- queued|running|waiting_for_approval|paused|completed|failed|cancelled|interrupted
  started_at             INTEGER,
  finished_at            INTEGER
);

-- Per-phase execution state within a run. A fan-out phase gets one parent row +
-- child rows (parent_id) for its sub-tasks. task_id links to the backing task/fork.
CREATE TABLE process_phase_runs (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  phase_id   TEXT NOT NULL REFERENCES process_phases(id),
  parent_id  TEXT REFERENCES process_phase_runs(id) ON DELETE CASCADE,  -- set for fan-out sub-tasks
  status     TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_name TEXT,                            -- the routed agent (dispatch outcome)
  iteration  INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_process_phases_process ON process_phases(process_id);
CREATE INDEX idx_process_edges_process  ON process_edges(process_id);
CREATE INDEX idx_process_phase_runs_run ON process_phase_runs(run_id);
```

(Definition/run split per the Template+Runs decision; `gate_policy` per-phase for HITL;
`on_each_subtask` enables partial-completion / dynamic fan-out; `process_phase_agents` is the agent
**pool** — `routing:'single'` uses its one agent, `routing:'dispatch'` routes each sub-task to the
best-fit agent in the pool.)

### A. Orchestrator as a new task kind

- New kind `process_run`, `registerKind("process_run", { autoResume: true, run: processService.execute })`
  (registered in `src/main/index.ts` alongside `workspace_index`/`summarize`). It uses the
  **deterministic executor seam** (`TaskKindCapability.run`) — the orchestrator itself is
  deterministic scheduling logic; the *phases* it dispatches are the LLM work.
- New module **`src/main/tasks/process/`** — `service.ts` (the `TaskExecutor`), `scheduler.ts` (the
  ready-set walk), `router.ts` (agent dispatch), `prompts.ts` (per-phase kickoff builders). Kept out
  of `runner.ts`, mirroring `src/main/index/service.ts` and `src/main/summaries/service.ts`.
- A new `process_phase` `task_events` type (union addition + `emit()` calls) carries live phase
  transitions to the panel/monitor — mirrors `018`'s proposed `phase_change`.

### B. Scheduling (the ready-set walk)

```
loop until all phases terminal or run cancelled:
  ready = phases whose every incoming 'on_complete' edge's source phase is done
          AND not already started
  dispatch every ready phase concurrently   ← parallelism + multi-dependency join fall out here
  await the next phase/sub-task completion event, then re-evaluate
```

- Each dispatched phase is enqueued as its **own forked worker conversation** via
  `TaskRunner.enqueue` (inherits durable events, transcript, cancellation, retry — the `015`
  producer contract). The phase's `process_phase_runs.task_id` links to it.
- **Multi-dependency** (Publish ← Construct AND Validate) is just a phase with two incoming edges;
  it's only "ready" when both sources are done. No special-casing.
- The global concurrency cap still applies; per-run vs global fairness is an Open question.

### C. Fan-out + partial-completion

- A phase with `fan_out=1` is asked (in its kickoff) to decompose its work into N sub-tasks; each
  sub-task becomes a **child `process_phase_runs` row** (`parent_id` set) backed by its own enqueued
  task. The parent phase is `done` when all children are terminal.
- A downstream phase joined by an **`on_each_subtask`** edge is triggered **per completed child**
  (Validate starts on each Construct piece as it lands) rather than waiting for the parent to
  complete. Implemented by the scheduler reacting to child-completion events, not just parent
  completion.
- Sub-task representation (child phase-runs vs genuinely nested tasks) is an Open question — leaning
  child `process_phase_runs` rows so the DAG stays inspectable in one place.

### D. Per-phase agent pool + routing

- Each phase binds **1..N agents** (`process_phase_agents`), each with optional `skills`/`tools`
  overrides (tri-state, same semantics as the agent files).
- `routing:'single'` → the one agent runs the phase directly.
- `routing:'dispatch'` → a lightweight **router** (`router.ts`) selects the best-fit agent per phase
  (or per fan-out sub-task): e.g. frontend-coding vs backend-coding chosen by the sub-task's nature.
  Router is **model-decided by default** — a small classification pass over the pool's agent
  `description`s (the same metadata `spawn_subagent`/`children` already advertise) — with a
  rule-based option deferred.
- Each selected agent's phase runs through `runAgentLoop` with tools/skills narrowed **exactly** as
  the existing custom-agent path does (`src/main/agent/index.ts`, `agents/tool-categories.ts`) — no
  new narrowing mechanism.

### E. Human-in-the-loop gates

- `gate_policy:'approve'` inserts a **durable approval** between a phase's completion and its
  dependents' dispatch, reusing the `approvals` table + gate machinery (`012`) that already survives
  restart. The run sits `waiting_for_approval`; on approve, the scheduler resumes and dispatches the
  dependents; on deny, the run settles (deny semantics an Open question).
- "Approve only after specific phases" = per-phase `gate_policy`. "Fully autonomous" = all phases
  `auto` + a terminal desktop notification (reuse the notifications added in the recent
  desktop-notifications PR).

### F. Crash-resume at phase granularity

- `process_run` reconciles to `queued` on restart (`autoResume:true`). On resume, `processService`
  reads `process_phase_runs` statuses + the latest per-phase `task_checkpoints` entry to rebuild the
  ready-set — completed phases are **not** re-run; an interrupted phase re-enters. This is the first
  real consumer of `task_checkpoints`.

## Open questions to resolve BEFORE building
1. **Fan-out sub-task representation.** Child `process_phase_runs` rows (parent_id) vs genuinely
   nested `TaskRunner` tasks. Lean **child phase-run rows** — keeps the whole DAG queryable in one
   place and simplifies the monitor; the backing task_id still links to the fork.
2. **Concurrency fairness.** One big global cap (a wide DAG could starve other conversations) vs a
   per-run cap. Lean a **per-run cap** (small, e.g. 4) layered under the global cap.
3. **Fan-out count authority.** Agent-decided at runtime (flexible) vs a fixed N in the definition.
   Lean **agent-decided**, bounded by a per-phase max to prevent runaway spawning.
4. **Routing strategy.** Model-decided dispatch vs rule-based (skills/glob/path match); per-phase vs
   per-sub-task. Lean **model-decided, per-sub-task** for `dispatch` phases; `single` otherwise.
5. **Gate + deny semantics.** Where the approval surfaces (activity panel vs the `026` monitor), and
   what a **deny** does — fail the whole run, skip the dependents, or pause for edit. Lean pause +
   surface in both.
6. **Cancellation of a partially-fanned-out phase.** Cancelling mid-fan-out must stop in-flight
   children and mark the parent cancelled without wedging downstream `on_each_subtask` consumers.
7. **Definition storage.** DB (structured, queryable, matches the schema above) vs editable files
   (like agents/skills). Lean **DB** for the structured DAG; export/import later.
8. **Model per phase.** Agents carry no `model` today (it's per-conversation). Does a phase need to
   pin a model? Lean **inherit the run's conversation model** for v1; revisit with `027`.

## Verification (when built)
- **Unit** (`src/main/tasks/process/*.test.ts`, runner test): scheduler ready-set ordering
  (sequential chain); parallel dispatch of independent phases; multi-dependency join (a phase waits
  for *both* parents); fan-out spawns children + `on_each_subtask` fires the downstream per child;
  `dispatch` routing picks an agent from the pool (stubbed classifier); `approve` gate blocks
  dependents until resolved; resume rebuilds the ready-set from phase-run statuses + checkpoints
  without re-running done phases; cancellation stops in-flight children.
- **Manual (real app):** build the 8-phase example (`Ideate…Publish`); run it and watch Construct +
  Validate overlap; make Construct fan out and see Validate pick up pieces as they complete;
  set one phase to `approve` and confirm the run blocks until approved; run a fully-`auto` process
  and get the completion notification; quit mid-run and relaunch → it resumes at the right phases.
- `pnpm typecheck` + `pnpm build` clean; migration applies over `SCHEMA_V14`. (Runner/DB suites need
  `better-sqlite3` built for **node** — see `.plan/native-module-rebuild` note / `020` — restore
  Electron after with `@electron/rebuild`.)

## Out of scope
- **The visual builder + run monitor UI** — `026` (this PR ships the engine + IPC only).
- **In-app agent authoring** — `027` (phases reference agents by name; they must exist on disk).
- **In-app skill authoring** — `028`.
- **Rule-based routing, cron/scheduled runs, cross-run dependencies, export/import of definitions** —
  later.
- **A rich diff/review phase type** — 018's deterministic reviewer becomes a *template* built on this
  engine, not a hardcoded phase kind; that template is its own follow-up.
