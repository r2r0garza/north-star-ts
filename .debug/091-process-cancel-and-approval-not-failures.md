---
status: CLOSED
severity: P2
trigger: "Cancellation, pause, shutdown, or approval holds could be mislabeled as API/model failures"
created: 2026-09-02
updated: 2026-09-02
---

# Keep process control-flow states out of failure records

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) requires that
cancellation and approval holds are not relabeled as API errors. The process
runtime has distinct pause/cancel/gate handling, but structured failure plumbing
adds new paths where control flow could accidentally produce a `FailureContext`.

## Proposed direction

Add regression tests for user cancel, pause, shutdown-resume, phase approval
gate, validator approval gate, and flag confirmation gate. Each should assert
the task/run/phase status and confirm no failure attempt is recorded unless a
real failure also occurred.

## Acceptance criteria

- [x] User cancellation settles as cancelled/stopped without `FailureContext`.
- [x] Pause and shutdown leave resumable state without failure attempts.
- [x] Phase approval gates park as waiting/paused without model/API failure records.
- [x] Validator gates and flag gates preserve their own gate metadata, not a fake failure.
- [x] Existing real failure records are preserved when a later control-flow action occurs.

## Resolution

Added scheduler regression coverage that asserts cancellation, pause, shutdown,
phase approval gates, validator approval gates, and flag confirmation gates do
not write `FailureContext` data or `process_phase_attempts` rows. The structured
failure test now also verifies a later control-flow abort preserves the existing
real failure record without duplicating attempts.

## Likely files and dependencies

`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, approval repositories, and process service
tests. Coordinates with [066](./066-api-retries-restart-process-workers.md) and
[081](./081-cancellation-records-unresolved-tool-outcomes.md).
