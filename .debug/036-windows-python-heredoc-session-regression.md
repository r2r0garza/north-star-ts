# Session shell execution broke Python heredocs on Windows

> Status: **FIXED**
> Severity: **P2 — Windows command regression**
> Area: exec_command and run_shell compatibility

## Problem

The Windows Python-heredoc materializer is implemented only in
`LocalEnvironment.exec`. Current `exec_command` and compatibility
`run_shell_tool` use `spawnCommand`, which merely changes `python3` to `py -3`.
CMD does not understand POSIX `<<` heredoc syntax, so commands that previously
worked now fail.

## Reproduction test

On a Windows/fake-platform path, execute supported Python heredocs through both
public shell entry points and verify script output, exit status, cleanup, timeout,
and Stop behavior.

## Fix direction

Move materialization into the shared command-start path. Associate the temporary
script with session lifecycle so every exit, spawn failure, abort, and timeout
removes it and reports unexpected cleanup failure.

## Acceptance criteria

- Supported heredocs work through `exec_command` and compatibility execution.
- Temporary scripts never outlive their session.
- Non-heredoc Windows commands remain unchanged.

## Resolution

- `LocalEnvironment.spawnCommand` now materializes supported Windows Python
  heredocs before command-session spawn, matching the legacy `exec` path.
- Temporary heredoc scripts are tied to the returned command handle and removed
  before the session reports exit; cleanup failures are surfaced on stderr.
- Regression tests cover `exec_command`, `run_shell_tool` compatibility, normal
  exit cleanup, timeout cleanup, Stop cleanup, and non-heredoc `python3`
  launcher normalization on a fake Windows platform.

## Verification

- `npm test -- src/main/agent/tools/command_session_tools.test.ts`
- `npm run typecheck`
- `git diff --check`
