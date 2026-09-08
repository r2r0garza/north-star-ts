---
status: CLOSED
severity: P1
trigger: "Manual retry needs a new model-request budget without replaying completed or unknown side effects"
created: 2026-09-02
updated: 2026-09-02
---

# Define explicit retry budget semantics

## Context

Automatic retry and explicit user retry need different boundaries.

Automatic retry should stay within the durable budget for one logical model
round. An explicit user retry may create a new linked budget, but must retain
completed tool results and must not bypass unknown side-effect checks from
[067](./067-interrupted-tools-risk-duplicate-side-effects.md).

## Risk

If explicit retry is treated like automatic resume, users may be unable to recover
from a genuine transient failure. If it is treated like a full rerun, completed
tools may replay or unresolved side effects may be hidden.

## Proposed direction

Define and implement explicit retry as a linked budget transition.

- Preserve the transcript and completed tool results.
- Create a new retry-budget record linked to the exhausted logical request.
- Make the UI/task/process action explicit: this is a user-authorized retry, not
  auto-resume.
- Before retrying, check for unresolved/unknown side-effecting tool calls and
  require the 067 gate where applicable.
- Keep whole-phase rerun separate from model-request retry.

## Acceptance criteria

- [x] Explicit retry creates a linked new model-request budget.
- [x] Completed side-effecting tool results are not replayed.
- [x] Unknown-outcome side effects block retry until resolved or explicitly
      authorized.
- [x] A deliberate whole-phase rerun remains a separate audited action.
- [x] Tests cover explicit retry after exhaustion, with and without unresolved
      side effects.

## Resolution

Implemented explicit retry as the failed-task/process `restart` path. The runner
now creates a `user_retry` model-request budget linked to the latest exhausted
budget for the worker conversation before re-queueing the task. The agent loop
continues using stable transcript-bound logical ids, so automatic resume still
reuses/exhausts the existing durable budget instead of refreshing it.

Completed side-effecting tool results remain in the transcript and are not
replayed. Retry is blocked when a side-effecting tool call has no durable result
or has the synthetic interrupted/unknown result from 067-era repair handling.
Whole-phase/process restart remains the existing `ProcessService.restartRun`
frontier-reset action; it delegates to task restart only after the audited process
frontier is reset.

## Verification

- `npm test -- src/main/db/repositories/model-request-retry-budgets.test.ts src/main/db/migrations.test.ts src/main/tasks/runner.test.ts src/main/agent/repair.test.ts`
- `npm run typecheck`

## Likely files

`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/agent/index.ts`, preload/main IPC if a new explicit action is needed,
and tests.

Coordinate directly with [067](./067-interrupted-tools-risk-duplicate-side-effects.md).
