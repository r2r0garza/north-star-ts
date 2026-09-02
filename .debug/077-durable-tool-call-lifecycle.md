---
status: CLOSED
severity: P1
trigger: "Tool-call intent, start, and terminal outcomes are not durably tracked independently of chat messages"
created: 2026-09-02
updated: 2026-09-02
---

# Persist per-tool-call lifecycle evidence

## Context

[067](./067-interrupted-tools-risk-duplicate-side-effects.md) now preserves
interrupted tool-call transcript evidence, but the message log still cannot
distinguish every recovery state by itself.

The system needs durable per-call execution evidence that survives app restart,
process retry, task resume, and partial persistence failure.

## Risk

A local crash, thrown exception, timeout, or process shutdown can happen after a
tool was requested but before its result is persisted. Without a separate
lifecycle record, recovery has to infer too much from the transcript and can
either retry a mutation unsafely or block a call that provably never started.

## Proposed direction

Introduce a durable tool-call lifecycle table/repository keyed by conversation,
assistant message or logical round, tool-call id, tool name, normalized
arguments/identity, and execution state.

States should distinguish at least:

- prepared / intent persisted;
- waiting_for_approval;
- started;
- settled_success;
- settled_error;
- unknown.

Persist intent before execution and persist terminal evidence as each call
settles. Legacy transcript-only calls without lifecycle rows must be classified
conservatively.

## Acceptance criteria

- [x] Tool intent is persisted before approval or execution begins.
- [x] Starting execution is durably recorded before invoking the tool body.
- [x] Success and error outcomes are durably recorded as each call settles.
- [x] Recovery can query lifecycle state without parsing only chat messages.
- [x] Legacy dangling transcript calls without lifecycle evidence default to
      unknown where side effects are possible.

## Likely files

`src/main/db/schema.ts`, DB migrations, `src/main/db/repositories/*`,
`src/main/agent/index.ts`, `src/main/agent/tool-batch-scheduler.ts`, and tests.
