# PR38: Sub-processes — a phase that runs another Process

> Status: **NOT STARTED**. ⚠️ **DESIGN-PENDING** (nested-run correctness with gates/fan-out/resume is
> the risky part). Lets a Process **phase invoke another Process definition** as a nested run — e.g. an
> "Implement" phase delegates to a reusable **"Best-practices implementation"** sub-process (plan →
> code → self-review) instead of doing it in one worker. Composition of the `025` engine with itself.

## Context

`025`'s engine drives a `process_run` **task** through the scheduler's **ready-set walk**
(`scheduler.ts`): each ready phase is `dispatch`ed and runs **inline** via `runAgentLoop` in a **forked
worker conversation** (`service.ts` `makeRunPhase` → `createConversation` + a `process_phase`
`createTask`, run under a per-run promise pool `PER_RUN_CONCURRENCY=4`). A run is kicked off by
`ProcessService.startRun({ processId, … })` → `runner.enqueueKind({ kind:'process_run', input:{
processRunId } })`. Phases already have `routing` (`single`/`dispatch`), `gate_policy`, `fan_out`, and
an agent pool. **Precedent for blocking nested execution:** `spawn_subagent` runs a child
`runAgentLoop` synchronously inside the parent turn (the codebase's documented ruling against
re-enqueuing — "would deadlock under the concurrency cap on a blocking wait"), bounded by
**`MAX_AGENT_DEPTH=5`** (`agents/types.ts`) via `agentDepth`. The DAG has **no cycle guard** — bounds
are mandatory (same rule `031` calls out).

## Goal

1. A phase can be marked as **running a sub-process** (a reference to another `process_definitions`
   row) instead of a single agent worker. When that phase becomes ready, the engine **starts a nested
   run** of the referenced definition, feeds it the phase's kickoff prompt (+ upstream digest, like any
   phase), waits for it to complete, and treats the sub-process's **final aggregated output** as the
   phase's output for downstream `collectUpstream`.
2. **Bounded + inspectable:** a sub-process run is a first-class `process_runs` row **linked to its
   parent phase-run**, so the `026` monitor can **nest it** (expand a sub-process phase to see its own
   phase-run rows), and a depth/cycle bound prevents infinite nesting.

## Likely shape (hypothesis — revisit per Open questions)

### A. Storage (additive, `SCHEMA_V20+`)
- `process_phases` gains a nullable **`subprocess_id`** (FK → `process_definitions`, `ON DELETE`
  guarded). A phase is either an **agent phase** (today: pool + routing) or a **sub-process phase**
  (`subprocess_id` set) — mutually exclusive, validated in the repo layer (the `025` bare-TEXT ruling).
- `process_runs` gains a nullable **`parent_phase_run_id`** (FK → `process_phase_runs`) so a nested run
  knows its caller and the monitor can nest. (Mirror `process_phase_runs.parent_id`, which nests
  fan-out children within a run; this nests a whole run within a phase-run.)

### B. Engine (`scheduler.ts` + `service.ts`)
- **Dispatch fork:** in `dispatch`/`makeRunPhase`, branch on `phase.subprocess_id`. A sub-process phase
  does **not** fork an agent worker; instead it **starts a nested run** — reusing the `spawnSubagent`
  precedent: call the run executor **inline** (a nested scheduler walk under the parent's per-run pool),
  NOT `enqueueKind` (avoids the documented deadlock-under-cap). The nested run gets its own
  `process_runs` row (`parent_phase_run_id` set) + `sourceConversationId` inherited, and its completion
  settles the parent phase-run (`completed` when the nested run completes; failed/cancelled propagates —
  v1, mirroring fan-out parent settling).
- **Bound (mandatory):** a **process-depth counter** threaded like `agentDepth` (a `MAX_PROCESS_DEPTH`),
  AND a **cycle guard** — a definition cannot (transitively) invoke itself; validate the sub-process
  reference graph is acyclic at **author time** (reject the edge) and defensively at run time.
- **Upstream/downstream:** the sub-process phase's output = the nested run's **aggregated final output**
  (reuse `025.1`'s `aggregateChildContent` idea over the nested run's terminal phases), so a downstream
  phase's `collectUpstream` digest is real. Gates: a gate on the sub-process phase fires on the nested
  run's completion (like a fan-out source — `025.2`'s documented limitation applies).
- **Resume:** a checkpoint records the nested `process_runs` id so crash-resume re-attaches to the
  in-flight nested run instead of restarting it (extends `025`'s frontier checkpoint; the nested run has
  its own phase-granularity resume already).

### C. Builder + monitor (`process-screen.tsx`, renderer)
- Builder: a phase's inspector gains a **"Runs a sub-process"** toggle → a **definition picker** (the
  other process definitions, minus self + anything that would cycle). Selecting it hides the
  agent-pool/routing controls (mutually exclusive).
- Monitor: a sub-process phase-run is **expandable** to show the nested run's own phase-run rows
  (recursively — the monitor already nests fan-out/each-subtask children; this adds one more nesting
  kind keyed by `parent_phase_run_id`).

## Open questions to resolve BEFORE building
1. **Inline vs enqueued nested run.** Inline (the `spawnSubagent` precedent — no re-enqueue, shares the
   parent's global slot, avoids deadlock) vs a separate queued `process_run` the parent waits on. Lean
   **inline** (the documented ruling); confirm the per-run concurrency accounting holds when a phase's
   "work" is itself a bounded sub-walk.
2. **Depth + cycle bounds.** `MAX_PROCESS_DEPTH` value; author-time acyclicity check on `subprocess_id`
   references (reject a cycle) + a runtime backstop. Lean **both** (author-time reject + runtime guard),
   mirroring `031`'s "bound is mandatory."
3. **Input/output contract.** What the sub-process receives (the phase kickoff prompt + upstream
   digest) and what it returns (aggregated terminal output). Does the sub-process get the parent's
   fan-out sub-task prompt when the parent phase is itself a fan-out child? Lean: **sub-process = a
   normal run seeded with the phase's kickoff prompt**; per-child sub-process invocation is the
   `025.2`-style granularity, likely deferred.
4. **Failure propagation.** A failed nested run fails the parent phase (v1) vs a policy (retry /
   continue-with-partial). Lean **fail the parent (retryable)**, matching fan-out v1.
5. **Split on build** (`025.x` pattern): `038.1` a sub-process phase end-to-end (author-time acyclic
   check, inline nested run, monitor nesting, completion→downstream) → `038.2` gates/fan-out edge cases
   + resume-reattach hardening.

## Verification (when built)
- **Unit (`scheduler.test.ts`/`service.test.ts`):** a sub-process phase starts a nested run whose
  completion settles the parent phase-run and feeds `collectUpstream`; a self-referential /cyclic
  `subprocess_id` graph is rejected at author time; depth bound stops runaway nesting; a failed nested
  run fails the parent (retryable); resume re-attaches to an in-flight nested run without restarting
  completed nested phases.
- **Manual (real app):** build a parent process where "Implement" is a sub-process (plan→code→review);
  run it; in the monitor, expand the sub-process phase to watch its inner phases; confirm downstream
  phases see the sub-process's output; cancel mid-sub-process and confirm clean unwind.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Per-fan-out-child sub-process invocation** (a sub-process run *per* sub-task) — a granularity
  follow-up (the `025.2` pattern), likely `038.2`+.
- **Cross-process shared state** beyond the prompt/digest contract — later.
- **Recursion / self-invocation** — explicitly bounded + cycle-rejected, not supported.
- **Agent-to-agent messaging across phases** — `039` (a different primitive: a question/answer channel,
  not nested execution).
