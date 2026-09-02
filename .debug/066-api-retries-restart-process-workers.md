---
status: OPEN
severity: P1
trigger: "Processes and conversations share API error classification but not the same recovery boundary"
created: 2026-09-01
updated: 2026-09-01
---

# Retry failed model requests without restarting process work

## Current behavior and evidence

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

- [ ] A completed side-effecting tool executes once when the following request
  fails twice and then succeeds; all attempts include its existing result.
- [ ] Test failure before response and during stream iteration, including partial
  tool arguments and partial text. No abandoned tool fragment executes.
- [ ] Fake-clock tests cover backoff, server delay, exhaustion, cancellation,
  shutdown, and no late request after abort. Inject jitter for deterministic tests.
- [ ] Auth/invalid-request failures do not consume transient retry cycles.
- [ ] Assert total transport attempts across the stack; no multiplicative retry.
- [ ] Exhaustion followed by automatic task/process resume, including app restart,
  makes no new transport request. Explicit retry creates a linked budget without
  replaying completed tools or bypassing unresolved-effect checks.
- [ ] Both live chat and process workers exercise this shared implementation.
- [ ] Exhaustion exposes an actionable recoverable failure, not a success or an
  automatic worker restart. No provider-internal retry setting is assumed.

## Likely files and dependencies

`src/main/agent/index.ts`, `src/main/agent/providers/index.ts`,
`src/main/tasks/runner.ts`, `src/main/tasks/process/service.ts`,
`src/main/tasks/process/scheduler.ts`, and corresponding tests.

Build on [065](./065-tool-error-feedback-lacks-loop-integration-tests.md).
Coordinate resume semantics with [067](./067-interrupted-tools-risk-duplicate-side-effects.md)
and attempt visibility with [069](./069-process-failures-lose-stage-and-attempt-context.md).
New settings or retry events require the normal preload/main IPC boundary.
