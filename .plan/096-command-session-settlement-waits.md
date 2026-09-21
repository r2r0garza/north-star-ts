# PR96: Leak-free command-session settlement waits

> Status: **PLANNED**. Remove transient `exit` listener accumulation from command and diagnostic session waits while preserving termination timing and result semantics.

## Goal

Repeated writes, polls, yields, or termination waits must not retain one new exit listener per call until the process exits or trigger `MaxListenersExceededWarning`.

## Current state

- `command_session_tools.ts::waitForExitOrDelay()` registers `handle.onExit()` for every wait and cannot remove the listener when its timer wins.
- `test_diagnostics_tools.ts` repeats the same pattern.
- Command sessions already own a one-shot `settled` promise resolved by the single lifecycle exit listener.
- Diagnostic sessions do not yet expose an equivalent promise.
- Widening `CommandSessionHandle.onExit()` to return a disposer would touch Local, container, wrapper, PTY, and test implementations even though these session managers can own settlement themselves.

## Required plan/analysis pass

Before implementation, enumerate every `onExit` registration and every session status transition, including timeout, interrupt, kill, abort, natural exit, and cleanup wrappers. Confirm whether duplicate backend exit notifications are possible and whether settlement resolution must be idempotent. Update this plan if the shared-promise approach cannot preserve all behavior.

## Proposed direction

Use one lifecycle listener per managed session. Race or combine the session-owned settlement promise with a bounded delay for temporary waits. Add an equivalent one-shot settled promise to diagnostic sessions and resolve it from their existing lifecycle exit handler. Keep timeout cleanup explicit so completed races do not retain timers.

Do not change the environment-wide `CommandSessionHandle` API unless the analysis identifies a listener outside managed sessions that truly requires independent unsubscription.

## Verification and acceptance

- Repeated delay waits on a still-running session do not increase backend exit-listener count.
- Natural exit resolves all current waiters once.
- Timer-first waits return at the requested bound without changing session state.
- Interrupt-to-kill escalation and abort cleanup retain current timing and status behavior.
- Command and diagnostic session implementations both receive regression coverage.
- No new unhandled promises, timer leaks, or duplicate completion events are introduced.
- Run focused command-session and diagnostics tests, `pnpm typecheck`, and `pnpm test`.

## Likely files

- `src/main/agent/tools/command_session_tools.ts`
- `src/main/agent/tools/command_session_tools.test.ts`
- `src/main/agent/tools/test_diagnostics_tools.ts`
- `src/main/agent/tools/test_diagnostics_tools.test.ts`

## Out of scope

- Redesigning process handles or command output retention.
- Changing foreground/background command behavior.
- Cosmetic output-buffer refactors.
