---
status: CLOSED
severity: P1
trigger: "In-memory model-request retries lose their budget across task or app restart"
created: 2026-09-02
updated: 2026-09-02
---

# Persist model request retry budgets

## Context

Debug note [066](./066-api-retries-restart-process-workers.md) added an
in-process retry boundary inside `runAgentLoop` for native completion-backed
model rounds. That prevents recoverable transient failures from replaying a whole
process phase while the process remains alive.

The retry budget is still memory-only. If the app exits, the task pauses, or a
process worker resumes from persisted transcript, the logical model round can
receive a fresh retry budget even though it is retrying the same failed request.

## Risk

A transient outage after completed side-effecting tool work can still become a
duplicate recovery boundary after restart:

- the completed tool result is persisted;
- the model round that follows it fails/exhausts in memory;
- app/task restart rebuilds the transcript;
- `runAgentLoop` creates a new in-memory retry budget for the same logical round.

That violates 066's budget ownership goal and complicates 067's unknown-outcome
side-effect gate.

## Proposed direction

Add durable retry-budget state for native completion rounds.

- Introduce a small repository/table keyed by conversation/task plus a stable
  logical model-round id.
- Store request status, attempts consumed, first attempt time, absolute deadline,
  last error, and completion/exhaustion timestamps.
- Persist before each transport attempt, not only after failures, so a crash
  during the provider request still consumes the attempt.
- Mark success when a stream completes and the round is accepted for persistence.
- Mark exhausted when retry attempts or elapsed-time budget are consumed.

## Acceptance criteria

- [x] A native model round has a stable logical id across task/process resume.
- [x] Attempt count is durable before each provider transport attempt.
- [x] Retry deadline is durable and uses absolute time.
- [x] Successful completion marks the budget completed.
- [x] Exhaustion marks the budget exhausted with the last error.
- [x] Repository tests cover create, consume attempt, complete, exhaust, and
      reload.

## Resolution

Implemented in schema v36 with `model_request_retry_budgets`, repository helpers
for consuming attempts and marking completion/exhaustion, and agent-loop wiring
keyed by `after-seq:<max persisted message seq>`. Attempts are written before
`createCompletion`, the original deadline is reused across reload, successful
assistant transcript persistence completes the budget, and exhausted budgets fail
fast without receiving a fresh in-memory retry window.

Verified with:

- `npm test -- src/main/db/repositories/model-request-retry-budgets.test.ts src/main/db/migrations.test.ts`
- `npm test -- src/main/agent/tool-error-feedback.integration.test.ts src/main/agent/providers/index.test.ts`
- `npm run typecheck`

## Likely files

`src/main/agent/index.ts`, `src/main/db/migrations/*`,
`src/main/db/repositories/*`, `src/main/db/types.ts`, and tests.

Coordinate with [066](./066-api-retries-restart-process-workers.md) and
[067](./067-interrupted-tools-risk-duplicate-side-effects.md).
