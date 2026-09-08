---
status: CLOSED
severity: P1
trigger: "Processes and conversations share API error classification but not the same recovery boundary"
created: 2026-09-01
updated: 2026-09-02
---

# Retry failed model requests without restarting process work

## Original behavior and evidence

At revision `21bd34d`:

- `src/main/agent/providers/index.ts`, `isTransientError`, recognizes HTTP
  408/429/5xx and selected connection errors, including nested causes.
- `src/main/agent/index.ts`, `runAgentLoop`, catches model/stream failures and
  returns a persisted failure plus `retryable`; `runChat` adds no application
  retry loop around it.
- `src/main/tasks/process/scheduler.ts`, `runPhaseWithRetry` and
  `runDecomposeWithRetry`, immediately retry retryable failures up to three total
  attempts. `service.ts` creates a fresh worker conversation for each attempt.
- `src/main/tasks/runner.ts`, `settleError`, instead retries background tasks
  with jittered backoff using their existing conversation.

These are not equivalent recovery guarantees. A transient failure after useful
tool work can cause an entire process phase to be attempted again. Lower-level
client retry defaults have not been audited; do not assume their attempt count.

## Current state

The native completion-backed agent loop now owns a durable retry boundary for one
logical model round:

- `runAgentLoop` retries transient failures from both completion creation and
  stream iteration.
- Retries reuse the same `messages` and `tools` for the failed model round, so
  completed tool results from earlier rounds stay in context.
- Partial text and partial tool-call fragments from failed stream attempts are
  buffered per attempt and discarded unless the stream completes.
- Retry state is persisted by stable logical request id, including consumed
  attempts, absolute deadline, completion, exhaustion, and linked user retries.
- OpenAI SDK internal retries are disabled with `maxRetries: 0`; Portkey's
  exposed `maxRetries` instance field is set to `0`.
- Output-length truncation while a tool call is present is treated as an
  unchanged-request failure, not a transient transport retry.

This closes the phase-worker replay hazard for transient failures: recoverable
request failures stay inside the worker's model round, while exhausted requests
fail visibly without causing automatic phase replay with a fresh worker
conversation. Automatic resume reloads the existing retry budget and makes zero
new provider calls when the request is exhausted or past deadline. Explicit user
retry creates a linked new budget only after preserving completed tool results
and checking unresolved side effects.

## Proposed direction

Introduce a shared bounded model-request recovery boundary inside the agent
loop, covering both request creation and stream consumption. Preserve the
messages from completed tool rounds. Retry only the failed completion request,
not the phase, tool batch, or worker initialization.

- Reuse the shared transient classifier. Do not retry authentication,
  authorization, invalid-request, or unclassified programmer errors blindly.
- Use abortable capped exponential backoff with jitter and a total elapsed-time
  budget. Respect valid `Retry-After` values; when the server delay exceeds the
  remaining budget, stop/defer visibly instead of retrying earlier than advised.
- Buffer tool fragments per attempt. Never execute partial tool calls from a
  broken stream. Reconcile partial text shown live so retries do not duplicate
  it or present abandoned text as a completed answer.
- Define one effective retry budget across client, loop, task runner, and phase
  scheduler. Audit actual client configuration before choosing how to disable
  or account for nested retries. Exhaustion must not trigger a fresh automatic
  phase replay with a new budget.
- Treat output-length truncation and malformed output separately from transient
  transport failure: unchanged requests may deterministically truncate again.
- Scope this change to the native completion-backed loop first. CLI-backed
  providers bypass it; document and test their distinct behavior rather than
  claiming automatic parity or blindly restarting a CLI session.

### Budget ownership and lifetime

The proposed authoritative owner is a shared model-request retry coordinator
called by `runAgentLoop`, scoped to a stable logical request ID (one model round,
including its transport/stream retries). Persist consumed attempts and the
deadline through the conversation/task recovery record. The task runner and
process scheduler consume its outcome; they must not wrap an exhausted request
in a fresh automatic retry budget. Client-internal attempts must either be
disabled where supported or counted within this coordinator's effective budget.

Automatic resume/restart retains the request identity and remaining budget;
elapsed downtime counts toward its deadline. An explicit user retry may create
a linked new budget, but must retain completed tool results and obey 067's
unknown-outcome gate. A deliberate whole-phase rerun is a separate audited
action, not an implicit consequence of retrying a request. A subsequent model
round or genuine semantic rework is new logical work with its own request ID.

## Acceptance criteria

- [x] A completed side-effecting tool executes once when the following request
      fails twice and then succeeds; all attempts include its existing result.
- [x] Test failure before response and during stream iteration, including partial
      tool arguments and partial text. No abandoned tool fragment executes.
- [x] Fake-clock tests cover backoff, server delay, exhaustion, cancellation,
      shutdown, and no late request after abort. Inject jitter for deterministic
      tests.
- [x] Auth/invalid-request failures do not consume transient retry cycles.
- [x] Assert total transport attempts across the stack; no multiplicative retry.
- [x] Exhaustion followed by automatic task/process resume, including app restart,
      makes no new transport request. Explicit retry creates a linked budget without
      replaying completed tools or bypassing unresolved-effect checks.
- [x] Both live chat and process workers exercise this shared implementation.
- [x] Exhaustion exposes an actionable recoverable failure, not a success or an
      automatic worker restart. No provider-internal retry setting is assumed.

## Completed slices

The umbrella work was split into narrower follow-up notes, now resolved:

- [072](./072-persist-model-request-retry-budget.md): persist logical
  model-request budget state.
- [073](./073-agent-loop-retry-state-wiring.md): wire durable retry state into
  `runAgentLoop`.
- [074](./074-auto-resume-must-not-refresh-model-retry-budget.md): prevent
  task/process auto-resume from refreshing an exhausted request budget.
- [075](./075-explicit-retry-linked-model-budget.md): define explicit user retry
  as a linked new budget without replaying completed or unknown side effects.
- [076](./076-model-request-retry-fake-clock-tests.md): add deterministic
  fake-clock coverage for backoff, `Retry-After`, cancellation, shutdown, and
  exhaustion.

## Likely files and dependencies

`src/main/agent/index.ts`, `src/main/agent/providers/index.ts`,
`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, and corresponding tests.

Build on [065](./065-tool-error-feedback-lacks-loop-integration-tests.md).
Coordinate resume semantics with [067](./067-interrupted-tools-risk-duplicate-side-effects.md)
and attempt visibility with [069](./069-process-failures-lose-stage-and-attempt-context.md).
New settings or retry events require the normal preload/main IPC boundary.

## Progress 2026-09-02

- Added a native completion retry coordinator in `runAgentLoop` around request
  creation and stream consumption. Retries reuse the same messages/tools for the
  failed model round, buffer partial text/tool fragments per attempt, and persist
  only a completed stream.
- Disabled hidden SDK retries for OpenAI (`maxRetries: 0`) and Portkey
  (`maxRetries = 0`) so the loop owns the effective transport attempt count.
- Output-length tool truncation is now surfaced as non-retryable for the unchanged
  request path.
- Added integration coverage proving a completed mutating tool is not replayed
  when the following model request fails twice then succeeds, partial stream text
  and partial tool arguments are discarded, and deterministic 401-style failures
  do not retry.
- Persisted logical request retry identity/deadline across task and process
  resume, including zero-transport auto-resume after exhaustion or deadline
  expiry.
- Added explicit linked user-retry semantics that preserve completed tool results
  and block unresolved/unknown side-effect outcomes.
- Extracted the model-request retry coordinator and added deterministic
  fake-clock coverage for capped backoff, `Retry-After`, elapsed-budget
  exhaustion, attempt exhaustion, cancellation, shutdown, no late provider
  access, abandoned stream fragment discard, and auto-resume after exhaustion.

## Resolution

The shared native completion retry boundary now covers live chat and process
workers without relying on process-scheduler replay. Provider transport attempts
are counted by the coordinator, hidden SDK retries are disabled, failed stream
attempts are discarded before persistence, durable request budgets survive
resume/restart, and explicit user retry is represented as a linked budget rather
than an automatic refresh.

Verification:

- `npm test -- src/main/agent/model-request-retry.test.ts src/main/agent/tool-error-feedback.integration.test.ts`
- `npm test -- src/main/db/repositories/model-request-retry-budgets.test.ts src/main/db/migrations.test.ts src/main/tasks/runner.test.ts src/main/agent/repair.test.ts`
- `npm test -- src/main/tasks/process/service.test.ts src/main/agent/tool-error-feedback.integration.test.ts`
- `npm run typecheck`
