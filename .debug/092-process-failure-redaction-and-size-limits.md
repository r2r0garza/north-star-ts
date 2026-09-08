---
status: CLOSED
severity: P1
trigger: "Structured process diagnostics could leak provider bodies, credentials, tool payloads, or sensitive paths"
created: 2026-09-02
updated: 2026-09-02
---

# Redact and cap process failure diagnostics

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) calls out
redaction and diagnostic size limits. `FailureContext` records are now durable
and renderer-visible, so provider errors, tool failures, and cause summaries
need explicit sanitization guarantees before the parent item can close.

## Proposed direction

Centralize process failure sanitization before writing phase failures, attempt
records, task events, or support/export diagnostics. Redact credentials,
authorization headers, API keys, provider response bodies, full prompts, tool
arguments/results, and sensitive absolute paths where appropriate. Cap message
and cause sizes so a failed provider/tool cannot bloat SQLite or the renderer.

## Acceptance criteria

- [x] Provider error tests cover API keys, auth headers, response bodies, and long messages.
- [x] Tool failure tests cover tool arguments/results and path-like sensitive data.
- [x] `FailureContext.message` and `cause` are bounded by documented limits.
- [x] Redaction happens before DB persistence and task event emission.
- [x] Tests prove useful stage/code/identity survive redaction.

## Resolution

Added a shared process failure sanitizer with documented caps:
`FAILURE_MESSAGE_MAX_BYTES = 2048` and `FAILURE_CAUSE_MAX_BYTES = 4096`.
The sanitizer redacts credential-like keys, bearer credentials, provider/body
payloads, tool argument/result payloads, and sensitive absolute user/temp paths.

`runAgentLoop` now sanitizes `FailureContext` records as they are created, and
the scheduler sanitizes merged/synthetic phase failures before writing phase
rows, attempt audit rows, or emitting process phase events. Retry paths now store
the sanitized `failure.message` instead of a separate raw error string.

Verification:

- `pnpm exec vitest run src/main/tasks/process/failure-sanitizer.test.ts src/main/tasks/process/scheduler.test.ts`
- `pnpm exec vitest run src/main/agent/tool-error-feedback.integration.test.ts`
- `pnpm run typecheck`

## Likely files and dependencies

`src/main/agent/index.ts`, `src/main/tasks/process/scheduler.ts`,
`src/main/tasks/process/service.ts`, failure helper code if extracted, and tests
around provider/tool failures. Coordinates with [033](./033-network-response-bodies-unbounded.md).
