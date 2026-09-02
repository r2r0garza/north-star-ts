---
status: CLOSED
severity: P1
trigger: "A validator-unavailable phase needs a retry path that re-runs only the review against the completed worker output"
created: 2026-09-02
updated: 2026-09-02
---

# Retry validator review without rerunning phase work

## Context

[068](./068-validator-errors-silently-approve-phases.md) now fails closed when a
validator returns an API error, throws, or produces invalid output. The phase is
parked behind the durable `process_validator_gate`, which prevents downstream
work from silently releasing.

That is safe, but it is not complete recovery. A transient reviewer outage still
requires the user to approve as-is or request changes, instead of retrying the
same review against the same completed phase output.

## Proposed direction

Add an explicit review-only retry action for validator-unavailable gates.

The retry must reuse the completed phase worker output that originally needed
review. It must not reset or rerun the phase worker, and it must not consume a
substantive validator rejection round. Transient reviewer retries should be
accounted separately from `validatorRound`, which is reserved for valid negative
verdicts that ask the phase worker to rework.

Prefer integrating with the model request retry machinery from
[066](./066-api-retries-restart-process-workers.md) and the persisted retry
budget work from [072](./072-persist-model-request-retry-budget.md), while
keeping the review input stable across restart.

## Acceptance criteria

- [x] A pending validator-unavailable gate exposes a retry-review action distinct
      from approve and request-changes.
- [x] Retry-review invokes only the validator reviewer; the phase worker
      invocation count remains unchanged.
- [x] Retry-review reuses the completed phase output that failed validation.
- [x] Retry-review does not increment `validatorRound` or `reworkRound`.
- [x] A transient API failure followed by retry completes only after a valid
      positive verdict.
- [x] A valid negative verdict after retry enters the existing bounded validator
      rework loop.
- [x] Retry exhaustion leaves the phase held behind a durable actionable state.
- [x] The retry action survives app restart and works from persisted state.

## Likely files

`src/main/tasks/process/service.ts`, `src/main/tasks/process/scheduler.ts`,
process DB repositories/migrations if a retry counter is persisted separately,
`src/main/ipc/process-handlers.ts`, `src/preload/index.ts`, and
`src/renderer/src/components/process-screen.tsx`, with scheduler/service/UI
tests.
