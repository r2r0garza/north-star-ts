---
status: CLOSED
severity: P2
trigger: "A failed process and a transcript ending at a tool request do not reveal whether dispatch, execution, persistence, review, or the next API call failed"
created: 2026-09-01
updated: 2026-09-02
---

# Preserve failure stages and recovery history across process boundaries

## Evidence

At revision `21bd34d`, `runAgentLoop` in `src/main/agent/index.ts` catches a
broad region and logs `Portkey request failed` even when the thrown failure may
come from local persistence or another operation in that region. `ChatResult`
largely carries an error string and retryability. Process service wrappers
preserve those but generic catches collapse exceptions to strings.

`src/main/tasks/process/service.ts` passes `onEvent: () => {}` for worker,
decomposer, and reviewer loops. Tool results remain in their transcripts, but
the parent run does not receive those live details. The scheduler's terminal
summary can be only `a process phase failed`; the original child phase may have
a more specific error. Retry workers replace the phase's current task pointer,
making earlier attempts harder to discover from that phase.

## Proposed direction

Define bounded structured failure and recovery records shared by agent/task/
process boundaries. Candidate fields: stable code, stage, message, retryability,
retry budget/exhaustion, attempt identity, run/phase/worker IDs, optional tool
call ID, and a safe underlying cause summary. Persist parent-child causality so
the top-level failure links to the actual failed phase and attempt.

Differentiate stages such as agent setup, model request/stream, tool dispatch,
tool execution, result persistence, output validation, reviewer, and scheduling.
Do not infer stages by parsing human-readable error strings. Handle exceptions
before the current worker try blocks as well as normal result errors, without
mistaking control-flow pause/cancel/gate signals for failures.

Publish minimal durable events for retry scheduling, attempt start/exhaustion,
tool outcome unknown, and review unavailability. The monitor must render the
same state live and after reload, with relevant actions and attempt history.
Route new renderer capabilities through `window.cowork` and main/preload IPC.

Redact credentials, provider bodies, tool arguments/results, and sensitive paths
as appropriate; cap diagnostic size. Do not dump all model prompts into logs.
If DB persistence fails, retain a best-effort bounded external diagnostic and
surface the failure honestly; do not claim it was durably recorded in that DB.

## Acceptance criteria

- [x] Inject each stage failure and assert its typed stage and identity survive
  agent, worker, phase, nested run, and user-visible error boundaries.
- [x] A tool error followed by an API error is shown as two distinct events;
  the last visible tool request is not blamed automatically.
- [x] Retrying/exhausted/review-unavailable states survive reload and show the
  correct action without relying on an in-memory event subscription.
- [x] Earlier attempts remain inspectable after retry, linked to the same phase.
- [x] Terminal runs have no active spinner unless backed by genuinely active
  work under a documented draining policy; test durable rows as well as display.
- [x] Cancellation and approval holds are not relabeled as API errors.
- [x] Redaction and size-limit tests cover provider errors and tool failures.
- [x] A support/export record includes app build and nested failure identity so
  incidents from another computer can be investigated without speculation.

## Scope and dependencies

Likely touch points: `src/main/agent/index.ts`, `src/main/tasks/runner.ts`,
process service/scheduler, DB schema/repositories, preload/main IPC, process
monitor, and task transcript UI. Define the shared record early alongside
[066](./066-api-retries-restart-process-workers.md) and
[068](./068-validator-errors-silently-approve-phases.md); implement display after
the runtime emits authoritative state. Preserve the nested-failure fix from
commit `5a8058c`; do not reopen it solely because older records contain stale rows.

## Implementation progress

2026-09-02: Added `FailureContext` records for agent-loop setup/model failures
and process worker/decomposition/reviewer/sub-process boundaries. Process phase
runs now persist the latest failure JSON, `process_phase` task events include it,
and `process_phase_attempts` stores failed retry attempts so earlier failed
attempts remain inspectable after a later retry succeeds. The process monitor
renders the typed stage/code/attempt metadata while preserving the legacy error
fallback.

2026-09-02: Closed the remaining follow-up slices. Fault-injection coverage now
exercises every declared failure stage, tool and API failures remain distinct,
retry/review recovery states are reload-safe, attempt history is visible in the
monitor, control-flow states do not create false failure records, diagnostics are
redacted and byte-capped, support exports include nested failure identity, and DB
persistence failures surface as `result_persistence` with a best-effort external
diagnostic fallback.

Closure follow-ups were split into:
[087](./087-process-failure-stage-fault-injection-coverage.md),
[088](./088-process-tool-error-then-api-error-distinct-events.md),
[089](./089-process-recovery-states-survive-reload.md),
[090](./090-process-attempt-history-ui.md),
[091](./091-process-cancel-and-approval-not-failures.md),
[092](./092-process-failure-redaction-and-size-limits.md),
[093](./093-process-support-export-failure-identity.md), and
[094](./094-process-failure-db-persistence-fallback.md).

Verification across the closure slices included:

- `pnpm exec vitest run src/main/tasks/process/scheduler.test.ts src/main/tasks/process/service.test.ts src/main/process/io.test.ts src/main/tasks/runner.test.ts`
- `pnpm exec vitest run src/main/tasks/process/failure-sanitizer.test.ts src/main/agent/tool-error-feedback.integration.test.ts`
- `pnpm exec vitest run src/renderer/src/components/process-screen.test.tsx`
- `pnpm run typecheck`
