---
status: CLOSED
severity: P2
trigger: "Retrying, exhausted, and review-unavailable process states may rely on live subscriptions instead of durable rows"
created: 2026-09-02
updated: 2026-09-02
---

# Make process recovery states reload-safe

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) requires
retrying, exhausted, and review-unavailable states to survive reload and show the
correct action. The current implementation stores failed process attempts, but
the full monitor behavior for recovery actions still needs durable reload tests.

## Proposed direction

Add tests that stop and rebuild the observable state from SQLite rows only:
process runs, phase runs, approvals, task events, retry budgets, validator review
workers, and phase attempt records. The monitor should render the same state and
actions after reload as it did live.

Cover automatic retry backoff, exhausted retry budget, validator review
unavailability, retry-review availability, and manual override availability.

## Acceptance criteria

- [x] Retrying process worker state survives reload without a live event subscription.
- [x] Exhausted retry state survives reload and exposes the correct retry action.
- [x] Validator review-unavailable state survives reload and exposes retry-review/manual-override actions.
- [x] Durable rows, not in-memory maps, are asserted in tests.
- [x] Reloaded monitor display matches live monitor display for the covered states.

## Resolution

- TaskRunner retry budgets now derive the consumed retry count from durable
  `task_events` rows, so an auto-resumed process worker that reloads during
  backoff keeps its bounded retry budget.
- Manual resume/restart writes a durable `retry_budget_reset` event, preserving
  the existing fresh-budget semantics while retaining old attempt history.
- The process monitor gate recovery path is factored into a pure helper and
  covered with durable task-event and approval-row fixtures for validator
  unavailable, retry-review, and manual override states.

## Verification

- `npx vitest run src/main/tasks/runner.test.ts src/renderer/src/components/process-screen.test.tsx`
- `npm run typecheck`

## Likely files and dependencies

`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, `src/main/db/repositories/processes.ts`,
`src/renderer/src/components/process-screen.tsx`, and process monitor tests.
Coordinates with [084](./084-validator-review-only-retry.md) and
[086](./086-validator-ui-retry-and-manual-override-audit.md).
