---
status: RESOLVED
severity: P1
trigger: "Recovered tool work lacks stable invocation identity for idempotent reconciliation"
created: 2026-09-02
updated: 2026-09-02
---

# Preserve stable tool invocation identity

## Context

When interrupted work resumes, the model may generate a fresh tool-call id for
an operation equivalent to one that may already have started. [067](./067-interrupted-tools-risk-duplicate-side-effects.md)
blocks the obvious transcript case, but tools still need stable operation
identity for safe reconciliation.

## Risk

Remote APIs, subprocesses, MCP tools, browser actions, and background task
creation can have side effects that outlive the local process. Without a durable
invocation id or provider operation id, recovery cannot ask "did this operation
already happen?" and must either block or risk duplication.

## Proposed direction

For each tool call, store a stable invocation identity separate from the
provider's transient tool-call id. Where a tool supports idempotency keys,
operation IDs, request IDs, task IDs, or queryable remote IDs, generate or
preserve them before execution and pass them through the tool implementation.

Recovery should reconcile using the original identity before retrying.

## Acceptance criteria

- [x] Each side-effecting call has a durable invocation identity before start.
- [x] Idempotency keys/operation IDs are persisted and reused across resume.
- [x] Tools that support reconciliation expose a recovery path before retry.
- [x] Reconciled settled outcomes are persisted as terminal evidence.
- [x] Tools without reconciliation remain blocked when outcome is unknown.

## Resolution

Added a durable `invocation_id` to `tool_call_lifecycle`, derived from the
conversation plus normalized tool name and arguments. The agent loop records that
identity before execution, exposes it to tool implementations as
`ctx.invocationId`, and reconciles equivalent side-effecting calls before
invoking the tool body.

If an equivalent prior call already settled, the new call reuses that terminal
result and persists it against the fresh provider `tool_call_id`. If an
equivalent prior call is `started` or `unknown`, the new call records a terminal
blocked result instead of retrying and risking duplicate side effects.

## Likely files

`src/main/agent/tools/types.ts`, individual side-effecting tools,
`src/main/agent/tool-batch-scheduler.ts`, lifecycle repository, MCP tool
adapter, browser tools, task enqueue tools, and tests.
