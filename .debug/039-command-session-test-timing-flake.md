# Command-session completion test relies on fixed wall-clock timing

> Status: **Fixed**
> Severity: **P3 — flaky regression suite**
> Area: command-session tests

## Problem

The completion test starts a child that exits after roughly 280 ms, waits a fixed
250 ms after the tool's initial yield, and requires the next poll to be complete.
Under full-suite load the scheduling margin disappears; the test has failed as
`running` and then passed immediately in isolation.

## Reproduction test

Run the focused test repeatedly under CPU load and with timer jitter. Preserve a
bounded overall test deadline so a real stuck-session regression still fails.

## Fix direction

Poll until a terminal state with a short bounded deadline, or replace the real
timer child with a deterministic command-session handle controlled by the test.

## Acceptance criteria

- The test does not depend on one scheduling instant.
- A genuinely non-terminating session still fails quickly.
- Repeated focused and full-suite runs remain green.

## Resolution

Implemented in `feat/tool-hardening`:

- Replaced the fixed post-yield sleep in the command-session polling test with a
  bounded `pollUntilTerminal` helper.
- Added a regression assertion that the helper fails quickly when a session does
  not terminate, preserving coverage for genuinely stuck sessions.

Verification:

- `pnpm exec vitest run src/main/agent/tools/command_session_tools.test.ts`
  passed.
- 20 filtered runs of
  `pnpm exec vitest run src/main/agent/tools/command_session_tools.test.ts -t
  "returns a running session and polls without duplicate output"` passed.
- `pnpm test` was attempted. The command-session coverage passed, but the full
  suite still fails in `src/main/db/repositories/cli-sessions.test.ts` because
  the local `better-sqlite3` native module was compiled for Node ABI 136 while
  the active Node requires ABI 137. That is tracked separately by
  `.debug/040-cli-sessions-native-abi-test-failure.md`.
