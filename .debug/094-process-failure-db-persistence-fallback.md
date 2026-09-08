---
status: CLOSED
severity: P2
trigger: "If SQLite persistence fails while recording a process failure, the app may imply diagnostics were durably stored"
created: 2026-09-02
updated: 2026-09-02
---

# Handle process failure diagnostic persistence failures honestly

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) requires that DB
persistence failures retain a best-effort bounded external diagnostic and surface
the persistence failure honestly. The current runtime assumes SQLite writes for
phase failures, attempt rows, and task events succeed.

## Proposed direction

Define what happens when writing `process_phase_runs.failure`,
`process_phase_attempts`, task events, or related diagnostic rows throws. The
runtime should not replace the original failure with a misleading provider error
or claim the diagnostic was stored. Where possible, write a bounded fallback
diagnostic to an external local location and surface a
`result_persistence`-stage failure that preserves the original failure summary.

## Acceptance criteria

- [x] Injected DB write failures during phase failure recording surface as `result_persistence`.
- [x] Original failure stage/code/message summary is preserved as a bounded cause.
- [x] The user-visible task/process result says diagnostics were not fully persisted.
- [x] A best-effort external diagnostic is written when the configured fallback is available.
- [x] If the fallback also fails, the app reports that honestly without crashing the process runner.

## Resolution

Failure diagnostic persistence now goes through a guarded scheduler helper. If a
phase failure row, failed-attempt audit row, or process phase event write throws,
the scheduler synthesizes a sanitized `result_persistence` failure that preserves
the original stage/code/message summary, attempts a bounded external JSON
diagnostic, and throws `FailurePersistenceError` so the process task result says
diagnostics were not fully persisted.

Production process runs configure the fallback directory under Electron
`userData/process-failure-diagnostics`. Tests cover both a successful fallback
write and a fallback-write failure.

Verification:

- `pnpm exec vitest run src/main/tasks/process/scheduler.test.ts`
- `pnpm exec vitest run src/main/tasks/process/scheduler.test.ts src/main/tasks/process/service.test.ts src/main/process/io.test.ts src/main/tasks/runner.test.ts`
- `pnpm run typecheck`

## Likely files and dependencies

`src/main/db/repositories/processes.ts`, `src/main/tasks/process/scheduler.ts`,
`src/main/tasks/process/service.ts`, task event persistence, and tests with
injected repository failures. Depends on redaction/capping from
[092](./092-process-failure-redaction-and-size-limits.md).
