# PR96: Leak-free command-session settlement waits

> Status: **COMPLETED** (2026-09-22). Replaced per-wait backend `exit` subscriptions with session-owned settlement signals while preserving public terminal status, interrupt-to-kill timing, output, cleanup, and completion-event behavior. Settlement is now first-exit-wins, bounded wait timers are always cleared, and graceful exit during the interrupt grace period avoids a redundant `kill()`.

## Goal

A session manager must subscribe to its backend handle exactly once for normal lifecycle settlement. Repeated `write_stdin` yield waits, compatibility polling waits, test-tool initial yield waits, and interrupt/kill grace waits must not add backend `exit` listeners until the process exits or trigger `MaxListenersExceededWarning`.

The change is deliberately narrower than a general handle-listener API redesign: it removes additive EventEmitter subscriptions from managed-session wait paths. A bounded promise race may temporarily retain a promise reaction until the shared settlement promise resolves, but it must not retain an additional backend-handle listener and its timer must always be cleared.

## Audit findings

### `CommandSessionHandle` contract and backends

`CommandSessionHandle.onExit()` returns `void` (`src/main/agent/env/types.ts:70`), so callers cannot remove a callback. The Local child-process, Local PTY, cleanup wrapper, and container implementations are additive EventEmitter subscriptions:

- `ChildProcessCommandHandle` emits `exit` after the child `close` event, after flushing decoders and removing its abort listener (`src/main/agent/env/local.ts:1095`).
- `PtyCommandHandle` emits `exit` from the PTY exit callback (`src/main/agent/env/local.ts:1260`).
- `CleanupCommandHandle` forwards the inner exit only after temporary-file cleanup settles (`src/main/agent/env/local.ts:1212`).
- `ContainerCommandHandle` emits `exit` after the CLI child closes and pending in-container signal cleanup promises settle (`src/main/agent/env/container.ts:1346`).

The production sources intend one terminal backend notification per handle, but the public interface does not guarantee this and wrapper/test handles can emit more than once. In particular, the diagnostics fake emits on `interrupt()`/`kill()` and may still emit its scheduled natural exit. Session settlement must consequently be idempotent and preserve the first terminal exit record.

### All current `onExit` registrations

| Location                                                                       | Purpose                                                                                                                                  | Must remain?                                                                                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `command_session_tools.ts:createSession`                                       | Single lifecycle subscription: records exit, resolves command settlement, queues background completion, and schedules retention cleanup. | Yes; remain the only normal command-session backend subscription.                                                          |
| `command_session_tools.ts:startCommand`                                        | Removes the per-tool-call abort listener after exit.                                                                                     | Replace with cleanup attached to the command session’s shared `settled` promise; do not add a second backend subscription. |
| `command_session_tools.ts:waitForExitOrDelay`                                  | Wakes each temporary write/compatibility/termination wait.                                                                               | Replace with bounded wait on `session.settled`; remove entirely.                                                           |
| `test_diagnostics_tools.ts:createTestSession`                                  | Single lifecycle subscription: records exit and schedules cleanup.                                                                       | Yes; extend it to resolve diagnostic settlement.                                                                           |
| `test_diagnostics_tools.ts:runTestsTool`                                       | Removes the per-tool-call abort listener after exit.                                                                                     | Replace with cleanup attached to the diagnostic session’s shared settlement promise.                                       |
| `test_diagnostics_tools.ts:waitForExitOrDelay`                                 | Wakes each initial-yield and termination-grace wait.                                                                                     | Replace with bounded wait on diagnostic `settled`; remove entirely.                                                        |
| `env/local.ts:CleanupCommandHandle`                                            | Wrapper forwarding from its inner handle after cleanup.                                                                                  | Backend implementation; unchanged.                                                                                         |
| `env/local.ts` child/PTY handles and `env/container.ts:ContainerCommandHandle` | Backend source of the handle exit signal.                                                                                                | Backend implementation; unchanged.                                                                                         |

`src/main/terminal/service.ts` has a distinct terminal-UI PTY lifecycle and is out of scope. Environment tests that make a one-off promise around `handle.onExit()` are not managed-session wait paths and are also out of scope.

### Status and cleanup transitions to preserve

For both command and test sessions:

- Creation starts at `running`, installs the session timeout, subscribes to data, and installs the one manager-owned lifecycle exit listener.
- The first backend exit clears the lifetime timeout, records `exitCode`, `signal`, and `cleanupError`, and changes only `running` to `completed`; `terminated` and `timed_out` remain externally visible after their eventual exit.
- The lifetime-timeout callback currently marks `timedOut`, assigns `timed_out`, and calls `kill()` whenever it fires before backend settlement. In particular, it may replace `terminated` during the interrupt grace period. Preserve that race: timeout must not itself resolve settlement, and an exit must still be observed before foreground execution settles.
- Explicit termination or an abort listener changes `running` to `terminated`, calls `interrupt()`, and waits up to `TERMINATE_GRACE_MS`. Escalate with `kill()` only if no backend exit has been observed and status is still `terminated`, then retain the existing 500 ms bounded post-kill wait. The current status-only check can redundantly call `kill()` after a graceful exit because settlement intentionally leaves status as `terminated`; replace that check with the explicit settlement guard without changing the reported status. Termination may still return before backend exit if the second bound wins.
- Command settlement resolves foreground callers, creates at most one background completion event, and schedules retained-output cleanup. Diagnostic settlement resolves its waiters and schedules its existing TTL cleanup.
- `testCommandSessions.clear()` and `testDiagnosticsSessions.clear()` clear timers, issue `kill()`, and drop maps; they are test teardown rather than normal settlement and must not acquire listeners. Synchronous fake-handle exit during `kill()` may still run the single lifecycle callback.

## Design decisions

1. Keep `CommandSessionHandle` unchanged. All relevant temporary waits are inside the two session managers, so a disposer would add a broad Local/container/wrapper/PTy/mock migration without solving a remaining caller.
2. Give both session types a shared `settled: Promise<void>`, `resolveSettled`, and a distinct boolean such as `didSettle`. Construct the promise and resolver before registering the lifecycle listener. The resolver and boolean are intentionally private to the session manager; do not overload `settled` as both a promise and a flag.
3. Make `settleSession` and `settleTestSession` first-exit-wins and idempotent. Check and set `didSettle` before mutating terminal fields, resolving the promise, queuing a completion, or scheduling cleanup. This avoids duplicate completion events and duplicate TTL timers when a backend or wrapper emits more than one exit.
4. Replace `waitForExitOrDelay` with a common local pattern for each module: if the session is no longer waitable, return immediately; otherwise create the delay, race `session.settled` against it, and clear the delay timer in `finally`, regardless of which branch wins. The helper must behave correctly for `ms === 0` and for an already-resolved settlement promise, and must never attach `handle.onExit()`.
5. Preserve existing public wait semantics. `write_stdin` and test initial-yield waits start only from `running`; temporary termination waits permit `running` or `terminated`; foreground command execution continues to await unconditional backend settlement through `waitForSettled`. After the interrupt grace wait, use `!session.didSettle && session.status === "terminated"` for kill escalation so a settled-but-`terminated` session is not killed again, while a timeout that changed status to `timed_out` is not double-killed.
6. Move per-call `AbortSignal` listener removal from `handle.onExit()` to `void session.settled.then(() => signal.removeEventListener("abort", onAbort))`. Register this cleanup after adding the abort listener. For an already-aborted signal, no listener is added, but attaching the same no-op removal to settlement is safe. It must not change abort behavior or cause an unhandled rejection because `settled` never rejects.
7. Do not alter lifetime-timeout ownership, completion-inbox retention, compatibility-session deletion, or TTL values as part of this fix. “Clear every delay” refers to the new temporary settlement-race timers, not the existing lifetime or retention timers.

## Implementation sequence

1. In `command_session_tools.ts`, add `didSettle` to `AgentCommandSession` and guard `settleSession` before any side effect. Keep the existing lifecycle `handle.onExit()` as the only manager-owned command-session backend listener.
2. Replace command `waitForExitOrDelay` with a settlement-vs-delay helper that performs deterministic timer cleanup. Route `waitForSettle`, `runShellCompatibility`, and both stages of `terminateSession` through it without changing their bounds. Change only the post-grace escalation predicate to require both `!didSettle` and `status === "terminated"`.
3. Replace command abort-listener cleanup with settlement-promise cleanup, retaining the exact `onAbort` callback and `{ once: true }` registration for non-aborted signals.
4. Mirror the settlement fields, guarded lifecycle settlement, bounded delay helper, abort cleanup, and settlement-aware escalation predicate in `test_diagnostics_tools.ts`. Do not change `workspaceDiagnosticsTool`, which uses `env.exec` rather than a session handle.
5. Add deterministic listener-counting, manually settled handles to focused tests. Use fake timers for the 1,500 ms and 500 ms bounds and to identify/verify cancellation of temporary delay timers; restore real timers after each such test. Avoid fixed sleeps: explicitly emit exits and flush promise microtasks.

## Regression coverage

### Command sessions

Add a controllable fake handle that exposes its current exit-listener count, records `interrupt`/`kill` calls, and can emit one or more chosen exits. Cover:

- A background interactive command remains running while many `write_stdin` calls with `yield_ms: 0` or a short bound complete. Its backend exit-listener count stays at the lifecycle baseline (one, plus no abort-cleanup subscription); after a natural exit, its completion is rendered once.
- Repeated compatibility-loop waits against a still-running session do not add listeners. Start `runShellCompatibility` without awaiting it, advance its 100 ms loop with fake timers while retaining the environment’s handle reference, assert the listener baseline after several iterations, then emit exit and await the call.
- A timer-first yield returns while status remains `running`; a later exit still settles normally, clears its command lifetime timeout, and makes final output/status visible.
- Exit-first waits return early and cancel their pending delay timer. Identify the temporary timer by its requested delay or spy on `clearTimeout`; do not assume the global timer count is zero because lifetime and retention timers also exist.
- Interrupted sessions do not call `kill()` if an exit occurs during the 1,500 ms grace period. Sessions with no exit escalate exactly once after the grace period, wait at most the existing additional 500 ms, and keep current terminal status semantics. Also cover a lifetime timeout firing during the grace period: it reports `timed_out`, performs the timeout kill, and is not killed a second time by termination.
- An already-aborted signal adds no abort listener. A signal that aborts while running retains existing termination behavior, removes its registered abort listener on settlement, and adds no backend exit subscription; spy on `addEventListener`/`removeEventListener` if listener counts are needed.
- Two exit emissions retain the first `exitCode`, `signal`, and `cleanupError`, resolve all waiters once, enqueue at most one completion event, and create one cleanup schedule. Count the retention-duration `setTimeout` calls rather than relying only on the final map state.

### Diagnostic test sessions

Use the same controllable/counting handle through `runTestsTool` and cover:

- A timer-first initial yield leaves only the lifecycle backend listener; the later abort-driven termination grace and post-kill waits do not increase that count. There is only one public initial-yield call per diagnostic session, so do not describe this as repeated polling of one session.
- Timer-first initial yield still reports `running`; a later exit produces the normal completed result and test parsing.
- Abort-driven interrupt-to-kill escalation retains the current 1,500 ms plus 500 ms bounds, does not kill after an exit during grace, and preserves the timeout-during-grace behavior described above.
- Duplicate exits preserve the first terminal record, resolve settlement once, and schedule cleanup only once.
- Abort listener cleanup is driven by settlement, not by an additional handle subscription; cover both already-aborted and later-aborted signals.

## Acceptance and verification

- Each managed command or diagnostic session registers exactly one manager-owned lifecycle `onExit` callback on its handle; temporary waits and abort cleanup never increase that baseline.
- Both lifecycle settlement functions are first-exit-wins and idempotent: terminal fields, promise resolution, completion enqueue, and cleanup scheduling occur once.
- Backend exit wakes all outstanding shared-promise waiters. No delay winner changes session status, and a timer-first waiter does not prevent later settlement.
- Every temporary delay is cleared when settlement wins, including zero-delay/already-settled races, and no unhandled promise rejection or duplicate completion event is introduced.
- Interrupt escalation is based on observed settlement as well as status: graceful exit during the 1,500 ms window avoids redundant kill, no-exit paths retain the additional 500 ms bound, and timeout during termination retains `timed_out` semantics.
- Timeout, explicit termination, abort, Local pipe, Local PTY, cleanup-wrapper, and container behavior otherwise remain compatible because the handle contract and its backend implementations are unchanged.
- Focused tests pass:
  - `pnpm exec vitest run src/main/agent/tools/command_session_tools.test.ts`
  - `pnpm exec vitest run src/main/agent/tools/test_diagnostics_tools.test.ts`
- Then run `pnpm typecheck` and `pnpm test`. Record any pre-existing environment failure separately rather than weakening this change’s focused coverage.

## Likely files

- `src/main/agent/tools/command_session_tools.ts`
- `src/main/agent/tools/command_session_tools.test.ts`
- `src/main/agent/tools/test_diagnostics_tools.ts`
- `src/main/agent/tools/test_diagnostics_tools.test.ts`

## Out of scope

- Redesigning process handles or command output retention.
- Changing foreground/background command behavior, completion-inbox ownership, or output cursor semantics.
- Altering terminal-drawer session management.
- Cosmetic output-buffer refactors.
