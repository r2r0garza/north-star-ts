---
status: CLOSED
severity: P1
trigger: "The agent loop retry coordinator is not yet backed by durable request state"
created: 2026-09-02
updated: 2026-09-02
---

# Wire retry state into runAgentLoop

## Context

The native completion retry coordinator in `runAgentLoop` currently owns
transient retries for request creation and stream consumption, but it keeps
attempt count and deadline in local variables.

Once [072](./072-persist-model-request-retry-budget.md) adds durable state, the
agent loop must use that repository as the authority.

## Proposed direction

Thread durable retry state into the model-round coordinator.

- Derive or load a stable logical model-round id before calling the provider.
- Load an existing budget when resuming a task/process worker.
- Persist the consumed attempt before calling `createCompletion`.
- Use the durable deadline for elapsed-time checks.
- Mark completed only after the stream finishes and the round is accepted.
- Mark exhausted and return a non-retryable recoverable failure when no budget
  remains.

## Constraints

- Do not persist partial tool-call fragments from a failed stream attempt.
- Do not emit abandoned partial text into the UI or transcript.
- Do not give output-length truncation a transient retry path.
- CLI-backed providers still bypass this native completion loop; document their
  behavior separately if needed.

## Acceptance criteria

- [x] `runAgentLoop` consumes durable attempts before each provider request.
- [x] A resumed loop reuses existing budget state for the same logical model
      round.
- [x] Successful round completion marks the durable record completed.
- [x] Exhaustion returns a non-retryable failure and does not ask the process
      scheduler or task runner for another automatic budget.
- [x] Existing 065/066 integration tests still pass.

## Resolution

`runAgentLoop` now keys native completion rounds by the persisted transcript
boundary (`after-seq:<max seq>`) and routes each provider transport attempt
through the durable model-request retry budget repository before calling
`createCompletion`. Failed stream attempts buffer partial text/tool fragments and
discard them before retrying, while accepted model rounds are marked completed
only after the assistant turn is persisted.

Rejected rounds are terminalized instead of receiving another transient path:
deterministic provider failures exhaust their durable budget immediately, retry
budget exhaustion returns `retryable: false`, and output-length truncation with a
partial tool call exhausts the budget without executing or persisting the partial
tool call.

Added integration assertions for durable budget attempts/statuses across normal
multi-round tool recovery, retry after completed tool work, failed stream retry,
deterministic provider failure, and truncated tool-call rejection.

Verified with:

- `npm test -- src/main/agent/tool-error-feedback.integration.test.ts src/main/db/repositories/model-request-retry-budgets.test.ts src/main/db/migrations.test.ts`
- `npm test -- src/main/agent/providers/index.test.ts`
- `npm run typecheck`

## Likely files

`src/main/agent/index.ts`,
`src/main/agent/tool-error-feedback.integration.test.ts`, and the repository
introduced by [072](./072-persist-model-request-retry-budget.md).
