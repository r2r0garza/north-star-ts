---
status: RESOLVED
severity: P2
trigger: "Process failure records exist but do not yet have injected coverage for every declared stage"
created: 2026-09-02
updated: 2026-09-02
---

# Add process failure stage fault-injection coverage

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) introduced a
shared `FailureContext` and stage vocabulary, but current tests cover only a
small vertical slice. Untested stages can still regress back to unstructured
strings or lose run/phase/worker identity across task, scheduler, and renderer
boundaries.

## Proposed direction

Add fault-injection tests for every declared failure stage:
`agent_setup`, `model_request`, `tool_dispatch`, `tool_execution`,
`result_persistence`, `output_validation`, `decomposition`, `reviewer`,
`subprocess`, and `scheduler`.

Each test should inject a failure at the specific boundary, then assert the
typed stage, stable code, retryability, attempt budget, run id, phase id,
phase-run id, process task id, worker task id, and agent identity survive in the
phase row, durable attempt history, task events, and user-visible display path.

## Acceptance criteria

- [x] Each declared `FailureStage` has at least one direct fault-injection test.
- [x] Tests assert structured fields, not only human-readable error strings.
- [x] Agent, worker, phase, nested run, and renderer-facing event boundaries are covered.
- [x] Legacy string-only errors still synthesize a safe fallback `FailureContext`.
- [x] Cancellation, pause, shutdown, and approval holds are excluded from failure-stage tests.

## Resolution

Added scheduler fault-injection coverage for `agent_setup`, `model_request`,
`tool_dispatch`, `tool_execution`, `result_persistence`, `output_validation`,
`decomposition`, `reviewer`, `subprocess`, and `scheduler`.

The shared assertions verify the phase row, `process_phase_attempts`, and emitted
process phase event carry structured `FailureContext` identity fields. Reviewer
failures remain approval holds, but the live gate event now carries the persisted
failure payload. Scheduler-derived container failures now write an attempt audit
row when synthesizing a fallback failure from a failed child that had only a
legacy string error.

Verified with:

- `npm test -- src/main/tasks/process/scheduler.test.ts`
- `npm run typecheck`

## Likely files and dependencies

`src/main/agent/index.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, process tests, runner tests, and renderer
monitor tests if added. Depends on the schema/runtime slice from [069](./069-process-failures-lose-stage-and-attempt-context.md).
