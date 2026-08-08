# PR29: Process review feedback loop — "Request changes" + re-run

> Status: **NOT STARTED**. Follow-up on `026` (Process UI) surfaced by live testing. A gated phase is
> binary today — Approve or Deny — and Deny is a dead-end (the run wedges `paused`, only Cancel
> escapes). This adds a third gate decision, **Request changes**, that re-runs the gated phase's own
> worker with a feedback note and re-gates. Builds the **reopen → inject feedback → bounded re-run**
> primitive that `031` (validator + cross-phase flag-back) generalizes — build it once, here.

## Context

A process phase with `gatePolicy: "approve"` pauses the run after it completes and waits for a human.
The gate lives in `src/main/tasks/process/scheduler.ts`:

- `raiseGate` (~L316): on a completed gated phase, `createApproval({ taskId, request })` (the
  `GateRequest` blob `{ kind:"process_phase_gate", phaseKey, phaseRunId, requestId }`), flips the
  **run** to `waiting_for_approval` (the phase itself stays `completed`), emits a `process_phase`
  event carrying the `requestId`, and throws `GateBlockedError` → the `process_run` task settles
  `paused`.
- `process:approve` (`src/main/ipc/process-handlers.ts`): `recordApprovalDecision(...,"approved")` +
  `runner.resume(taskId)` → `runScheduler` re-derives from the DB; the gate now resolves and
  dependents dispatch.
- `process:deny`: records `denied` and does **not** resume — dependents stay blocked forever
  (`gateResolved` only accepts `"approved"`). The `026` monitor shows a "denied → paused, cancel to
  end" hint.

The scheduler re-derives the whole frontier from the DB on every entry (no in-memory state across a
pause), and the crash-orphan reset (scheduler.ts ~L255-265) already resets a `running`/`ready`
phase-run back to `pending` so it re-dispatches. So a *re-run* is mechanically cheap — the work is in
re-opening a **completed+gated** phase (net-new) and threading feedback in.

## Goal

1. A **Request changes** action on a gated phase's card (alongside Approve / Deny): a textarea for
   feedback + a button, wired to a new `window.cowork.process.requestChanges({ processRunId,
   requestId, feedback })`.
2. The gated phase's worker **re-runs** with the feedback injected as a "## Requested changes" block
   in its kickoff, then **re-gates** for another look.
3. **Bounded** — a per-phase rework-round cap (`maxIterations`-style) so repeated requests can't loop
   forever; on exhaustion the card forces Approve/Cancel (no more "request changes").

## Likely shape (hypothesis — revisit per Open questions)

### A. Re-open a completed+gated phase (the crux)
`needsGate` returns false once **any** approval row exists (`return !gate`), and `gateResolved`
accepts only `"approved"` — so after a naive re-run the phase would neither raise a fresh gate nor
resolve the old one. Fix one of:
- **Supersede the old approval row** — add a `deleteApproval`/`supersedeApproval` to
  `src/main/db/repositories/approvals.ts` (only create/get/list/resolve exist today) and drop the
  stale row on request-changes, so a re-completed phase raises a fresh gate; **or**
- **Re-key gate detection on the latest row** — `needsGate`/`gateResolved` compare the phase-run's
  `finishedAt` against the newest gate row's timestamp, treating a phase re-completed after its last
  gate as needing a new one.

### B. The `process:requestChanges` verb (`process-handlers.ts` + preload + `api.process`)
Given `{ processRunId, requestId, feedback }`: settle the old approval `denied` (feedback in
`decision`), reset the gated phase-run `completed → pending`, supersede the gate (per A), persist the
feedback (per C), increment the rework round (per D), then `runner.resume(run.taskId)`.

### C. Feedback → the re-run kickoff
No field carries a note into the worker prompt today; **do not reuse `iteration`** (it's a
retry-attempt counter, overwritten on every terminal write in `runPhaseWithRetry`). Add a
`process_phase_runs.rework_note TEXT` column (additive migration, mirrors the `026` ALTERs) — or a
checkpoint row (the fan-out `createCheckpoint` precedent). `makeRunPhase` (`service.ts` ~L149) reads
it and `kickoffPrompt` (`prompts.ts` ~L16-44) appends a "## Requested changes" section.

### D. The round bound
Add `process_phase_runs.rework_round INTEGER NOT NULL DEFAULT 0`. `requestChanges` increments it;
when it reaches the cap (a `maxIterations` on the phase/definition — see `031`), the monitor card
drops the Request-changes button (Approve/Cancel only). 018 is the design template for the bound.

### E. UI (`process-screen.tsx`, `PhaseRunItem`)
A third control on the gate card: a collapsible textarea + "Request changes" button. On submit, call
the new verb and optimistically clear the gate (same pattern as the existing approve/deny clear).

## Open questions to resolve BEFORE building
1. **Supersede vs. re-key** the gate row (A) — deleting is simpler but loses the audit trail;
   re-keying preserves history but touches `needsGate`/`gateResolved` logic. Lean **re-key** (keeps
   every decision durable, which matters for a review trail).
2. **Round-cap location** — per-phase column, per-definition field, or the run's input blob? Lean a
   per-phase/`definition` `maxIterations` shared with `031`'s validator (one concept).
3. **Feedback storage** — column vs. checkpoint. Lean a column (`rework_note`) — simplest to read in
   `makeRunPhase`; checkpoints are for resume-critical state.
4. **Does re-running a gated phase also re-run its downstream?** For the *human same-phase* case the
   dependents never released (they were gated), so no downstream reset is needed here — that's
   `031`'s cross-phase concern. Confirm the gated phase truly had no released dependents.

## Verification (when built)
- Unit: a `requestChanges` scheduler/handler test — a gated completed phase resets to `pending`,
  re-runs with the feedback in its kickoff, re-gates; the round counter increments and caps.
- `approvals` repo test for the supersede/re-key path.
- DB suite under a node-ABI rebuild (new migration reaches the bumped `user_version`, new columns
  present); restore Electron ABI after.
- Manual E2E: run a process to a gated Review, click **Request changes** with a note, watch the
  phase re-run and re-gate; exhaust the cap and confirm the button disappears.

## Out of scope
- **Cross-phase send-back** (Review → Implement) and the **per-phase validator** — `031`.
- Autonomous (agent-initiated) rework — `031`.
- Per-pool-agent skills/tools overrides, visual canvas — unrelated `026` deferrals.
