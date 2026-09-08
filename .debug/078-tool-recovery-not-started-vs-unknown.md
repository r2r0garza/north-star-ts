---
status: RESOLVED
severity: P1
trigger: "Recovery cannot reliably distinguish approval-waiting calls that never started from calls with unknown external effects"
created: 2026-09-02
updated: 2026-09-02
---

# Distinguish not-started recovery from unknown outcomes

## Context

[067](./067-interrupted-tools-risk-duplicate-side-effects.md) blocks unknown
side-effecting outcomes, but durable recovery still needs to tell apart calls
that demonstrably never started from calls that may have already produced an
external effect.

## Risk

If every interrupted call is treated as retryable, the system can duplicate a
mutation. If every interrupted call is treated as unknown, approvals that were
only waiting on the user cannot re-prompt cleanly.

## Proposed direction

Use the lifecycle evidence from [077](./077-durable-tool-call-lifecycle.md) to
drive recovery:

- prepared but not approved/not started: re-prompt when appropriate;
- waiting_for_approval: create a fresh approval request without inventing a user
  decision;
- started without terminal evidence: classify as unknown and block automatic
  replay;
- settled: replay the recorded result and continue.

Never infer failure solely from timeout, abort, crash, or a thrown exception.

## Acceptance criteria

- [x] A call interrupted before approval re-prompts and is not marked unknown.
- [x] A call interrupted after approval but before start is classified as
      not-started only when lifecycle evidence proves it.
- [x] A call interrupted after start without terminal evidence is unknown.
- [x] Unknown mutations block automatic continuation.
- [x] Read-only calls may be retried only under an explicit read-only recovery
      policy.

## Resolution

Recovery now uses durable lifecycle rows before transcript fallbacks:

- `prepared` and `waiting_for_approval` are repaired with a not-started tool
  result and are not classified as unknown;
- `started` or `unknown` without terminal evidence remains unknown and blocks
  side-effecting task resume/retry through the existing runner guard;
- `settled_success` and `settled_error` replay their stored lifecycle output.

The read-only recovery policy remains the existing effect-based gate:
`unknownSideEffectingToolCalls` only permits automatic continuation for calls
whose registered tool effects are read-only.

## Likely files

`src/main/agent/repair.ts`, `src/main/agent/index.ts`,
`src/main/tasks/runner.ts`, approval repositories, lifecycle repositories, and
tests.
