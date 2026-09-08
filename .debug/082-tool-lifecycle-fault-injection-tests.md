---
status: RESOLVED
severity: P1
trigger: "Interrupted tool recovery lacks fault-injection tests for execution and persistence boundaries"
created: 2026-09-02
updated: 2026-09-02
---

# Add fault-injection coverage for tool lifecycle recovery

## Context

The closure criteria for [067](./067-interrupted-tools-risk-duplicate-side-effects.md)
require tests at the exact boundaries where duplication risk appears: before
execution, after external effect, before result persistence, after result
persistence, app restart, retry, resume, and cancellation.

## Risk

Without boundary tests, later refactors can reintroduce unsafe replay by moving
a persistence write after a side effect, by deleting sibling evidence, or by
letting retry paths bypass recovery classification.

## Proposed direction

Build explicit fault-injection hooks around the lifecycle repository and tool
execution scheduler. Tests should simulate crashes or thrown errors at durable
boundaries without requiring real external systems.

## Acceptance criteria

- [x] Fault before execution produces not-started recovery.
- [x] Fault after external effect but before terminal persistence produces
      unknown recovery.
- [x] Fault after terminal result persistence produces settled recovery.
- [x] Resume preserves completed sibling results and does not repeat actions.
- [x] Unknown mutations block after app restart, manual resume, auto-resume, and
      retry.
- [x] Pending approvals re-prompt without synthetic approval or denial.
- [x] Cancellation records unresolved outcomes and stops scheduling new work.

## Resolution

Added fault-injection coverage across the repair and scheduler boundaries:

- `repairDanglingToolCalls` now durably marks prepared-but-unstarted tool calls
  as `not_started` while leaving approval-waiting calls resumable.
- Repair coverage now preserves settled sibling output and marks only the
  unresolved side-effecting sibling unknown.
- Scheduler coverage now proves a failed batch-persistence callback prevents the
  next side-effecting barrier from starting.

Existing task-runner and lifecycle repository tests cover restart/retry/manual
resume/auto-resume blocking, approval recovery, cancellation, and settled
lifecycle evidence.

## Likely files

`src/main/agent/*.test.ts`, `src/main/tasks/runner.test.ts`,
`src/main/tasks/process/*.test.ts`, lifecycle repository tests, and test-only
fake tools.
