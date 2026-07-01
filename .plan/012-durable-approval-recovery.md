# PR12: Durable approval recovery — survive a restart while waiting_for_approval

> Status: **BUILT** on `feat/durable-approval-recovery` (commit `7bc7f78`; merged to `main`).
> Split out of `009` (durable task execution). Builds on the `TaskRunner` (`src/main/tasks/runner.ts`)
> and the in-memory approval gate in `src/main/agent/index.ts` (`pendingApprovals`, `resolveApproval`).

## Context

`009`'s first cut kept approvals exactly as the live `chat` path has them: an in-memory
`pendingApprovals` map. When a task's tool needs approval the gate emits an `approval` event and
blocks on a Promise stored in that map. If the app quit while a task was blocked, the pending request
was lost — no durable record. This PR makes a blocked task recoverable across a restart: quit while
it asks → reopen → Resume → it **re-prompts**, and on approval completes. Reuses the existing
`approvals` table + repository — **no schema change**.

## As built

Three layers, the last two discovered while debugging the resume path (the original single-hypothesis
plan was insufficient):

1. **Dual-write the gate in the task runner** (not via a gate hook on `RunAgentLoopOptions`, as
   originally hypothesized). `approvals.task_id` is `NOT NULL REFERENCES tasks(id)`, so only the
   runner — which has a `taskId` — can write the table; the live `chat` path has no task and is left
   untouched for free. The `approval` ChatEvent already carries everything (`tool`, `summary`,
   `reason`, `requestId`, tool-call `id`) and already flows through `runOne`'s `onEvent`, so the
   dual-write needed **zero changes to the agent module / gate**.
   - On an `approval` event: `createApproval({ taskId, request: { tool, summary, reason, requestId,
     toolCallId } })` alongside the existing `waiting_for_approval` status flip. (`question` events
     create no row — out of scope.)
   - On the user's decision (`task:approve`/`deny` IPC): `recordApprovalDecision(taskId, requestId,
     status)` resolves the matching durable row (scoped by `requestId`) and then `markRunning`.
   - `reconcile` (on boot) and the cancel/abort sweeps resolve any still-`pending` row to
     `denied` with `decision:{superseded:…}` so none lingers.

2. **Don't fabricate a denial on shutdown.** `will-quit` → `runner.stop()` aborted the gate with a
   bare `abort()`, which the gate's abort listener resolved as `"denied"` — persisting a fake
   `ERROR[denied]` tool result that **wedged resume** (the model read it as a real denial; Bedrock
   400'd on the message shape). Fix: `stop()` now aborts with a `SHUTDOWN_ABORT_REASON` sentinel
   (exported from `agent/index.ts`); the approval **and** `ask_user_question` gates skip resolving on
   that reason, leaving the gate **unresolved** so the task stays `waiting_for_approval` →
   `reconcile` maps it to `interrupted` → clean re-prompt. A user Stop/cancel still aborts bare and
   resolves `"denied"` as before.

3. **Two-mode dangling tool-call repair** (`src/main/agent/repair.ts`, extracted out of the runner
   and now called inside `runAgentLoop`, shared by both callers). A blocked turn leaves an assistant
   `tool_call` with no result; the model API requires a result for every `tool_call`, but a synthetic
   one reads as a *finished* call so the gated action would never retry. Mode is chosen by caller via
   `userMessage`:
   - **`rollback`** (task resume — no `userMessage`, "carry on"): delete the incomplete trailing turn
     (the dangling assistant message + anything after it) so the agent re-plans and re-issues the
     gated tool — the gate **re-prompts**. This is what makes Resume actually re-attempt.
   - **`synthesize`** (live chat — fresh `userMessage`): append an "interrupted" tool result and let
     the new message drive (live chat is ephemeral; the user retries by typing). A first task run has
     no dangling tail, so its rollback is a no-op.

4. **Renderer**: a reloaded conversation marks a persisted `tool_call` with no result as
   `"interrupted"` (a settled note, not a forever spinner), so a live chat left mid-gate at quit
   isn't visually stuck.

## Restart recovery flow

The tool that triggered the gate never executed, so its result was never persisted. On boot,
`reconcile` moves `waiting_for_approval` → `interrupted` (and sweeps the stale `pending` approval
row). On Resume, `runAgentLoop` rolls back the incomplete turn, rebuilds context from the persisted
transcript, the model re-issues the gated tool, and the gate re-creates a fresh approval — i.e.
**re-prompt on resume**. Replaying a decision made while the app was closed stays out of scope.

## Out of scope (unchanged)
- Persisting/replaying a decision made while the app was closed (re-prompt on resume instead).
- Durable recovery of **live chat** turns — live chat is ephemeral by design (synthesize + retry).
- The `ask_user_question` gate's *durability* (no `approvals` row); it does honor the shutdown-abort
  fix so it isn't falsely cancelled.

## Verification (done)
- Unit: `agent/repair.test.ts` (synthesize + rollback modes — re-attempt, partial-result drop, prior
  complete turns preserved, no-ops). `tasks/runner.test.ts` adds pending-row creation,
  requestId-scoped resolve, reconcile sweep, and the **shutdown-abort-leaves-gate-unresolved** path.
  Full suite 194 passing (one unrelated SIGKILL test in `env/local.test.ts` flakes only under
  full-suite CPU contention; passes in isolation). Typecheck clean.
  - Note: the runner/DB suites need `better-sqlite3` built for **node** (`npm rebuild
    better-sqlite3`); restore the Electron build afterward (`electron-rebuild -f -w better-sqlite3`).
- E2E: background task `delete the build/ folder` → at the approval prompt, quit → reopen → task
  reconciles to `interrupted` → Resume → **the approval prompt reappears** → approve → folder deleted.
