---
status: CLOSED
severity: P2
trigger: "Process phase failed attempts are stored but not yet inspectable from the monitor"
created: 2026-09-02
updated: 2026-09-02
---

# Expose process attempt history in the monitor

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) now has a
`process_phase_attempts` table and IPC/preload access. The monitor renders only
the latest `phaseRun.failure`, so earlier failed attempts are durable but not
yet discoverable by a user investigating a retry chain.

## Proposed direction

Add an attempt-history affordance to each phase/child row that has recorded
attempts. It should show attempt number, max attempts, stage, code, retryability,
timestamp, and linked worker transcript identity. Keep the compact phase card
scannable; use a disclosure, sheet, or inline compact list consistent with the
existing process monitor.

## Acceptance criteria

- [x] Phases with prior failed attempts show an obvious attempt-history affordance.
- [x] Attempt history is loaded from `process_phase_attempts` through `window.cowork`.
- [x] Earlier failed attempts remain visible after a later retry succeeds.
- [x] Each attempt displays stage/code/attempt/retryability and can link to the worker transcript when available.
- [x] Legacy phase rows without attempt records keep the current fallback display.

## Likely files and dependencies

`src/renderer/src/components/process-screen.tsx`, `src/preload/index.ts`,
`src/main/ipc/db-handlers.ts`, and process monitor tests. Depends on the
`process_phase_attempts` schema from [069](./069-process-failures-lose-stage-and-attempt-context.md).
