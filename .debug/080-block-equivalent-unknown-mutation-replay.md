---
status: RESOLVED
severity: P1
trigger: "Unknown mutations can be reissued as equivalent calls with fresh model-generated tool-call IDs"
created: 2026-09-02
updated: 2026-09-02
---

# Gate equivalent replay after unknown mutations

## Context

The current [067](./067-interrupted-tools-risk-duplicate-side-effects.md) guard
blocks resume/retry when an existing transcript contains an unknown
side-effecting tool call. A later model round, user retry, or explicit rerun can
still attempt an equivalent mutation under a different tool-call id unless the
gate understands unresolved operation identity.

## Risk

Handing an "unknown outcome" result to an unrestricted model is not sufficient.
The model can simply call the same mutation again with new IDs or slightly
different wording, duplicating external effects.

## Proposed direction

Track unresolved side-effecting operation identities and consult them before
executing future calls. Normalize hazardous tool identities using the same
approval/action identity machinery where possible, then block or require
explicit reconciliation before equivalent mutations execute.

## Acceptance criteria

- [x] Unknown side-effecting calls create an unresolved-operation guard.
- [x] A future equivalent mutation with a fresh tool-call id is blocked.
- [x] The guard uses conservative normalized identities for shell, file,
      browser, MCP, web, and task-delegation side effects.
- [x] Read-only calls remain retryable under explicit policy.
- [x] The model does not receive an unrestricted path to rerun unknown
      mutations automatically.

## Resolution notes

- Added normalized lifecycle operation identities derived from gated
  `ToolAction` identity (`kind` + approval identity), so equivalent mutations
  with different provider tool-call ids reconcile to the same invocation.
- The agent gate now upgrades current lifecycle rows to the normalized operation
  identity before approval/execution and blocks equivalent prior `started` or
  `unknown` non-read-only operations.
- Added repository coverage for normalized action identity reconciliation and an
  agent-loop regression proving a fresh-id `write_file_tool` retry is blocked
  before touching the workspace.

## Likely files

`src/main/agent/approval/*`, `src/main/agent/index.ts`,
`src/main/agent/repair.ts`, lifecycle repository, tool effect metadata,
side-effecting tools, and tests.
