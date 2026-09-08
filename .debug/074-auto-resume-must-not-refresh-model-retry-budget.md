---
status: RESOLVED
severity: P1
trigger: "Automatic task/process resume can reissue an exhausted logical model request"
created: 2026-09-02
updated: 2026-09-02
---

# Prevent auto-resume from refreshing model retry budgets

## Context

The task runner and process service can automatically resume interrupted work.
For process runs, this is intentional: completed phase work, fan-out checkpoints,
and nested subprocess state should survive app restart.

For an exhausted model request, however, automatic resume must not create a new
transport budget for the same logical request.

## Risk

After a model request exhausts or consumes attempts and the app restarts, the
runner can auto-resume a process task. If the loop creates a fresh budget, it may
send another provider request after a boundary that was already exhausted before
shutdown.

## Proposed direction

Use durable retry-budget state during task and process resume.

- On auto-resume, reload the logical request budget before provider access.
- If the budget is exhausted, return the prior recoverable failure without
  issuing a new request.
- If the absolute deadline has elapsed, mark exhausted/deferred visibly and avoid
  provider access.
- Preserve completed tool results already present in the transcript.
- Keep process-run status actionable: failed/recoverable, not completed and not
  silently restarted as a new phase attempt.

## Acceptance criteria

- [x] A process worker whose next model round exhausted before restart makes zero
      provider calls on auto-resume.
- [x] A task runner auto-resume after deadline expiry makes zero provider calls.
- [x] The user sees an actionable failed/recoverable state, not a success.
- [x] Completed tool results remain in the worker transcript.
- [x] No fresh automatic phase worker conversation is created solely because the
      model-request budget was exhausted.

## Likely files

`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, `src/main/agent/index.ts`, and tests.

Coordinate with [066](./066-api-retries-restart-process-workers.md),
[067](./067-interrupted-tools-risk-duplicate-side-effects.md), and
[069](./069-process-failures-lose-stage-and-attempt-context.md).

## Resolution

Process phase and decomposition workers now reattach to an existing
`phaseRun.taskId` on plain resume and call `runAgentLoop` without a new kickoff
message. That preserves the original worker transcript, including completed tool
results and the stable `after-seq:*` logical model round that owns the durable
retry budget. Intentional rework remains a fresh prompted attempt so validator
and flag feedback is still delivered.

Verified with:

- `npm test -- src/main/tasks/process/service.test.ts src/main/agent/tool-error-feedback.integration.test.ts`
