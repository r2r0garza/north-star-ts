---
status: CLOSED
severity: P1
trigger: "Cancellation can stop scheduling without durably recording which in-flight tool outcomes are unresolved"
created: 2026-09-02
updated: 2026-09-02
---

# Record unresolved outcomes on cancellation

## Context

[071](./071-tool-batches-delay-error-feedback-and-cancellation.md) covers
batch-level cancellation feedback. [067](./067-interrupted-tools-risk-duplicate-side-effects.md)
also requires cancellation to stop scheduling new work and record unresolved
outcomes.

## Risk

If cancellation occurs while a tool batch is in flight, completed sibling
results can be lost and started calls without terminal evidence can be mistaken
for retryable failures. The scheduler must stop launching new calls while still
settling what is known.

## Proposed direction

Teach the scheduler and agent loop to:

- stop scheduling additional calls once cancellation is observed;
- persist terminal results for calls that already settled;
- mark started-but-unsettled side-effecting calls as unknown;
- classify never-started calls as not-started when lifecycle evidence proves it;
- preserve API-valid call/result pairs.

## Acceptance criteria

- [x] Cancellation stops launching new calls in the current and later batches.
- [x] Completed sibling results are persisted before cancellation settles.
- [x] Started side-effecting calls without terminal evidence are recorded as
      unknown.
- [x] Never-started calls are recorded as not-started, not unknown.
- [x] Resume/retry honors the recorded cancellation outcomes.

## Likely files

`src/main/agent/tool-batch-scheduler.ts`, `src/main/agent/index.ts`,
`src/main/tasks/runner.ts`, lifecycle repository, and tests.
