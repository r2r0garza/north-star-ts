# PR31: Process rework — per-phase validator + cross-phase flag-back

> Status: **DESIGN-PENDING** (core decisions settled below; a few sub-questions remain for the build
> PR). The agent **quality loop** for the Process engine: a phase can be sent back to rework its
> output — automatically by a **validator** (a second LLM reviewing the same phase) or by an agent's
> **flag** targeting an *earlier* phase. Generalizes the superseded `018` `review → fix → review`
> bounded loop, and shares the **reopen → inject feedback → bounded re-run** primitive with `029`
> (the human, same-phase case). **Will likely SPLIT** on build (the `025.1/.2/.3` pattern):
> `031.1` = validator, `031.2` = cross-phase flag-back + autonomous routing.

## Context

Live testing `026`: when a later phase (Review / QA / Docs / Publish) found a defect a *previous*
phase owned, the finding had nowhere to go — the Publish agent said "I'll fix it," but the fix
belonged back in **Implement**. Agents are self-contained (they don't see the phase graph) and today
either fix out of lane or bury the issue in prose. The engine is a **forward-only DAG walk** with no
backward path.

Confirmed in `src/main/tasks/process/scheduler.ts`:
- **Back-edges are storable** — edges are flat `{from,to,trigger}` rows with **no acyclicity CHECK /
  cycle validation** (`schema.ts` ~L490-497).
- `collectUpstream` (`service.ts` ~L382-415) reads **incoming** edges, so a back-edge automatically
  feeds a source's output into a re-run target's kickoff — feedback threading is free.
- **DANGER: the walk has no visited-set and no iteration cap.** It's safe today only because a
  `completed` phase never re-enters the ready set. Resetting `completed → pending` behind a back-edge
  can loop **forever** — a bound is mandatory.
- **One top-level row per phase per run** (`runByPhaseId`, ~L202-213). `parent_id` means "fan-out /
  consumer child," NOT "prior attempt" — rework rounds need a reset-in-place vs. new-sibling-row
  decision. `iteration` is a retry-attempt counter (don't repurpose).

## Goal

Three capabilities over **one shared rework primitive** (reopen a completed phase → inject a feedback
note → re-run → bounded; the same primitive `029` builds):

1. **Flag, don't fix** — an agent that finds a previous phase's defect emits a **structured flag**
   instead of fixing out of lane.
2. **Send-back** — route a flag to the owning phase; that phase **and everything downstream of it**
   re-run (a fix invalidates work built on the old output).
3. **Per-phase validator** — an optional second LLM reviews a phase's output and sends it back to the
   **same** phase with feedback until it passes, bounded.

## Decisions (from design discussion)

### (1) Per-phase VALIDATOR — automatic, same-phase (→ `031.1`)
- Builder toggle per phase: **"second agent review?"** (default off). New `process_phases.validator`
  (bool) column.
- After a validator-enabled phase's worker completes, a **`validate()`** step runs a bounded,
  non-streaming `createCompletion` (mirroring `router.ts` / `SummaryService`) over the objective +
  the phase's output as the rubric input → **approve** | **{feedback}**.
- Approve → proceed to dependents. Feedback → reset the phase `completed → pending`, stash the note,
  re-run its worker, `rework_round++`, capped by `maxIterations`; on exhaustion, force a human gate.

### (2) Cross-phase FLAG-BACK — agent-initiated (→ `031.2`)
- **Global `human_approve` toggle (true | false):**
  - `true` → an agent's flag surfaces for **human confirmation** before the send-back (reuses the
    gate/card affordance from `029`).
  - `false` → the agent **routes autonomously** — which requires **dynamically injecting into every
    phase worker the upstream chain** (which phases/agents ran before it) so it can name a valid
    target. Net-new context injection (agents don't see the graph today).
- **Flag mechanism:** a **gated `flag_for_rework` tool** — `{ target, reason }` — added to the
  process-phase tool surface. Explicit, inspectable, gateable (vs. parsing the final message).
- **Re-run scope is as granular as the target — sub-task-level, not just phase-level.** A flag may
  target a whole phase OR a single **fan-out sub-task** (child run). Rework only what was actually
  flawed:
  - **Flag a fan-out sub-task** (1 of N children) → reset **only that child** `completed → pending`
    and re-dispatch it (children are already first-class: their own `process_phase_runs` row, worker
    `taskId`, briefing in `childPrompts`, and Pass-1 `title`). The **container parent flips
    `completed → running`** so `deriveContainers` re-settles it when the child re-finishes. Do **not**
    re-run the other 4 children. This is *less* machinery than a phase replay, and the common case.
  - **Flag a whole (non-fan-out) phase** → reset that phase.
- **Downstream propagation is as granular as the consumption was:**
  - Downstream joined by an **`on_each_subtask`** edge → only the **instance tied to the reworked
    child** re-runs (per-child; the other instances stand).
  - Downstream joined by an **`on_complete`** edge (it aggregated all children via
    `aggregateChildContent`) → that monolithic consumer re-runs once (it read the whole batch, so it
    can't partially re-run), noting which piece changed. Then its own downstream, transitively.
- **Bound:** `maxIterations` caps round-trips; on exhaustion, force a human decision. (Never loop
  unbounded — the walk has no cycle guard.)

### Build order & split
`029` first (human same-phase gate — simplest, proves the reopen+feedback+round-cap primitive), then
`031.1` (validator: automatic same-phase), then `031.2` (cross-phase flag-back + autonomous routing —
the riskiest, needs sub-DAG-replay correctness).

## Open questions to resolve BEFORE building (per split)
1. **Validator reviewer identity** — a bounded `createCompletion` with a rubric (cheap, no new
   agent) vs. a dedicated "validator" agent from the pool vs. the phase's own agent in a review
   posture. Lean the **bounded `createCompletion`**.
2. **`human_approve` scope** — app-global vs. per-process-definition. Lean **per-definition** (a
   process is the behavioral unit; autonomy varies by process).
3. **`maxIterations` scope** — per-phase (validator rounds) vs. per-run (total flag-backs). Likely
   **both** (a per-phase validator cap AND a per-run flag-back cap).
4. **Rework-round row model** — reset-in-place (loses attempt history) vs. a new sibling phase-run
   row per round (needs new keying — `runByPhaseId` is strictly one-per-phase). Decide per split.
5. **Sub-DAG replay correctness (`031.2`, the riskiest)** — resetting a target (phase OR a single
   fan-out child) + its downstream must cooperate with the existing container / gate / checkpoint
   machinery: a reset child must flip its **container parent** `completed → running` (a new *backward*
   container transition) so `deriveContainers` re-settles it; a reset gated phase must **re-gate**; a
   reset whole fan-out parent must **re-decompose**; `on_each_subtask` consumers must re-trigger only
   the affected instance. This is the spike to run before building `031.2`.
6. **How the agent names the target** — the flagging agent sees the *aggregated* upstream (labeled
   `#### Sub-task N`), not child run-ids. So the flag references a phase by key AND a sub-task by
   **title/index** (Pass 1 now stores child titles), which the engine resolves to the specific child
   `process_phase_runs` row. Needs a fixed vocabulary injected into the worker + validation that the
   target is a real upstream phase/sub-task (reject forward/unknown targets).

## Verification (when built, per split)
- Validator (`031.1`): a scheduler test — a validator phase with a stubbed reviewer that returns
  feedback resets + re-runs the phase, caps at `maxIterations`, then proceeds/forces-gate.
- Flag-back (`031.2`): the `flag_for_rework` tool gates correctly; a flag resets the target + its
  transitive downstream to `pending` and re-walks; a bad target is rejected; the per-run cap holds;
  `human_approve` true vs. false both behave.
- DB migrations (`validator`, any `rework_*` columns) under a node-ABI rebuild; Electron ABI restored
  after. Manual E2E on the example process.

## Out of scope
- Human same-phase "Request changes" — `029` (this doc's automatic + cross-phase generalization).
- Non-LLM/deterministic validators (tests/lint/build as the reviewer — 018's "deterministic-first"
  idea) — a possible later addition to the validator step.
